import { Router } from 'express';
import authRoutes from './auth.routes.js';
import adminRoutes from './admin.routes.js';
import legalRoutes from './legal.routes.js';
import supplierRoutes from './supplier.routes.js';
import staffRoutes from './staff.routes.js';
import catalogRoutes from './catalog.routes.js';
import conversationRoutes from './conversation.routes.js';
import orderRoutes from './order.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/legal', legalRoutes);
router.use('/supplier', supplierRoutes);
router.use('/staff', staffRoutes);
router.use('/catalog', catalogRoutes);
router.use('/conversations', conversationRoutes);
router.use('/orders', orderRoutes);

export default router;
