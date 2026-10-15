// config/openapi/modules/driver.openapi.js
//
// Courses du livreur connecté. Toutes les routes exigent un compte DRIVER
// actif rattaché à une agence (requireRole + profil livreur).
//
// La livraison exposée au livreur ne contient AUCUN montant : il n'a pas à
// connaître la tarification, la valeur assurée ni les frais d'agence
// (voir utils/dto/delivery.dto.js).

import Joi from 'joi';
import {
  makeSuccessResponse,
  makeErrorResponse,
  makeValidationErrorResponse,
  makePaginatedResponse,
  makeJoiRequestBody,
  makePathParam,
  makeQueryParam,
  paginationParams,
  nullableDateTimeSchema,
  nullableNumberSchema,
  nullableStringSchema,
} from '../openapi.helpers.js';

// Schéma défini en ligne dans driver.routes.js : le livreur fait avancer sa
// propre course, et FAILED impose un motif.
const statusSchema = Joi.object({
  status: Joi.string().valid('PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED').required(),
  failureReason: Joi.string()
    .trim()
    .max(500)
    .when('status', { is: 'FAILED', then: Joi.required(), otherwise: Joi.optional() }),
});

const DeliveryDriverSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 88 },
    status: {
      type: 'string',
      enum: ['PENDING', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED'],
    },
    pickupAddress: nullableStringSchema,
    pickupLatitude: { ...nullableNumberSchema, example: 7.34 },
    pickupLongitude: { ...nullableNumberSchema, example: 13.23 },
    dropoffAddress: { type: 'string', example: 'Marché central, Yaoundé' },
    dropoffLatitude: { ...nullableNumberSchema, example: 3.87 },
    dropoffLongitude: { ...nullableNumberSchema, example: 11.52 },
    distanceKm: nullableNumberSchema,
    buyer: {
      type: 'object',
      nullable: true,
      description: 'Destinataire, pour le contacter en cas de besoin',
      properties: {
        firstname: { type: 'string', example: 'Awa' },
        lastname: { type: 'string', example: 'Ndiaye' },
        phone: { type: 'string', example: '+237699112233' },
      },
    },
    items: {
      type: 'array',
      description: 'Nature de la marchandise, sans prix',
      items: {
        type: 'object',
        properties: {
          productName: nullableStringSchema,
          categoryName: nullableStringSchema,
          quantity: { type: 'number', example: 50 },
        },
      },
    },
    acceptedAt: nullableDateTimeSchema,
    pickedUpAt: nullableDateTimeSchema,
    deliveredAt: nullableDateTimeSchema,
    failureReason: nullableStringSchema,
  },
};

const noDriverProfile = {
  403: {
    description: 'Le compte n\'a pas de profil livreur actif',
    content: makeErrorResponse('Profil livreur introuvable', 'NO_DRIVER_PROFILE'),
  },
};

const forbiddenRole = {
  403: { description: "Rôle non autorisé", content: makeErrorResponse('Accès refusé pour ce rôle') },
};

export const driverOpenApi = {
  openapi: '3.0.3',
  info: { title: 'Module Livreur', version: '1.0.0' },
  paths: {
    // ── GET /driver/deliveries/available ──────────────────────────────────
    '/api/v2/driver/deliveries/available': {
      get: {
        tags: ['Livreur'],
        summary: 'Lister les courses à prendre',
        security: [{ bearerAuth: [] }],
        description:
          'Courses PENDING de la même agence, sans livreur, les plus anciennes ' +
          'd\'abord. Un livreur ne peut avoir qu\'une course en cours.',
        parameters: paginationParams(),
        responses: {
          200: { description: 'Courses disponibles', content: makePaginatedResponse(DeliveryDriverSchema) },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
          ...noDriverProfile,
        },
      },
    },

    // ── GET /driver/deliveries/mine ───────────────────────────────────────
    '/api/v2/driver/deliveries/mine': {
      get: {
        tags: ['Livreur'],
        summary: 'Lister ses courses',
        security: [{ bearerAuth: [] }],
        parameters: [
          makeQueryParam('status', "Filtrer par statut (non validé : une valeur inconnue renvoie une liste vide)", {
            type: 'string',
            enum: ['PENDING', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED'],
          }),
          ...paginationParams(),
        ],
        responses: {
          200: { description: 'Courses du livreur connecté', content: makePaginatedResponse(DeliveryDriverSchema) },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
          ...noDriverProfile,
        },
      },
    },

    // ── POST /driver/deliveries/:id/accept ────────────────────────────────
    '/api/v2/driver/deliveries/{id}/accept': {
      post: {
        tags: ['Livreur'],
        summary: 'Prendre une course',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant de la livraison')],
        responses: {
          200: { description: 'Course prise (statut ACCEPTED)', content: makeSuccessResponse(DeliveryDriverSchema) },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
          ...noDriverProfile,
          409: {
            description: 'Course déjà prise, ou le livreur a déjà une course en cours',
            content: makeErrorResponse('Course déjà prise', 'DELIVERY_ALREADY_TAKEN'),
          },
        },
      },
    },

    // ── PATCH /driver/deliveries/:id/status ───────────────────────────────
    '/api/v2/driver/deliveries/{id}/status': {
      patch: {
        tags: ['Livreur'],
        summary: 'Faire avancer sa course',
        security: [{ bearerAuth: [] }],
        description:
          'Effets de bord : `PICKED_UP` passe la commande en OUT_FOR_DELIVERY, ' +
          'et `DELIVERED` termine la commande quand toutes ses livraisons le sont.',
        parameters: [makePathParam('id', 'Identifiant de la livraison')],
        requestBody: makeJoiRequestBody(statusSchema),
        responses: {
          200: { description: 'Statut mis à jour', content: makeSuccessResponse(DeliveryDriverSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
          ...noDriverProfile,
          404: {
            description: 'Livraison introuvable',
            content: makeErrorResponse('Livraison introuvable', 'DELIVERY_NOT_FOUND'),
          },
          409: {
            description: "Transition d'état refusée, ou livraison d'un autre livreur",
            content: makeErrorResponse('Transition refusée', 'INVALID_STATE_TRANSITION'),
          },
        },
      },
    },
  },
};