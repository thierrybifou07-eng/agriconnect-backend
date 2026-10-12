import Joi from 'joi';
import { Prisma } from '@prisma/client';

const Decimal = Prisma.Decimal;

// Joi 18 ne rejette plus number().precision() : il arrondit silencieusement.
// La précision des montants est donc vérifiée ici, avec le même Decimal que
// money.js, avant tout arrondi d'écriture.
function precisionDecimale(max) {
  return (value, helpers) => {
    if (new Decimal(value).decimalPlaces() > max) {
      return helpers.error('number.precision');
    }
    return value;
  };
}

// POST /api/v2/staff/orders — émission d'un devis.
//
// deliveryMode conditionne les champs obligatoires : HUB_PICKUP exige
// pickupHubId, AGENCY_DELIVERY exige delivery.{zoneId, address, latitude,
// longitude}. La règle est appliquée dans le contrôleur (le schéma Joi ne
// peut pas exprimer une dépendance aussi simplement).
export const orderCreateSchema = Joi.object({
  buyerId: Joi.number().integer().positive().required().messages({
    'any.required': 'buyerId est requis',
    'number.base': 'buyerId doit être un entier',
  }),
  conversationId: Joi.number().integer().positive().optional().messages({
    'number.base': 'conversationId doit être un entier',
  }),
  items: Joi.array()
    .items(
      Joi.object({
        listingId: Joi.number().integer().positive().required().messages({
          'any.required': 'listingId est requis',
          'number.base': 'listingId doit être un entier',
        }),
        quantity: Joi.number().positive().custom(precisionDecimale(3)).required().messages({
          'any.required': 'quantity est requis',
          'number.positive': 'La quantité doit être positive',
          'number.precision': 'La quantité ne peut pas dépasser 3 décimales',
        }),
        // Prix public surchargé : par défaut, c'est celui de l'annonce.
        unitPrice: Joi.number().positive().custom(precisionDecimale(2)).optional().messages({
          'number.positive': 'Le prix unitaire doit être positif',
          'number.precision': 'Le prix unitaire ne peut pas dépasser 2 décimales',
        }),
      })
    )
    .min(1)
    .required()
    .messages({
      'any.required': 'items est requis',
      'array.min': 'Au moins un article est requis',
    }),
  deliveryMode: Joi.string().valid('HUB_PICKUP', 'AGENCY_DELIVERY').required().messages({
    'any.required': 'deliveryMode est requis',
    'any.only': 'deliveryMode doit être HUB_PICKUP ou AGENCY_DELIVERY',
  }),
  pickupHubId: Joi.number().integer().positive().optional().messages({
    'number.base': 'pickupHubId doit être un entier',
  }),
  delivery: Joi.object({
    zoneId: Joi.number().integer().positive().required().messages({
      'any.required': 'delivery.zoneId est requis',
      'number.base': 'delivery.zoneId doit être un entier',
    }),
    address: Joi.string().trim().min(3).max(500).required().messages({
      'any.required': 'delivery.address est requis',
      'string.min': 'delivery.address doit contenir au moins 3 caractères',
    }),
    latitude: Joi.number().min(-90).max(90).required().messages({
      'any.required': 'delivery.latitude est requis',
      'number.min': 'delivery.latitude doit être entre -90 et 90',
      'number.max': 'delivery.latitude doit être entre -90 et 90',
    }),
    longitude: Joi.number().min(-180).max(180).required().messages({
      'any.required': 'delivery.longitude est requis',
      'number.min': 'delivery.longitude doit être entre -180 et 180',
      'number.max': 'delivery.longitude doit être entre -180 et 180',
    }),
  })
    .optional()
    .messages({
      'object.base': 'delivery doit être un objet',
    }),
  notes: Joi.string().trim().max(1000).allow(null).optional().messages({
    'string.max': 'notes ne peut pas dépasser 1000 caractères',
  }),
});
