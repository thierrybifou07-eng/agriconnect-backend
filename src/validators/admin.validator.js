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
          // helpers.message avec texte français : dans un .external(), Joi
          // force le type d'erreur à 'external' et les messages du bloc
          // .messages() ci-dessous ne sont PAS hérités par ce champ — le
          // template du même nom est donc passé en premier argument, le
          // contexte en second.
          if (inconnues.length > 0)
            return helpers.message({ external: 'Capacites inconnues : {{#codes}}' }, { codes: inconnues });
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
          // helpers.message avec texte français : dans un .external(), Joi
          // force le type d'erreur à 'external' et les messages du bloc
          // .messages() ci-dessous ne sont PAS hérités par ce champ — le
          // template du même nom est donc passé en premier argument, le
          // texte en second (voir capabilities plus haut).
          if (!agency) return helpers.message({ external: '{{#custom}}' }, { custom: 'Agence introuvable' });
          if (!agency.isActive) return helpers.message({ external: '{{#custom}}' }, { custom: 'Agence inactive' });
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
  'array.unique': 'Une capacite est repete',
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

// PATCH /api/v2/admin/settings — modification partielle des réglages de la
// plateforme, réservée à ROOT. Au moins un champ (Joi.min(1) : un corps vide
// est un 400, pas une modification silencieuse).
//
// currency est en lecture seule : Joi.forbidden() fait renvoyer un 400 explicite
// quand elle est fournie, plutôt que de la supprimer en silence avec
// stripUnknown (middlewares/validate.middleware.js).
export const updateSettingsSchema = Joi.object({
  // Bornes alignées sur le schéma (Decimal(5,4) pour les taux) : une valeur
  // hors bornes corromprait chaque nouveau devis, donc elle est refusée ici
  // (400), jamais bornée silencieusement.
  supplierCommissionRate: Joi.number().min(0).max(0.5),
  buyerFeeType: Joi.string().valid('NONE', 'FIXED', 'PERCENT'),
  // PERCENT : la valeur est un taux (1 = 100 %) ; NONE/FIXED : un montant.
  buyerFeeValue: Joi.number()
    .min(0)
    .when('buyerFeeType', {
      is: 'PERCENT',
      then: Joi.number().max(1),
      otherwise: Joi.number(),
    }),
  transportMarkupRate: Joi.number().min(0).max(1),
  referralBuyerReward: Joi.number().min(0),
  referralSupplierReward: Joi.number().min(0),
  // Une réservation dure entre 1 heure et une semaine : au-delà, le stock serait
  // bloqué sans raison.
  reservationHours: Joi.number().integer().min(1).max(168),
  expiryCompensationRate: Joi.number().min(0).max(1),
  currency: Joi.forbidden(),
})
  .min(1)
  .messages({
    'object.min': 'Aucun champ à modifier',
    'any.unknown': 'Champ non autorisé',
    'number.min': 'La valeur minimale est {{#limit}}',
    'number.max': 'La valeur maximale est {{#limit}}',
    'number.integer': 'La valeur doit être un entier',
  });

// PATCH /api/v2/admin/referrals/:id/pay — référence de paiement obligatoire.
// Le parrainage ne peut être payé qu'une seule fois : la référence permet de
// tracer le paiement dans l'audit.
export const payReferralSchema = Joi.object({
  reference: Joi.string().trim().min(1).max(100).required(),
});

// PATCH /api/v2/admin/referrals/:id/reject — motif obligatoire. Rejeter sans
// dire pourquoi priverait le parrain de toute correction possible.
export const rejectReferralSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(2000).required(),
});
