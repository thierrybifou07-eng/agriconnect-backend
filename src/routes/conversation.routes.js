import { Router } from 'express';
import {
  createConversation,
  listConversations,
  listMessages,
  sendMessage,
} from '../controllers/conversation.controller.js';
import { protect } from '../middlewares/auth.middleware.js';
import { coerceIdParam } from '../middlewares/params.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import {
  conversationCreateSchema,
  conversationMessageSchema,
} from '../validators/conversation.validator.js';

// Messagerie client <-> équipe (plan v2, P3.1). Toutes les routes sont
// protégées : une conversation ne se lit et ne s'écrit qu'authentifié.
const router = Router();

// :id est un identifiant entier partout (D2) : la conversion numérique
// s'applique avant tout contrôleur.
router.param('id', coerceIdParam);

// Ouvrir une conversation (avec son premier message) et consulter les siennes.
router.post('/', protect, validate(conversationCreateSchema), createConversation);
router.get('/', protect, listConversations);

// Lire le fil public et répondre.
router.get('/:id/messages', protect, listMessages);
router.post('/:id/messages', protect, validate(conversationMessageSchema), sendMessage);

export default router;
