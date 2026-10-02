import Joi from 'joi';
import prisma from '../config/prisma.js';

// helpers.error est l'idiome correct pour signaler un echec depuis .external() :
// lever une Error ordinaire sort de validateAsync telle quelle, le middleware
// ne voit donc pas une erreur Joi et repond 500 au lieu de 400.
//
// Le message est celui de Joi ("<champ>" contains an invalid value) : sur une
// regle .external(), .messages() et helpers.message() sont ignores, le message
// personnalisable n'est donc pas disponible ici.
const deliveryModeRule = Joi.string()
  .required()
  .external(async (code, helpers) => {
    const exists = await prisma.deliveryMode.findUnique({ where: { code } });
    if (!exists) return helpers.error('any.invalid');
    return code;
  });

// Listing.id est un Int auto-incremente : exiger un UUID rendait la creation de
// commande impossible ("must be a valid GUID"). convert:true accepte aussi la
// forme chaine, qu'un client mobile peut envoyer apres serialisation.
export const createOrderSchema = Joi.object({
  listingId: Joi.number().integer().positive().required(),
  quantity: Joi.number().greater(0).required(),
  deliveryMode: deliveryModeRule,
  deliveryAddress: Joi.string().optional().allow(null, ''),
  deliveryLatitude: Joi.number().min(-90).max(90).optional(),
  deliveryLongitude: Joi.number().min(-180).max(180).optional(),
});
