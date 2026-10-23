import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { getAiStatus, testAiProvider } from '../services/ai/ai.controller.js';
import { protect, requireMinLevel } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { testAiSchema } from '../validators/ai.validator.js';

const router = Router();
const aiTestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessayez plus tard', code: 'RATE_LIMITED' },
});

router.use(protect, requireMinLevel(50));
router.get('/status', getAiStatus);
router.post('/test', aiTestLimiter, validate(testAiSchema, 'body'), testAiProvider);

export default router;
