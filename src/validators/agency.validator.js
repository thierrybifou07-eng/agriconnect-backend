import prisma from '../config/prisma.js';
import Joi from 'joi';

// Les vérifications en base des external() utilisent helpers.message() et
// non helpers.error('code') : cette version de Joi ne résout pas les
// messages d'erreur external via .messages() — helpers.error() remonterait
// le message anglais par défaut à la place du message français voulu.

// ---- Agences de transport ----

// POST /api/v2/admin/agencies
// L'unicité du nom est vérifiée dans le contrôleur (409 lisible), comme pour
// les catégories et les zones : la contrainte en base reste le garde-fou des
// écritures concurrentes.
export const createAgencySchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  contactName: Joi.string().trim().max(120).allow(null).empty(''),
  phone: Joi.string().trim().min(6).max(20).required(),
  email: Joi.string().trim().email().max(160).allow(null).empty(''),
  insuranceProvider: Joi.string().trim().max(120).allow(null).empty(''),
  insurancePolicyNumber: Joi.string().trim().max(80).allow(null).empty(''),
  insuranceExpiresAt: Joi.date().iso().allow(null).empty(''),
  isActive: Joi.boolean(),
}).messages({
  'any.required': '{{#label}} est requis(e)',
});

// PATCH /api/v2/admin/agencies/:id — mêmes règles, champs optionnels.
export const updateAgencySchema = Joi.object({
  name: Joi.string().trim().min(2).max(120),
  contactName: Joi.string().trim().max(120).allow(null).empty(''),
  phone: Joi.string().trim().min(6).max(20),
  email: Joi.string().trim().email().max(160).allow(null).empty(''),
  insuranceProvider: Joi.string().trim().max(120).allow(null).empty(''),
  insurancePolicyNumber: Joi.string().trim().max(80).allow(null).empty(''),
  insuranceExpiresAt: Joi.date().iso().allow(null).empty(''),
  isActive: Joi.boolean(),
})
  .min(1)
  .messages({
    'object.min': 'Aucun champ à modifier',
  });

// PUT /api/v2/admin/agencies/:id/zones/:zoneId
// Les tarifs sont des montants : Joi.number().min(0) refuse les valeurs
// négatives en amont (400), et le contrôleur les arrondit au centime via
// utils/money.js avant écriture. La conversion en nombre pour la validation
// n'est pas un calcul d'argent : aucun montant n'est produit ici.
export const upsertAgencyZoneSchema = Joi.object({
  baseFee: Joi.number().min(0).required(),
  perKmFee: Joi.number().min(0).required(),
  isActive: Joi.boolean(),
}).messages({
  'number.min': 'Le tarif ne peut pas être négatif',
  'any.required': '{{#label}} est requis(e)',
});
