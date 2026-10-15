// Fragment OpenAPI : /api/v2/catalog — catalogue acheteur (jamais les lots).

const R = (ref) => ({ $ref: `#/components/responses/${ref}` });

export default {
  openapi: '3.0.0',
  paths: {
    '/catalog/categories': {
      get: {
        tags: ['Catalogue'],
        summary: 'Catégories (acheteur, équipe)',
        description: 'BUYER, AGENT, ADMIN, ROOT. SUPPLIER et DRIVER exclus.',
        responses: {
          '200': {
            description: 'Catégories actives',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Category' } } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/catalog/listings': {
      get: {
        tags: ['Catalogue'],
        summary: 'Annonces visibles (ACTIVE)',
        description: 'Le catalogue acheteur n\'utilise PAS les lots : il utilise les annonces. Une annonce SOLD ou INACTIVE n\'y figure plus.',
        parameters: [
          { in: 'query', name: 'categoryId', schema: { type: 'integer' } },
          { in: 'query', name: 'productId', schema: { type: 'integer' } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': { $ref: '#/components/responses/PaginatedCatalogListings' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/catalog/listings/{id}': {
      get: {
        tags: ['Catalogue'],
        summary: 'Détail d\'une annonce (DTO acheteur)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': {
            description: 'Annonce avec produit, photos et prix public',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CatalogListing' } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': { description: 'Annonce inactive ou introuvable', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
  },
};
