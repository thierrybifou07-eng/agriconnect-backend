// config/openapi/modules/legal.openapi.js
//
// Conditions générales d'utilisation. Seul fragment public de l'API : les CGU
// doivent être consultables sans compte, pour la mention légale.

import {
  makeSuccessResponse,
  makeErrorResponse,
  makePathParam,
  makeQueryParam,
  nullableDateTimeSchema,
  nullableStringSchema,
} from '../openapi.helpers.js';

// getLegalDocument : la version publiée et sa traduction, avec la langue
// réellement servie (elle peut différer de celle demandée, voir resolveLocale).
const LegalDocumentSchema = {
  type: 'object',
  properties: {
    code: { type: 'string', example: 'CGU' },
    version: { type: 'string', example: '1.2' },
    locale: {
      type: 'string',
      enum: ['fr', 'en'],
      description: "Langue réellement servie : celle demandée si elle existe, sinon fr",
    },
    title: { type: 'string', example: "Conditions générales d'utilisation" },
    content: { type: 'string', description: 'Contenu HTML', example: '<h1>Conditions</h1>' },
    publishedAt: { type: 'string', format: 'date-time', example: '2026-01-15T09:00:00.000Z' },
  },
};

export const legalOpenApi = {
  openapi: '3.0.3',
  info: { title: 'Module CGU', version: '1.0.0' },
  paths: {
    // ── GET /legal ───────────────────────────────────────────────────────
    '/api/v2/legal': {
      get: {
        tags: ['CGU'],
        summary: 'Lister les documents légaux',
        description:
          'Un document sans version publiée reste listé : `version` et ' +
          '`publishedAt` valent alors null.',
        responses: {
          200: {
            description: 'Documents légaux, triés par code',
            content: makeSuccessResponse({
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  code: { type: 'string', example: 'CGU' },
                  label: { type: 'string', example: "Conditions générales d'utilisation" },
                  version: nullableStringSchema,
                  publishedAt: nullableDateTimeSchema,
                },
              },
            }),
          },
          500: { description: 'Erreur serveur', content: makeErrorResponse('Erreur serveur interne') },
        },
      },
    },

    // ── GET /legal/:code ─────────────────────────────────────────────────
    '/api/v2/legal/{code}': {
      get: {
        tags: ['CGU'],
        summary: 'Consulter un document légal',
        parameters: [
          makePathParam('code', 'Code du document (CGU, CGV...)', { type: 'string' }),
          makeQueryParam('lang', "Langue souhaitée, sinon l'en-tête Accept-Language est lu", {
            type: 'string',
            enum: ['fr', 'en'],
          }),
        ],
        responses: {
          200: {
            description: 'Version publiée et sa traduction',
            content: makeSuccessResponse(LegalDocumentSchema),
          },
          404: {
            description: 'Document inconnu, sans version publiée, ou sans traduction fr',
            content: makeErrorResponse('Document introuvable ou non publié'),
          },
        },
      },
    },
  },
};