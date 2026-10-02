import { Router } from 'express';
import {
  createOrder,
  getMyOrders,
  getOrderById,
  confirmOrder,
  cancelOrder,
  completeOrder,
} from '../controllers/order.controller.js';
import { protect, requireRole } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { coerceIdParam } from '../middlewares/params.middleware.js';
import { createOrderSchema } from '../validators/order.validator.js';

const router = Router();

// Toutes les cles primaires sont des Int : voir middlewares/params.middleware.js
router.param('id', coerceIdParam);

router.use(protect);

router.post('/', requireRole('BUYER'), validate(createOrderSchema), createOrder);
router.get('/', getMyOrders);
router.get('/:id', getOrderById);
router.patch('/:id/confirm', requireRole('FARMER'), confirmOrder);
router.patch('/:id/cancel', cancelOrder);
router.patch('/:id/complete', completeOrder);

export default router;
