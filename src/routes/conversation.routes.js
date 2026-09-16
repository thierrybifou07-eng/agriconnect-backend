import { Router } from 'express';
import {
  createConversation,
  getMyConversations,
  getMessages,
  sendMessage,
} from '../controllers/conversation.controller.js';
import { protect } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(protect);

router.get('/', getMyConversations);
router.post('/', createConversation);
router.get('/:id/messages', getMessages);
router.post('/:id/messages', sendMessage);

export default router;
