import prisma from '../config/prisma.js';
import {
  approveCompensation,
  rejectCompensation,
  payCompensation,
  listAllCompensations,
} from '../services/compensation.service.js';
import { compensationToApi } from '../utils/dto/compensation.dto.js';

// Résout l'identité de l'acteur pour l'audit (recordAudit attend des objets).
// Un admin connecté a req.user ; req.agent n'existe pas (pas de fiche d'agent).
function acteur(req) {
  return {
    actorUser: req.user,
    actorAgent: null,
  };
}

// GET /api/v2/admin/compensations?status=&page=&limit=
//
// Vue complète de toutes les indemnisations (ADMIN et plus), avec filtre par
// statut. Les paramètres de liste ne passent pas par validate() : en Express
// 5, req.query est un getter sans setter (voir supplier.routes.js).
export const listCompensations = async (req, res) => {
  const { status } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const result = await listAllCompensations(prisma, {
    page,
    limit,
    ...(status ? { status } : {}),
  });
  res.json(result);
};

// PATCH /api/v2/admin/compensations/:id/approve
//
// PENDING_APPROVAL -> APPROVED : l'administrateur valide le bien-fondé de la
// perte. Décision tracée dans l'audit (COMPENSATION_APPROVED).
export const approveCompensationController = async (req, res) => {
  const compensation = await prisma.$transaction((tx) =>
    approveCompensation(tx, req.params.id, acteur(req))
  );
  res.json(compensationToApi(compensation));
};

// PATCH /api/v2/admin/compensations/:id/reject
//
// PENDING_APPROVAL -> REJECTED : l'administrateur refuse l'indemnisation avec
// une justification obligatoire. Décision tracée dans l'audit
// (COMPENSATION_REJECTED).
export const rejectCompensationController = async (req, res) => {
  const { note } = req.body;
  const compensation = await prisma.$transaction((tx) =>
    rejectCompensation(tx, req.params.id, note, acteur(req))
  );
  res.json(compensationToApi(compensation));
};

// PATCH /api/v2/admin/compensations/:id/pay
//
// APPROVED -> PAID : enregistrement du virement avec sa reference. requireHumanActor
// (monté sur la route) refuse les agents IA : l'argent ne se déplace pas tout seul.
export const payCompensationController = async (req, res) => {
  const { reference } = req.body;
  const compensation = await prisma.$transaction((tx) =>
    payCompensation(tx, req.params.id, reference, acteur(req))
  );
  res.json(compensationToApi(compensation));
};
