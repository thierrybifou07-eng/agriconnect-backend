const R = (ref) => ({ $ref: `#/components/responses/${ref}` });
const paginatedResponse = (schema, description) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: `#/components/schemas/${schema}` } },
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
        },
      },
    },
  },
});

const pagination = [
  { $ref: '#/components/parameters/PageParam' },
  { $ref: '#/components/parameters/LimitParam' },
];

const listOperation = (summary, schema, parameters = pagination, responseDescription) => ({
  tags: ['Référentiels'],
  summary,
  security: [{ bearerAuth: [] }],
  parameters,
  responses: {
    '200': paginatedResponse(
      schema,
      responseDescription ?? 'Référentiel actif paginé, trié par ordre alphabétique',
    ),
    '400': R('BadRequest'),
    '401': R('Unauthorized'),
    '403': R('Forbidden'),
  },
});

export default {
  openapi: '3.0.0',
  paths: {
    '/reference/categories': {
      get: listOperation('Catégories actives', 'ReferenceCategory'),
    },
    '/reference/units': {
      get: listOperation(
        'Unités',
        'ReferenceUnit',
        pagination,
        'Unités du référentiel, paginées et triées alphabétiquement (le modèle n’a pas de isActive)',
      ),
    },
    '/reference/products': {
      get: listOperation('Produits actifs', 'ReferenceProduct', [
        { in: 'query', name: 'categoryId', schema: { type: 'integer', minimum: 1 } },
        { in: 'query', name: 'q', schema: { type: 'string', minLength: 1, maxLength: 120 } },
        ...pagination,
      ]),
    },
    '/reference/zones': {
      get: listOperation('Zones actives', 'ReferenceZone'),
    },
    '/reference/hubs': {
      get: listOperation('Points de dépôt actifs', 'ReferenceHub', [
        { in: 'query', name: 'zoneId', schema: { type: 'integer', minimum: 1 } },
        { in: 'query', name: 'acceptsDropoff', schema: { type: 'boolean' } },
        { in: 'query', name: 'acceptsPickup', schema: { type: 'boolean' } },
        ...pagination,
      ]),
    },
  },
};
