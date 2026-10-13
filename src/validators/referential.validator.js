import prisma from '../config/prisma.js';
import Joi from 'joi';

// Codes de référentiels : convention MAJUSCULES_AVEC_UNDERSCORES, identique
// aux tables de lookup (Role, UserStatus, ...). Le pattern n'est pas
// cosmétique : MySQL compare les chaînes sans égard à la casse (collation
// _ci), donc autoriser les minuscules créerait des doublons invisibles —
// "cereales" et "CEREALES" entreraient en collision sur l'index unique.
const codePattern = /^[A-Z][A-Z0-9_]*$/;
const codePatternMessage = 'Le code doit contenir uniquement des majuscules, des chiffres et des underscores';

// Tous les référentiels portent isActive, SAUF Unit : le schéma cible
// (docs/schema.v2.target.prisma) n'a pas la colonne et on ne le modifie
// pas. PATCH /units ne fait donc que modifier code et label, et GET /units
// n'accepte pas le filtre ?active=.

// Les vérifications en base des external() utilisent helpers.message() et
// non helpers.error('code') : cette version de Joi ne résout pas les
// messages d'erreur external via .messages() — helpers.error() remonterait
// le message anglais par défaut ("Error code ... is not defined") à la
// place du message français voulu.

// ---- Catégories de produits ----

// POST /api/v2/admin/categories
export const createCategorySchema = Joi.object({
  code: Joi.string().trim().min(2).max(20).pattern(codePattern).required(),
  label: Joi.string().trim().min(2).max(80).required(),
  isActive: Joi.boolean(),
}).messages({
  'string.pattern.base': codePatternMessage,
  'any.required': '{{#label}} est requis(e)',
});

// PATCH /api/v2/admin/categories/:id
export const updateCategorySchema = Joi.object({
  code: Joi.string().trim().min(2).max(20).pattern(codePattern),
  label: Joi.string().trim().min(2).max(80),
  isActive: Joi.boolean(),
})
  .min(1)
  .messages({
    'string.pattern.base': codePatternMessage,
    'object.min': 'Aucun champ à modifier',
  });

// ---- Unités ----

// POST /api/v2/admin/units
export const createUnitSchema = Joi.object({
  code: Joi.string().trim().min(2).max(20).pattern(codePattern).required(),
  label: Joi.string().trim().min(2).max(80).required(),
}).messages({
  'string.pattern.base': codePatternMessage,
  'any.required': '{{#label}} est requis(e)',
});

// PATCH /api/v2/admin/units/:id — pas de isActive (voir plus haut).
export const updateUnitSchema = Joi.object({
  code: Joi.string().trim().min(2).max(20).pattern(codePattern),
  label: Joi.string().trim().min(2).max(80),
})
  .min(1)
  .messages({
    'string.pattern.base': codePatternMessage,
    'object.min': 'Aucun champ à modifier',
  });

// ---- Produits ----

// POST /api/v2/admin/products
// categoryId et unitId sont vérifiés en base via .external() : un produit
// exige une catégorie existante ET active (on ne référence pas une
// catégorie désactivée), et une unité existante.
export const createProductSchema = Joi.object({
  categoryId: Joi.number()
    .integer()
    .positive()
    .required()
    .external(async (value, helpers) => {
      // Joi exécute .external() même sur un champ optionnel non fourni : sans
      // ce garde, la requête partirait avec id undefined et échouerait en 500.
      if (value === undefined) return value;
      const category = await prisma.productCategory.findUnique({ where: { id: value } });
      if (!category) return helpers.message('Catégorie introuvable');
      if (!category.isActive) return helpers.message('Catégorie inactive');
      return value;
    }),
  unitId: Joi.number()
    .integer()
    .positive()
    .required()
    .external(async (value, helpers) => {
      if (value === undefined) return value;
      const unit = await prisma.unit.findUnique({ where: { id: value } });
      if (!unit) return helpers.message('Unité introuvable');
      return value;
    }),
  name: Joi.string().trim().min(2).max(120).required(),
  description: Joi.string().trim().max(500).allow(null).empty(''),
  imageUrl: Joi.string().trim().empty('').uri().max(500).allow(null),
  isPerishable: Joi.boolean(),
  isActive: Joi.boolean(),
}).messages({
  'any.required': '{{#label}} est requis(e)',
});

