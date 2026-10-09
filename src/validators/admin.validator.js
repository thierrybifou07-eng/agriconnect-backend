import prisma from '../config/prisma.js';
import Joi from 'joi';

// Un compte staff se connecte avec le meme formulaire que les autres : ses
// contraintes sont celles de l inscription (src/validators/auth.validator.js).
const passwordRegex =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])(?!.*(.)\1\1\1)[A-Za-z\d@$!%*?&]{8,}$/;
const passwordPatternMessage =
  'Le mot de passe doit contenir au moins 8 caracteres, une majuscule, une minuscule, un chiffre et un caractere special (@$!%*?&)';

// POST /api/v2/admin/users — creation d un compte staff (ADMIN, AGENT, DRIVER)
// par un ADMIN ou ROOT. Selon le role, le corps emporte agent ou driver : ces
// deux profils n ont aucun sens pour un autre role, ils sont interdits hors de
// leur branche (Joi.forbidden ci-dessous).
export const createStaffUserSchema = Joi.object({
  // Aligne sur le modele User : le nom est stocke en deux colonnes. 'fullName'
  // n'existe pas en base, l'envoyer crashingait la creation du compte.
  firstname: Joi.string().trim().min(2).required(),
  lastname: Joi.string().trim().min(2).required(),
  phone: Joi.string()
    .trim()
    .pattern(/^\+?[0-9]{8,15}$/)
    .required()
    .messages({ 'string.pattern.base': 'Numéro de téléphone invalide (8 à 15 chiffres, "+" optionnel)' }),
  email: Joi.string().trim().email().required(),
  password: Joi.string().regex(passwordRegex).required(),
  role: Joi.string().valid('ADMIN', 'AGENT', 'DRIVER').required(),

  agent: Joi.when('role', {
    is: 'AGENT',
    then: Joi.object({
      displayName: Joi.string().trim().default('Équipe AgriConnect'),
      // Verification en base via .external() : une capacite inconnue doit etre
      // refusee ici (400), pas laisser la transaction echouer sur la liaison.
      capabilities: Joi.array()
        .items(Joi.string().trim())
        .unique()
        .default([])
        .external(async (codes, helpers) => {
          const rows = await prisma.agentCapability.findMany({
            where: { code: { in: codes } },
            select: { code: true },
          });
          const inconnues = codes.filter((code) => !rows.some((r) => r.code === code));
          if (inconnues.length > 0) return helpers.error('capabilities.unknown', { codes: inconnues });
          return codes;
        }),
    }),
    otherwise: Joi.forbidden(),
  }),
  driver: Joi.when('role', {
    is: 'DRIVER',
    then: Joi.object({
      // Un livreur appartient a une agence (plan v2, M3) : l agence doit exister
      // et etre active, sinon le livreur n aurait aucune affectation possible.
      agencyId: Joi.number()
        .integer()
        .positive()
        .required()
        .external(async (value, helpers) => {
          const agency = await prisma.transportAgency.findUnique({ where: { id: value } });
          if (!agency) return helpers.error('agency.unknown');
          if (!agency.isActive) return helpers.error('agency.inactive');
          return value;
        }),
      vehicleType: Joi.string().trim().max(50).allow(null).empty(''),
      plateNumber: Joi.string().trim().max(20).allow(null).empty(''),
    }),
    otherwise: Joi.forbidden(),
  }),
}).messages({
  // Joi.forbidden() emet une erreur de type object.unknown : c est ici que son
  // message est traduit, au niveau racine pour couvrir les deux branches.
  'object.unknown': "Champ refuse pour ce role",
  'capabilities.unknown': 'Capacites inconnues : {{#codes}}',
  'array.unique': 'Une capacite est repete',
  'agency.unknown': 'Agence introuvable',
  'agency.inactive': 'Agence inactive',
});

// POST /api/v2/admin/legal/:code/versions — création d'une version brouillon.
// 'fr' est obligatoire ( langue de repli ), 'en' est facultatif.
export const createLegalVersionSchema = Joi.object({
  version: Joi.string().trim().min(1).max(20).required(),
  translations: Joi.array()
    .items(
      Joi.object({
        locale: Joi.string().valid('fr', 'en').required(),
        title: Joi.string().trim().min(1).max(200).required(),
        content: Joi.string().trim().min(1).required(),
      })
    )
    .min(1)
    .required()
    .custom((value, helpers) => {
      if (!value.some((t) => t.locale === 'fr')) {
        return helpers.error('translations.frRequired');
      }
      return value;
    })
    .messages({
      translations_frRequired: 'La traduction fr est obligatoire',
    }),
});
