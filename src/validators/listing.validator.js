import Joi from 'joi';
import prisma from '../config/prisma.js';

const categoryRule = Joi.string()
  .trim()
  .external(async (code) => {
    if (code === undefined) return code;
    const exists = await prisma.listingCategory.findUnique({ where: { code } });
    if (!exists) throw new Error('category invalide');
    return code;
  });

const statusRule = Joi.string()
  .trim()
  .external(async (code) => {
    if (code === undefined) return code;
    const exists = await prisma.listingStatus.findUnique({ where: { code } });
    if (!exists) throw new Error('status invalide');
    return code;
  });

export const createListingSchema = Joi.object({
  title: Joi.string().trim().min(3).required().messages({
    'string.min': 'Le titre doit contenir au moins 3 caractères',
  }),
  category: categoryRule.required(),
  price: Joi.number().greater(0).required(),
  quantity: Joi.number().greater(0).required(),
  unit: Joi.string().trim().required(),
  location: Joi.string().trim().required(),
  description: Joi.string().optional().allow(null, ''),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
});

export const updateListingSchema = Joi.object({
  title: Joi.string().trim().min(3).optional(),
  category: categoryRule.optional(),
  price: Joi.number().greater(0).optional(),
  quantity: Joi.number().greater(0).optional(),
  unit: Joi.string().trim().optional(),
  location: Joi.string().trim().optional(),
  description: Joi.string().optional().allow(null, ''),
  status: statusRule.optional(),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
});
