import { Router } from 'express';
import authRoutes from './auth.routes.js';
import adminRoutes from './admin.routes.js';
import legalRoutes from './legal.routes.js';
import supplierRoutes from './supplier.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/legal', legalRoutes);
router.use('/supplier', supplierRoutes);

export default router;
