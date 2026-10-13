import Joi from 'joi';

// POST /api/v2/staff/compensations
//
// lotId : lot dont la perte est indemnisee (charge par le controleur, 404 si
// absent). reason : motif de la perte (enum CompensationReason du schema).
// quantity : quantite perdue, bornee par le service a la quantite initiale
// du lot. deliveryId : livraison d'ou vient la perte, optionnel. note :
// precision libre de l'equipe, optionnelle.
export const compensationCreateSchema = Joi.object({
  lotId: Joi.number().integer().positive().required().messages({
    'any.required': 'lotId est requis',
    'number.base': 'lotId doit être un entier',
    'number.positive': 'lotId doit être positif',
  }),
  reason: Joi.string().valid('EXPIRED_UNSOLD', 'LOST_OR_DAMAGED', 'OTHER').required().messages({
    'any.required': 'reason est requis',
    'any.only': 'reason doit être EXPIRED_UNSOLD, LOST_OR_DAMAGED ou OTHER',
  }),
  quantity: Joi.number().positive().required().messages({
    'any.required': 'quantity est requis',
    'number.base': 'quantity doit être un nombre',
    'number.positive': 'quantity doit être positive',
  }),
  deliveryId: Joi.number().integer().positive().allow(null).optional().messages({
    'number.base': 'deliveryId doit être un entier',
    'number.positive': 'deliveryId doit être positif',
  }),
  note: Joi.string().trim().max(500).allow(null).optional(),
});

// PATCH /api/v2/admin/compensations/:id/reject
//
// note : justification du rejet, obligatoire — une indemnisation refusee
// sans motif ne permet pas au fournisseur de comprendre la decision.
export const compensationRejectSchema = Joi.object({
  note: Joi.string().trim().min(1).max(500).required().messages({
    'any.required': 'note est requis',
    'string.empty': 'note est requis',
  }),
});

// PATCH /api/v2/admin/compensations/:id/pay
//
// reference : identifiant du virement, obligatoire — c'est elle qui permet
// la reconciliation bancaire (tracee dans l'audit COMPENSATION_PAID).
export const compensationPaySchema = Joi.object({
  reference: Joi.string().trim().min(1).max(255).required().messages({
    'any.required': 'reference est requis',
    'string.empty': 'reference est requis',
  }),
});
