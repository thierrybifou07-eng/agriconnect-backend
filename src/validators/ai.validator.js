import Joi from 'joi';

export const testAiSchema = Joi.object({
  prompt: Joi.string().trim().min(1).max(1000),
}).default({});