// PATCH /api/v2/admin/products/:id — mêmes règles, champs optionnels.
export const updateProductSchema = Joi.object({
  categoryId: Joi.number()
    .integer()
    .positive()
    .external(async (value, helpers) => {
      if (value === undefined) return value;
      const category = await prisma.productCategory.findUnique({ where: { id: value } });
      if (!category) return helpers.message('Catégorie introuvable');
      if (!category.isActive) return helpers.message('Catégorie inactive');
      return value;
    }),
  unitId: Joi.number()
    .integer()
    .positive()
    .external(async (value, helpers) => {
      if (value === undefined) return value;
      const unit = await prisma.unit.findUnique({ where: { id: value } });
      if (!unit) return helpers.message('Unité introuvable');
      return value;
    }),
  name: Joi.string().trim().min(2).max(120),
  description: Joi.string().trim().max(500).allow(null).empty(''),
  imageUrl: Joi.string().trim().empty('').uri().max(500).allow(null),
  isPerishable: Joi.boolean(),
  isActive: Joi.boolean(),
})
  .min(1)
  .messages({
    'object.min': 'Aucun champ à modifier',
  });

// ---- Zones ----

// POST /api/v2/admin/zones
export const createZoneSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  city: Joi.string().trim().max(80).allow(null).empty(''),
  region: Joi.string().trim().max(80).allow(null).empty(''),
  isActive: Joi.boolean(),
}).messages({
  'any.required': '{{#label}} est requis(e)',
});

// PATCH /api/v2/admin/zones/:id
export const updateZoneSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120),
  city: Joi.string().trim().max(80).allow(null).empty(''),
  region: Joi.string().trim().max(80).allow(null).empty(''),
  isActive: Joi.boolean(),
})
  .min(1)
  .messages({ 'object.min': 'Aucun champ à modifier' });

// ---- Points de dépôt (hubs) ----

// POST /api/v2/admin/hubs
// zoneId vérifié en base via .external() : un hub exige une zone existante.
export const createHubSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  address: Joi.string().trim().min(3).max(500).required(),
  city: Joi.string().trim().max(80).allow(null).empty(''),
  latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
  zoneId: Joi.number()
    .integer()
    .positive()
    .required()
    .external(async (value, helpers) => {
      if (value === undefined) return value;
      const zone = await prisma.zone.findUnique({ where: { id: value } });
      if (!zone) return helpers.message('Zone introuvable');
      return value;
    }),
  acceptsDropoff: Joi.boolean(),
  acceptsPickup: Joi.boolean(),
  isActive: Joi.boolean(),
}).messages({
  'any.required': '{{#label}} est requis(e)',
});

// PATCH /api/v2/admin/hubs/:id
export const updateHubSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120),
  address: Joi.string().trim().min(3).max(500),
  city: Joi.string().trim().max(80).allow(null).empty(''),
  latitude: Joi.number().min(-90).max(90),
  longitude: Joi.number().min(-180).max(180),
  zoneId: Joi.number()
    .integer()
    .positive()
    .external(async (value, helpers) => {
      if (value === undefined) return value;
      const zone = await prisma.zone.findUnique({ where: { id: value } });
      if (!zone) return helpers.message('Zone introuvable');
      return value;
    }),
  acceptsDropoff: Joi.boolean(),
  acceptsPickup: Joi.boolean(),
  isActive: Joi.boolean(),
})
  .min(1)
  .messages({
    'object.min': 'Aucun champ à modifier',
  });
