import Joi from 'joi';

// Schéma de création d'un paiement manuel (plan v2, P4.1).
// amount et method sont obligatoires ; reference et paidAt sont facultatifs.
// amount n'est pas limité à positif ici : un montant <= 0 est une règle
// métier (409 INVALID_AMOUNT), pas une requête mal formée.
export const paymentCreateSchema = Joi.object({
  amount: Joi.number().required().messages({
    'any.required': 'amount est requis',
    'number.base': 'amount doit être un nombre',
  }),
  method: Joi.string().valid('CASH', 'MOBILE_MONEY', 'BANK_TRANSFER').required().messages({
    'any.required': 'method est requis',
    'any.only': 'method doit être CASH, MOBILE_MONEY ou BANK_TRANSFER',
  }),
  reference: Joi.string().trim().max(200).allow(null).optional(),
  paidAt: Joi.date().iso().optional().messages({
    'date.format': 'paidAt doit être une date ISO 8601',
  }),
});

// Schéma de remboursement d'un paiement (P4.1). force est une dérogation de
// direction : elle permet à un administrateur (ADMIN ou ROOT) de rembourser
// même si un reversement fournisseur a déjà été payé — le reversement PAID
// n'est pas annulé, le règlement fournisseur devient un traitement manuel.
// Un non-administrateur qui envoie force: true est ignoré (409).
export const paymentRefundSchema = Joi.object({
  force: Joi.boolean().optional(),
});
