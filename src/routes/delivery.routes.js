import { Router } from 'express';
import {
  getAvailableDeliveries,
  getMyDeliveries,
  acceptDelivery,
  updateDeliveryStatus,
} from '../controllers/delivery.controller.js';
import { protect, requireRole } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(protect, requireRole('DRIVER'));

router.get('/available', getAvailableDeliveries);
router.get('/mine', getMyDeliveries);
router.post('/:id/accept', acceptDelivery);
router.patch('/:id/status', updateDeliveryStatus);

export default router;
