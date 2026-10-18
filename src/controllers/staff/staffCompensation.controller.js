import prisma from '../../config/prisma.js';
import { createForLoss } from '../../services/compensation.service.js';

// POST /api/v2/staff/compensations — demande d'indemnisation pour invendus
// ou pertes (capacite DISPUTE_HANDLING, ADMIN toujours).
//
// Le montant est figé dès la création (taux d'indemnisation en vigueur) : la
// ligne part en PENDING_APPROVAL, l'approbation et le paiement sont des actes
// d'admin (requireHumanActor : l'argent ne se déplace pas tout seul).
export const createCompensation = async (req, res, next) => {
  try {
    const { lotId, reason, quantity, deliveryId = null, note = null } = req.body;

    const lot = await prisma.stockLot.findUnique({ where: { id: lotId } });
    if (!lot) {
      return res.status(404).json({ error: `Lot ${lotId} introuvable` });
    }

    // Une livraison référencée doit exister : une clé étrangère inconnue vaut
    // une requête mal formée (400), jamais une erreur serveur.
    if (deliveryId !== null) {
      const livraison = await prisma.delivery.findUnique({ where: { id: deliveryId } });
      if (!livraison) {
        return res.status(400).json({ error: `Livraison ${deliveryId} introuvable` });
      }
    }

    const compensation = await prisma.$transaction(async (tx) =>
      createForLoss(tx, { lot, quantity, reason, deliveryId, note })
    );

    // Taux à zéro : aucune indemnisation due, aucune ligne créée.
    if (!compensation) {
      return res.status(400).json({
        error: "Aucune indemnisation : le taux d'indemnisation est à zéro",
        code: 'COMPENSATION_RATE_ZERO',
      });
    }

    res.status(201).json(compensation);
  } catch (err) {
    next(err);
  }
};
