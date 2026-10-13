import Joi from 'joi';

// PATCH /api/v2/admin/payouts/:id/pay
//
// reference : identifiant du virement (obligatoire, trace pour reconciliation).
// payoutAccountId : optionnel, permet de choisir un compte different de
// celui par defaut. Le controleur verifie qu'il appartient au fournisseur.
export const payPayoutSchema = Joi.object({
  reference: Joi.string().trim().min(1).max(255).required().messages({
    'any.required': 'reference est requis',
    'string.empty': 'reference est requis',
  }),
  payoutAccountId: Joi.number().integer().positive().allow(null).optional().messages({
    'number.base': 'payoutAccountId doit être un entier',
    'number.positive': 'payoutAccountId doit être positif',
  }),
});
