import { Router } from 'express';
import {
  listUsers,
  suspendUser,
  reactivateUser,
  createAdmin,
  deactivateListing,
  getAllOrders,
  getStats,
} from '../controllers/admin.controller.js';
import { protect, requireRole, requireMinLevel } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { createAdminSchema } from '../validators/admin.validator.js';

const router = Router();

router.use(protect, requireMinLevel(50));

router.get('/users', listUsers);
router.patch('/users/:id/suspend', suspendUser);
router.patch('/users/:id/reactivate', reactivateUser);
router.get('/orders', getAllOrders);
router.get('/stats', getStats);
router.patch('/listings/:id/deactivate', deactivateListing);

router.post('/users', requireRole('ROOT'), validate(createAdminSchema), createAdmin);

export default router;
