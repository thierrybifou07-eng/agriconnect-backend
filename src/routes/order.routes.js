import { Router } from 'express';
import {
  listMesCommandes,
  getMaCommande,
  confirmerCommande,
  annulerMaCommande,
} from '../controllers/order.controller.js';
import { protect, requireRole } from '../middlewares/auth.middleware.js';
import { coerceIdParam } from '../middlewares/params.middleware.js';
import { requireVerifiedProfile } from '../middlewares/verification.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { orderCancelSchema } from '../validators/order.validator.js';

const router = Router();

// :id est un identifiant entier partout (D2) : la conversion numerique
// s'applique avant tout controleur.
router.param('id', coerceIdParam);

// Les routes de commande du cote acheteur ne concernent que l'acheteur
// connecte : un acheteur n'agit que sur ses propres commandes (le
// controleur repond 404 pour toute commande qui n'est pas la sienne).
const ACHETEUR = [protect, requireRole('BUYER')];

// Meme chaine pour la confirmation, completee par le controle de verification
// du profil (D2) : confirmer un devis engage l'acheteur sur un contrat, donc
// un profil VERIFIED est exige. Lire ses commandes ou annuler un devis reste
// possible sans etre verifie.
const ACHETEUR_VERIFIE = [protect, requireRole('BUYER'), requireVerifiedProfile];

// Cycle de vie de la commande cote acheteur (plan v2, P3.5) : consultation
// de ses commandes, confirmation et annulation d'un devis.
router.get('/', ACHETEUR, listMesCommandes);
router.get('/:id', ACHETEUR, getMaCommande);
router.post('/:id/confirm', ACHETEUR_VERIFIE, confirmerCommande);
router.post('/:id/cancel', ACHETEUR, validate(orderCancelSchema), annulerMaCommande);

export default router;
