import { verifyToken } from '../utils/jwt.js';
import prisma from '../config/prisma.js';
import { joinUserRoom } from './revocation.js';

export default function initChatSocket(io) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentification requise'));

      const decoded = verifyToken(token);

      // Point de blocage manquant jusqu'ici : le socket ne lisait que
      // l'identite du jeton. Un compte suspendu pouvait donc conserver une
      // connexion vivante et continuer d'envoyer des messages, alors que
      // protect, login et refresh le refusaient deja. Le statut est relu en base
      // et non pris dans le jeton : il peut avoir change depuis son emission.
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { userStatus: { select: { code: true } } },
      });
      if (!user) return next(new Error('Utilisateur introuvable'));
      if (user.userStatus.code === 'SUSPENDED') {
        return next(new Error('Ce compte a été suspendu'));
      }

      socket.userId = decoded.id;
      next();
    } catch (err) {
      next(new Error('Token invalide'));
    }
  });

  io.on('connection', (socket) => {
    // Room par utilisateur : c'est elle qui permet de prevenir toutes les
    // connexions d'une personne lors d'une suspension, sans que le serveur
    // ait a connaitre leurs identifiants de socket.
    joinUserRoom(socket, socket.userId);

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
