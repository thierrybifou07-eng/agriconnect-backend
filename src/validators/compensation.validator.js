import Joi from 'joi';

// Schémas de validation des indemnisations fournisseurs (plan v2, P6.2).

// POST /api/v2/staff/compensations — demande d'indemnisation pour invendus
// ou pertes. quantité n'est pas limitée à positif ici : une quantité <= 0 ou
// supérieure au lot est une regle metier (400 du service), pas une requete
// mal formee.
export const compensationCreateSchema = Joi.object({
  lotId: Joi.number().integer().positive().required().messages({
    'any.required': 'lotId est requis',
    'number.base': 'lotId doit être un entier',
  }),
  reason: Joi.string().valid('EXPIRED_UNSOLD', 'LOST_OR_DAMAGED', 'OTHER').required().messages({
    'any.required': 'reason est requis',
    'any.only': 'reason doit être EXPIRED_UNSOLD, LOST_OR_DAMAGED ou OTHER',
  }),
  quantity: Joi.number().greater(0).required().messages({
    'any.required': 'quantity est requis',
    'number.base': 'quantity doit être un nombre',
    'number.greater': 'quantity doit être supérieure à 0',
  }),
  deliveryId: Joi.number().integer().positive().allow(null).optional().messages({
    'number.base': 'deliveryId doit être un entier',
  }),
  note: Joi.string().trim().max(500).allow(null).optional().messages({
    'string.max': 'note ne peut pas dépasser 500 caractères',
  }),
});

// PATCH /api/v2/admin/compensations/:id/reject — la justification est
// obligatoire : un rejet doit pouvoir être expliqué a posteriori (audit).
export const compensationRejectSchema = Joi.object({
  note: Joi.string().trim().min(1).max(500).required().messages({
    'any.required': 'note est requis',
  }),
});

// PATCH /api/v2/admin/compensations/:id/pay — reference obligatoire (1 a 100
// caracteres) : c'est l'identifiant du virement, trace pour reconciliation.
export const compensationPaySchema = Joi.object({
  reference: Joi.string().trim().min(1).max(100).required().messages({
    'any.required': 'reference est requis',
    'string.empty': 'reference est requis',
    'string.max': 'reference ne peut pas dépasser 100 caractères',
  }),
});
