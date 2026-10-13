import Joi from 'joi';

// PATCH /api/v2/admin/referrals/:id/pay
//
// reference : identifiant du virement (obligatoire, trace pour reconciliation).
export const payReferralSchema = Joi.object({
  reference: Joi.string().trim().min(1).max(255).required().messages({
    'any.required': 'reference est requis',
    'string.empty': 'reference est requis',
  }),
});

// PATCH /api/v2/admin/referrals/:id/reject
//
// reason : motif du rejet (obligatoire, affiche au parrain).
export const rejectReferralSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(500).required().messages({
    'any.required': 'reason est requis',
    'string.empty': 'reason est requis',
  }),
});

// GET /api/v2/admin/referrals?status=
//
// status : filtre optionnel sur le statut du parrainage.
export const listReferralsQuerySchema = Joi.object({
  status: Joi.string().valid('PENDING', 'ELIGIBLE', 'PAID', 'REJECTED').optional().messages({
    'any.only': 'status doit être PENDING, ELIGIBLE, PAID ou REJECTED',
  }),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
});
