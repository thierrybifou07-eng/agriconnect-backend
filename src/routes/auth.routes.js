const express = require('express');
const { register, login, refresh, logout } = require('../controllers/auth.controller');
const { authLimiter } = require('../middlewares/rateLimit.middleware');
const handleValidation = require('../middlewares/validate.middleware');
const { registerRules, loginRules, refreshRules } = require('../validators/auth.validator');

const router = express.Router();

router.post('/register', authLimiter, registerRules, handleValidation, register);
router.post('/login', authLimiter, loginRules, handleValidation, login);
router.post('/refresh', authLimiter, refreshRules, handleValidation, refresh);
router.post('/logout', logout);

module.exports = router;
