// Fragment OpenAPI : /api/v2/conversations — messagerie client <-> équipe.

import {
  conversationCreateSchema,
  conversationMessageSchema,
} from '../src/validators/conversation.validator.js';
import { jsonBody } from './openapi.helpers.js';

const R = (ref) => ({ $ref: `#/components/responses/${ref}` });

export default {
  openapi: '3.0.0',
  paths: {
    '/conversations': {
      post: {
        tags: ['Conversations'],
        summary: 'Ouvre une conversation avec son premier message',
        description: 'listingId ou lotId selon le rôle ; envoyer les deux est refusé explicitement par le contrôleur, pas ignoré en silence.',
        requestBody: jsonBody(conversationCreateSchema),
        responses: {
          '201': {
            description: 'Conversation créée',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Conversation' } } },
          },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '404': { description: 'Référence introuvable', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      get: {
        tags: ['Conversations'],
        summary: 'Conversations du connecté',
        parameters: [
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': {
            description: 'Conversations de l\'utilisateur (ou de l\'équipe pour un agent)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: { type: 'array', items: { $ref: '#/components/schemas/Conversation' } },
                    page: { type: 'integer' },
                    limit: { type: 'integer' },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          '401': R('Unauthorized'),
        },
      },
    },

    '/conversations/{id}/messages': {
      get: {
        tags: ['Conversations'],
        summary: 'Messages du fil public',
        parameters: [
          { $ref: '#/components/parameters/IdParam' },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': {
            description: 'Messages (fil public)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
                    page: { type: 'integer' },
                    limit: { type: 'integer' },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          '401': R('Unauthorized'),
          '404': R('NotFound'),
        },
      },
      post: {
        tags: ['Conversations'],
        summary: 'Répond au fil public',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(conversationMessageSchema),
        responses: {
          '201': {
            description: 'Message envoyé',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } },
          },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '404': R('NotFound'),
        },
      },
    },
  },
};
