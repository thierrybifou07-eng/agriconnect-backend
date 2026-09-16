const { verifyToken } = require('../utils/jwt');
const prisma = require('../config/prisma');

function initChatSocket(io) {
  // Authentification du socket via le token JWT envoyé dans le handshake
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentification requise'));

      const decoded = verifyToken(token);
      socket.userId = decoded.id;
      next();
    } catch (err) {
      next(new Error('Token invalide'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('join_conversation', (conversationId) => {
      socket.join(conversationId);
    });

    socket.on('leave_conversation', (conversationId) => {
      socket.leave(conversationId);
    });

    socket.on('send_message', async ({ conversationId, content }) => {
      try {
        const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
        if (!conversation) return;
        if (![conversation.buyerId, conversation.farmerId].includes(socket.userId)) return;

        const message = await prisma.message.create({
          data: { conversationId, senderId: socket.userId, content },
        });

        io.to(conversationId).emit('new_message', message);
      } catch (err) {
        socket.emit('error_message', { error: "Impossible d'envoyer le message" });
      }
    });
  });
}

module.exports = initChatSocket;
