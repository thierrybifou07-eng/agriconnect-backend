// Fragment OpenAPI : /api/v2/legal — CGU versionnées, publiques.

export default {
  openapi: '3.0.0',
  paths: {
    '/legal': {
      get: {
        tags: ['CGU'],
        summary: 'Documents courants (publique)',
        security: [],
        responses: {
          '200': {
            description: 'Liste des documents avec version publiée',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      code: { type: 'string', example: 'CGU' },
                      label: { type: 'string' },
                      version: { type: 'string', example: '1.0' },
                      publishedAt: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    '/legal/{code}': {
      get: {
        tags: ['CGU'],
        summary: 'Contenu d\'une version publiée, FR ou EN',
        description: '\'?lang=\' ou en-tête Accept-Language > fr. Repli sur fr si la langue manque ; le champ locale donne la langue réelle.',
        security: [],
        parameters: [
          { $ref: '#/components/parameters/LegalCodeParam' },
          {
            in: 'query',
            name: 'lang',
            schema: { type: 'string', enum: ['fr', 'en'] },
          },
        ],
        responses: {
          '200': {
            description: 'Contenu du document',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    code: { type: 'string' },
                    version: { type: 'string' },
                    locale: { type: 'string', example: 'fr' },
                    title: { type: 'string' },
                    content: { type: 'string' },
                    publishedAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          '404': {
            description: 'Code inconnu ou sans version publiée',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
  },
};
