import { verifyToken } from '../utils/jwt.js';
import prisma from '../config/prisma.js';
import { joinUserRoom } from './revocation.js';
import {
  createMessage,
  conversationRoom,
  STAFF_ROOM,
  ERROR_MESSAGE,
} from '../services/message.service.js';

// Messagerie temps reel (plan v2, P3.2).
//
// L authentification du socket et la room `user:{id}` ne changent pas : ce
// fichier ajoute seulement la gestion des conversations. Un client rejoint
// la room de sa conversation pour recevoir `message:new` ; l equipe rejoint
// la room `staff` des sa connexion pour recevoir notes internes et
// notifications de cycle de vie.

// Capacite requise par type de conversation : meme table que le controleur
// staff (staffConversation.controller.js). Un agent n agit que sur les
// conversations de son metier.
const CAPACITE_PAR_TYPE = {
  BUYER_SUPPORT: 'BUYER_SUPPORT',
  SUPPLIER_SUPPORT: 'SUPPLIER_SUPPORT',
};

// Charge ce que le controle d acces staff doit connaitre : le role (ADMIN
// et ROOT, level >= 50, ont tous les pouvoirs, sans fiche) et, pour un AGENT,
// sa fiche active avec ses capacites.
async function chargerStaff(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      role: { select: { level: true } },
      agent: {
        include: { capabilities: { include: { capability: { select: { code: true } } } } },
      },
    },
  });

  // Le filtre isActive se fait cote application : Prisma refuse `where` dans
  // include sur une relation 1-1 (Agent.userId est unique). Sans ce
  // filtrage, un agent desactive garderait l acces au socket.
  if (user && user.agent && !user.agent.isActive) user.agent = null;
  return user;
}

// ADMIN et ROOT sont toujours autorises ; un AGENT seulement avec la
// capacite du type de la conversation. Renvoie null quand l utilisateur
// n est pas habite : le client rejoint alors seulement ses propres
// conversations.
async function autoriseStaff(user, type) {
  if (!user) return null;
  if (user.role.level >= 50) return user;
  const capacite = CAPACITE_PAR_TYPE[type];
  if (user.agent && capacite && user.agent.capabilities.some((lien) => lien.capability.code === capacite)) {
    return user;
  }
  return null;
}

// Content envoy par socket : meme bornes que la route REST (le schema Joi
// accepte 1 a 5000 caracteres). Un message vide n a pas plus de sens en
// temps reel que par API.
function contentInvalide(content) {
  return typeof content !== 'string' || !content.trim() || content.length > 5000;
}

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
    // Les handlers sont enregistrés AVANT tout await, de facon synchrone.
    // Socket.io ne met pas les paquets en file d attente : un join_conversation
    // emis par le client des son 'connect' arriverait pendant l attente d une
    // requete base, alors que le handler n existe pas encore — le paquet
    // serait perdu, et le client attendrait un accuse qui ne vient jamais.
    // Seul l enregistrement des handlers est synchrone ici ; leur execution
    // reste asynchrone, et n a lieu que des la connexion entierement etablie.

    // Rejoindre une conversation : le client rejoint la sienne, l equipe
    // rejoint celles de son metier. L acces se verifie comme en REST : une
    // conversation d autrui est refusee, et le refus passe par un evenement
    // plutot que par une exception de socket, pour que le client ait un
    // message a afficher.
    socket.on('join_conversation', async (id, callback) => {
      const conversationId = Number(id);
      if (!Number.isInteger(conversationId) || conversationId <= 0) {
        socket.emit(ERROR_MESSAGE, { error: 'Conversation introuvable' });
        return;
      }

      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
      });
      if (!conversation) {
        socket.emit(ERROR_MESSAGE, { error: 'Conversation introuvable' });
        return;
      }

      const autorise =
        conversation.customerId === socket.userId ||
        (await autoriseStaff(await chargerStaff(socket.userId), conversation.type));
      if (!autorise) {
        socket.emit(ERROR_MESSAGE, { error: 'Accès refusé' });
        if (typeof callback === 'function') callback({ ok: false });
        return;
      }
      socket.join(conversationRoom(conversationId));

      // Accuse de reunion : le traitement du join est asynchrone (lectures en
      // base), et le client ne peut pas savoir quand la room est effectivement
      // rejointe. Sans cet accuse, un leave ou un send_message emis tout de
      // suite partirait avant la fin du join : le client se retrouverait dans
      // une room qu il voulait quitter, ou en dehors de celle qu il voulait
      // suivre. Le client attend l accuse avant toute emission suivante.
      if (typeof callback === 'function') callback({ ok: true });
    });

    // Quitter une conversation : sans controle — quitter une room ne
    // revele rien, et sortir d une room ou l on n est pas est sans effet.
    socket.on('leave_conversation', (id) => {
      socket.leave(conversationRoom(Number(id)));
    });

    // Ecrire dans une conversation : memes regles d acces que
    // join_conversation. Le client ecrit en son nom ; l equipe ecrit en
    // s identifiant comme agent (senderAgentId) quand elle en a une fiche,
    // comme le fait l API REST.
    socket.on('send_message', async ({ conversationId, content } = {}) => {
      const id = Number(conversationId);
      if (!Number.isInteger(id) || id <= 0) {
        socket.emit(ERROR_MESSAGE, { error: 'Conversation introuvable' });
        return;
      }
      if (contentInvalide(content)) {
        socket.emit(ERROR_MESSAGE, { error: 'content est requis' });
        return;
      }

      const conversation = await prisma.conversation.findUnique({ where: { id } });
      if (!conversation) {
        socket.emit(ERROR_MESSAGE, { error: 'Conversation introuvable' });
        return;
      }

      const utilisateur = await chargerStaff(socket.userId);
      const estProprietaire = conversation.customerId === socket.userId;
      const autorise = estProprietaire || (await autoriseStaff(utilisateur, conversation.type));
      if (!autorise) {
        socket.emit(ERROR_MESSAGE, { error: 'Accès refusé' });
        return;
      }

      await createMessage(io, {
        conversationId: conversation.id,
        senderType: estProprietaire ? 'CUSTOMER' : 'AGENT',
        senderUserId: socket.userId,
        senderAgentId: estProprietaire ? null : utilisateur.agent?.id ?? null,
        content,
        isInternal: false,
      });
    });

    // Room par utilisateur : c'est elle qui permet de prevenir toutes les
    // connexions d'une personne lors d'une suspension, sans que le serveur
    // ait a connaitre leurs identifiants de socket.
    joinUserRoom(socket, socket.userId);

    // La room staff rassemble les connexions de l equipe (ADMIN, ROOT, AGENT
    // actif) : notes internes et notifications assigned / escalated n y sont
    // emises, et un client, lui, n en fait jamais partie. Le rejoint se fait
    // en tache de fond : aucun evenement n est emis vers staff avant la
    // fin de l requete, donc attendre ne coute rien.
    chargerStaff(socket.userId).then((staff) => {
      if (staff && (staff.role.level >= 50 || staff.agent)) {
        socket.join(STAFF_ROOM);
      }
    });
  });
}
