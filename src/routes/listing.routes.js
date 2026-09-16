const express = require('express');
const {
  getListings,
  getListingById,
  createListing,
  updateListing,
  deleteListing,
  uploadPhotos,
} = require('../controllers/listing.controller');
const { protect, requireRole } = require('../middlewares/auth.middleware');
const upload = require('../middlewares/upload.middleware');
const handleValidation = require('../middlewares/validate.middleware');
const { createListingRules, updateListingRules } = require('../validators/listing.validator');

const router = express.Router();

router.get('/', getListings);
router.get('/:id', getListingById);
router.post('/', protect, requireRole('FARMER'), createListingRules, handleValidation, createListing);
router.patch('/:id', protect, requireRole('FARMER'), updateListingRules, handleValidation, updateListing);
router.delete('/:id', protect, requireRole('FARMER'), deleteListing);
router.post('/:id/photos', protect, requireRole('FARMER'), upload.array('photos', 5), uploadPhotos);

module.exports = router;
