import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.js';
import { toDecimal } from '../utils/money.js';

const Decimal = Prisma.Decimal;

// Somme un tableau de Decimal en restant en Decimal : l'agregat d'une table
// vide renvoie null, et un tableau de bord doit afficher 0, pas null. La
// conversion en nombre pour l'API est faite plus tard par le middleware
// decimal-json.middleware.js.
const sommeDecimal = (valeurs) =>
  valeurs.reduce((acc, valeur) => acc.add(toDecimal(valeur)), new Decimal(0));

// Date ISO de query string -> Date, ou null si absente ou invalide. Une date
// invalide n'est pas bloquante : le filtre de periode est simplement ignore,
// comme les autres filtres de query string du projet (pas de validateur Joi).
const parseDate = (valeur) => {
  if (!valeur) return null;
  const date = new Date(valeur);
  return Number.isNaN(date.getTime()) ? null : date;
};

// Identifiant de query string -> entier positif, ou undefined si invalide.
const parseId = (valeur) => {
  const n = Number(valeur);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

// Filtre de periode [from, to] sur un champ date, a fusionner dans un where
// Prisma. L'absence de borne est frequente (tableau de bord sans periode) :
// la condition n'est ajoutee que si au moins une borne est presente.
const periode = (from, to, champ) =>
  from || to ? { [champ]: { ...(from && { gte: from }), ...(to && { lte: to }) } } : {};

// GET /api/v2/admin/stats?from=&to=
//
// Indicateurs d'exploitation. Tous les calculs sont en Prisma.Decimal : jamais
// de calcul d'argent ou de quantite en Number (regle 5 du preambule).
//
// Seul grossRevenue porte sur la periode [from, to] (date de completion) : les
// autres indicateurs sont des instantanes de l'etat courant de la base.
export const getStats = async (req, res) => {
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);

  const [
    roles,
    utilisateursParRole,
    lotsParStatut,
    commandesParStatut,
    livraisonsParStatut,
    stock,
    commandesCreances,
    reversements,
    indemnisations,
    parrainages,
    commandesCompletees,
  ] = await Promise.all([
    prisma.role.findMany({ select: { id: true, code: true } }),
    prisma.user.groupBy({ by: ['roleId'], _count: { _all: true } }),
    prisma.stockLot.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.delivery.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.stockLot.aggregate({
      _sum: {
        quantityAvailable: true,
        quantityReserved: true,
        quantitySold: true,
        quantityLost: true,
      },
    }),
    // Creances : solde restant du de chaque commande en cours (CONFIRMED a
    // COMPLETED) dont le paiement n'est pas solde : total moins les paiements
    // CONFIRMED. L'ancienne definition (somme des totaux des CONFIRMED non
    // PAID) comptait deux fois une commande payee partiellement et ignorait
    // les commandes en preparation.
    prisma.order.findMany({
      where: {
        status: { in: ['CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED'] },
        paymentStatus: { in: ['UNPAID', 'PARTIALLY_PAID'] },
      },
      select: {
        total: true,
        payments: { where: { status: 'CONFIRMED' }, select: { amount: true } },
      },
    }),
    prisma.supplierPayout.aggregate({
      where: { status: { in: ['READY', 'ON_HOLD'] } },
      _sum: { netAmount: true },
    }),
    prisma.supplierCompensation.aggregate({
      where: { status: 'PENDING_APPROVAL' },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.referral.aggregate({
      where: { status: 'ELIGIBLE' },
      _count: { _all: true },
      _sum: { rewardAmount: true },
    }),
    prisma.order.findMany({
      where: { status: 'COMPLETED', ...periode(from, to, 'completedAt') },
      select: {
        commissionTotal: true,
        buyerFee: true,
        deliveryFee: true,
        // Une commande peut avoir plusieurs livraisons : l'agencyCost n'est pas
        // sur Order mais sur chaque Delivery. Les livraisons CANCELLED sont
        // exclues : une livraison annulee puis recreee (P5.4) ne doit pas
        // compter son cout deux fois.
        deliveries: { where: { status: { not: 'CANCELLED' } }, select: { agencyCost: true } },
      },
    }),
  ]);

  // Repartition par role : tous les roles seedes figurent, meme a zero — un
  // tableau de bord affiche des lignes fixes, pas des trous.
  const usersByRole = Object.fromEntries(roles.map((role) => [role.code, 0]));
  for (const groupe of utilisateursParRole) {
    const role = roles.find((r) => r.id === groupe.roleId);
    if (role) usersByRole[role.code] = groupe._count._all;
  }

  const comptageParStatut = (groupes) =>
    Object.fromEntries(groupes.map((g) => [g.status, g._count._all]));

  // Creances : solde restant du = total - paiements CONFIRMED, commande par
  // commande. Le nombre de commandes concernees est expose a cote du solde :
  // un tableau de bord sert aussi a piloter le nombre de dossiers a relancer.
  let creances = new Decimal(0);
  for (const commande of commandesCreances) {
    const paye = sommeDecimal(commande.payments.map((paiement) => paiement.amount));
    creances = creances.add(toDecimal(commande.total).sub(paye));
  }
  const creancesCount = commandesCreances.length;

  // Revenu brut AgriConnect : commission + frais acheteur + marge de livraison
  // (ce que l'acheteur a paye pour la livraison moins ce que l'agence coute).
  // L'agencyCost n'est pas sur Order mais sur chaque Delivery : une commande
  // peut avoir plusieurs livraisons (une par point d'enlevement).
  const grossRevenue = commandesCompletees.reduce((acc, commande) => {
    const coutsAgence = sommeDecimal(commande.deliveries.map((livraison) => livraison.agencyCost));
    return acc.add(
      toDecimal(commande.commissionTotal)
        .add(toDecimal(commande.buyerFee))
        .add(toDecimal(commande.deliveryFee).sub(coutsAgence))
    );
  }, new Decimal(0));

  res.json({
    usersByRole,
    lotsByStatus: comptageParStatut(lotsParStatut),
    ordersByStatus: comptageParStatut(commandesParStatut),
    deliveriesByStatus: comptageParStatut(livraisonsParStatut),
    stock: {
      available: stock._sum.quantityAvailable ?? new Decimal(0),
      reserved: stock._sum.quantityReserved ?? new Decimal(0),
      sold: stock._sum.quantitySold ?? new Decimal(0),
      lost: stock._sum.quantityLost ?? new Decimal(0),
    },
    receivables: creances,
    receivablesCount: creancesCount,
    pendingPayouts: reversements._sum.netAmount ?? new Decimal(0),
    pendingCompensations: {
      count: indemnisations._count._all,
      amount: indemnisations._sum.amount ?? new Decimal(0),
    },
    eligibleReferrals: {
      count: parrainages._count._all,
      amount: parrainages._sum.rewardAmount ?? new Decimal(0),
    },
    grossRevenue,
  });
};

// GET /api/v2/admin/audit-logs?entityType=&entityId=&actorUserId=&actorAgentId=&from=&to=
//
// Journal d'audit en lecture seule, pagine, ordre antichronologique : l'entree
// la plus recente est celle qu'un administrateur cherche en priorite.
export const listAuditLogs = async (req, res) => {
  const entityType = req.query.entityType;
  const entityId = parseId(req.query.entityId);
  const actorUserId = parseId(req.query.actorUserId);
  const actorAgentId = parseId(req.query.actorAgentId);
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const where = {
    ...(entityType && { entityType }),
    ...(entityId && { entityId }),
    ...(actorUserId && { actorUserId }),
    ...(actorAgentId && { actorAgentId }),
    ...periode(from, to, 'createdAt'),
  };

  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      select: {
        id: true,
        actorUserId: true,
        actorAgentId: true,
        action: true,
        entityType: true,
        entityId: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  res.json({ items, page, limit, total });
};
