import Joi from 'joi';

const pagination = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
};

export const listReferenceSchema = Joi.object(pagination);

export const listProductsSchema = Joi.object({
  ...pagination,
  categoryId: Joi.number().integer().positive(),
  q: Joi.string().trim().min(1).max(120),
});

export const listHubsSchema = Joi.object({
  ...pagination,
  zoneId: Joi.number().integer().positive(),
  acceptsDropoff: Joi.boolean(),
  acceptsPickup: Joi.boolean(),
});
