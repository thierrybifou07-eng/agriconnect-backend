const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { haversineDistanceKm } = require('../utils/distance');

const ACTIVE_DELIVERY_STATUSES = ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'];

// GET /api/deliveries/available  (livreur uniquement)
// Liste les livraisons non assignées, triées par proximité si la position du livreur est connue.
// Pas d'assignation automatique : le livreur choisit lui-même (mode pull, cf. décision sur les quotas).
const getAvailableDeliveries = asyncHandler(async (req, res) => {
  const deliveries = await prisma.delivery.findMany({
    where: { status: 'PENDING', driverId: null },
    include: {
      order: {
        include: {
          listing: { select: { id: true, title: true, category: true } },
          farmer: { select: { id: true, fullName: true, phone: true, location: true } },
          buyer: { select: { id: true, fullName: true, phone: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const withDistance = deliveries.map((d) => ({
    ...d,
    distanceFromDriverKm: haversineDistanceKm(
      req.user.latitude,
      req.user.longitude,
      d.pickupLatitude,
      d.pickupLongitude
    ),
  }));

  if (req.user.latitude != null && req.user.longitude != null) {
    withDistance.sort((a, b) => (a.distanceFromDriverKm ?? Infinity) - (b.distanceFromDriverKm ?? Infinity));
  }

  res.json(withDistance);
});

// GET /api/deliveries/mine  (livreur uniquement)
const getMyDeliveries = asyncHandler(async (req, res) => {
  const deliveries = await prisma.delivery.findMany({
    where: { driverId: req.user.id },
    include: {
      order: {
        include: {
          listing: { select: { id: true, title: true } },
          farmer: { select: { id: true, fullName: true, phone: true } },
          buyer: { select: { id: true, fullName: true, phone: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json(deliveries);
});

// POST /api/deliveries/:id/accept  (livreur uniquement)
// Vérifie que le livreur est disponible ET n'a pas déjà une course active, puis réclame la
// livraison de façon atomique (le premier arrivé la remporte) et se marque indisponible.
const acceptDelivery = asyncHandler(async (req, res) => {
  if (!req.user.isAvailable) {
    return res.status(400).json({ error: "Passez votre statut en disponible avant d'accepter une livraison" });
  }

  const ongoing = await prisma.delivery.findFirst({
    where: { driverId: req.user.id, status: { in: ACTIVE_DELIVERY_STATUSES } },
  });
  if (ongoing) {
    return res.status(400).json({ error: 'Vous avez déjà une livraison en cours' });
  }

  const delivery = await prisma.$transaction(async (tx) => {
    const result = await tx.delivery.updateMany({
      where: { id: req.params.id, status: 'PENDING', driverId: null },
      data: { driverId: req.user.id, status: 'ASSIGNED', assignedAt: new Date() },
    });

    if (result.count === 0) {
      throw Object.assign(new Error('Cette livraison a déjà été prise en charge par un autre livreur'), {
        statusCode: 409,
      });
    }

    await tx.user.update({ where: { id: req.user.id }, data: { isAvailable: false } });

    return tx.delivery.findUnique({ where: { id: req.params.id } });
  });

  res.json(delivery);
});

// PATCH /api/deliveries/:id/status  (livreur uniquement, assigné)  body: { status }
const VALID_TRANSITIONS = {
  ASSIGNED: ['PICKED_UP'],
  PICKED_UP: ['IN_TRANSIT'],
  IN_TRANSIT: ['DELIVERED'],
};

const updateDeliveryStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;

  const delivery = await prisma.delivery.findUnique({ where: { id: req.params.id } });
  if (!delivery) return res.status(404).json({ error: 'Livraison introuvable' });
  if (delivery.driverId !== req.user.id) {
    return res.status(403).json({ error: "Vous n'êtes pas assigné à cette livraison" });
  }

  const allowedNext = VALID_TRANSITIONS[delivery.status] || [];
  if (!allowedNext.includes(status)) {
    return res.status(400).json({ error: `Transition invalide: ${delivery.status} -> ${status}` });
  }

  const timestampField = status === 'PICKED_UP' ? 'pickedUpAt' : status === 'DELIVERED' ? 'deliveredAt' : null;

  const updated = await prisma.$transaction(async (tx) => {
    const updatedDelivery = await tx.delivery.update({
      where: { id: req.params.id },
      data: {
        status,
        ...(timestampField && { [timestampField]: new Date() }),
      },
    });

    if (status === 'DELIVERED') {
      await tx.order.update({ where: { id: delivery.orderId }, data: { status: 'DELIVERED' } });
      // Le livreur redevient disponible pour une prochaine course
      await tx.user.update({ where: { id: req.user.id }, data: { isAvailable: true } });
    }

    return updatedDelivery;
  });

  res.json(updated);
});

module.exports = { getAvailableDeliveries, getMyDeliveries, acceptDelivery, updateDeliveryStatus };
