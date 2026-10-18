import prisma from '../../config/prisma.js';
import { ensureProfile } from '../../utils/profile.js';
import { listPayoutsPourFournisseur } from '../../services/payout.service.js';

// GET /api/v2/supplier/payouts?page=&limit=
//
// Liste paginée des reversements du fournisseur connecte. Le filtre porte sur
// le profil fournisseur (supplierProfile), jamais sur l'utilisateur directement.
// Aucune donnee acheteur n'exposee.
export const listPayouts = async (req, res) => {
  const profile = await ensureProfile(prisma, req.user);

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const result = await listPayoutsPourFournisseur(prisma, profile.id, { page, limit });
  res.json(result);
};
