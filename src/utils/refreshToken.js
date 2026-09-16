import crypto from 'crypto';

// Génère la valeur brute du refresh token (envoyée une seule fois au client, jamais stockée telle quelle)
export function generateRefreshTokenValue() {
  return crypto.randomBytes(40).toString('hex');
}

// On stocke uniquement le hash en base, comme pour un mot de passe.
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
