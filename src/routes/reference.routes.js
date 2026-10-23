import { Router } from 'express';
import {
  listCategories,
  listHubs,
  listProducts,
  listUnits,
  listZones,
} from '../controllers/reference.controller.js';
import { protect, requireRole } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import {
  listHubsSchema,
  listProductsSchema,
  listReferenceSchema,
} from '../validators/reference.validator.js';

const router = Router();

router.use(protect, requireRole('SUPPLIER', 'BUYER', 'AGENT', 'ADMIN', 'ROOT'));

router.get('/categories', validate(listReferenceSchema, 'query'), listCategories);
router.get('/units', validate(listReferenceSchema, 'query'), listUnits);
router.get('/products', validate(listProductsSchema, 'query'), listProducts);
router.get('/zones', validate(listReferenceSchema, 'query'), listZones);
router.get('/hubs', validate(listHubsSchema, 'query'), listHubs);

export default router;
