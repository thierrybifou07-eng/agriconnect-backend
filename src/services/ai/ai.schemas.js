export const supportReplySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'language', 'confidence', 'needs_human', 'reply', 'reasons'],
  properties: {
    intent: {
      type: 'string',
      enum: [
        'PRODUCT_QUESTION',
        'PRICE_QUOTE_REQUEST',
        'DELIVERY_QUESTION',
        'VERIFICATION_STATUS',
        'COMPLAINT',
        'OTHER',
      ],
    },
    language: { type: 'string', enum: ['fr', 'en'] },
    confidence: { type: 'number' },
    needs_human: { type: 'boolean' },
    reply: { type: 'string' },
    reasons: { type: 'array', items: { type: 'string' } },
  },
};
