// Fragment OpenAPI : /api/v2/supplier — lots déclarés par le promoteur connecté.

import { lotCreateSchema, lotUpdateSchema } from '../src/validators/lot.validator.js';
import { jsonBody, multipartBody } from './openapi.helpers.js';

const R = (ref) => ({ $ref: `#/components/responses/${ref}` });

// Schéma inline du corps de retrait (défini dans la route, pas dans un validator).
const withdrawBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
      },
    },
  },
};

// Champs texte du lot : convertis depuis le validateur Joi réel. La route ajoute
// le champ fichier images par-dessus (le schéma Joi ne le connaît pas).
const lotFields = Object.fromEntries(lotCreateSchema.$_terms.keys.map((k) => [k.key, k.schema]));

function lotMultipart() {
  return multipartBody({
    file: { name: 'images', description: 'Photos du lot, 5 maximum (au-delà : 400)' },
    fields: lotFields,
  });
}

export default {
  openapi: '3.0.0',
  paths: {
    '/supplier/lots': {
      post: {
        tags: ['Fournisseur'],
        summary: 'Déclare un lot (multipart)',
        description:
          'Crée le lot en PENDING_VALIDATION (lotCode = \'LOT-\' + id sur 6 chiffres) et ses photos (ownerLotId). expiresAt obligatoire si le produit est périssable (vérifié par le contrôleur). hubId obligatoire si HUB ; pickupAddress + coordonnées obligatoires si SUPPLIER_SITE.',
        requestBody: lotMultipart(),
        responses: {
          '201': {
            description: 'Lot créé',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SupplierLot' } } },
          },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
      get: {
        tags: ['Fournisseur'],
        summary: 'Lots du fournisseur connecté (paginé)',
        parameters: [
          { in: 'query', name: 'status', schema: { type: 'string', enum: ['PENDING_VALIDATION', 'AVAILABLE', 'FULLY_RESERVED', 'SOLD_OUT', 'EXPIRED', 'RETURNED', 'REJECTED', 'WITHDRAWN'] } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': { $ref: '#/components/responses/PaginatedSupplierLots' },
          '400': { description: 'Statut inconnu', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/supplier/payouts': {
      get: {
        tags: ['Fournisseur'],
        summary: 'Reversements du fournisseur connecté',
        responses: {
          '200': { $ref: '#/components/responses/PaginatedPayouts' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/supplier/compensations': {
      get: {
        tags: ['Fournisseur'],
        summary: 'Indemnisations du fournisseur connecté',
        responses: {
          '200': { $ref: '#/components/responses/PaginatedSupplierCompensations' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/supplier/lots/{id}': {
      get: {
        tags: ['Fournisseur'],
        summary: 'Détail d\'un lot (404 si le lot n\'est pas à lui)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': {
            description: 'Lot',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SupplierLot' } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
      patch: {
        tags: ['Fournisseur'],
        summary: 'Modifie un lot (PENDING_VALIDATION uniquement)',
        description: 'PATCH hors PENDING_VALIDATION -> 409 INVALID_STATE_TRANSITION.',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(lotUpdateSchema),
        responses: {
          '200': {
            description: 'Lot mis à jour',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SupplierLot' } } },
          },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Fournisseur'],
        summary: 'Supprime définitivement un lot',
        description: 'Uniquement en PENDING_VALIDATION ou REJECTED (sinon 409 — utiliser le retrait).',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': { description: 'Lot et photos supprimés' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/supplier/lots/{id}/withdraw': {
      post: {
        tags: ['Fournisseur'],
        summary: 'Retire un lot (AVAILABLE sans réservation -> WITHDRAWN)',
        description: 'Avec réservation -> 409 INVALID_STATE_TRANSITION.',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: withdrawBody,
        responses: {
          '200': { description: 'Lot retiré (WITHDRAWN)' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
  },
};
