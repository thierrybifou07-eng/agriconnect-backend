const express = require('express');
const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const listingRoutes = require('./listing.routes');
const conversationRoutes = require('./conversation.routes');
const orderRoutes = require('./order.routes');
const deliveryRoutes = require('./delivery.routes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/listings', listingRoutes);
router.use('/conversations', conversationRoutes);
router.use('/orders', orderRoutes);
router.use('/deliveries', deliveryRoutes);

module.exports = router;
