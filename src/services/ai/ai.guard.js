import Joi from 'joi';
import { AiError } from './ai.error.js';

const supportReplyJoiSchema = Joi.object({
  intent: Joi.string().valid(
    'PRODUCT_QUESTION',
    'PRICE_QUOTE_REQUEST',
    'DELIVERY_QUESTION',
    'VERIFICATION_STATUS',
    'COMPLAINT',
    'OTHER',
  ).required(),
  language: Joi.string().valid('fr', 'en').required(),
  confidence: Joi.number().min(0).max(1).required(),
  needs_human: Joi.boolean().required(),
  reply: Joi.string().max(800).required(),
  reasons: Joi.array().items(Joi.string().max(160)).max(5).required(),
}).unknown(false);

const normalizeNumber = (value) => value.replace(/[\s,]/g, '').replace(/[.]+$/, '');

export function validateSupportOutput(raw, { allowedNumbers = new Set() } = {}) {
  const truncated = raw && typeof raw === 'object' && typeof raw.reply === 'string'
    ? { ...raw, reply: Array.from(raw.reply).slice(0, 800).join('') }
    : raw;
  const { error, value } = supportReplyJoiSchema.validate(truncated, { abortEarly: false });
  if (error) {
    return { ok: false, data: null, warnings: ['AI_INVALID_OUTPUT'] };
  }

  const reply = value.reply;
  if (/https?:\/\/|www\./i.test(reply) || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(reply) || /\+?\d[\d\s().-]{7,}/.test(reply)) {
    return { ok: false, data: null, warnings: ['AI_INVALID_OUTPUT'] };
  }

  const allowed = new Set([...allowedNumbers].map((number) => normalizeNumber(String(number))));
  const warnings = [];
  for (const match of reply.matchAll(/\d[\d\s.,]*/g)) {
    const number = normalizeNumber(match[0].trim());
    if (number && !allowed.has(number) && !warnings.includes(`UNVERIFIED_NUMBER:${number}`)) {
      warnings.push(`UNVERIFIED_NUMBER:${number}`);
    }
  }

  return {
    ok: true,
    data: { ...value, needs_human: value.needs_human || warnings.length > 0 },
    warnings,
  };
}

export function parseAndValidateSupportOutput(raw, options) {
  const result = validateSupportOutput(raw, options);
  if (!result.ok) throw new AiError('AI_INVALID_OUTPUT', 'La sortie IA ne respecte pas les règles de sécurité');
  return result;
}
