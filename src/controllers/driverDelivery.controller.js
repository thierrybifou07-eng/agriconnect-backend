import prisma from '../config/prisma.js';
import { assertTransition } from '../services/delivery.state.js';
import { assertTransition as assertOrderTransition } from '../services/order.state.js';
import { completeOrder } from '../services/order.service.js';
import { deliveryToDriverDto } from '../utils/dto/delivery.dto.js';

// Dispatch du livreur (plan v2, P5.3) : le livreur choisit ses courses
// (modele "pull"), acceptation atomique.
//
// Un livreur ne voit que les livraisons de son agence, et uniquement les
// courses disponibles (PENDING sans livreur) ou les siennes. Le DTO livreur
// ne contient JAMAIS de prix ni de montant.

// Include complet pour le DTO livreur : commande, acheteur, items, lots, produits.
const INCLUDE_POUR_LIVREUR = {
  order: {
    include: {
      buyer: { select: { firstname: true, lastname: true, phone: true } },
      items: {
        include: {
          lot: {
            include: {
              product: { include: { category: { select: { label: true } } } },
            },
          },
        },
      },
    },
  },
};

// Charge le DriverProfile de l'utilisateur connecte. Un compte DRIVER sans
// profil ne peut pas accepter de courses.
async function chargerDriver(userId) {
  const driver = await prisma.driverProfile.findUnique({ where: { userId } });
  if (!driver) {
    throw Object.assign(new Error('Profil livreur introuvable'), {
      statusCode: 403,
      code: 'NO_DRIVER_PROFILE',
    });
  }
  return driver;
}

// GET /api/v2/driver/deliveries/available — livraisons PENDING sans livreur,
// de l'agence du livreur, paginees.
export const listAvailable = async (req, res) => {
  const driver = await chargerDriver(req.user.id);

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const where = {
    status: 'PENDING',
    driverId: null,
    agencyId: driver.agencyId,
  };

  const [items, total] = await Promise.all([
    prisma.delivery.findMany({
      where,
      include: INCLUDE_POUR_LIVREUR,
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.delivery.count({ where }),
  ]);

  res.json({ items: items.map(deliveryToDriverDto), page, limit, total });
};

// GET /api/v2/driver/deliveries/mine?status= — livraisons du livreur.
export const listMine = async (req, res) => {
  const driver = await chargerDriver(req.user.id);

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const where = { driverId: driver.id };
  if (req.query.status) where.status = req.query.status;

  const [items, total] = await Promise.all([
    prisma.delivery.findMany({
      where,
      include: INCLUDE_POUR_LIVREUR,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.delivery.count({ where }),
  ]);

  res.json({ items: items.map(deliveryToDriverDto), page, limit, total });
};

// POST /api/v2/driver/deliveries/:id/accept — acceptation atomique.
//
// Un livreur qui a deja une livraison ACCEPTED, PICKED_UP ou IN_TRANSIT ne
// peut pas en accepter une seconde. L'acceptation est atomique : un seul
// updateMany conditionnel, count 0 -> 409.
export const acceptDelivery = async (req, res) => {
  const driver = await chargerDriver(req.user.id);
  const livraisonId = req.params.id;

  const livraison = await prisma.$transaction(async (tx) => {
    // 1. Le livreur ne peut avoir qu'une seule course en cours.
    const enCours = await tx.delivery.findFirst({
      where: {
        driverId: driver.id,
        status: { in: ['ACCEPTED', 'PICKED_UP', 'IN_TRANSIT'] },
      },
    });
    if (enCours) {
      throw Object.assign(new Error('Vous avez déjà une livraison en cours'), {
        statusCode: 409,
        code: 'DELIVERY_ALREADY_ACTIVE',
      });
    }

    // 2. Acceptation atomique : un seul updateMany conditionnel.
    const { count } = await tx.delivery.updateMany({
      where: {
        id: livraisonId,
        status: 'PENDING',
        driverId: null,
        agencyId: driver.agencyId,
      },
      data: {
        driverId: driver.id,
        status: 'ACCEPTED',
        acceptedAt: new Date(),
      },
    });

    if (count === 0) {
      throw Object.assign(new Error('Course déjà prise'), {
        statusCode: 409,
        code: 'DELIVERY_ALREADY_TAKEN',
      });
    }

    return tx.delivery.findUnique({ where: { id: livraisonId }, include: INCLUDE_POUR_LIVREUR });
  });

  res.status(200).json(deliveryToDriverDto(livraison));
};

// PATCH /api/v2/driver/deliveries/:id/status — changement de statut par le
// proprietaire. pickedUpAt et deliveredAt sont renseignes automatiquement.
// La commande est synchronisee dans la meme transaction.
export const updateDeliveryStatus = async (req, res) => {
  const driver = await chargerDriver(req.user.id);
  const livraisonId = req.params.id;
  const { status, failureReason } = req.body;

  const livraison = await prisma.$transaction(async (tx) => {
    const livraison = await tx.delivery.findUnique({
      where: { id: livraisonId },
      include: { order: { select: { buyerId: true, status: true } } },
    });
    if (!livraison) {
      throw Object.assign(new Error('Livraison introuvable'), {
        statusCode: 404,
        code: 'DELIVERY_NOT_FOUND',
      });
    }

    // Proprietaire seulement.
    if (livraison.driverId !== driver.id) {
      throw Object.assign(new Error('Cette livraison ne vous appartient pas'), {
        statusCode: 403,
        code: 'NOT_DELIVERY_OWNER',
      });
    }

    // Transition valide.
    assertTransition(livraison.status, status);

    // Mise a jour avec dates automatiques.
    const update = { status };
    if (status === 'PICKED_UP') update.pickedUpAt = new Date();
    if (status === 'DELIVERED') update.deliveredAt = new Date();
    if (status === 'FAILED') update.failureReason = failureReason;

    await tx.delivery.update({ where: { id: livraisonId }, data: update });

    // Synchronisation de la commande dans la meme transaction.
    if (status === 'PICKED_UP') {
      // Premier PICKED_UP -> commande OUT_FOR_DELIVERY.
      assertOrderTransition(livraison.order.status, 'OUT_FOR_DELIVERY');
      await tx.order.update({
        where: { id: livraison.orderId },
        data: { status: 'OUT_FOR_DELIVERY' },
      });
    }

    if (status === 'DELIVERED') {
      // Toutes les livraisons DELIVERED -> completeOrder (vente validee,
      // reversements prets via refreshPayoutReadiness).
      const toutesLivraisons = await tx.delivery.findMany({
        where: { orderId: livraison.orderId },
        select: { status: true },
      });
      if (toutesLivraisons.every((d) => d.status === 'DELIVERED')) {
        await completeOrder(tx, livraison.orderId, { actorUser: req.user });
      }
    }

    return tx.delivery.findUnique({ where: { id: livraisonId }, include: INCLUDE_POUR_LIVREUR });
  });

  // Socket delivery:status vers staff et acheteur (payload sans prix).
  const io = req.app.get('io');
  if (io) {
    const payload = { deliveryId: livraison.id, status: livraison.status };
    io.to('staff').emit('delivery:status', payload);
    io.to(`user:${livraison.order.buyerId}`).emit('delivery:status', payload);
  }

  res.status(200).json(deliveryToDriverDto(livraison));
};
