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
  // Contournement de la règle du prix plancher (prix convenu avec le
  // promoteur) : réservé à ADMIN/ROOT, vérifié et tracé par le contrôleur.
  // Un agent peut l'envoyer : il est simplement ignoré pour lui.
  force: Joi.boolean().optional(),
});

// PATCH /api/v2/staff/orders/:id/status — changement de statut manuel.
//
// Seuls les statuts cibles de la machine a etats sont proposes : QUOTED
// n'est pas un statut que l'on peut poser (c'est l'etat initial d'un devis),
// et OUT_FOR_DELIVERY, present dans la table, est refuse par le service :
// ce statut ne peut etre pose que par le flux livraison (P5.3).
export const orderStatusSchema = Joi.object({
  status: Joi.string()
    .valid('CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED')
    .required()
    .messages({
      'any.required': 'status est requis',
      'any.only': 'status invalide',
    }),
  // Contournement de la regle de paiement avant PREPARING : reserve aux
  // administrateurs (verifie et trace par le service).
  force: Joi.boolean().optional(),
});

// POST /api/v2/orders/:id/cancel et POST /api/v2/staff/orders/:id/cancel.
// La raison est facultative : une annulation n'a pas toujours a etre justifiee.
export const orderCancelSchema = Joi.object({
  reason: Joi.string().trim().max(500).allow(null).optional().messages({
    'string.max': 'reason ne peut pas dépasser 500 caracteres',
  }),
});
