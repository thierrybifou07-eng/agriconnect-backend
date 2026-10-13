import Joi from 'joi';

// Validation des corps de messagerie (plan v2, P3.1).
//
// listingId et lotId sont tous deux déclarés connus : stripUnknown ne les
// retirerait pas du corps validé, et un acheteur envoyant lotId (ou l'inverse)
// doit être refusé explicitement par le contrôleur, pas ignoré en silence.

const content = Joi.string().trim().min(1).max(5000).required().messages({
  'any.required': 'content est requis',
  'string.empty': 'content ne peut pas être vide',
  'string.max': 'content ne peut pas dépasser 5000 caractères',
});

export const conversationCreateSchema = Joi.object({
  listingId: Joi.number().integer().positive().optional(),
  lotId: Joi.number().integer().positive().optional(),
  content,
});

export const conversationMessageSchema = Joi.object({
  content,
});

// Un agent s'assigne à lui-même : agentId n'est accepté que pour désigner
// l'agent courant (le contrôleur le vérifie). Un admin, sans fiche d'agent,
// doit fournir agentId.
export const assignSchema = Joi.object({
  agentId: Joi.number().integer().positive().optional(),
});

export const escalateSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(500).required().messages({
    'any.required': 'reason est requis',
  }),
});

export const staffMessageSchema = Joi.object({
  content,
  isInternal: Joi.boolean().default(false),
});
