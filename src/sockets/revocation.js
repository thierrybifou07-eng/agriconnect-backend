// Signalement des coupes de session aux websockets.
//
// Le blocage d'un compte se faisait jusqu'ici en trois points sur quatre :
// protect, login et refresh. Le quatrieme etait le websocket, qui ne lisait que
// l'identite du jeton et ne consultait jamais le statut. Un utilisateur suspendu
// conservait donc une connexion vivante et pouvait encore envoyer des messages.
//
// L'instance Socket.io n'est pas un singleton importe : elle est attachee a
// l'application Express par server.js, et chaque appelant la recupere par le
// `io` qu'il possede deja. Un module exporte qui garderait l'instance dans son
// propre etat rendrait l'ordre de demarrage significant, et les tests ne
// pourraient plus l'exercer.

// Nom de l'evenement. Cote client, le socket doit etre ferme sur cet evenement :
// le serveur ne peut pas deconnecter un socket depuis un autre processus, et ne
// pretend pas le faire.
export const SESSION_REVOKED = 'session_revoked';

// Temps entre l'annonce et la fermeture du socket. Court : il ne laisse pas un
// compte suspendu continuer a ecrire, tout en donnant au client le temps de
// recevoir la raison avant de perdre la connexion.
const DELAI_FERMETURE_MS = 50;

// Room dans laquelle chaque socket rejoint la sienne. Une room par utilisateur
// permet de viser toutes ses connexions sans connaitre leurs identifiants de
// socket, que le client ne peut pas deviner.
export const userRoom = (userId) => `user:${userId}`;

/** Fait rejoindre sa room a un socket, des la connexion reussie. */
export function joinUserRoom(socket, userId) {
  socket.join(userRoom(userId));
}

/**
 * Previent tous les websockets d'un utilisateur que ses sessions sont coupees,
 * puis les ferme.
 *
 * L'emission et la fermeture sont deux temps distincts, et l'ordre compte. Un
 * client qui recoit un 'disconnect' sans explication ne peut afficher que
 * "deconnecte", ce qui est le message le plus trompeur possible lors d'une
 * suspension : l'utilisateur croira a un probleme reseau. `disconnectSockets`
 * ferme immediatement, donc l'evenement doit partir avant.
 *
 * Pourquoi `disconnectSockets` et pas un `socket.on(...)` cote serveur : un
 * `on` enregistre cote serveur n'ecoute que ce que le CLIENT envoie. L'emission
 * ci-dessus ne le declencherait donc jamais — c'est une erreur qui laisse le
 * socket ouvert en silence, sans le moindre signe.
 *
 * Silencieux quand aucun serveur Socket.io n'est monte — cas des tests — : un
 * signalement impossible ne doit pas faire echouer la suspension d'un compte.
 *
 * @param {object|null} io  Instance Socket.io, ou null si absente.
 * @param {number} userId
 * @param {string} [reason]
 * @returns {boolean} false si aucune instance n'etait disponible.
 */
export function emitSessionRevoked(io, userId, reason = 'session_closed') {
  if (!io) return false;

  io.to(userRoom(userId)).emit(SESSION_REVOKED, { reason });

  const room = io.in(userRoom(userId));
  // Delai court : assez pour que l'evenement parte sur le socket, trop court pour
  // laisser un client suspendu continuer d'ecrire pendant une seconde.
  setTimeout(() => room.disconnectSockets(true), DELAI_FERMETURE_MS);

  return true;
}