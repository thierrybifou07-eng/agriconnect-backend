const R = (ref) => ({ $ref: `#/components/responses/${ref}` });
const response = (description, schema) => ({
  description,
  content: { 'application/json': { schema } },
});
const error = { $ref: '#/components/schemas/Error' };

const supportOutput = {
  type: 'object',
  required: ['intent', 'language', 'confidence', 'needs_human', 'reply', 'reasons', 'warnings'],
  properties: {
    intent: { type: 'string', enum: ['PRODUCT_QUESTION', 'PRICE_QUOTE_REQUEST', 'DELIVERY_QUESTION', 'VERIFICATION_STATUS', 'COMPLAINT', 'OTHER'] },
    language: { type: 'string', enum: ['fr', 'en'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    needs_human: { type: 'boolean' },
    reply: { type: 'string', maxLength: 800 },
    reasons: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 160 } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

export default {
  openapi: '3.0.0',
  paths: {
    '/admin/ai/status': {
      get: {
        tags: ['IA'],
        summary: 'État du moteur IA local',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': response('État du fournisseur et du modèle configuré', {
            type: 'object',
            required: ['enabled', 'provider', 'baseUrl', 'model', 'reachable', 'modelInstalled', 'capabilities', 'lastLatencyMs', 'queue', 'autonomousEnabled'],
            properties: {
              enabled: { type: 'boolean' },
              provider: { type: 'string', enum: ['ollama'] },
              baseUrl: { type: 'string', format: 'uri' },
              model: { type: 'string', nullable: true },
              reachable: { type: 'boolean' },
              modelInstalled: { type: 'boolean' },
              capabilities: { type: 'array', items: { type: 'string' } },
              lastLatencyMs: { type: 'integer', nullable: true },
              queue: {
                type: 'object',
                properties: { pending: { type: 'integer' }, running: { type: 'integer' } },
              },
              autonomousEnabled: { type: 'boolean' },
            },
          }),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },
    '/admin/ai/test': {
      post: {
        tags: ['IA'],
        summary: 'Teste une génération structurée sur le modèle local',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: { prompt: { type: 'string', minLength: 1, maxLength: 1000 } },
              },
            },
          },
        },
        responses: {
          '200': response('Génération structurée validée par la garde de sortie', {
            type: 'object',
            required: ['ok', 'latencyMs', 'output'],
            properties: {
              ok: { type: 'boolean', enum: [true] },
              latencyMs: { type: 'integer', minimum: 0 },
              output: supportOutput,
            },
          }),
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '409': response('Moteur IA désactivé', error),
          '429': response('Limite de test atteinte', error),
          '502': response('Ollama inaccessible, modèle absent ou sortie invalide', error),
        },
      },
    },
  },
};
