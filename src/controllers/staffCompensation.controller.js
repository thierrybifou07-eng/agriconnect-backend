import prisma from '../config/prisma.js';
import { createForLoss } from '../services/compensation.service.js';
import { compensationToApi } from '../utils/dto/compensation.dto.js';

// Résout l'identité de l'acteur pour l'audit (recordAudit attend des objets).
// Un agent connecté a req.agent (requireCapability) ; un admin n'en a pas.
function acteur(req) {
  return {
    actorUser: req.user,
    actorAgent: req.agent ?? null,
  };
}

// POST /api/v2/staff/compensations — déclare une perte indemnisable sur un
// lot. Le lot est charge dans la transaction : createForLoss travaille sur un
// lot déjà verrouillé par la transaction courante.
//
// 201 avec l'indemnisation créée, 200 { created: false } quand le taux de la
// plateforme vaut zéro (aucune indemnisation, ce n'est pas une erreur).
export const createCompensation = async (req, res) => {
  const { lotId, reason, quantity, deliveryId, note } = req.body;

  const result = await prisma.$transaction(async (tx) => {
    const lot = await tx.stockLot.findUnique({ where: { id: lotId } });
    if (!lot) {
      throw Object.assign(new Error(`Lot ${lotId} introuvable`), {
        statusCode: 404,
        code: 'LOT_NOT_FOUND',
      });
    }
    return createForLoss(tx, { lot, quantity, reason, deliveryId, note }, acteur(req));
  });

  if (!result) {
    return res.status(200).json({
      created: false,
      reason: "Taux d'indemnisation nul : aucune indemnisation créée",
    });
  }

  res.status(201).json(compensationToApi(result));
};
