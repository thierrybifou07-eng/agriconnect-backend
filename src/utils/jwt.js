import jwt from 'jsonwebtoken';

// Charge utile du jeton d'acces.
//
// Le jeton porte le statut du compte et la verification de l'adresse pour que
// le client puisse afficher l'etat d'un compte sans aller le redemander, et pour
// qu'il puisse reconnaitre un changement sans recharger son etat.
//
// Ces informations restent informatives : `protect` recharge l'utilisateur en
// base a chaque requete et n'accorde jamais une permission sur la foi du jeton.
// Un jeton peut donc porter un statut perime sans consequence, et un jeton
// portant un statut plus permissif que la base ne fait rien passer.
//
// `sessionId` identifie l'appareil connecte. C'est lui qui permet au client de
// reconnaitre sa propre session parmi celles qu'il liste, et de fermer les
// autres.
export function generateToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
  });
}

export function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}
