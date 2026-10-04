import { Router } from 'express';
import {
  register,
  login,
  refresh,
  logout,
  listSessions,
  closeSessionById,
  logoutAll,
  verifyEmailPage,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPasswordPage,
  resetPassword,
} from '../controllers/auth.controller.js';
import {
  getMe,
  updateMe,
  uploadAvatar,
  updateAvailability,
} from '../controllers/user.controller.js';
import {
  authLimiter,
  refreshLimiter,
  forgotPasswordLimiter,
} from '../middlewares/rateLimit.middleware.js';
import { protect, requireRole } from '../middlewares/auth.middleware.js';
import { coerceIdParam } from '../middlewares/params.middleware.js';
import upload from '../middlewares/upload.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  oneTimeTokenSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from '../validators/auth.validator.js';

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

// Mot de passe oublie.
//
// Route publique, et c'est necessaire : elle est appelee precisement quand
// l'utilisateur ne peut plus s'authentifier. Sa limite de debit est propre, voir
// forgotPasswordLimiter dans rateLimit.middleware.js.
// Le GET qui affiche le formulaire et le POST qui applique le changement sont
// volontairement distincts : le lien recu par email ne doit pas consommer le
// jeton au premier clic, les clients de messagerie et les antivirus prechargent
// les liens.
router.post('/forgot-password', forgotPasswordLimiter, validate(forgotPasswordSchema), forgotPassword);
router.get('/reset-password', resetPasswordPage);
router.post('/reset-password', validate(resetPasswordSchema), resetPassword);

// Verification d'adresse email.
//
// Le GET affiche une page et ne consomme rien ; le POST applique. Ce couple de
// routes est celui que recoit le lien de l'email, et il est separe pour que le
// client de messagerie qui precharge le lien ne verifie pas l'adresse a la place
// du proprietaire. Voir verifyEmailPage.
router.get('/verify-email', verifyEmailPage);
router.post('/verify-email', validate(oneTimeTokenSchema), verifyEmail);
// Renvoi : authentifie, puisque l'on agit sur le compte connecte et non sur une
// adresse fournie dans le corps.
router.post('/resend-verification', protect, resendVerification);

// Gestion des sessions : routes authentifiees. Elles agissent sur les sessions du
// compte connecte, identifie par le jeton d'acces — et non par le refresh token,
// qui ne dit rien de l'appareil appelant.
router.get('/sessions', protect, listSessions);
router.delete('/sessions/:id', protect, closeSessionById);
router.post('/logout-all', protect, logoutAll);

// Profil de l'utilisateur connecte. Ces quatre routes etaient sous /api/users :
// elles y ont ete deplacees pour que tout ce que fait un utilisateur sur son
// propre compte soit dans le meme registre que son authentification. /api/users
// reste libre pour les endpoints d'administration.
// Elles partagent la forme de reponse unique userToApi (voir utils/userApi.js).
router.get('/me', protect, getMe);
router.patch('/me', protect, updateMe);
router.post('/me/avatar', protect, upload.single('avatar'), uploadAvatar);
router.patch('/me/availability', protect, requireRole('DRIVER'), updateAvailability);

export default router;