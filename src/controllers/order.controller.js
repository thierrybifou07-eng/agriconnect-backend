import prisma from '../config/prisma.js';
import { haversineDistanceKm, calculateDeliveryFee } from '../utils/distance.js';
import { asMoney, asQuantity } from '../utils/money.js';
import { getLookupId } from '../utils/lookupCache.js';

const orderInclude = {
  listing: { select: { id: true, title: true } },
  buyer: { select: { id: true, firstname: true, lastname: true, phone: true } },
  farmer: { select: { id: true, firstname: true, lastname: true, phone: true } },
  deliveryMode: true,
  delivery: true,
};

// POST /api/orders  (acheteur uniquement)
// Réserve immédiatement la quantité commandée sur le stock de l'annonce (voir cancelOrder
// pour la restitution). Transaction : relecture du stock + décrément + création atomiques.
export const createOrder = async (req, res) => {
  const { listingId, quantity, deliveryMode, deliveryAddress, deliveryLatitude, deliveryLongitude } = req.body;

  if (deliveryMode === 'DELIVERY' && (deliveryLatitude === undefined || deliveryLongitude === undefined)) {
    return res.status(400).json({ error: 'deliveryLatitude et deliveryLongitude sont requis pour une livraison' });
  }

  const deliveryModeId = await getLookupId('deliveryMode', deliveryMode);

  const order = await prisma.$transaction(async (tx) => {
    const listing = await tx.listing.findUnique({ where: { id: listingId }, include: { status: true } });

    if (!listing) {
      throw Object.assign(new Error('Annonce introuvable'), { statusCode: 404 });
    }
    if (listing.status.code !== 'ACTIVE') {
      throw Object.assign(new Error("Cette annonce n'est plus disponible"), { statusCode: 400 });
    }
    if (listing.farmerId === req.user.id) {
      throw Object.assign(new Error('Vous ne pouvez pas commander votre propre annonce'), { statusCode: 400 });
    }
    // price et quantity sont des Decimal : toute comparaison ou soustraction
    // faite avec les operateurs JS donnerait NaN. On travaille donc avec les
    // methodes Decimal, qui sont exactes.
    const available = listing.quantity;
    const requested = asQuantity(quantity);

    if (requested.gt(available)) {
      throw Object.assign(
        new Error(`Quantité demandée (${requested.toString()}) supérieure au stock disponible (${available.toString()})`),
        { statusCode: 400 }
      );
    }

    const totalPrice = asMoney(listing.price.mul(requested));
    const remaining = asQuantity(available.minus(requested));

    const listingUpdateData = { quantity: remaining };
    if (remaining.isZero()) {
      listingUpdateData.statusId = await getLookupId('listingStatus', 'SOLD');
    }

    await tx.listing.update({ where: { id: listingId }, data: listingUpdateData });

    return tx.order.create({
      data: {
        listingId,
        buyerId: req.user.id,
        farmerId: listing.farmerId,
        quantity: requested,
        unitPrice: listing.price,
        totalPrice,
        deliveryModeId,
        deliveryAddress,
        ...(deliveryLatitude !== undefined && { deliveryLatitude }),
        ...(deliveryLongitude !== undefined && { deliveryLongitude }),
      },
    });
  });

  res.status(201).json(order);
};

// GET /api/orders?status=
export const getMyOrders = async (req, res) => {
  const { status } = req.query;

  const orders = await prisma.order.findMany({
    where: {
      OR: [{ buyerId: req.user.id }, { farmerId: req.user.id }],
      ...(status && { status }),
    },
    include: orderInclude,
    orderBy: { createdAt: 'desc' },
  });

  res.json(orders);
};

// GET /api/orders/:id
export const getOrderById = async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { ...orderInclude, listing: true },
  });

  if (!order) return res.status(404).json({ error: 'Commande introuvable' });
  if (![order.buyerId, order.farmerId].includes(req.user.id)) {
    return res.status(403).json({ error: "Vous n'avez pas accès à cette commande" });
  }

  res.json(order);
};

// PATCH /api/orders/:id/confirm  (agriculteur uniquement, propriétaire)
export const confirmOrder = async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { listing: true, deliveryMode: true },
  });

  if (!order) return res.status(404).json({ error: 'Commande introuvable' });
  if (order.farmerId !== req.user.id) {
    return res.status(403).json({ error: 'Seul le vendeur peut confirmer cette commande' });
  }
  if (order.status !== 'PENDING') {
    return res.status(400).json({ error: 'Seule une commande en attente peut être confirmée' });
  }

  const isDelivery = order.deliveryMode.code === 'DELIVERY';

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
          // Les frais sont un montant : ils sont arrondis au centime avant
          // d'atteindre la colonne DECIMAL, comme tous les autres.
          deliveryFee: asMoney(calculateDeliveryFee(distanceKm)),
        },
      });
    }

    return updatedOrder;
  });

  res.json(updated);
};

// PATCH /api/orders/:id/cancel
export const cancelOrder = async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });

  if (!order) return res.status(404).json({ error: 'Commande introuvable' });
  if (![order.buyerId, order.farmerId].includes(req.user.id)) {
    return res.status(403).json({ error: "Vous n'avez pas accès à cette commande" });
  }
  if (['DELIVERED', 'CANCELLED'].includes(order.status)) {
    return res.status(400).json({ error: 'Cette commande ne peut plus être annulée' });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const cancelled = await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });

    const listing = await tx.listing.findUnique({ where: { id: order.listingId } });
    if (listing) {
      const soldStatusId = await getLookupId('listingStatus', 'SOLD');
      // Stock restitue a l'annulation. Les deux quantites sont des Decimal : on
      //additionne donc avec plus() plutot qu avec l operateur +.
      const listingUpdateData = { quantity: asQuantity(listing.quantity.plus(order.quantity)) };
      if (listing.statusId === soldStatusId) {
        listingUpdateData.statusId = await getLookupId('listingStatus', 'ACTIVE');
      }
      await tx.listing.update({ where: { id: order.listingId }, data: listingUpdateData });
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
};

// PATCH /api/orders/:id/complete  (mode PICKUP uniquement)
export const completeOrder = async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { deliveryMode: true } });

  if (!order) return res.status(404).json({ error: 'Commande introuvable' });
  if (![order.buyerId, order.farmerId].includes(req.user.id)) {
    return res.status(403).json({ error: "Vous n'avez pas accès à cette commande" });
  }
  if (order.deliveryMode.code !== 'PICKUP' || order.status !== 'READY_FOR_PICKUP') {
    return res
      .status(400)
      .json({ error: 'Cette action ne concerne que les commandes en retrait, prêtes à récupérer' });
  }

  const updated = await prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });

  res.json(updated);
};
