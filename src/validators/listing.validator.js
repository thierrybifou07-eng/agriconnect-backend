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

// Statuts d'annonce (lookup ListingStatus). Partagés avec le contrôleur, qui
// rejette un ?status= inconnu plutôt que de renvoyer une liste vide qui
// passerait pour une équipe sans annonce.
export const LISTING_STATUSES = ['DRAFT', 'ACTIVE', 'SOLD', 'INACTIVE'];

// POST /api/v2/staff/listings.
//
// lotIds est un tableau : au MVP une annonce = exactement un lot (C7), la règle
// est appliquée dans le service (400 si plusieurs). productId n'est pas accepté
// ici : il est repris du lot, jamais du client.
export const listingCreateSchema = Joi.object({
  lotIds: Joi.array()
    .items(Joi.number().integer().positive())
    .required()
    .messages({
      'any.required': 'lotIds est requis',
      'array.base': 'lotIds doit être un tableau',
    }),
  title: Joi.string().trim().min(3).max(140).required().messages({
    'any.required': 'title est requis',
    'string.min': 'title doit contenir au moins 3 caractères',
    'string.max': 'title ne peut pas dépasser 140 caractères',
  }),
  description: Joi.string().trim().max(2000).allow(null).optional().messages({
    'string.max': 'description ne peut pas dépasser 2000 caractères',
  }),
  // Prix public : si absent, le prix convenu du lot fait foi (C7).
  unitPrice: Joi.number().positive().custom(precisionDecimale(2)).optional().messages({
    'number.positive': 'Le prix unitaire doit être positif',
    'number.precision': 'Le prix unitaire ne peut pas dépasser 2 décimales',
  }),
  // Zone d'affichage : si absente, la zone du lot fait foi.
  zoneId: Joi.number().integer().positive().optional().messages({
    'number.base': 'zoneId doit être un entier',
  }),
});

// PATCH /api/v2/staff/listings/:id — tous les champs sont facultatifs mais au
// moins un doit être présent : un PATCH vide ne ferait rien passer pour une
// mise à jour réussie.
export const listingUpdateSchema = Joi.object({
  title: Joi.string().trim().min(3).max(140).messages({
    'string.min': 'title doit contenir au moins 3 caractères',
    'string.max': 'title ne peut pas dépasser 140 caractères',
  }),
  description: Joi.string().trim().max(2000).allow(null).messages({
    'string.max': 'description ne peut pas dépasser 2000 caractères',
  }),
  unitPrice: Joi.number().positive().custom(precisionDecimale(2)).messages({
    'number.positive': 'Le prix unitaire doit être positif',
    'number.precision': 'Le prix unitaire ne peut pas dépasser 2 décimales',
  }),
  zoneId: Joi.number().integer().positive().messages({
    'number.base': 'zoneId doit être un entier',
  }),
}).min(1).messages({
  'object.min': 'Aucun champ à modifier',
});
