import prisma from '../config/prisma.js';
import { generateOneTimeToken, hashOneTimeToken } from './oneTimeToken.js';
import { backendUrl } from './links.js';
import { sendTemplateEmail } from '../config/email/sendMail.js';

// Verification de l'adresse email.
//
// User.emailVerified existait depuis la premiere migration sans jamais etre
// ecrite ni lue : il n'y avait aucune verification. Le drapeau est pose par un
// jeton a usage unique envoye par email, et expose dans le jeton d'acces.
//
// Non bloquante : un compte non verifie utilise l'API normalement. L'indicateur
// sert a l'affichage et au scoring, pas a autoriser. C'est un choix assume —
// bloquer ici condamnerait au MVP tout utilisateur dont le mail arrive a
// l'etre spam.

const TTL_HOURS = parseInt(process.env.EMAIL_VERIFICATION_TTL_HOURS || '24', 10);
const COOLDOWN_MINUTES = parseInt(process.env.RESEND_VERIFICATION_COOLDOWN_MINUTES || '5', 10);

function expiresAt() {
  return new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000);
}

function cooldownStart(maintenant) {
  return new Date(maintenant.getTime() - COOLDOWN_MINUTES * 60 * 1000);
}

/**
 * Emet un jeton de verification et renvoie sa valeur claire.
 *
 * A attendre par l'appelant : l'existence du jeton en base est un fait dont la route
 * a besoin avant de repondre, alors que l'envoi du message ne l'est pas.
 * Confondre les deux forceait soit a bloquer la reponse sur le SMTP, soit a
 *repondre avant que le lien existe et reponde "lien invalide" a l'utilisateur.
 *
 * Les jetons anterieurs sont marques utilises plutot que supprimes : la table
 * garde ainsi l'historique, et un changement d'adresse peut repondre "ce lien ne
 * vaut plus" au lieu de "lien inconnu".
 *
 * @returns {Promise<string|null>} le jeton en clair, ou null si le cooldown bloque.
 */
export async function issueVerificationToken(user, { force = false } = {}) {
  const maintenant = new Date();

  // Fenetre de cooldown : sans elle, "renvoyer" permet d'inonder une boite, et
  // le serveur d'email se met a rejeter les envois legitimes pour tout le monde.
  if (!force) {
    const recent = await prisma.emailVerificationToken.findFirst({
      where: { userId: user.id, usedAt: null, createdAt: { gt: cooldownStart(maintenant) } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (recent) return null;
  }

  await prisma.emailVerificationToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: maintenant },
  });

  const rawToken = generateOneTimeToken();
  await prisma.emailVerificationToken.create({
    data: {
      token: hashOneTimeToken(rawToken),
      userId: user.id,
      expiresAt: expiresAt(),
    },
  });

  return rawToken;
}

/**
 * Envoie le message qui porte le lien.
 *
 * Volontairement non attendu par les appelants, comme l'email de bienvenue : le
 * SMTP est la dependance la moins fiable du projet, et faire dependre le temps
 * de reponse d'une inscription de la joignabilite d'un serveur de messagerie
 * serait le pire des deux mondes. sendTemplateEmail ne leve jamais.
 *
 * L'appel a sendTemplateEmail est synchrone : les proprietes du message sont donc
 * disponibles immediatement apres l'appel, ce qui rend l'envoi observable sans
 * attendre.
 */
export function dispatchVerificationEmail(user, rawToken, { username } = {}) {
  return sendTemplateEmail(
    user.email,
    'Confirmez votre adresse email AgriConnect',
    'verify-email',
    {
      heading: 'Confirmez votre adresse',
      username: username ?? `${user.firstname} ${user.lastname}`,
      // Le lien est construit ici et non dans le gabarit : un gabarit qui connait
      // la construction d'URL dupliquerait la regle, et le jour ou la forme du
      // lien change il faudrait corriger les deux.
      verificationUrl: backendUrl('/api/v2/auth/verify-email', { token: rawToken }),
    }
  );
}

/**
 * Verifie une adresse a partir d'un jeton.
 *
 * Trois refus distincts, tous affiches de facon differente sur la page : dire
 * "expire" a un instant donne d'autres informations que "inconnu", mais ces
 * pages ne sont vues que par la personne qui detient le lien.
 *
 * @returns {Promise<{ ok: true } | { ok: false; reason: 'inconnu' | 'expire' | 'deja_utilise' }>}
 */
export async function consumeVerificationToken(rawToken) {
  const stored = await prisma.emailVerificationToken.findUnique({
    where: { token: hashOneTimeToken(rawToken) },
  });

  if (!stored) return { ok: false, reason: 'inconnu' };
  if (stored.usedAt) return { ok: false, reason: 'deja_utilise' };
  if (stored.expiresAt < new Date()) return { ok: false, reason: 'expire' };

  // La mise a jour est conditionnelle sur usedAt encore nul : deux verifications
  // simultanees du meme lien ne doivent pas passer toutes les deux.
  const consomme = await prisma.emailVerificationToken.updateMany({
    where: { id: stored.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (consomme.count === 0) return { ok: false, reason: 'deja_utilise' };

  await prisma.user.update({ where: { id: stored.userId }, data: { emailVerified: true } });

  return { ok: true };
}

/**
 * Repart de zero apres un changement d'adresse.
 *
 * Sans cela, changer son email vers une adresse non verifiable ferait heriter du
 * verified=true de la precedente : le drapeau decrirait alors une adresse qui
 * n'est pas la sienne.
 *
 * Invalide aussi les jetons en cours — le nouveau message doit etre le seul
 * valable — et renvoie un email.
 */
export async function resetVerificationForNewEmail(user) {
  const [, reinitialise] = await prisma.$transaction([
    prisma.emailVerificationToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({ where: { id: user.id }, data: { emailVerified: false } }),
  ]);

  // force : l'utilisateur vient d'agir, il ne doit pas subir le cooldown.
  const rawToken = await issueVerificationToken(user, { force: true });
  if (rawToken) dispatchVerificationEmail(user, rawToken);

  // L'utilisateur reinitialise est renvoye : l'appelant a mis a jour l'adresse
  // juste avant, et repondre avec son objet anterieur ferait dire au client que
  // le compte est encore verifie alors qu'il ne l'est plus.
  return reinitialise;
}