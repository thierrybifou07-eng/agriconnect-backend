import { Router } from 'express';
import { getMe, updateMe, uploadAvatar, updateAvailability } from '../controllers/user.controller.js';
import { protect, requireRole } from '../middlewares/auth.middleware.js';
import upload from '../middlewares/upload.middleware.js';

const router = Router();

router.get('/me', protect, getMe);
router.patch('/me', protect, updateMe);
router.post('/me/avatar', protect, upload.single('avatar'), uploadAvatar);
router.patch('/me/availability', protect, requireRole('DRIVER'), updateAvailability);

export default router;
