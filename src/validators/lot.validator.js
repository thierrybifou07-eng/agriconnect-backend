import Joi from 'joi';
import { Prisma } from '@prisma/client';

const Decimal = Prisma.Decimal;

// Joi 18 ne rejette plus number().precision() : il arrondit silencieusement.
// La précision des montants et des quantités est donc vérifiée ici, avec le
// même Decimal que money.js, avant tout arrondi d'écriture.
function precisionDecimale(max) {
  return (value, helpers) => {
    if (new Decimal(value).decimalPlaces() > max) {
      return helpers.error('number.precision');
    }
    return value;
  };
}

// Statuts d'un lot (enum LotStatus de prisma/schema.prisma). Partagés avec le
// contrôleur, qui rejette un ?status= inconnu plutôt que de renvoyer une liste
// vide qui passerait pour un fournisseur sans lot.
export const LOT_STATUSES = [
  'PENDING_VALIDATION',
  'AVAILABLE',
  'FULLY_RESERVED',
  'SOLD_OUT',
  'EXPIRED',
  'RETURNED',
  'REJECTED',
  'WITHDRAWN',
];

// POST /api/v2/supplier/lots.
//
// Tout ce qui porte sur la forme du corps est exprimé ici, y compris les
// champs conditionnels liés à storageType (un lot sur site n'a pas de point de
// dépôt, et inversement). En revanche les règles qui touchent la base — hub
// actif et acceptant la dépose, produit périssable — sont vérifiées par le
// contrôleur : un schéma Joi statique n'a pas accès à la requête.
export const lotCreateSchema = Joi.object({
  productId: Joi.number().integer().positive().required().messages({
    'any.required': 'productId est requis',
    'number.base': 'productId doit être un entier',
  }),
  zoneId: Joi.number().integer().positive().required().messages({
    'any.required': 'zoneId est requis',
    'number.base': 'zoneId doit être un entier',
  }),
  // Le prix et la quantité arrivent en texte du formulaire multipart : Joi
  // les convertit. La précision maximale repose sur les colonnes DECIMAL du
  // schéma (14,2 pour le prix, 12,3 pour la quantité) : accepter plus de
  // décimales reviendrait à écrire un arrondi que MySQL appliquerait de toute
  // façon.
  agreedUnitPrice: Joi.number().positive().custom(precisionDecimale(2)).required().messages({
    'any.required': 'agreedUnitPrice est requis',
    'number.positive': 'Le prix unitaire doit être positif',
    'number.precision': 'Le prix unitaire ne peut pas dépasser 2 décimales',
  }),
  quantity: Joi.number().positive().custom(precisionDecimale(3)).required().messages({
    'any.required': 'quantity est requis',
    'number.positive': 'La quantité doit être positive',
    'number.precision': 'La quantité ne peut pas dépasser 3 décimales',
  }),
  storageType: Joi.string().valid('SUPPLIER_SITE', 'HUB').required().messages({
    'any.required': 'storageType est requis',
    'any.only': 'storageType doit être SUPPLIER_SITE ou HUB',
  }),
  hubId: Joi.number()
    .integer()
    .positive()
    .when('storageType', { is: 'HUB', then: Joi.required(), otherwise: Joi.optional() })
    .messages({
      'any.required': 'hubId est requis quand storageType vaut HUB',
      'number.base': 'hubId doit être un entier',
    }),
  pickupAddress: Joi.string()
    .trim()
    .when('storageType', { is: 'SUPPLIER_SITE', then: Joi.required(), otherwise: Joi.optional() })
    .messages({
      'any.required': 'pickupAddress est requis quand storageType vaut SUPPLIER_SITE',
    }),
  pickupLatitude: Joi.number()
    .min(-90)
    .max(90)
    .when('storageType', { is: 'SUPPLIER_SITE', then: Joi.required(), otherwise: Joi.optional() })
    .messages({
      'any.required': 'pickupLatitude est requis quand storageType vaut SUPPLIER_SITE',
      'number.min': 'pickupLatitude doit être compris entre -90 et 90',
      'number.max': 'pickupLatitude doit être compris entre -90 et 90',
    }),
  pickupLongitude: Joi.number()
    .min(-180)
    .max(180)
    .when('storageType', { is: 'SUPPLIER_SITE', then: Joi.required(), otherwise: Joi.optional() })
    .messages({
      'any.required': 'pickupLongitude est requis quand storageType vaut SUPPLIER_SITE',
      'number.min': 'pickupLongitude doit être compris entre -180 et 180',
      'number.max': 'pickupLongitude doit être compris entre -180 et 180',
    }),
  // expiresAt n'est obligatoire que pour un produit périssable : le
  // contrôleur vérifie isPerishable en base. Ici, une date fournie doit au
  // moins être future ; null/undefined laisse le champ absent (colonne
  // nullable).
  expiresAt: Joi.date().greater('now').allow(null).optional().messages({
    'date.greater': "La date d'expiration doit être dans le futur",
  }),
  harvestedAt: Joi.date().allow(null).optional(),
  packagingNote: Joi.string().trim().max(500).allow(null).optional().messages({
    'string.max': 'packagingNote ne peut pas dépasser 500 caractères',
  }),
  qualityNote: Joi.string().trim().max(500).allow(null).optional().messages({
    'string.max': 'qualityNote ne peut pas dépasser 500 caractères',
  }),
});

// PATCH /api/v2/supplier/lots/:id — même formulaire, mais partiel : un PATCH
// ne renvoie que ce qui change. .min(1) refuse un corps vide, qui ne ferait
// rien passer pour une mise à jour réussie.
export const lotUpdateSchema = Joi.object({
  agreedUnitPrice: Joi.number().positive().custom(precisionDecimale(2)).optional().messages({
    'number.positive': 'Le prix unitaire doit être positif',
    'number.precision': 'Le prix unitaire ne peut pas dépasser 2 décimales',
  }),
  quantity: Joi.number().positive().custom(precisionDecimale(3)).optional().messages({
    'number.positive': 'La quantité doit être positive',
    'number.precision': 'La quantité ne peut pas dépasser 3 décimales',
  }),
  expiresAt: Joi.date().greater('now').allow(null).optional().messages({
    'date.greater': "La date d'expiration doit être dans le futur",
  }),
  harvestedAt: Joi.date().allow(null).optional(),
  packagingNote: Joi.string().trim().max(500).allow(null).optional().messages({
    'string.max': 'packagingNote ne peut pas dépasser 500 caractères',
  }),
  qualityNote: Joi.string().trim().max(500).allow(null).optional().messages({
    'string.max': 'qualityNote ne peut pas dépasser 500 caractères',
  }),
}).min(1).messages({
  'object.min': 'Aucun champ à modifier',
});
