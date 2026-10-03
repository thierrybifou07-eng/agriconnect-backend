// Resolution de la politique CORS, partagee par HTTP et Socket.io.
//
// Pourquoi un utilitaire : les deux serveurs lisaient CORS_IO chacun de leur
// cote. HTTP le decoupe sur des virgules et le passe a `cors` sous forme de
// tableau, Socket.io le transmet tel quel a la bibliotheque. Deux
// interpretations, donc deux comportements possibles pour une meme variable.
//
// Le defaut qui drove de la premiere version : '*' etait lu comme le nom d'une
// origine litterale. Aucun navigateur n'a une origine nommee "*", donc
// l'en-tete Access-Control-Allow-Origin n'etait jamais emis et toutes les
// requetes cross-origin etaient rejetees. Le caractere joker a ce sens,
// '*' doit ouvrir l'API.

/**
 * @typedef {object} OriginPolicy
 * @property {boolean} configured  Une valeur CORS_IO a-t-elle ete fournie ?
 * @property {boolean} all         La valeur '*' ouvre-t-elle toutes les origines ?
 * @property {string[]} origins    Origines explicitement autorisees, hors '*'.
 */

/**
 * Decoupe CORS_IO en une politique.
 *
 * @param {string|undefined} raw  Valeur brute, espaces autour des virgules tolerees.
 * @returns {OriginPolicy}
 */
export function parseAllowedOrigins(raw = process.env.CORS_IO) {
  const origins = String(raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) return { configured: false, all: false, origins: [] };
  if (origins.includes('*')) return { configured: true, all: true, origins: [] };
  return { configured: true, all: false, origins };
}

/**
 * Options pour le middleware `cors` d'Express.
 *
 * Sans configuration on renvoie un objet vide : le defaut de `cors` reste
 * alors ouvert, et une API non configuree n'est pas refusee a un client
 * forget de renseigner la variable.
 *
 * Avec '*', on renvoie `origin: true`, c'est-a-dire l'origine de la requete
 * reflechee dans l'en-tete, et non `origin: '*'`. La raison est technique :
 * un navigateur refuse l'en-tete wildcard des qu'il autorise les identifiants,
 * et nous les autorisons toujours. Refleeter la valeur '*' est la seule facon
 * de satisfaire les deux.
 *
 * @param {string|undefined} raw
 * @returns {object} configuration acceptee par `cors(...)`
 */
export function httpCorsOptions(raw = process.env.CORS_IO) {
  const { configured, all, origins } = parseAllowedOrigins(raw);

  if (!configured) return {};
  return { origin: all ? true : origins, credentials: true };
}

/**
 * Options pour le serveur Socket.io.
 *
 * Socket.io n'a pas la meme contrainte que le navigateur sur le wildcard :
 * il autorise '*' directement. On garde donc le joker litteral ici, et `true`
 * pour une liste laissee ouverte.
 *
 * @param {string|undefined} raw
 * @returns {object} configuration acceptee par `new Server({ cors })`
 */
export function socketCorsOptions(raw = process.env.CORS_IO) {
  const { configured, all, origins } = parseAllowedOrigins(raw);

  if (!configured) return { origin: '*' };
  if (all) return { origin: '*' };
  return { origin: origins };
}