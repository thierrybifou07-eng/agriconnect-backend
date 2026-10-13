import { Router } from 'express';
import Joi from 'joi';
import {
  listAvailable,
  listMine,
  acceptDelivery,
  updateDeliveryStatus,
} from '../controllers/driverDelivery.controller.js';
import { protect, requireRole } from '../middlewares/auth.middleware.js';
import { coerceIdParam } from '../middlewares/params.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';

const router = Router();

// :id est un identifiant entier partout (D2) : la conversion numérique
// s'applique avant tout contrôleur.
router.param('id', coerceIdParam);

// Toutes les routes du livreur exigent un compte DRIVER actif.
const DRIVER = [protect, requireRole('DRIVER')];

// Les routes disponibles et mine doivent etre declarees AVANT /:id pour
// eviter que le parametre :id capture "available" ou "mine".
router.get('/deliveries/available', DRIVER, listAvailable);
router.get('/deliveries/mine', DRIVER, listMine);

router.post('/deliveries/:id/accept', DRIVER, acceptDelivery);

// Changement de statut : le livreur fait avancer sa course. FAILED exige
// un motif (failureReason obligatoire).
const statusSchema = Joi.object({
  status: Joi.string()
    .valid('PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED')
    .required(),
  failureReason: Joi.string()
    .trim()
    .max(500)
    .when('status', { is: 'FAILED', then: Joi.required(), otherwise: Joi.optional() }),
});
router.patch('/deliveries/:id/status', DRIVER, validate(statusSchema), updateDeliveryStatus);

export default router;
