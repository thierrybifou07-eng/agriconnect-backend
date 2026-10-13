import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.js';
import { toDecimal, toNumber } from '../utils/money.js';
import { recordAudit } from '../utils/audit.js';
import { haversineDistanceKm } from '../utils/distance.js';
import { findActiveAgencyForZone } from '../services/agency.service.js';
import { computeDeliveryFee, getSettings } from '../services/pricing.service.js';
import { deliveryToStaffDto } from '../utils/dto/delivery.dto.js';

// Résout l'identité de l'acteur pour l'audit (recordAudit attend des objets).
// Un agent connecté a req.agent (requireCapability) ; un admin n'en a pas.
function acteur(req) {
  return {
    actorUser: req.user,
    actorAgent: req.agent ?? null,
  };
}

const ORDER_WITH_ITEMS = {
  items: { include: { lot: { include: { hub: true } }, listing: true } },
  deliveryMode: true,
};

// POST /api/v2/staff/orders/:id/deliveries — création des livraisons.
//
// Une livraison par origine d'enlèvement (hub ou site fournissement) : le
// marchandise part d'un point unique et n'est pas consolidée. Chaque livraison
// fige sa propre tarification (base + km + marge), la valeur assurée (somme des
// lineTotal du groupe) et le numéro de police d'assurance de l'agence.
//
// Idempotence : si des livraisons existent déjà pour cette commande -> 409.
export const createDeliveries = async (req, res) => {
  const result = await prisma.$transaction(async (tx) => {
    // 1. Charge la commande avec ses lignes et ses lots.
    const order = await tx.order.findUnique({
      where: { id: req.params.id },
      include: ORDER_WITH_ITEMS,
    });
    if (!order) {
      throw Object.assign(new Error('Commande introuvable'), {
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
      });
    }

    // 2. Réservé aux commandes AGENCY_DELIVERY en statut PREPARING.
    if (order.deliveryMode.code !== 'AGENCY_DELIVERY') {
      throw Object.assign(
        new Error('La commande doit être en livraison par agence'),
        { statusCode: 409, code: 'INVALID_DELIVERY_MODE' }
      );
    }
    if (order.status !== 'PREPARING') {
      throw Object.assign(
        new Error('La commande doit être en préparation'),
        { statusCode: 409, code: 'INVALID_ORDER_STATUS' }
      );
    }

    // 3. Idempotence : toute livraison existante refuse une seconde création.
    const livraisonsExistantes = await tx.delivery.count({ where: { orderId: order.id } });
    if (livraisonsExistantes > 0) {
      throw Object.assign(
        new Error('Des livraisons existent déjà pour cette commande'),
        { statusCode: 409, code: 'DELIVERIES_ALREADY_CREATED' }
      );
    }

    // 4. Regroupe les lignes par origine d'enlèvement : hub:{hubId} si le lot
    //    est en hub, sinon site:{supplierId}.
    const groupes = new Map();
    for (const item of order.items) {
      const cle = item.lot.storageType === 'HUB' && item.lot.hubId
        ? `hub:${item.lot.hubId}`
        : `site:${item.lot.supplierId}`;
      if (!groupes.has(cle)) groupes.set(cle, []);
      groupes.get(cle).push(item);
    }

    // 5. Agence, tarifs et devise.
    const agency = await findActiveAgencyForZone(order.deliveryZoneId, tx);
    const settings = await getSettings(tx);
    const currency = settings.currency;
    const markupRate = settings.transportMarkupRate;

    const livraisons = [];
    for (const [cle, items] of groupes) {
      const lot = items[0].lot;

      // Point d'enlèvement : hub ou site fournisseur.
      let pickupHubId = null;
      let pickupAddress;
      let pickupLatitude;
      let pickupLongitude;
      if (cle.startsWith('hub:') && lot.hub) {
        pickupHubId = lot.hub.id;
        pickupAddress = lot.hub.address;
        pickupLatitude = lot.hub.latitude;
        pickupLongitude = lot.hub.longitude;
      } else {
        pickupAddress = lot.pickupAddress;
        pickupLatitude = lot.pickupLatitude;
        pickupLongitude = lot.pickupLongitude;
      }

      if (pickupLatitude === null || pickupLatitude === undefined ||
          pickupLongitude === null || pickupLongitude === undefined) {
        throw Object.assign(
          new Error(`Coordonnées d'enlèvement manquantes pour le lot ${lot.id}`),
          { statusCode: 409, code: 'ORIGIN_COORDINATES_MISSING' }
        );
      }

      // Distance et tarification.
      const distanceKm = haversineDistanceKm(
        pickupLatitude,
        pickupLongitude,
        order.deliveryLatitude,
        order.deliveryLongitude
      );
      if (distanceKm === null) {
        throw Object.assign(
          new Error('Coordonnées de livraison manquantes'),
          { statusCode: 409, code: 'DELIVERY_COORDINATES_MISSING' }
        );
      }

      const agencyZone = await tx.agencyZone.findFirst({
        where: { zoneId: order.deliveryZoneId, isActive: true },
      });
      const { agencyCost, deliveryFee } = computeDeliveryFee({
        baseFee: agencyZone.baseFee,
        perKmFee: agencyZone.perKmFee,
        distanceKm,
        markupRate,
      }, currency);

      // Valeur assurée : somme des lineTotal du groupe.
      const insuredValue = items.reduce((acc, item) => acc.add(item.lineTotal), toDecimal(0));

      // Crée la livraison et rattache chaque ligne.
      const livraison = await tx.delivery.create({
        data: {
          orderId: order.id,
          agencyId: agency.id,
          pickupHubId,
          pickupAddress,
          pickupLatitude,
          pickupLongitude,
          dropoffAddress: order.deliveryAddress,
          dropoffLatitude: order.deliveryLatitude,
          dropoffLongitude: order.deliveryLongitude,
          distanceKm,
          agencyCost,
          deliveryFee,
          insuredValue,
          insurancePolicyNumber: agency.insurancePolicyNumber,
        },
      });

      for (const item of items) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: { deliveryId: livraison.id },
        });
      }

      livraisons.push(livraison);
    }

    await recordAudit(tx, {
      ...acteur(req),
      action: 'DELIVERIES_CREATED',
      entityType: 'Order',
      entityId: order.id,
      metadata: {
        deliveries: livraisons.map((l) => ({
          id: l.id,
          agencyId: l.agencyId,
          insuredValue: l.insuredValue.toString(),
          deliveryFee: l.deliveryFee.toString(),
        })),
      },
    });

    return livraisons;
  });

  // Notifier les livreurs de l agence : une course est disponible.
  // L instance Socket.io est attachee a l app Express (server.js). En
  // environnement de test, elle est absente : l emission est silencieuse.
  const io = req.app.get('io');
  if (io) {
    for (const livraison of result) {
      io.to(`agency:${livraison.agencyId}`).emit('delivery:available', {
        deliveryId: livraison.id,
        agencyId: livraison.agencyId,
      });
    }
  }

  res.status(201).json(result.map(deliveryToStaffDto));
};

// GET /api/v2/staff/deliveries — liste paginée avec filtres.
export const listDeliveries = async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.orderId) where.orderId = Number(req.query.orderId);

  const [items, total] = await Promise.all([
    prisma.delivery.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { agency: { select: { id: true, name: true } } },
    }),
    prisma.delivery.count({ where }),
  ]);

  res.json({ items: items.map(deliveryToStaffDto), page, limit, total });
};
