const express = require('express');
const {
  createConversation,
  getMyConversations,
  getMessages,
  sendMessage,
} = require('../controllers/conversation.controller');
const { protect } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(protect);

router.get('/', getMyConversations);
router.post('/', createConversation);
router.get('/:id/messages', getMessages);
router.post('/:id/messages', sendMessage);

module.exports = router;
