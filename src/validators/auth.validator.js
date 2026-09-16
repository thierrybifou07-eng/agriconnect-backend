const { body } = require('express-validator');

const registerRules = [
  body('fullName').trim().isLength({ min: 2 }).withMessage('Le nom complet doit contenir au moins 2 caractères'),
  body('phone')
    .trim()
    .matches(/^\+?[0-9]{8,15}$/)
    .withMessage('Numéro de téléphone invalide (8 à 15 chiffres, "+" optionnel)'),
  body('password').isLength({ min: 6 }).withMessage('Le mot de passe doit contenir au moins 6 caractères'),
  body('role').isIn(['FARMER', 'BUYER', 'DRIVER']).withMessage('role doit être FARMER, BUYER ou DRIVER'),
  body('email').optional({ checkFalsy: true }).isEmail().withMessage('Email invalide'),
];

const loginRules = [
  body('phone').trim().notEmpty().withMessage('phone est requis'),
  body('password').notEmpty().withMessage('password est requis'),
];

const refreshRules = [body('refreshToken').notEmpty().withMessage('refreshToken est requis')];

module.exports = { registerRules, loginRules, refreshRules };
