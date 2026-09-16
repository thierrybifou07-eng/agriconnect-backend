const express = require('express');
const {
  getAvailableDeliveries,
  getMyDeliveries,
  acceptDelivery,
  updateDeliveryStatus,
} = require('../controllers/delivery.controller');
const { protect, requireRole } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(protect, requireRole('DRIVER'));

router.get('/available', getAvailableDeliveries);
router.get('/mine', getMyDeliveries);
router.post('/:id/accept', acceptDelivery);
router.patch('/:id/status', updateDeliveryStatus);

module.exports = router;
