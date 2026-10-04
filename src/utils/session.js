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

// Nombre de sessions ouvertes simultanement par compte. Au-dela, la plus
// ancienne est fermee : un compte qui s'accumule depuis des appareils perdus
// resterait connectable indefiniment.
export const SESSION_MAX_PER_USER = parseInt(process.env.SESSION_MAX_PER_USER || '5', 10);

// Duree pendant laquelle un jeton deja remplace peut encore etre presente.
//
// Ce delai existe parce que deux refreshs paralleles d'une meme application
// mobile sont ordinaires : plusieurs appels decouvrent en meme temps que le jeton
// d'acces a expire, et le second presenta donc un jeton que le premier vient de
// remplacer. Sans tolerant, le serveur y verrait un vol et detruirait la session
// d'un utilisateur parfaitement legitime.
//
// Ce que la tolerance achete, et ce qu'elle coute : un jeton vole reste
// utilisable pendant au plus cette fenetre apres son remplacement. C'est le
// compromis assume, legerement moins strict que la detection immediate.
export const REFRESH_REUSE_GRACE_SECONDS = parseInt(
  process.env.REFRESH_REUSE_GRACE_SECONDS || '30',
  10
);

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
 * Ouvre une session pour un utilisateur, en evictant les plus anciennes si le
 * plafond est atteint.
 *
 * `req` est facultatif : le user-agent et l'adresse IP sont absents plus
 * souvent qu'ils ne sont presents, et leur absence ne doit pas empêcher de
 * connecter quelqu'un.
 */
export async function openSession(userId, req) {
  const userAgent = req?.get?.('user-agent') ?? null;
  const ip = req?.ip ?? req?.socket?.remoteAddress ?? null;

  return prisma.$transaction(async (tx) => {
    const actives = await tx.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    // On libere le nombre de places necessaire, pas toutes les places libres :
    // on ne ferme que ce qui doit l'etre.
    const aEvacuer = actives.length - SESSION_MAX_PER_USER + 1;
    if (aEvacuer > 0) {
      const maintenant = new Date();
      const victimes = actives.slice(0, aEvacuer).map((s) => s.id);

      await tx.refreshToken.updateMany({
        where: { sessionId: { in: victimes }, revoked: false },
        data: { revoked: true },
      });
      await tx.session.updateMany({
        where: { id: { in: victimes } },
        data: { revokedAt: maintenant },
      });
    }

    return tx.session.create({
      data: { userId, userAgent, ip, expiresAt: refreshTokenExpiry() },
    });
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

/**
 * Un jeton peut-il etre utilise, ou faut-il le faire tourner ?
 *
 * Deux raisons de revoquer un jeton se distinguent, et la colonne unique `revoked`
 * les confondait. Un jeton revoque parce qu'il a ete REMPLACE par rotation
 * n'est pas vole : c'est le client lui-meme qui l'a presente, peut-etre par
 * megarde, et c'est rotateRefreshToken qui doit decider entre tolerance et
 * fermeture. Un jeton revoque parce qu'on s'est deconnecte, lui, ne revient pas.
 *
 * @returns {boolean} true si le jeton est valide tel quel.
 */
export function isRefreshTokenUsable(stored, now = new Date()) {
  if (!stored || !isSessionActive(stored.session, now)) return false;
  if (stored.expiresAt <= now) return false;
  return !(stored.revoked && !stored.rotatedAt);
}

/**
 * Tourne le jeton de rafraichissement au sein de sa session.
 *
 * @param {object} stored  Le jeton stocke, session incluse.
 * @returns {Promise<
 *   | { outcome: 'rotated'; rawToken: string }
 *   | { outcome: 'stolen' }
 * >}
 */
export async function rotateRefreshToken(stored) {
  const maintenant = new Date();

  if (!stored.rotatedAt) {
    // Rotation ordinaire : le jeton presente est remplace, et la session reste
    // ouverte.
    const rawToken = generateRefreshTokenValue();
    const nouveau = await prisma.refreshToken.create({
      data: {
        token: hashToken(rawToken),
        userId: stored.userId,
        sessionId: stored.sessionId,
        expiresAt: refreshTokenExpiry(),
      },
      select: { id: true },
    });

    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revoked: true, rotatedAt: maintenant, replacedById: nouveau.id },
      }),
      prisma.session.update({
        where: { id: stored.sessionId },
        data: { lastActivityAt: maintenant },
      }),
    ]);

    return { outcome: 'rotated', rawToken };
  }

  // Le jeton a deja ete remplace. Pendant la fenetre de tolerance, c'est un
  // double appel legitime : on rend un jeton et on prolonge.
  //
  // La fenetre se mesure depuis le PREMIER remplacement, et rotatedAt n'est donc
  // pas reecrit. Une chaine de presentations repetees ne peut donc pas
  // repousser l'echeance indefiniment : au-dela du delai initial, la session
  // est consideree comme volee.
  const age = maintenant.getTime() - stored.rotatedAt.getTime();
  if (age <= REFRESH_REUSE_GRACE_SECONDS * 1000) {
    const rawToken = generateRefreshTokenValue();
    const nouveau = await prisma.refreshToken.create({
      data: {
        token: hashToken(rawToken),
        userId: stored.userId,
        sessionId: stored.sessionId,
        expiresAt: refreshTokenExpiry(),
      },
      select: { id: true },
    });

    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: stored.id },
        data: { replacedById: nouveau.id },
      }),
      prisma.session.update({
        where: { id: stored.sessionId },
        data: { lastActivityAt: maintenant },
      }),
    ]);

    return { outcome: 'rotated', rawToken };
  }

  // Hors fenetre : un jeton remplace et represente plus tard n'appartient plus a
  // ce client. Toute la session tombe : elle peut avoir ete volee avec.
  await closeSession(stored.sessionId);
  return { outcome: 'stolen' };
}