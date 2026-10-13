import { randomInt } from 'node:crypto';
import prisma from '../config/prisma.js';
import { getLookupId } from '../utils/lookupCache.js';
import { asMoney, asQuantity, toDecimal } from '../utils/money.js';
import { recordAudit } from '../utils/audit.js';
import { reserve } from '../services/stock.service.js';
import {
  computeLine,
  computeBuyerFee,
  computeDeliveryFee,
  computeOrderTotals,
  getSettings,
} from '../services/pricing.service.js';
import { haversineDistanceKm } from '../utils/distance.js';
import { orderToStaffDto } from '../utils/dto/order.dto.js';
import { confirmerAvecExpiration, cancelOrder, changeStatus } from '../services/order.service.js';

// Résout l'identité de l'acteur pour l'audit (recordAudit attend des objets).
// Un agent connecté a req.agent (requireCapability) ; un admin n'en a pas.
function acteur(req) {
  return {
    actorUser: req.user,
    actorAgent: req.agent ?? null,
  };
}

// Include pour charger une annonce avec son lot unique (MVP : 1 annonce = 1 lot).
const LISTING_WITH_LOT = {
  status: true,
  lots: { include: { lot: { include: { hub: true } } } },
};

// Include pour recharger la commande complète après création (DTO staff).
const ORDER_STAFF_INCLUDE = {
  items: { include: { listing: true } },
  buyer: { select: { id: true, firstname: true, lastname: true } },
  deliveryMode: true,
  pickupHub: true,
};

