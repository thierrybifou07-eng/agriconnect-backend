import prisma from '../config/prisma.js';
import Joi from 'joi';

// PATCH /api/v2/admin/agents/:id — modification d'une fiche d'agent.
// capabilities remplace TOUTES les capacites de la fiche (liste complete, pas
// d'ajout incremental) : plus simple a raisonner pour l'admin, et la
// transaction du controleur garantit l'atomicite du remplacement.
export const updateAgentSchema = Joi.object({
  displayName: Joi.string().trim().min(1).max(120),
  isActive: Joi.boolean(),
  // Verification en base via .external() : une capacite inconnue est refusee
  // ici (400), pas dans la transaction (meme principe que createStaffUser).
  capabilities: Joi.array()
    .items(Joi.string().trim())
    .unique()
    .external(async (codes, helpers) => {
      // Joi exécute l'external même sur un champ absent (undefined) : sans
      // garde, un PATCH qui ne touche pas aux capacités planterait en 500.
      if (!codes) return codes;
      const rows = await prisma.agentCapability.findMany({
        where: { code: { in: codes } },
        select: { code: true },
      });
      const inconnues = codes.filter((code) => !rows.some((row) => row.code === code));
      if (inconnues.length > 0) return helpers.error('capabilities.unknown', { codes: inconnues });
      return codes;
    }),
  // Autonomie : surtout utile pour kind = AI (plan v2), mais le champ reste
  // modifiable pour un HUMAN sans effet de bord.
  autonomy: Joi.string().valid('SUGGEST_ONLY', 'ACT_WITH_APPROVAL', 'AUTONOMOUS').allow(null).empty(''),
}).messages({
  'capabilities.unknown': 'Capacités inconnues : {{#codes}}',
  'array.unique': 'Une capacité est répétée',
});

// POST /api/v2/admin/agents/ai — creation d'un agent IA, SANS compte
// utilisateur (pas de userId : l'IA n'a pas de connexion).
export const createAiAgentSchema = Joi.object({
  displayName: Joi.string().trim().min(1).max(120).required(),
  aiProvider: Joi.string().trim().min(1).max(80).required(),
  aiModel: Joi.string().trim().min(1).max(120).required(),
  aiConfig: Joi.object().allow(null).empty(''),
  // Une IA ne decide pas seule au depart : elle suggere, l'humain valide.
  autonomy: Joi.string().valid('SUGGEST_ONLY', 'ACT_WITH_APPROVAL', 'AUTONOMOUS').default('SUGGEST_ONLY'),
});
