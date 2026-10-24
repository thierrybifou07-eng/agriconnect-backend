import Joi from 'joi';

export const testAiSchema = Joi.object({
  prompt: Joi.string().trim().min(1).max(1000),
}).default({});

export const aiSuggestionListQuerySchema = Joi.object({
  status: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED', 'EXPIRED'),
  kind: Joi.string().valid('REPLY', 'TRIAGE', 'LISTING_DRAFT'),
  conversationId: Joi.number().integer().positive(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
}).unknown(false);

export const aiSuggestionApproveSchema = Joi.object({
  editedContent: Joi.string().max(5000).allow('').optional(),
}).unknown(false);

export const aiSuggestionRejectSchema = Joi.object({
  reason: Joi.string().trim().max(500).allow('').optional(),
}).unknown(false);
