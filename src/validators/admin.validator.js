import Joi from 'joi';

export const createAdminSchema = Joi.object({
  fullName: Joi.string().trim().min(2).required(),
  phone: Joi.string()
    .trim()
    .pattern(/^\+?[0-9]{8,15}$/)
    .required()
    .messages({ 'string.pattern.base': 'Numéro de téléphone invalide (8 à 15 chiffres, "+" optionnel)' }),
  email: Joi.string().trim().email().optional().allow(null, ''),
  password: Joi.string().min(6).required(),
});
