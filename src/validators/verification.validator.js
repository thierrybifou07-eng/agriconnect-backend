import Joi from 'joi';

// POST /api/v2/auth/me/documents — type de document déposé (enum DocumentType).
export const submitDocumentSchema = Joi.object({
  type: Joi.string().valid('ID_CARD', 'BUSINESS_REGISTRATION', 'FARM_PROOF', 'OTHER').required(),
});

// PATCH /api/v2/admin/verifications/:id — décision d'examen. La note est
// obligatoire en cas de rejet : rejeter sans dire pourquoi priverait
// l'utilisateur de toute correction possible.
export const reviewVerificationSchema = Joi.object({
  decision: Joi.string().valid('APPROVE', 'REJECT').required(),
  note: Joi.when('decision', {
    is: 'REJECT',
    then: Joi.string().trim().min(1).max(2000).required(),
    otherwise: Joi.string().trim().max(2000).allow(null).empty(''),
  }),
});
