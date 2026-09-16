import Joi from 'joi';
import prisma from '../config/prisma.js';

const deliveryModeRule = Joi.string()
  .required()
  .external(async (code) => {
    const exists = await prisma.deliveryMode.findUnique({ where: { code } });
    if (!exists) throw new Error('deliveryMode invalide');
    return code;
  });

export const createOrderSchema = Joi.object({
  listingId: Joi.string().uuid().required(),
  quantity: Joi.number().greater(0).required(),
  deliveryMode: deliveryModeRule,
  deliveryAddress: Joi.string().optional().allow(null, ''),
  deliveryLatitude: Joi.number().min(-90).max(90).optional(),
  deliveryLongitude: Joi.number().min(-180).max(180).optional(),
});
