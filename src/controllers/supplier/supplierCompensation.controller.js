import prisma from '../../config/prisma.js';
import { ensureProfile } from '../../utils/profile.js';
import { listCompensationsPourFournisseur } from '../../services/compensation.service.js';

// GET /api/v2/supplier/compensations?page=&limit= — liste paginée des
// indemnisations du fournisseur connecté (motif, quantité, montant, statut).
// Le filtre porte sur le profil fournisseur (supplierProfile), jamais sur
// l'utilisateur directement : un fournisseur ne voit que les siennes.
export const listCompensations = async (req, res, next) => {
  try {
    const profile = await ensureProfile(prisma, req.user);

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const result = await listCompensationsPourFournisseur(prisma, profile.id, { page, limit });
    res.json(result);
  } catch (err) {
    next(err);
  }
};
