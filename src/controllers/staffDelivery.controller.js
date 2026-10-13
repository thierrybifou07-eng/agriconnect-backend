import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.js';
import { toDecimal, toNumber } from '../utils/money.js';
import { recordAudit } from '../utils/audit.js';
import { findActiveAgencyForZone } from '../services/agency.service.js';
import { getSettings } from '../services/pricing.service.js';
import {
  cleOrigine,
  pointEnlevement,
  distanceOrigine,
  tarifOrigine,
} from '../services/delivery.pricing.js';
import { deliveryToStaffDto } from '../utils/dto/delivery.dto.js';
import { assertTransition } from '../services/delivery.state.js';

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

    // 3. Idempotence : le refus ne s'applique que s'il existe au moins une
    //    livraison NON annulée. Des livraisons annulées ne bloquent pas une
    //    nouvelle création : l'équipe doit pouvoir reprendre une commande
    //    dont toutes les courses ont été annulées.
    const livraisonsActives = await tx.delivery.count({
      where: { orderId: order.id, status: { not: 'CANCELLED' } },
    });
    if (livraisonsActives > 0) {
      throw Object.assign(
        new Error('Des livraisons existent déjà pour cette commande'),
        { statusCode: 409, code: 'DELIVERIES_ALREADY_CREATED' }
      );
    }

    // 4. Regroupe les lignes par origine d'enlèvement : hub:{hubId} si le lot
    //    est en hub, sinon site:{supplierId}.
    const groupes = new Map();
    for (const item of order.items) {
      const cle = cleOrigine(item.lot);
      if (!groupes.has(cle)) groupes.set(cle, []);
      groupes.get(cle).push(item);
    }

    // 5. Agence, tarifs et devise.
    const agency = await findActiveAgencyForZone(order.deliveryZoneId, tx);
    const settings = await getSettings(tx);
    const currency = settings.currency;
    const markupRate = settings.transportMarkupRate;

    const livraisons = [];
    for (const items of groupes.values()) {
      const lot = items[0].lot;

      // Point d'enlèvement, distance et tarification : delivery.pricing.js,
      // la même logique que le devis (staffOrder.controller.js). Le point de
      // livraison vit sur la commande (deliveryLatitude/Longitude), pas sur
      // le corps de requête comme au devis.
      const point = pointEnlevement(lot);
      const distanceKm = distanceOrigine(lot, {
        latitude: order.deliveryLatitude,
        longitude: order.deliveryLongitude,
      });
      const agencyZone = await tx.agencyZone.findFirst({
        where: { zoneId: order.deliveryZoneId, isActive: true },
      });
      const { agencyCost, deliveryFee } = tarifOrigine({ agencyZone, distanceKm, markupRate, currency });

      // Valeur assurée : somme des lineTotal du groupe.
      const insuredValue = items.reduce((acc, item) => acc.add(item.lineTotal), toDecimal(0));

      // Crée la livraison et rattache chaque ligne.
      const livraison = await tx.delivery.create({
        data: {
          orderId: order.id,
          agencyId: agency.id,
          pickupHubId: point.hubId,
          pickupAddress: point.address,
          pickupLatitude: point.latitude,
          pickupLongitude: point.longitude,
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

// Include minimal pour les actions staff : l'acheteur sert à l'émission
// socket delivery:status (le staff suit la course, l'acheteur est informé).
const INCLUDE_POUR_ACTION = {
  order: { select: { buyerId: true } },
};

// Emet delivery:status vers le staff et l'acheteur (payload sans prix,
// comme en P5.3) : toute action staff sur une course est un changement de
// statut comme les autres.
function emettreStatut(req, livraison) {
  const io = req.app.get('io');
  if (!io) return;
  const payload = { deliveryId: livraison.id, status: livraison.status };
  io.to('staff').emit('delivery:status', payload);
  io.to(`user:${livraison.order.buyerId}`).emit('delivery:status', payload);
}

// Emet delivery:available vers la salle de l'agence : la course est de
// nouveau dans le pool, n'importe quel livreur de l'agence peut la prendre.
function emettreDisponible(req, livraison) {
  const io = req.app.get('io');
  if (!io) return;
  io.to(`agency:${livraison.agencyId}`).emit('delivery:available', {
    deliveryId: livraison.id,
    agencyId: livraison.agencyId,
  });
}

// Charge la livraison ou lève 404 DELIVERY_NOT_FOUND.
async function chargerLivraison(tx, id) {
  const livraison = await tx.delivery.findUnique({
    where: { id },
    include: INCLUDE_POUR_ACTION,
  });
  if (!livraison) {
    throw Object.assign(new Error('Livraison introuvable'), {
      statusCode: 404,
      code: 'DELIVERY_NOT_FOUND',
    });
  }
  return livraison;
}

// POST /api/v2/staff/deliveries/:id/release — libère une course acceptée.
//
// Un livreur accepte une course puis ne se présente pas : sans cette action,
// la course reste bloquée à vie en ACCEPTED. La release remet la course dans
// la salle de l'agence (PENDING, driverId et acceptedAt à nul) : n'importe
// quel livreur de l'agence peut alors l'accepter.
export const releaseDelivery = async (req, res) => {
  const livraison = await prisma.$transaction(async (tx) => {
    const livraison = await chargerLivraison(tx, req.params.id);

    // ACCEPTED seulement : libérer une course PENDING n'a pas de sens, et
    // une course FAILED a sa propre voie de sortie (redispatch).
    assertTransition(livraison.status, 'PENDING');

    await tx.delivery.update({
      where: { id: livraison.id },
      data: { status: 'PENDING', driverId: null, acceptedAt: null },
    });

    await recordAudit(tx, {
      ...acteur(req),
      action: 'DELIVERY_RELEASED',
      entityType: 'Delivery',
      entityId: livraison.id,
      ...(req.body.reason ? { metadata: { reason: req.body.reason } } : {}),
    });

    return tx.delivery.findUnique({
      where: { id: livraison.id },
      include: INCLUDE_POUR_ACTION,
    });
  });

  emettreDisponible(req, livraison);
  emettreStatut(req, livraison);

  res.status(200).json(deliveryToStaffDto(livraison));
};

// POST /api/v2/staff/deliveries/:id/redispatch — remet une course échouée
// dans la salle de l'agence.
//
// Une course FAILED est bloquée : le livreur ne peut pas la reprendre. Le
// staff la remet à PENDING (driverId et acceptedAt à nul) : un autre
// livreur peut l'accepter. L'ancien motif d'échec est copié dans
// incidentNote avant d'être effacé : l'historique de pourquoi cette course
// a échoué ne doit pas disparaître avec le statut.
export const redispatchDelivery = async (req, res) => {
  const livraison = await prisma.$transaction(async (tx) => {
    const livraison = await chargerLivraison(tx, req.params.id);

    // FAILED seulement : redispatch d'une course PENDING ou ACCEPTED n'a
    // pas de sens (release existe pour ACCEPTED).
    assertTransition(livraison.status, 'PENDING');

    await tx.delivery.update({
      where: { id: livraison.id },
      data: {
        status: 'PENDING',
        driverId: null,
        acceptedAt: null,
        failureReason: null,
        incidentNote: livraison.failureReason,
      },
    });

    await recordAudit(tx, {
      ...acteur(req),
      action: 'DELIVERY_REDISPATCHED',
      entityType: 'Delivery',
      entityId: livraison.id,
      metadata: { previousFailureReason: livraison.failureReason },
    });

    return tx.delivery.findUnique({
      where: { id: livraison.id },
      include: INCLUDE_POUR_ACTION,
    });
  });

  emettreDisponible(req, livraison);
  emettreStatut(req, livraison);

  res.status(200).json(deliveryToStaffDto(livraison));
};

// POST /api/v2/staff/deliveries/:id/cancel — annule une course bloquée.
//
// PENDING, ACCEPTED ou FAILED -> CANCELLED. PICKED_UP et IN_TRANSIT ne
// sont pas annulables (409 INVALID_STATE_TRANSITION) : la marchandise est
// déjà en mouvement, seule la déclaration FAILED est possible.
//
// Si toutes les livraisons de la commande sont alors CANCELLED, les lignes
// sont détachées (OrderItem.deliveryId à nul) : l'équipe peut recréer des
// livraisons, l'idempotence ne bloquant que sur une livraison non annulée.
export const cancelDelivery = async (req, res) => {
  const { reason } = req.body;

  const livraison = await prisma.$transaction(async (tx) => {
    const livraison = await chargerLivraison(tx, req.params.id);

    assertTransition(livraison.status, 'CANCELLED');

    await tx.delivery.update({
      where: { id: livraison.id },
      data: { status: 'CANCELLED' },
    });

    // Annulation totale seulement : tant qu'une livraison de la commande
    // est active, les lignes restent rattachées (annulation partielle).
    const livraisonsActives = await tx.delivery.count({
      where: { orderId: livraison.orderId, status: { not: 'CANCELLED' } },
    });
    if (livraisonsActives === 0) {
      await tx.orderItem.updateMany({
        where: { orderId: livraison.orderId },
        data: { deliveryId: null },
      });
    }

    await recordAudit(tx, {
      ...acteur(req),
      action: 'DELIVERY_CANCELLED',
      entityType: 'Delivery',
      entityId: livraison.id,
      metadata: { reason },
    });

    return tx.delivery.findUnique({
      where: { id: livraison.id },
      include: INCLUDE_POUR_ACTION,
    });
  });

  emettreStatut(req, livraison);

  res.status(200).json(deliveryToStaffDto(livraison));
};
