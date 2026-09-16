const express = require('express');
const { getMe, updateMe, updateAvailability } = require('../controllers/user.controller');
const { protect, requireRole } = require('../middlewares/auth.middleware');

const router = express.Router();

router.get('/me', protect, getMe);
router.patch('/me', protect, updateMe);
router.patch('/me/availability', protect, requireRole('DRIVER'), updateAvailability);

module.exports = router;
