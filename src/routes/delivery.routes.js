import { Router } from 'express';
import {
  getAvailableDeliveries,
  getMyDeliveries,
  acceptDelivery,
  updateDeliveryStatus,
} from '../controllers/delivery.controller.js';
import { protect, requireRole } from '../middlewares/auth.middleware.js';
import { coerceIdParam } from '../middlewares/params.middleware.js';

const router = Router();

// Toutes les cles primaires sont des Int : voir middlewares/params.middleware.js
router.param('id', coerceIdParam);

router.use(protect, requireRole('DRIVER'));

router.get('/available', getAvailableDeliveries);
router.get('/mine', getMyDeliveries);
router.post('/:id/accept', acceptDelivery);
router.patch('/:id/status', updateDeliveryStatus);

export default router;
