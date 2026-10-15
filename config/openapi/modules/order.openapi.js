// config/openapi/modules/order.openapi.js
//
// Cycle de vie de la commande côté acheteur (plan v2, P3.5). Toutes les routes
// sont réservées au BUYER connecté et n'agissent que sur SES commandes : le
// contrôleur répond 404 pour toute commande qui n'est pas la sienne, jamais 403.

import {
  makeSuccessResponse,
  makeErrorResponse,
  makeValidationErrorResponse,
  makePaginatedResponse,
  makeJoiRequestBody,
  makePathParam,
  paginationParams,
  nullableDateTimeSchema,
  nullableNumberSchema,
  nullableStringSchema,
} from '../openapi.helpers.js';
import { orderCancelSchema } from '../../../src/validators/order.validator.js';

const OrderItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 301 },
    listingId: { type: 'integer', example: 12 },
    listingReference: nullableStringSchema,
    listingTitle: nullableStringSchema,
    quantity: { type: 'number', example: 50 },
    unitPrice: { type: 'number', example: 750 },
    lineTotal: { type: 'number', example: 37500 },
  },
};

// orderToBuyerDto : aucune donnée fournisseur ni prix interne n'y figure.
const OrderSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 45 },
    orderNumber: { type: 'string', example: 'CMD-2026-000045' },
    status: {
      type: 'string',
      enum: ['QUOTED', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED'],
    },
    deliveryMode: {
      type: 'string',
      nullable: true,
      enum: ['HUB_PICKUP', 'AGENCY_DELIVERY', null],
    },
    items: { type: 'array', items: OrderItemSchema },
    subtotal: { type: 'number', example: 37500 },
    buyerFee: { type: 'number', example: 0 },
    deliveryFee: { type: 'number', example: 2500 },
    total: { type: 'number', example: 40000 },
    delivery: {
      type: 'object',
      nullable: true,
      description: 'Adresse de livraison, renseignée seulement en mode AGENCY_DELIVERY',
      properties: {
        zoneId: { type: 'integer', example: 3 },
        address: { type: 'string', example: 'Rue Njo-Njo, Yaoundé' },
        latitude: nullableNumberSchema,
        longitude: nullableNumberSchema,
      },
    },
    pickup: {
      type: 'object',
      nullable: true,
      description: 'Point de retrait, renseigné seulement en mode HUB_PICKUP',
      properties: {
        id: { type: 'integer', example: 5 },
        name: { type: 'string', example: 'Dépôt Ngaoundéré Centre' },
        address: { type: 'string', example: 'BP 12, Ngaoundéré' },
        city: nullableStringSchema,
      },
    },
    notes: nullableStringSchema,
    reservedUntil: {
      ...nullableDateTimeSchema,
      description: 'Échéance de réservation du stock, tant que le devis n\'est pas confirmé',
    },
    confirmedAt: nullableDateTimeSchema,
    completedAt: nullableDateTimeSchema,
    cancelledAt: nullableDateTimeSchema,
    cancellationReason: nullableStringSchema,
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const orderNotFound = {
  404: { description: 'Commande inexistante ou appartenant à un autre acheteur', content: makeErrorResponse('Commande introuvable') },
};

const forbiddenRole = {
  403: { description: "Rôle non autorisé", content: makeErrorResponse('Accès refusé pour ce rôle') },
};

export const orderOpenApi = {
  openapi: '3.0.3',
  info: { title: 'Module Commandes', version: '1.0.0' },
  paths: {
    // ── GET /orders ───────────────────────────────────────────────────────
    '/api/v2/orders': {
      get: {
        tags: ['Commandes'],
        summary: 'Lister ses commandes',
        security: [{ bearerAuth: [] }],
        parameters: paginationParams(),
        responses: {
          200: { description: 'Commandes de l\'acheteur connecté', content: makePaginatedResponse(OrderSchema) },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
        },
      },
    },

    // ── GET /orders/:id ───────────────────────────────────────────────────
    '/api/v2/orders/{id}': {
      get: {
        tags: ['Commandes'],
        summary: 'Consulter une commande',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant de la commande')],
        responses: {
          200: { description: 'Commande trouvée', content: makeSuccessResponse(OrderSchema) },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
          400: { description: 'Identifiant non numérique', content: makeErrorResponse('Identifiant invalide') },
          ...orderNotFound,
        },
      },
    },

    // ── POST /orders/:id/confirm ──────────────────────────────────────────
    '/api/v2/orders/{id}/confirm': {
      post: {
        tags: ['Commandes'],
        summary: 'Confirmer un devis',
        security: [{ bearerAuth: [] }],
        description: 'Un devis expire : au-delà de `reservedUntil`, la confirmation est refusée.',
        parameters: [makePathParam('id', 'Identifiant de la commande')],
        responses: {
          200: { description: 'Devis confirmé', content: makeSuccessResponse(OrderSchema) },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
          400: { description: 'Identifiant non numérique', content: makeErrorResponse('Identifiant invalide') },
          ...orderNotFound,
          409: {
            description: 'Devis expiré, ou transition d\'état refusée',
            content: makeErrorResponse('Devis expire', 'QUOTE_EXPIRED'),
          },
        },
      },
    },

    // ── POST /orders/:id/cancel ───────────────────────────────────────────
    '/api/v2/orders/{id}/cancel': {
      post: {
        tags: ['Commandes'],
        summary: 'Annuler une commande',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant de la commande')],
        requestBody: makeJoiRequestBody(orderCancelSchema, {
          required: false,
          description: 'Motif facultatif : une annulation n\'a pas toujours à être justifiée.',
        }),
        responses: {
          200: { description: 'Commande annulée', content: makeSuccessResponse(OrderSchema) },
          400: { description: 'Identifiant non numérique ou corps invalide', content: makeValidationErrorResponse() },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
          ...orderNotFound,
          409: {
            description: "Transition d'état refusée",
            content: makeErrorResponse('Transition refusée', 'INVALID_STATE_TRANSITION'),
          },
        },
      },
    },
  },
};