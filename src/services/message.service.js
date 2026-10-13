import prisma from '../config/prisma.js';
import { messageToClientDto, messageToStaffDto, conversationToStaffDto } from '../utils/dto/conversation.dto.js';

// Messagerie temps réel (plan v2, P3.2).
//
// L'instance Socket.io n'est pas un singleton importe : elle est attachee a
// l'application Express par server.js. Tout emit passe donc par un `io`
// fourni par l'appelant (le socket le possede deja, les controleurs le
// lisent sur req.app). Sans instance montee (tests unitaires), les helpers
// d'emission repondent false au lieu de lever : un evenement impossible ne
// doit jamais faire echouer une ecriture.

// Evenements serveur -> client. `new_message` (v1) disparait au profit de
// `message:new` : le nom dit ce que le client recoit, pas ce que le client
// a emis, et le suffixe `message:` le distingue des evenements de cycle de
// vie de la conversation (`conversation:assigned`, `conversation:escalated`).
export const MESSAGE_NEW = 'message:new';
export const CONVERSATION_ASSIGNED = 'conversation:assigned';
export const CONVERSATION_ESCALATED = 'conversation:escalated';

// Evenement d'erreur cote client : meme format que les erreurs REST, pour que
// le client ait un seul traitement d'erreur.
export const ERROR_MESSAGE = 'error_message';

// Room rassemblant toutes les connexions de l equipe : elle recoit les notes
// internes et les notifications assigned / escalated, qu aucun client ne doit
// voir. Une room, et non une room par agent : un agent se connecte rarement,
// et la note interne vaut pour toute l equipe.
export const STAFF_ROOM = 'staff';

// Room d une conversation : le client et l equipe qui la suit y recoivent
// les messages publics.
export const conversationRoom = (id) => `conversation:${id}`;

// Ecrit le message et met a jour lastMessageAt, dans la transaction
// appelante. C est le controleur qui decide de l atomicite : ouvrir une
// conversation avec son premier message est une seule transaction (P3.1),
// repondre dans un fil existant n engage que le message et son compteur.
// Aucune emission ici : emettre dans une transaction enverrait l evenement
// avant le commit, et le client lirait un message que l ecriture aurait pu
// annuler.
export async function createMessageTx(tx, { conversationId, senderType, senderUserId, senderAgentId = null, content, isInternal = false }) {
  const cree = await tx.message.create({
    data: {
      conversationId,
      senderType,
      senderUserId,
      senderAgentId,
      content,
      isInternal,
    },
  });
  await tx.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date() },
  });
  return cree;
}

// Ecrit le message dans sa propre transaction, puis emet l evenement.
// Utiliser createMessageTx quand l ecriture appartient a une transaction
// plus large : l emission est alors a la charge de l appelant.
export async function createMessage(io, data) {
  const message = await prisma.$transaction((tx) => createMessageTx(tx, data));
  emitNewMessage(io, message);
  return message;
}

// Diffusion d un message nouveau.
//
// Les deux destinations ne se chevauchent jamais, et c est le coeur de la
// confidentialite de la messagerie : un message public part vers la room de
// la conversation (client + agent qui la suit), une note interne part vers
// la room staff UNIQUEMENT. Le client, lui, ne voit jamais la room staff :
// connecte ou non, une note interne ne peut pas lui parvenir.
//
// Le DTO suit la destination : messageToClientDto vers la conversation (pas
// d identite, le client parle a l equipe), messageToStaffDto vers l equipe
// (auteur complet, isInternal visible).
export function emitNewMessage(io, message) {
  if (!io) return false;
  if (message.isInternal) {
    io.to(STAFF_ROOM).emit(MESSAGE_NEW, messageToStaffDto(message));
  } else {
    io.to(conversationRoom(message.conversationId)).emit(MESSAGE_NEW, messageToClientDto(message));
  }
  return true;
}

// Notifie l equipe qu une conversation vient d etre prise en charge. La
// conversation repart dans la file commune : c est le rapprochement
// assigned -> escalated qui la sort de la file.
export function emitConversationAssigned(io, conversation) {
  if (!io) return false;
  io.to(STAFF_ROOM).emit(CONVERSATION_ASSIGNED, conversationToStaffDto(conversation));
  return true;
}

// Notifie l equipe qu une conversation monte vers toute l equipe. L
// evenement part apres l ecriture : escalatedAt et la raison sont ceux qui
// viennent etre commites, pas ceux de la requete.
export function emitConversationEscalated(io, conversation) {
  if (!io) return false;
  io.to(STAFF_ROOM).emit(CONVERSATION_ESCALATED, conversationToStaffDto(conversation));
  return true;
}
