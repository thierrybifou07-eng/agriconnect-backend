// config/openapi/modules/health.openapi.js
//
// Sonde d'état. Elle n'appartient à aucun routeur : elle est déclarée
// directement dans src/app.js, avant le montage de /api/v2. Elle a donc son
// propre fragment, pour que la liste des surfaces documentées reste complète.

import { makeSuccessResponse } from '../openapi.helpers.js';

export const healthOpenApi = {
  openapi: '3.0.3',
  info: { title: 'Système', version: '1.0.0' },
  paths: {
    '/health': {
      get: {
        tags: ['Système'],
        summary: "État du service",
        description:
          "Sonde publique, sans authentification ni limitation de débit " +
          "(elle est déclarée avant le rate limiter de /api/v2).",
        responses: {
          200: {
            description: 'Service opérationnel',
            content: makeSuccessResponse({
              type: 'object',
              required: ['status'],
              properties: { status: { type: 'string', example: 'ok' } },
            }),
          },
        },
      },
    },
  },
};