const { body } = require('express-validator');

const createOrderRules = [
  body('listingId').isUUID().withMessage('listingId invalide'),
  body('quantity').isFloat({ gt: 0 }).withMessage('quantity doit être un nombre supérieur à 0'),
  body('deliveryMode').isIn(['PICKUP', 'DELIVERY']).withMessage('deliveryMode doit être PICKUP ou DELIVERY'),
  body('deliveryLatitude').optional().isFloat({ min: -90, max: 90 }).withMessage('deliveryLatitude invalide'),
  body('deliveryLongitude').optional().isFloat({ min: -180, max: 180 }).withMessage('deliveryLongitude invalide'),
];

module.exports = { createOrderRules };