// POST /api/v2/staff/orders — émission d'un devis.
// Une seule transaction : toute erreur annule tout (rollback complet).
export const createOrder = async (req, res) => {
  const {
    buyerId,
    conversationId,
    items,
    deliveryMode,
    pickupHubId,
    delivery: deliveryInfo,
    notes,
  } = req.body;

  // Livraison : AGENCY_DELIVERY exige delivery (zone, adresse, coordonnées).
  if (deliveryMode === 'AGENCY_DELIVERY' && !deliveryInfo) {
    return res.status(400).json({ error: 'delivery est requis pour AGENCY_DELIVERY' });
  }
  // Retrait : HUB_PICKUP exige pickupHubId.
  if (deliveryMode === 'HUB_PICKUP' && !pickupHubId) {
    return res.status(400).json({ error: 'pickupHubId est requis pour HUB_PICKUP' });
  };

  const result = await prisma.$transaction(async (tx) => {
    // 1. Vérifie l'acheteur : doit exister, être BUYER et actif.
    const buyer = await tx.user.findUnique({
      where: { id: buyerId },
      include: { role: true, userStatus: true },
    });
    if (!buyer) {
      throw Object.assign(new Error('Acheteur introuvable'), { statusCode: 404, code: 'BUYER_NOT_FOUND' });
    }
    if (buyer.role.code !== 'BUYER') {
      throw Object.assign(new Error("L'utilisateur n'est pas un acheteur"), { statusCode: 400, code: 'NOT_A_BUYER' });
    }
    if (buyer.userStatus.code !== 'ACTIVE') {
      throw Object.assign(new Error("Ce compte acheteur n'est pas actif"), { statusCode: 403, code: 'BUYER_NOT_ACTIVE' });
    }

    // Conversation : si fournie, elle doit exister et appartenir à l'acheteur.
    if (conversationId) {
      const conversation = await tx.conversation.findUnique({ where: { id: conversationId } });
      if (!conversation || conversation.customerId !== buyerId) {
        throw Object.assign(new Error('Conversation introuvable'), { statusCode: 404, code: 'CONVERSATION_NOT_FOUND' });
      }
    }

    // Charge chaque annonce ACTIVE avec son lot (un seul par annonce au MVP).
    const listingIds = items.map((i) => i.listingId);
    const listings = await tx.listing.findMany({
      where: { id: { in: listingIds }, status: { code: 'ACTIVE' } },
      include: LISTING_WITH_LOT,
    });
    const listingById = new Map(listings.map((l) => [l.id, l]));
    for (const item of items) {
      const listing = listingById.get(item.listingId);
      if (!listing) {
        throw Object.assign(
          new Error(`Annonce ${item.listingId} introuvable ou non active`),
          { statusCode: 404, code: 'LISTING_NOT_FOUND' }
        );
      }
      const lot = listing.lots?.[0]?.lot;
      if (!lot) {
        throw Object.assign(
          new Error(`Annonce ${item.listingId} sans lot`),
          { statusCode: 409, code: 'LISTING_NO_LOT' }
        );
      }
    }

    // 2. Réserve chaque ligne sur le lot de l'annonce.
    //    INSUFFICIENT_STOCK annule TOUT (rollback transaction).
    const lignes = [];
    for (const item of items) {
      const listing = listingById.get(item.listingId);
      const lot = listing.lots[0].lot;
      const quantity = asQuantity(item.quantity);
      await reserve(tx, lot.id, quantity, {
        actorUserId: req.user.id,
        actorAgentId: req.agent?.id ?? null,
      });
      lignes.push({ listing, lot, quantity, requestedUnitPrice: item.unitPrice });
    }

    // 3. Prix figés : unitPrice = prix de l'annonce (ou surcharge), supplierUnitPrice = prix convenu du lot.
    const settings = await getSettings(tx);
    const commissionRate = settings.supplierCommissionRate;
    const currency = settings.currency;

    const lignesCalculees = lignes.map(({ listing, lot, quantity, requestedUnitPrice }) => {
      const unitPrice = asMoney(requestedUnitPrice ?? listing.unitPrice);
      const supplierUnitPrice = lot.agreedUnitPrice;
      const calc = computeLine({ quantity, unitPrice, supplierUnitPrice, commissionRate }, currency);
      return { listing, lot, quantity, unitPrice, supplierUnitPrice, ...calc };
    });

    // 4. Frais de livraison (AGENCY_DELIVERY).
    let deliveryFeeTotal = toDecimal(0);
    let origins = [];
    if (deliveryMode === 'AGENCY_DELIVERY') {
      // Trouve l'AgencyZone active pour la zone de livraison.
      const agencyZone = await tx.agencyZone.findFirst({
        where: { zoneId: deliveryInfo.zoneId, isActive: true },
        include: { agency: true },
      });
      if (!agencyZone) {
        throw Object.assign(new Error('Zone non couverte'), { statusCode: 409, code: 'ZONE_NOT_COVERED' });
      }

      // Origines d'enlèvement DISTINCTES : hub ou site fournisseur.
      const originesMap = new Map();
      for (const { lot } of lignesCalculees) {
        const cle = lot.storageType === 'HUB' && lot.hubId ? `hub:${lot.hubId}` : `site:${lot.supplierId}`;
        if (!originesMap.has(cle)) {
          originesMap.set(cle, { lot });
        }
      }

      for (const { lot } of originesMap.values()) {
        let originLat, originLon, originAddress, hubId = null, hubName = null, type;
        if (lot.storageType === 'HUB' && lot.hubId) {
          const hub = lot.hub;
          originLat = hub.latitude;
          originLon = hub.longitude;
          originAddress = hub.address;
          hubId = hub.id;
          hubName = hub.name;
          type = 'HUB';
        } else {
          originLat = lot.pickupLatitude;
          originLon = lot.pickupLongitude;
          originAddress = lot.pickupAddress;
          type = 'SUPPLIER_SITE';
        }

        if (originLat === null || originLat === undefined || originLon === null || originLon === undefined) {
          throw Object.assign(
            new Error(`Coordonnées d'enlèvement manquantes pour le lot ${lot.id}`),
            { statusCode: 409, code: 'ORIGIN_COORDINATES_MISSING' }
          );
        }

        const distanceKm = haversineDistanceKm(
          originLat,
          originLon,
          deliveryInfo.latitude,
          deliveryInfo.longitude
        );
        if (distanceKm === null) {
          throw Object.assign(
            new Error('Coordonnées de livraison manquantes'),
            { statusCode: 409, code: 'DELIVERY_COORDINATES_MISSING' }
          );
        }

        const { agencyCost, deliveryFee } = computeDeliveryFee({
          baseFee: agencyZone.baseFee,
          perKmFee: agencyZone.perKmFee,
          distanceKm,
          markupRate: settings.transportMarkupRate,
        }, currency);

        deliveryFeeTotal = deliveryFeeTotal.add(deliveryFee);
        origins.push({
          type,
          hubId,
          hubName,
          address: originAddress,
          latitude: originLat,
          longitude: originLon,
          distanceKm,
          agencyCost,
          deliveryFee,
        });
      }
    }

    // 5. Retrait HUB_PICKUP : le hub doit être actif et accepter le retrait.
    let pickupHub = null;
    if (deliveryMode === 'HUB_PICKUP') {
      pickupHub = await tx.hub.findUnique({ where: { id: pickupHubId } });
      if (!pickupHub || !pickupHub.isActive) {
        throw Object.assign(new Error('Point de dépôt introuvable ou inactif'), { statusCode: 400, code: 'HUB_NOT_FOUND' });
      }
      if (!pickupHub.acceptsPickup) {
        throw Object.assign(new Error("Ce point de dépôt n'accepte pas le retrait"), { statusCode: 400, code: 'HUB_NO_PICKUP' });
      }
    }

    // 6. Frais acheteur et totaux.
    const subtotal = lignesCalculees.reduce((acc, l) => acc.add(l.lineTotal), toDecimal(0));
    const buyerFee = computeBuyerFee(subtotal, { type: settings.buyerFeeType, value: settings.buyerFeeValue }, currency);
    const totaux = computeOrderTotals({ lines: lignesCalculees, buyerFee, deliveryFee: deliveryFeeTotal });

    // 7. Crée la commande puis les lignes, puis l'audit.
    const deliveryModeId = await getLookupId('deliveryMode', deliveryMode);
    const maintenant = new Date();
    const reservedUntil = new Date(maintenant.getTime() + settings.reservationHours * 3600 * 1000);

    const orderCreated = await tx.order.create({
      data: {
        orderNumber: `AC-TMP-${Date.now()}-${randomInt(0, 1_000_000)}`,
        buyerId,
        handledByAgentId: req.agent?.id ?? null,
        conversationId: conversationId ?? null,
        deliveryModeId,
        pickupHubId: deliveryMode === 'HUB_PICKUP' ? pickupHubId : null,
        deliveryZoneId: deliveryMode === 'AGENCY_DELIVERY' ? deliveryInfo.zoneId : null,
        deliveryAddress: deliveryMode === 'AGENCY_DELIVERY' ? deliveryInfo.address : null,
        deliveryLatitude: deliveryMode === 'AGENCY_DELIVERY' ? deliveryInfo.latitude : null,
        deliveryLongitude: deliveryMode === 'AGENCY_DELIVERY' ? deliveryInfo.longitude : null,
        reservedUntil,
        subtotal: totaux.subtotal,
        buyerFee: totaux.buyerFee,
        deliveryFee: totaux.deliveryFee,
        total: totaux.total,
        commissionTotal: totaux.commissionTotal,
        notes: notes ?? null,
      },
    });

    // orderNumber = `AC-${année}-` + id sur 6 chiffres.
    const orderNumber = `AC-${maintenant.getFullYear()}-${String(orderCreated.id).padStart(6, '0')}`;
    await tx.order.update({
      where: { id: orderCreated.id },
      data: { orderNumber },
    });

    // Crée les OrderItem (listingId ET lotId renseignés).
    for (const l of lignesCalculees) {
      await tx.orderItem.create({
        data: {
          orderId: orderCreated.id,
          listingId: l.listing.id,
          lotId: l.lot.id,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          supplierUnitPrice: l.supplierUnitPrice,
          lineTotal: l.lineTotal,
          commissionRate,
          commissionAmount: l.commissionAmount,
          supplierNetAmount: l.supplierNetAmount,
        },
      });
    }

    await recordAudit(tx, {
      ...acteur(req),
      action: 'ORDER_QUOTED',
      entityType: 'Order',
      entityId: orderCreated.id,
    });

    return { id: orderCreated.id, origins };
  });

  // Recharge la commande complète pour le DTO staff.
  const complet = await prisma.order.findUnique({
    where: { id: result.id },
    include: ORDER_STAFF_INCLUDE,
  });
  complet.origins = result.origins;

  res.status(201).json(orderToStaffDto(complet));
};

