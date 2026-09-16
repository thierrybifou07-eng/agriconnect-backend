import Joi from 'joi';

export const registerSchema = Joi.object({
  fullName: Joi.string().trim().min(2).required().messages({
    'string.min': 'Le nom complet doit contenir au moins 2 caractères',
  }),
  phone: Joi.string()
    .trim()
    .pattern(/^\+?[0-9]{8,15}$/)
    .required()
    .messages({ 'string.pattern.base': 'Numéro de téléphone invalide (8 à 15 chiffres, "+" optionnel)' }),
  email: Joi.string().trim().email().optional().allow(null, ''),
  password: Joi.string().min(6).required().messages({
    'string.min': 'Le mot de passe doit contenir au moins 6 caractères',
  }),
  // ADMIN/ROOT jamais acceptés ici, même si envoyés : voir PUBLIC_ROLES dans auth.controller.js
  role: Joi.string().valid('FARMER', 'BUYER', 'DRIVER').required().messages({
    'any.only': 'role doit être FARMER, BUYER ou DRIVER',
  }),
  location: Joi.string().optional().allow(null, ''),
  vehicleType: Joi.string().optional().allow(null, ''),
});

export const loginSchema = Joi.object({
  phone: Joi.string().required(),
  password: Joi.string().required(),
});

export const refreshSchema = Joi.object({
  refreshToken: Joi.string().required(),
});
