const crypto = require('crypto');

// Génère la valeur brute du refresh token (envoyée une seule fois au client, jamais stockée telle quelle)
function generateRefreshTokenValue() {
  return crypto.randomBytes(40).toString('hex');
}

// On stocke uniquement le hash en base, comme pour un mot de passe :
// si la base fuite, les refresh tokens des utilisateurs ne sont pas directement exploitables.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { generateRefreshTokenValue, hashToken };
