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
  // ADMIN/AGENT/ROOT/DRIVER jamais acceptés ici, même si envoyés : voir PUBLIC_ROLES dans auth.controller.js
  role: Joi.string().valid('SUPPLIER', 'BUYER').required().messages({
    'any.only': 'role doit être SUPPLIER ou BUYER',
  }),
  location: Joi.string().optional().allow(null, ''),
  // L'inscription emporte acceptation des documents requis pour le role : le
  // controller enregistre une TermsAcceptance par document, donc sans accord
  // explicite il n'y a rien a enregistrer.
  acceptTerms: Joi.boolean().valid(true).required().messages({
    'any.required': 'Vous devez accepter les conditions',
    'any.only': 'Vous devez accepter les conditions',
  }),
  referralCode: Joi.string().trim().max(20).optional(),
  farmName: Joi.string().trim().min(2).max(120).optional(),
  buyerType: Joi.string().valid('RETAILER', 'FARMER', 'WHOLESALER', 'OTHER').optional(),
  businessName: Joi.string().trim().max(120).optional(),
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

// forgot-password : seule l'adresse est demandee, et elle doit ressembler a une
// adresse. Un format invalide est rejete ici plutot que d'atteindre la base ;
// le message reste par ailleurs identique a celui d'un compte inconnu.
export const forgotPasswordSchema = Joi.object({
  email: Joi.string().trim().email().required().messages({
    'string.email': 'Email must be a valid email address',
    'string.empty': 'Email is required',
    'any.required': 'Email is required',
  }),
});

// PATCH /api/v2/auth/me/profile — un role ne peut modifier que les champs de
// son propre profil : un SUPPLIER n a pas a connaitre ceux d un BUYER, et
// inversement. Le schema applique depend du role (voir auth.routes.js) ; les
// champs d un autre role sont refuses par stripUnknown du middleware de
// validation. zoneId est optionnel et nullable (la colonne l est) : son
// existence est verifiee par le controleur, pas ici.
export const supplierProfileSchema = Joi.object({
  farmName: Joi.string().trim().min(2).max(120).optional(),
  description: Joi.string().trim().max(2000).allow(null).optional(),
  zoneId: Joi.number().integer().positive().allow(null).optional(),
});

export const buyerProfileSchema = Joi.object({
  buyerType: Joi.string().valid('RETAILER', 'FARMER', 'WHOLESALER', 'OTHER').optional(),
  businessName: Joi.string().trim().max(120).allow(null).optional(),
  zoneId: Joi.number().integer().positive().allow(null).optional(),
});

export const driverProfileSchema = Joi.object({
  vehicleType: Joi.string().trim().max(50).allow(null).optional(),
  plateNumber: Joi.string().trim().max(20).allow(null).optional(),
});

// Comptes de paiement (SUPPLIER et BUYER). Le numero est requis a la creation
// et fait au moins quatre caracteres : le masque n expose que les quatre
// derniers, un numero plus court n aurait pas de sens. Il n est jamais
// renvoye par l API : voir payoutAccountToApi dans utils/userApi.js.
export const payoutAccountCreateSchema = Joi.object({
  method: Joi.string().valid('MOBILE_MONEY', 'BANK_TRANSFER', 'CASH').required(),
  provider: Joi.string().trim().max(80).allow(null).optional(),
  accountNumber: Joi.string().trim().min(4).max(64).required(),
  accountName: Joi.string().trim().max(120).allow(null).optional(),
  isDefault: Joi.boolean().optional(),
});

// Meme formulaire, mais partiel : un PATCH ne renvoie que ce qui change.
export const payoutAccountUpdateSchema = Joi.object({
  method: Joi.string().valid('MOBILE_MONEY', 'BANK_TRANSFER', 'CASH').optional(),
  provider: Joi.string().trim().max(80).allow(null).optional(),
  accountNumber: Joi.string().trim().min(4).max(64).optional(),
  accountName: Joi.string().trim().max(120).allow(null).optional(),
  isDefault: Joi.boolean().optional(),
});
