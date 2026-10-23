// Fragment OpenAPI : /api/v2/driver — courses du livreur connecté.

import Joi from 'joi';
import { jsonBody } from './openapi.helpers.js';

const R = (ref) => ({ $ref: `#/components/responses/${ref}` });

// Schéma inline défini dans driver.routes.js (pas dans un fichier validator).
const statusSchema = Joi.object({
  status: Joi.string().valid('PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED').required(),
  failureReason: Joi.string()
    .trim()
    .max(500)
    .when('status', { is: 'FAILED', then: Joi.required(), otherwise: Joi.optional() }),
});

export default {
  openapi: '3.0.0',
  paths: {
    '/driver/deliveries/available': {
      get: {
        tags: ['Livreur'],
        summary: 'Courses disponibles (PENDING, non assignées)',
        parameters: [
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': {
            description: 'Courses disponibles',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: { type: 'array', items: { $ref: '#/components/schemas/DriverDelivery' } },
                    page: { type: 'integer' },
                    limit: { type: 'integer' },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/driver/deliveries/mine': {
      get: {
        tags: ['Livreur'],
        summary: 'Courses du livreur connecté',
        parameters: [
          { in: 'query', name: 'status', schema: { type: 'string' } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': {
            description: 'Courses du livreur',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: { type: 'array', items: { $ref: '#/components/schemas/DriverDelivery' } },
                    page: { type: 'integer' },
                    limit: { type: 'integer' },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/driver/deliveries/{id}/accept': {
      post: {
        tags: ['Livreur'],
        summary: 'Accepte une course (PENDING -> ACCEPTED)',
        description: 'Premier arrivé, premier servi. Livreur déjà en course -> 409 DELIVERY_ALREADY_ACTIVE.',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': {
            description: 'Course acceptée',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DriverDelivery' } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': { description: 'Course introuvable (DELIVERY_NOT_FOUND) ou déjà prise (DELIVERY_ALREADY_TAKEN)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '409': { description: 'Course déjà prise (DELIVERY_ALREADY_TAKEN) ou livreur en course (DELIVERY_ALREADY_ACTIVE)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/driver/deliveries/{id}/status': {
      patch: {
        tags: ['Livreur'],
        summary: 'Fait avancer sa course',
        description: 'FAILED exige failureReason.',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(statusSchema),
        responses: {
          '200': {
            description: 'Statut mis à jour',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DriverDelivery' } } },
          },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': { description: 'Course introuvable (DELIVERY_NOT_FOUND) ou pas au livreur (NOT_DELIVERY_OWNER)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
  },
};
