import { Router } from 'express';
import authRoutes from './auth.routes.js';
import adminRoutes from './admin.routes.js';
import legalRoutes from './legal.routes.js';
import supplierRoutes from './supplier.routes.js';
import staffRoutes from './staff.routes.js';
import catalogRoutes from './catalog.routes.js';
import conversationRoutes from './conversation.routes.js';
import orderRoutes from './order.routes.js';
import driverRoutes from './driver.routes.js';
import referenceRoutes from './reference.routes.js';
import aiRoutes from './ai.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/admin/ai', aiRoutes);
router.use('/legal', legalRoutes);
router.use('/supplier', supplierRoutes);
router.use('/staff', staffRoutes);
router.use('/catalog', catalogRoutes);
router.use('/conversations', conversationRoutes);
router.use('/orders', orderRoutes);
router.use('/driver', driverRoutes);
router.use('/reference', referenceRoutes);

export default router;
