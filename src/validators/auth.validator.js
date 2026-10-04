import Joi from 'joi';

const passwordRegex =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])(?!.*(.)\1\1\1)[A-Za-z\d@$!%*?&]{8,}$/;

const passwordPatternMessage =
  "Password must be at least 8 characters long and include at least one lowercase letter, one uppercase letter, one digit, one special character (@$!%*?&), and must not repeat the same character more than 3 times in a row";


export const registerSchema = Joi.object({
  firstname: Joi.string().trim().min(2).required().messages({
    'string.min': 'Le prénom complet doit contenir au moins 2 caractères',
  }),
  lastname: Joi.string().trim().min(2).required().messages({
    'string.min': 'Le nom complet doit contenir au moins 2 caractères',
  }),
  phone: Joi.string()
    .trim()
    .pattern(/^\+?[0-9]{8,15}$/)
    .required()
    .messages({ 'string.pattern.base': 'Numéro de téléphone invalide (8 à 15 chiffres, "+" optionnel)' }),
  email: Joi.string().email().required().messages({
    "string.empty": "Email is required",
    "string.email": "Email must be a valid email address",
    "string.base": "Email must be a string",
  }),
  password: Joi.string().regex(passwordRegex).required().messages({
    "string.empty": "Password is required",
    "string.base": "Password must be a string",
    "string.pattern.base": passwordPatternMessage,
  }),
  // ADMIN/ROOT jamais acceptés ici, même si envoyés : voir PUBLIC_ROLES dans auth.controller.js
  role: Joi.string().valid('FARMER', 'BUYER', 'DRIVER').required().messages({
    'any.only': 'role doit être FARMER, BUYER ou DRIVER',
  }),
  location: Joi.string().optional().allow(null, ''),
  vehicleType: Joi.string().optional().allow(null, ''),
});

export const loginSchema = Joi.object({
  email: Joi.string().required(),
  password: Joi.string().required(),
});

export const refreshSchema = Joi.object({
  refreshToken: Joi.string().required(),
});

// Les jetons a usage unique sont des hex de 80 caracteres produits par
// crypto.randomBytes(40). La longueur est donc une constante du systeme, pas un
// format que l'on invente ici : un jeton d'une autre longueur ne peut venir que
// d'ailleurs, et le refuser tot evite une interrogation de base inutile.
//
// Le meme schema sert au GET (parametre de requete) et au POST (champ de
// formulaire) : les deux transportent exactement la meme valeur.
export const oneTimeTokenSchema = Joi.object({
  token: Joi.string()
    .pattern(/^[a-f0-9]{80}$/)
    .required()
    .messages({
      'string.pattern.base': 'Lien invalide',
      'any.required': 'Lien invalide',
    }),
});

export const resetPasswordSchema = oneTimeTokenSchema.keys({
  password: Joi.string().regex(passwordRegex).required().messages({
    'string.empty': 'Mot de passe requis',
    'string.pattern.base': passwordPatternMessage,
  }),
});
