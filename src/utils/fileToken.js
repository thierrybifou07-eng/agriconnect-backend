import jwt from 'jsonwebtoken';

// Jeton d'accès à un fichier privé (document de vérification).
//
// Il ne porte aucun chemin disque : seulement l'identifiant du Media et le
// membre du staff auquel le lien a été délivré. Le chemin est résolu au
// moment du service, depuis le Media en base (resolvePrivateFile), jamais
// depuis le jeton : un jeton ne peut donc pas désigner un fichier arbitraire.
//
// Trois séparation rendent le jeton inutilisable ailleurs :
//  - un secret propre (SECRET_FILE_TOKEN), distinct de celui des jetons
//    d'accès ; en production, l'égalité avec JWT_SECRET interdit le démarrage ;
//  - une audience et une finalité propres : un jeton d'accès valide ne passe
//    pas la vérification d'audience ;
//  - un `sub` : le lien n'est valable que pour le compte qui l'a demandé.

export const FILE_TOKEN_AUDIENCE = 'agriconnect-private-file';
export const FILE_TOKEN_PURPOSE = 'private-file';

// Durée de vie courte : le lien sert à consulter une pièce, pas à la
// conserver. Dix minutes couvrent largement l'ouverture d'un document.
const FILE_TOKEN_EXPIRES_IN = '10m';

// L'avertissement de repli ne sert qu'une fois par processus : il est émis au
// premier jeton, pas à chaque requête de fichier.
let repliAverti = false;

/**
 * Secret de signature des jetons de fichier.
 *
 * SECRET_FILE_TOKEN est la clé dédiée. Hors production, JWT_SECRET reste
 * accepté en repli pour ne pas casser les environnements existants — mais
 * c'est précisément ce qui rendait les deux jetons interchangeables, d'où
 * l'avertissement, et le refus au démarrage en production.
 */
function fileTokenSecret() {
  if (process.env.SECRET_FILE_TOKEN) return process.env.SECRET_FILE_TOKEN;

  if (!repliAverti) {
    repliAverti = true;
    console.warn(
      "SECRET_FILE_TOKEN est absent : les jetons de fichiers privés sont signés avec JWT_SECRET. " +
        'Cette variable doit être définie, et différente de JWT_SECRET, avant toute mise en production.'
    );
  }
  return process.env.JWT_SECRET;
}

/**
 * Garde de démarrage (appelée dans src/server.js).
 *
 * En production, un secret de fichier absent ou égal à JWT_SECRET est un refus
 * de démarrer : c'est une configuration, pas une panne, et continuer
 * reviendrait à exposer les documents d'identité sous le même secret que les
 * jetons d'accès.
 *
 * @throws {Error} si la configuration est inexploitable en production.
 */
export function assertFileTokenSecret() {
  if (process.env.NODE_ENV !== 'production') return;

  const { SECRET_FILE_TOKEN, JWT_SECRET } = process.env;
  if (!SECRET_FILE_TOKEN) {
    throw new Error('SECRET_FILE_TOKEN est obligatoire en production (signature des jetons de fichiers privés)');
  }
  if (SECRET_FILE_TOKEN === JWT_SECRET) {
    throw new Error('SECRET_FILE_TOKEN doit être différent de JWT_SECRET en production');
  }
}

/**
 * Signe un jeton de fichier pour un Media et un membre du staff.
 *
 * @param {{ mediaId: number, staffUserId: number }} params
 * @returns {string} jeton signé, valable 10 minutes.
 */
export function signFileToken({ mediaId, staffUserId }) {
  return jwt.sign(
    { purpose: FILE_TOKEN_PURPOSE, mediaId, sub: String(staffUserId) },
    fileTokenSecret(),
    { audience: FILE_TOKEN_AUDIENCE, expiresIn: FILE_TOKEN_EXPIRES_IN }
  );
}

/**
 * Vérifie un jeton de fichier : signature, expiration, audience, finalité.
 *
 * @param {string} token
 * @returns {object} charge utile du jeton (purpose, mediaId, sub).
 * @throws {Error} si le jeton est expiré, altéré, ou n'est pas un jeton de
 *                  fichier (jeton d'accès, audience inconnue, finalité autre).
 */
export function verifyFileToken(token) {
  const payload = jwt.verify(token, fileTokenSecret(), { audience: FILE_TOKEN_AUDIENCE });
  // L'audience est déjà vérifiée par jsonwebtoken ; la finalité reste à
  // contrôler explicitement, car deux usages peuvent partager une audience.
  if (payload?.purpose !== FILE_TOKEN_PURPOSE) {
    throw new Error('Jeton de fichier invalide : finalité inattendue');
  }
  return payload;
}