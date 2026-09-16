const express = require('express');
const {
  createOrder,
  getMyOrders,
  getOrderById,
  confirmOrder,
  cancelOrder,
  completeOrder,
} = require('../controllers/order.controller');
const { protect, requireRole } = require('../middlewares/auth.middleware');
const handleValidation = require('../middlewares/validate.middleware');
const { createOrderRules } = require('../validators/order.validator');

const router = express.Router();

router.use(protect);

router.post('/', requireRole('BUYER'), createOrderRules, handleValidation, createOrder);
router.get('/', getMyOrders);
router.get('/:id', getOrderById);
router.patch('/:id/confirm', requireRole('FARMER'), confirmOrder);
router.patch('/:id/cancel', cancelOrder);
router.patch('/:id/complete', completeOrder);

module.exports = router;
