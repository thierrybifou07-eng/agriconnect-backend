import crypto from 'crypto';

// Jeton a usage unique : rafraichissement, verification d'adresse,
// reinitialisation de mot de passe.
//
// La valeur brute part une seule fois vers le client, dans un lien ou une
// reponse. Seul le hash est stocke : une fuite de la base ne doit pas permettre
// de renegocier un acces, ni de verifier une adresse qui ne nous appartient pas.
//
// 40 octets entropiques, soit 80 caracteres hexadecimaux. Un jeton court
// donnerait une hypotese par seconde a un attaquant ; c'est le seul endroit du
// projet ou la longueur compte vraiment.

export function generateOneTimeToken() {
  return crypto.randomBytes(40).toString('hex');
}

export function hashOneTimeToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}