// Recharge la commande complete pour le DTO staff (apres une mutation).
async function rechargerCommande(orderId) {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: ORDER_STAFF_INCLUDE,
  });
}

// GET /api/v2/staff/orders — toutes les commandes, paginees.
export const listOrders = async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const [items, total] = await Promise.all([
    prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: ORDER_STAFF_INCLUDE,
    }),
    prisma.order.count(),
  ]);
  res.json({ items: items.map(orderToStaffDto), page, limit, total });
};

// GET /api/v2/staff/orders/:id — le detail d'une commande (toutes les
// donnees internes : lots, commission, origines, acheteur).
export const getOrder = async (req, res) => {
  const commande = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: ORDER_STAFF_INCLUDE,
  });
  if (!commande) {
    return res.status(404).json({ error: 'Commande introuvable' });
  }
  res.json(orderToStaffDto(commande));
};

// PATCH /api/v2/staff/orders/:id/status — changement de statut manuel.
// La machine a etats (order.state.js) refuse les transitions interdites ;
// PREPARING sans paiement exige force: true, reserve aux administrateurs.
export const changeOrderStatus = async (req, res) => {
  const { status, force } = req.body;
  await prisma.$transaction((tx) =>
    changeStatus(tx, req.params.id, status, acteur(req), { force: force === true })
  );
  res.json(orderToStaffDto(await rechargerCommande(req.params.id)));
};

// POST /api/v2/staff/orders/:id/confirm — confirmation d'un devis par
// l'equipe (memes regles que la confirmation acheteur, y compris
// l'expiration : le devis expire repond 409 et son stock est libere).
export const confirmOrderByStaff = async (req, res) => {
  await confirmerAvecExpiration(prisma, req.params.id, acteur(req));
  res.json(orderToStaffDto(await rechargerCommande(req.params.id)));
};

// POST /api/v2/staff/orders/:id/cancel — annulation par l'equipe. Le staff
// peut annuler une commande CONFIRMED ou PREPARING, pas seulement un devis :
// la machine a etats applique les transitions autorisees.
export const cancelOrderByStaff = async (req, res) => {
  const raison = req.body?.reason ?? null;
  await prisma.$transaction((tx) => cancelOrder(tx, req.params.id, acteur(req), raison));
  res.json(orderToStaffDto(await rechargerCommande(req.params.id)));
};
