import Joi from 'joi';

export const createAdminSchema = Joi.object({
  // Aligne sur le modele User : le nom est stocke en deux colonnes. 'fullName'
  // n'existe pas en base, l'envoyer crashingait la creation du compte.
  firstname: Joi.string().trim().min(2).required(),
  lastname: Joi.string().trim().min(2).required(),
  phone: Joi.string()
    .trim()
    .pattern(/^\+?[0-9]{8,15}$/)
    .required()
    .messages({ 'string.pattern.base': 'Numéro de téléphone invalide (8 à 15 chiffres, "+" optionnel)' }),
  email: Joi.string().trim().email().optional().allow(null, ''),
  password: Joi.string().min(6).required(),
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
