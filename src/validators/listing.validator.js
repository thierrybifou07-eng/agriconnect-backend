const { body } = require('express-validator');

const createListingRules = [
  body('title').trim().isLength({ min: 3 }).withMessage('Le titre doit contenir au moins 3 caractères'),
  body('category').trim().notEmpty().withMessage('category est requis'),
  body('price').isFloat({ gt: 0 }).withMessage('price doit être un nombre supérieur à 0'),
  body('quantity').isFloat({ gt: 0 }).withMessage('quantity doit être un nombre supérieur à 0'),
  body('unit').trim().notEmpty().withMessage('unit est requis'),
  body('location').trim().notEmpty().withMessage('location est requis'),
  body('latitude').optional().isFloat({ min: -90, max: 90 }).withMessage('latitude invalide'),
  body('longitude').optional().isFloat({ min: -180, max: 180 }).withMessage('longitude invalide'),
];

const updateListingRules = [
  body('price').optional().isFloat({ gt: 0 }).withMessage('price doit être un nombre supérieur à 0'),
  body('quantity').optional().isFloat({ gt: 0 }).withMessage('quantity doit être un nombre supérieur à 0'),
  body('status').optional().isIn(['ACTIVE', 'SOLD', 'INACTIVE']).withMessage('status invalide'),
  body('latitude').optional().isFloat({ min: -90, max: 90 }).withMessage('latitude invalide'),
  body('longitude').optional().isFloat({ min: -180, max: 180 }).withMessage('longitude invalide'),
];

module.exports = { createListingRules, updateListingRules };
