import { Router } from 'express';
import {
  listUsers,
  suspendUser,
  reactivateUser,
  createAdmin,
} from '../controllers/admin.controller.js';
import { protect, requireRole, requireMinLevel } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { coerceIdParam } from '../middlewares/params.middleware.js';
import { createAdminSchema } from '../validators/admin.validator.js';

const router = Router();

// Toutes les cles primaires sont des Int : voir middlewares/params.middleware.js
router.param('id', coerceIdParam);

router.use(protect, requireMinLevel(50));

router.get('/users', listUsers);
router.patch('/users/:id/suspend', suspendUser);
router.patch('/users/:id/reactivate', reactivateUser);

router.post('/users', requireRole('ROOT'), validate(createAdminSchema), createAdmin);

export default router;
