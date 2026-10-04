import prisma from '../config/prisma.js';
import { generateRefreshTokenValue, hashToken } from './refreshToken.js';

// Cycle de vie des sessions.
//
// RefreshToken etait un sac plat par utilisateur : rien ne distinguait deux
// connexions du meme compte, et une deconnexion ne revocait que l'un des jetons
// alors que les connexions concurrentes restaient valides. Une session est un
// appareil connecte ; elle porte les jetons de cet appareil et permet de ne
// couper que lui.

const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10);

export function refreshTokenExpiry() {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Une session est active si elle n'est pas close et pas expiree.
 *
 * Les deux cas sont distincts et le restent : une session close est une
 * deconnexion volontaire, une session expiree est une session oubliee.
 */
export function isSessionActive(session, now = new Date()) {
  return Boolean(session) && !session.revokedAt && session.expiresAt > now;
}

/**
 * Ouvre une session pour un utilisateur.
 *
 * `req` est facultatif : le user-agent et l'adresse IP sont absents plus
 * souvent qu'ils ne sont presents, et leur absence ne doit pas empêcher de
 * connecter quelqu'un.
 */
export async function openSession(userId, req) {
  const userAgent = req?.get?.('user-agent') ?? null;
  const ip = req?.ip ?? req?.socket?.remoteAddress ?? null;

  return prisma.session.create({
    data: {
      userId,
      userAgent,
      ip,
      expiresAt: refreshTokenExpiry(),
    },
  });
}

/**
 * Emet un jeton de rafraichissement au sein d'une session.
 *
 * Seule l'empreinte est stockee : la base ne doit pas permettre de renegocier
 * un acces a partir d'une fuite. La valeur claire n'est renvoyee qu'a l'appelant,
 * qui la remet au client.
 */
export async function issueRefreshToken(userId, sessionId) {
  const rawToken = generateRefreshTokenValue();
  await prisma.refreshToken.create({
    data: {
      token: hashToken(rawToken),
      userId,
      sessionId,
      expiresAt: refreshTokenExpiry(),
    },
  });
  return rawToken;
}

/**
 * Ferme une session et tous les jetons qu'elle porte.
 *
 * Ferme la session et revoke ses jetons dans une transaction : sans cela, une
 * erreur entre les deux laisserait des jetons actifs sans session active, donc
 * des acces qui survivent a la deconnexion.
 */
export async function closeSession(sessionId) {
  const maintenant = new Date();
  await prisma.$transaction([
    prisma.refreshToken.updateMany({
      where: { sessionId, revoked: false },
      data: { revoked: true },
    }),
    prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: maintenant },
    }),
  ]);
}

/**
 * Ferme toutes les sessions d'un utilisateur, sauf celle conservee.
 *
 * Utilise par la reinitialisation de mot de passe et la deconnexion globale.
 * Une session deja fermee n'est pas renvoyee par le filtre, donc la colonne
 * reste un historique et non un drapeau.
 */
export async function closeAllSessions(userId, exceptSessionId = null) {
  const maintenant = new Date();
  return prisma.$transaction([
    prisma.refreshToken.updateMany({
      where: {
        userId,
        revoked: false,
        ...(exceptSessionId !== null && { sessionId: { not: exceptSessionId } }),
      },
      data: { revoked: true },
    }),
    prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId !== null && { id: { not: exceptSessionId } }),
      },
      data: { revokedAt: maintenant },
    }),
  ]);
}