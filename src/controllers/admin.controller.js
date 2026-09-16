import bcrypt from 'bcrypt';
import prisma from '../config/prisma.js';
import { getLookupId } from '../utils/lookupCache.js';
import { sendMail } from '../utils/sendMail.js';

const userSafeSelect = {
  id: true,
  fullName: true,
  phone: true,
  email: true,
  role: { select: { code: true, label: true, level: true } },
  userStatus: { select: { code: true, label: true } },
  location: true,
  isAvailable: true,
  vehicleType: true,
  createdAt: true,
};

// GET /api/admin/users?role=&search=&status=
// Note MySQL : pas de "mode: insensitive" (non supporté par ce connecteur Prisma).
export const listUsers = async (req, res) => {
  const { role, search, status } = req.query;

  const users = await prisma.user.findMany({
    where: {
      ...(role && { role: { code: role } }),
      ...(status && { userStatus: { code: status } }),
      ...(search && {
        OR: [{ fullName: { contains: search } }, { phone: { contains: search } }],
      }),
    },
    select: userSafeSelect,
    orderBy: { createdAt: 'desc' },
  });

  res.json(users);
};

// PATCH /api/admin/users/:id/suspend
export const suspendUser = async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id }, include: { role: true } });
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });

  if (target.role.code === 'ROOT') {
    return res.status(403).json({ error: 'Le compte ROOT ne peut pas être suspendu' });
  }
  if (target.role.level >= 50 && req.user.role.code !== 'ROOT') {
    return res.status(403).json({ error: 'Seul ROOT peut suspendre un compte administrateur' });
  }

  const suspendedStatusId = await getLookupId('userStatus', 'SUSPENDED');

  const updated = await prisma.user.update({
    where: { id: req.params.id },
    data: { userStatusId: suspendedStatusId },
    select: userSafeSelect,
  });

  res.json(updated);
};

// PATCH /api/admin/users/:id/reactivate
export const reactivateUser = async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id }, include: { role: true } });
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });

  if (target.role.level >= 50 && req.user.role.code !== 'ROOT') {
    return res.status(403).json({ error: 'Seul ROOT peut réactiver un compte administrateur' });
  }

  const activeStatusId = await getLookupId('userStatus', 'ACTIVE');

  const updated = await prisma.user.update({
    where: { id: req.params.id },
    data: { userStatusId: activeStatusId },
    select: userSafeSelect,
  });

  res.json(updated);
};

// POST /api/admin/users  (ROOT uniquement)
export const createAdmin = async (req, res) => {
  const { fullName, phone, email, password } = req.body;

  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    return res.status(409).json({ error: 'Un compte existe déjà avec ce numéro' });
  }

  const [roleId, userStatusId] = await Promise.all([
    getLookupId('role', 'ADMIN'),
    getLookupId('userStatus', 'ACTIVE'),
  ]);

  const hashedPassword = await bcrypt.hash(password, 10);

  const admin = await prisma.user.create({
    data: { fullName, phone, email, password: hashedPassword, roleId, userStatusId },
    select: userSafeSelect,
  });

  // Non-bloquant, et sans jamais inclure le mot de passe dans l'email
  if (admin.email) {
    sendMail({
      to: admin.email,
      subject: 'Votre compte administrateur AgriConnect',
      template: 'welcome',
      data: { fullName: admin.fullName, roleLabel: 'Administrateur' },
    }).catch((err) => console.error('Email admin non envoyé:', err.message));
  }

  res.status(201).json(admin);
};

// PATCH /api/admin/listings/:id/deactivate
export const deactivateListing = async (req, res) => {
  const listing = await prisma.listing.findUnique({ where: { id: req.params.id } });
  if (!listing) return res.status(404).json({ error: 'Annonce introuvable' });

  const inactiveStatusId = await getLookupId('listingStatus', 'INACTIVE');

  const updated = await prisma.listing.update({
    where: { id: req.params.id },
    data: { statusId: inactiveStatusId },
  });

  res.json(updated);
};

// GET /api/admin/orders?status=
export const getAllOrders = async (req, res) => {
  const { status } = req.query;

  const orders = await prisma.order.findMany({
    where: { ...(status && { status }) },
    include: {
      listing: { select: { id: true, title: true } },
      buyer: { select: { id: true, fullName: true, phone: true } },
      farmer: { select: { id: true, fullName: true, phone: true } },
      deliveryMode: true,
      delivery: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json(orders);
};

// GET /api/admin/stats
export const getStats = async (req, res) => {
  const [usersByRole, listingsByStatus, ordersByStatus, deliveriesByStatus] = await Promise.all([
    prisma.user.groupBy({ by: ['roleId'], _count: true }),
    prisma.listing.groupBy({ by: ['statusId'], _count: true }),
    prisma.order.groupBy({ by: ['status'], _count: true }),
    prisma.delivery.groupBy({ by: ['status'], _count: true }),
  ]);

  const [roles, listingStatuses] = await Promise.all([prisma.role.findMany(), prisma.listingStatus.findMany()]);
  const roleCodeById = Object.fromEntries(roles.map((r) => [r.id, r.code]));
  const listingStatusCodeById = Object.fromEntries(listingStatuses.map((s) => [s.id, s.code]));

  res.json({
    usersByRole: usersByRole.map((r) => ({ role: roleCodeById[r.roleId], count: r._count })),
    listingsByStatus: listingsByStatus.map((s) => ({ status: listingStatusCodeById[s.statusId], count: s._count })),
    ordersByStatus,
    deliveriesByStatus,
  });
};
