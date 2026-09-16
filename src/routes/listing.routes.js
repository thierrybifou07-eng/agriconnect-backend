import { Router } from 'express';
import {
  getListings,
  getListingById,
  createListing,
  updateListing,
  deleteListing,
  uploadPhotos,
} from '../controllers/listing.controller.js';
import { protect, requireRole } from '../middlewares/auth.middleware.js';
import upload from '../middlewares/upload.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { createListingSchema, updateListingSchema } from '../validators/listing.validator.js';

const router = Router();

router.get('/', getListings);
router.get('/:id', getListingById);
router.post('/', protect, requireRole('FARMER'), validate(createListingSchema), createListing);
router.patch('/:id', protect, requireRole('FARMER'), validate(updateListingSchema), updateListing);
router.delete('/:id', protect, requireRole('FARMER'), deleteListing);
router.post('/:id/photos', protect, requireRole('FARMER'), upload.array('photos', 5), uploadPhotos);

export default router;
