import prisma from '../config/prisma.js';
import {
  getMyReferral,
  listAllReferrals,
  payReferral,
  rejectReferral,
} from '../services/referral.service.js';

// GET /api/v2/auth/me/referral
//
// Vue parrain : son code, les totaux par statut, et la liste de ses
// filleuls (prenom seul, aucune donnee personnelle supplementaire).
export const getMyReferralController = async (req, res) => {
  const data = await getMyReferral(prisma, req.user.id);
  res.json(data);
};

// GET /api/v2/admin/referrals?status=&page=&limit=
//
// Liste paginée de tous les parrainages (ADMIN et plus, uniquement agents
// humains : requireHumanActor bloque les agents IA).
export const listReferrals = async (req, res) => {
  const { status } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const result = await listAllReferrals(prisma, { page, limit, ...(status ? { status } : {}) });
  res.json(result);
};

// PATCH /api/v2/admin/referrals/:id/pay
//
// Marque un parrainage ELIGIBLE comme paye. Seul un ELIGIBLE peut etre paye.
export const payReferralController = async (req, res) => {
  const { reference } = req.body;

  const referral = await payReferral(
    prisma,
    req.params.id,
    { reference },
    { actorUser: req.user }
  );

  res.json(referral);
};

// PATCH /api/v2/admin/referrals/:id/reject
//
// Rejete un parrainage PENDING ou ELIGIBLE avec un motif obligatoire.
export const rejectReferralController = async (req, res) => {
  const { reason } = req.body;

  const referral = await rejectReferral(
    prisma,
    req.params.id,
    { reason },
    { actorUser: req.user }
  );

  res.json(referral);
};
