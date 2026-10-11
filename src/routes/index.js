import { Router } from 'express';
import authRoutes from './auth.routes.js';
import adminRoutes from './admin.routes.js';
import legalRoutes from './legal.routes.js';
import supplierRoutes from './supplier.routes.js';
import staffRoutes from './staff.routes.js';
import catalogRoutes from './catalog.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/legal', legalRoutes);
router.use('/supplier', supplierRoutes);
router.use('/staff', staffRoutes);
router.use('/catalog', catalogRoutes);

export default router;
