// Fragment OpenAPI : /api/v2/orders — cycle de vie de la commande côté acheteur.

import { orderCancelSchema } from '../src/validators/order.validator.js';
import { jsonSchema } from './openapi.helpers.js';

const R = (ref) => ({ $ref: `#/components/responses/${ref}` });

export default {
  openapi: '3.0.0',
  paths: {
    '/orders': {
      get: {
        tags: ['Commandes'],
        summary: 'Commandes de l\'acheteur connecté',
        responses: {
          '200': { $ref: '#/components/responses/PaginatedOrders' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/orders/{id}': {
      get: {
        tags: ['Commandes'],
        summary: 'Détail d\'une commande (404 si pas la sienne)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': {
            description: 'Commande',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/orders/{id}/confirm': {
      post: {
        tags: ['Commandes'],
        summary: 'Confirme un devis (QUOTED -> CONFIRMED)',
        description:
          'Exige un profil vérifié : 403 PROFILE_NOT_VERIFIED tant que profileVerificationStatus n\'est pas VERIFIED (le corps renvoie le statut courant).',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': {
            description: 'Commande confirmée',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
          '401': R('Unauthorized'),
          '403': R('ForbiddenProfileNotVerified'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/orders/{id}/cancel': {
      post: {
        tags: ['Commandes'],
        summary: 'Annule un devis ou une commande (restitue le stock)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: { required: false, content: { 'application/json': { schema: jsonSchema(orderCancelSchema) } } },
        responses: {
          '200': { description: 'Commande annulée' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
  },
};
