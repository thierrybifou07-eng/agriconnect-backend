const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { haversineDistanceKm, calculateDeliveryFee } = require('../utils/distance');

// POST /api/orders  (acheteur uniquement)
// Réserve immédiatement la quantité commandée sur le stock de l'annonce (voir cancelOrder pour la restitution).
// Tout se passe dans une transaction : relecture du stock + décrément + création de la commande sont atomiques,
// ce qui évite la survente en cas de commandes concurrentes sur la même annonce.
const createOrder = asyncHandler(async (req, res) => {
  const { listingId, quantity, deliveryMode, deliveryAddress, deliveryLatitude, deliveryLongitude } = req.body;

  if (deliveryMode === 'DELIVERY' && (deliveryLatitude === undefined || deliveryLongitude === undefined)) {
    return res.status(400).json({ error: 'deliveryLatitude et deliveryLongitude sont requis pour une livraison' });
  }

  const qty = parseFloat(quantity);

  const order = await prisma.$transaction(async (tx) => {
    const listing = await tx.listing.findUnique({ where: { id: listingId } });

    if (!listing) {
      throw Object.assign(new Error('Annonce introuvable'), { statusCode: 404 });
    }
    if (listing.status !== 'ACTIVE') {
      throw Object.assign(new Error("Cette annonce n'est plus disponible"), { statusCode: 400 });
    }
    if (listing.farmerId === req.user.id) {
      throw Object.assign(new Error('Vous ne pouvez pas commander votre propre annonce'), { statusCode: 400 });
    }
    if (qty > listing.quantity) {
      throw Object.assign(
        new Error(`Quantité demandée (${qty}) supérieure au stock disponible (${listing.quantity})`),
        { statusCode: 400 }
      );
    }

    const totalPrice = Math.round(listing.price * qty * 100) / 100;
    const remaining = listing.quantity - qty;

    await tx.listing.update({
      where: { id: listingId },
      data: {
        quantity: remaining,
        ...(remaining === 0 && { status: 'SOLD' }),
      },
    });

    return tx.order.create({
      data: {
        listingId,
        buyerId: req.user.id,
        farmerId: listing.farmerId,
        quantity: qty,
        unitPrice: listing.price,
        totalPrice,
        deliveryMode,
        deliveryAddress,
        ...(deliveryLatitude !== undefined && { deliveryLatitude }),
        ...(deliveryLongitude !== undefined && { deliveryLongitude }),
      },
    });
  });

  res.status(201).json(order);
});

// GET /api/orders?status=  (mes commandes, en tant qu'acheteur ou agriculteur)
const getMyOrders = asyncHandler(async (req, res) => {
  const { status } = req.query;

  const orders = await prisma.order.findMany({
    where: {
      OR: [{ buyerId: req.user.id }, { farmerId: req.user.id }],
      ...(status && { status }),
    },
    include: {
      listing: { select: { id: true, title: true, photos: true } },
      buyer: { select: { id: true, fullName: true, phone: true } },
      farmer: { select: { id: true, fullName: true, phone: true } },
      delivery: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json(orders);
});

// GET /api/orders/:id
const getOrderById = asyncHandler(async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: {
      listing: true,
      buyer: { select: { id: true, fullName: true, phone: true } },
      farmer: { select: { id: true, fullName: true, phone: true } },
      delivery: true,
    },
  });

  if (!order) return res.status(404).json({ error: 'Commande introuvable' });
  if (![order.buyerId, order.farmerId].includes(req.user.id)) {
    return res.status(403).json({ error: "Vous n'avez pas accès à cette commande" });
  }

  res.json(order);
});

// PATCH /api/orders/:id/confirm  (agriculteur uniquement, propriétaire)
// Transaction : statut de la commande + création de la livraison sont atomiques
// (si l'une échoue, l'autre est annulée - jamais d'état incohérent).
const confirmOrder = asyncHandler(async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { listing: true } });

  if (!order) return res.status(404).json({ error: 'Commande introuvable' });
  if (order.farmerId !== req.user.id) {
    return res.status(403).json({ error: 'Seul le vendeur peut confirmer cette commande' });
  }
  if (order.status !== 'PENDING') {
    return res.status(400).json({ error: 'Seule une commande en attente peut être confirmée' });
  }

  const isDelivery = order.deliveryMode === 'DELIVERY';

  const updated = await prisma.$transaction(async (tx) => {
    const updatedOrder = await tx.order.update({
      where: { id: order.id },
      data: { status: isDelivery ? 'IN_DELIVERY' : 'READY_FOR_PICKUP' },
    });

    if (isDelivery) {
      const distanceKm = haversineDistanceKm(
        order.listing.latitude,
        order.listing.longitude,
        order.deliveryLatitude,
        order.deliveryLongitude
      );

      await tx.delivery.create({
        data: {
          orderId: order.id,
          pickupLatitude: order.listing.latitude,
          pickupLongitude: order.listing.longitude,
          dropoffLatitude: order.deliveryLatitude,
          dropoffLongitude: order.deliveryLongitude,
          distanceKm,
          deliveryFee: calculateDeliveryFee(distanceKm),
        },
      });
    }

    return updatedOrder;
  });

  res.json(updated);
});

// PATCH /api/orders/:id/cancel  (acheteur ou agriculteur, propriétaire)
// Restitue le stock réservé, réactive l'annonce si besoin, annule la livraison associée
// et libère le livreur assigné le cas échéant - le tout dans une seule transaction.
const cancelOrder = asyncHandler(async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });

  if (!order) return res.status(404).json({ error: 'Commande introuvable' });
  if (![order.buyerId, order.farmerId].includes(req.user.id)) {
    return res.status(403).json({ error: "Vous n'avez pas accès à cette commande" });
  }
  if (['DELIVERED', 'CANCELLED'].includes(order.status)) {
    return res.status(400).json({ error: 'Cette commande ne peut plus être annulée' });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const cancelled = await tx.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED' },
    });

    const listing = await tx.listing.findUnique({ where: { id: order.listingId } });
    if (listing) {
      await tx.listing.update({
        where: { id: order.listingId },
        data: {
          quantity: listing.quantity + order.quantity,
          ...(listing.status === 'SOLD' && { status: 'ACTIVE' }),
        },
      });
    }

    const delivery = await tx.delivery.findUnique({ where: { orderId: order.id } });
    if (delivery && !['DELIVERED', 'CANCELLED'].includes(delivery.status)) {
      await tx.delivery.update({ where: { id: delivery.id }, data: { status: 'CANCELLED' } });
      if (delivery.driverId) {
        await tx.user.update({ where: { id: delivery.driverId }, data: { isAvailable: true } });
      }
    }

    return cancelled;
  });

  res.json(updated);
});

// PATCH /api/orders/:id/complete  (mode PICKUP uniquement : l'acheteur a récupéré la marchandise)
const completeOrder = asyncHandler(async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });

  if (!order) return res.status(404).json({ error: 'Commande introuvable' });
  if (![order.buyerId, order.farmerId].includes(req.user.id)) {
    return res.status(403).json({ error: "Vous n'avez pas accès à cette commande" });
  }
  if (order.deliveryMode !== 'PICKUP' || order.status !== 'READY_FOR_PICKUP') {
    return res
      .status(400)
      .json({ error: 'Cette action ne concerne que les commandes en retrait, prêtes à récupérer' });
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { status: 'DELIVERED' },
  });

  res.json(updated);
});

module.exports = { createOrder, getMyOrders, getOrderById, confirmOrder, cancelOrder, completeOrder };
