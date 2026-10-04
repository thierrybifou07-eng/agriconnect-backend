import { Router } from 'express';
import {
  register,
  login,
  refresh,
  logout,
  listSessions,
  closeSessionById,
  logoutAll,
} from '../controllers/auth.controller.js';
import { authLimiter, refreshLimiter } from '../middlewares/rateLimit.middleware.js';
import { protect } from '../middlewares/auth.middleware.js';
import { coerceIdParam } from '../middlewares/params.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { registerSchema, loginSchema, refreshSchema } from '../validators/auth.validator.js';

const router = Router();

// DELETE /api/auth/sessions/:id porte un identifiant, donc la conversion
// numerique s'applique ici aussi : sans elle, Prisma recevrait une chaine et
// leverait une erreur serveur au lieu de repondre 404.
router.param('id', coerceIdParam);

// Routes publiques : elles etablissent l'identite.
router.post('/register', authLimiter, validate(registerSchema), register);
router.post('/login', authLimiter, validate(loginSchema), login);
// Limite distincte de celle du login : se partageant le meme seau par IP, elle
// verrouillait un utilisateur legitime qui ouvrait simplement son application.
router.post('/refresh', refreshLimiter, validate(refreshSchema), refresh);
router.post('/logout', logout);

// Gestion des sessions : routes authentifiees. Elles agissent sur les sessions du
// compte connecte, identifie par le jeton d'acces — et non par le refresh token,
// qui ne dit rien de l'appareil appelant.
router.get('/sessions', protect, listSessions);
router.delete('/sessions/:id', protect, closeSessionById);
router.post('/logout-all', protect, logoutAll);

export default router;