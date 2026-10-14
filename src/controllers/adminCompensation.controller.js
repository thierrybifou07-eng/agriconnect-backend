import prisma from '../config/prisma.js';
import {
  listCompensations,
  approveCompensation,
  rejectCompensation,
  payCompensation,
} from '../services/compensation.service.js';

// Résout l'identité de l'acteur pour l'audit : un admin n'a pas de fiche
// d'agent (requireMinLevel(50) ne passe jamais par requireCapability).
function acteur(req) {
  return { actorUser: req.user, actorAgent: null };
}

// GET /api/v2/admin/compensations?status=&page=&limit= — vue complète de
// toutes les indemnisations (ADMIN et plus, agents humains seulement).
export const listCompensationsAdmin = async (req, res, next) => {
  try {
    const { status } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const result = await listCompensations(prisma, {
      page,
      limit,
      ...(status ? { status } : {}),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// PATCH /api/v2/admin/compensations/:id/approve — PENDING_APPROVAL -> APPROVED.
export const approveCompensationController = async (req, res, next) => {
  try {
    const compensation = await approveCompensation(prisma, req.params.id, acteur(req));
    res.json(compensation);
  } catch (err) {
    next(err);
  }
};

// PATCH /api/v2/admin/compensations/:id/reject — PENDING_APPROVAL -> REJECTED.
export const rejectCompensationController = async (req, res, next) => {
  try {
    const compensation = await rejectCompensation(prisma, req.params.id, { note: req.body.note }, acteur(req));
    res.json(compensation);
  } catch (err) {
    next(err);
  }
};

// PATCH /api/v2/admin/compensations/:id/pay — APPROVED -> PAID. Ecrit
// reference, paidAt ET paidById dans la ligne SupplierCompensation.
export const payCompensationController = async (req, res, next) => {
  try {
    const compensation = await payCompensation(prisma, req.params.id, { reference: req.body.reference }, acteur(req));
    res.json(compensation);
  } catch (err) {
    next(err);
  }
};
