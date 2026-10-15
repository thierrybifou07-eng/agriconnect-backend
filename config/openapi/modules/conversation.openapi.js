// config/openapi/modules/conversation.openapi.js
//
// Messagerie client <-> équipe (plan v2, P3.1). Toutes les routes exigent un
// compte authentifié : une conversation ne se lit et ne s'écrit qu'authentifié.
//
// Côté client, la règle est l'anonymat : le client parle à « l'équipe
// AgriConnect » et ne voit jamais d'agent identifié ni d'autre utilisateur
// (voir utils/dto/conversation.dto.js).

import {
  makeSuccessResponse,
  makeErrorResponse,
  makeValidationErrorResponse,
  makePaginatedResponse,
  makeJoiRequestBody,
  makePathParam,
  paginationParams,
  nullableDateTimeSchema,
  nullableIntegerSchema,
  nullableStringSchema,
} from '../openapi.helpers.js';
import {
  conversationCreateSchema,
  conversationMessageSchema,
} from '../../../src/validators/conversation.validator.js';

const ConversationClientSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 31 },
    type: {
      type: 'string',
      enum: ['BUYER_SUPPORT', 'SUPPLIER_SUPPORT'],
      description: "Déduit du rôle de l'auteur : un acheteur écrit au support acheteur",
    },
    status: { type: 'string', enum: ['OPEN', 'WAITING_CUSTOMER', 'CLOSED'] },
    subject: nullableStringSchema,
    listingId: {
      ...nullableIntegerSchema,
      description: "Annonce concernée ; absent d'une conversation ouverte par un fournisseur sur un lot",
    },
    escalatedAt: nullableDateTimeSchema,
    escalationReason: nullableStringSchema,
    lastMessageAt: { type: 'string', format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const MessageClientSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 512 },
    content: { type: 'string', example: 'Bonjour, le lot est-il toujours disponible ?' },
    senderLabel: {
      type: 'string',
      enum: ['Vous', 'Équipe AgriConnect'],
      description: "Provenance anonymisée : l'agent n'est jamais nommé",
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const conversationNotFound = {
  404: { description: 'Conversation introuvable ou appartenant à un autre utilisateur', content: makeErrorResponse('Conversation introuvable') },
};

export const conversationOpenApi = {
  openapi: '3.0.3',
  info: { title: 'Module Conversations', version: '1.0.0' },
  paths: {
    // ── POST /conversations ───────────────────────────────────────────────
    '/api/v2/conversations': {
      post: {
        tags: ['Conversations'],
        summary: 'Ouvrir une conversation avec son premier message',
        security: [{ bearerAuth: [] }],
        description:
          'Un BUYER ouvre sur une annonce (`listingId`), un SUPPLIER sur un lot ' +
          '(`lotId`) : envoyer le mauvais identifiant est refusé, jamais ignoré. ' +
          'Les autres rôles ne peuvent pas ouvrir de conversation.',
        requestBody: makeJoiRequestBody(conversationCreateSchema),
        responses: {
          201: {
            description: 'Conversation créée',
            content: makeSuccessResponse(ConversationClientSchema),
          },
          400: {
            description:
              "Rôle non autorisé, identifiant interdit pour ce rôle, ou corps invalide " +
              "(le cas Joi ajoute un tableau `details` champ par champ)",
            content: makeErrorResponse(
              "Seuls les acheteurs et les fournisseurs peuvent ouvrir une conversation",
            ),
          },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          404: {
            description: 'Annonce ou lot introuvable',
            content: makeErrorResponse('Annonce introuvable ou inactive'),
          },
        },
      },

      // ── GET /conversations ─────────────────────────────────────────────
      get: {
        tags: ['Conversations'],
        summary: 'Lister ses conversations',
        security: [{ bearerAuth: [] }],
        parameters: paginationParams(),
        responses: {
          200: {
            description: 'Conversations de l\'utilisateur connecté, la plus récente en tête',
            content: makePaginatedResponse(ConversationClientSchema),
          },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
        },
      },
    },

    // ── GET /conversations/:id/messages ───────────────────────────────────
    '/api/v2/conversations/{id}/messages': {
      get: {
        tags: ['Conversations'],
        summary: 'Lire le fil de discussion',
        security: [{ bearerAuth: [] }],
        description: "Les notes internes de l'équipe (isInternal) ne sont jamais renvoyées.",
        parameters: [makePathParam('id', 'Identifiant de la conversation'), ...paginationParams()],
        responses: {
          200: { description: 'Messages, du plus ancien au plus récent', content: makePaginatedResponse(MessageClientSchema) },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          404: conversationNotFound,
        },
      },

      // ── POST /conversations/:id/messages ───────────────────────────────
      post: {
        tags: ['Conversations'],
        summary: 'Répondre dans une conversation',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant de la conversation')],
        requestBody: makeJoiRequestBody(conversationMessageSchema),
        responses: {
          201: { description: 'Message envoyé', content: makeSuccessResponse(MessageClientSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          404: conversationNotFound,
        },
      },
    },
  },
};