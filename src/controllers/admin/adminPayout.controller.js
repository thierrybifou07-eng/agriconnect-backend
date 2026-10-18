import prisma from '../../config/prisma.js';
import { listAllPayouts, payPayout } from '../../services/payout.service.js';

// GET /api/v2/admin/payouts?status=&page=&limit=
//
// Vue complete de tous les reversements (ADMIN et plus). Expose le numero de
// compte complet, le nom du compte et l'identite du fournisseur : l'administrateur
// a besoin de ces informations pour effectuer le virement.
export const listPayouts = async (req, res) => {
  const { status } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const result = await listAllPayouts(prisma, { page, limit, ...(status ? { status } : {}) });
  res.json(result);
};

// PATCH /api/v2/admin/payouts/:id/pay
//
// Marque un reversement READY comme paye. Seul un reversement READY peut etre
// paye : un ON_HOLD n'a pas encore les fonds, un PAID est deja paye, un
// CANCELLED est annule. L'audit PAYOUT_PAID est ecrit dans la meme
// transaction que la mise a jour.
export const payPayoutController = async (req, res) => {
  const { reference, payoutAccountId } = req.body;

  const payout = await payPayout(
    prisma,
    req.params.id,
    { reference, payoutAccountId },
    { actorUser: req.user }
  );

  res.json(payout);
};
