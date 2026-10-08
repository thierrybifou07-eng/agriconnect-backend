import prisma from '../config/prisma.js';
import { generateOneTimeToken, hashOneTimeToken } from './oneTimeToken.js';
import { backendUrl } from './links.js';
import { sendTemplateEmail } from '../config/email/sendMail.js';

// Reinitialisation de mot de passe.
//
// Le principe directeur est l'absence d'enumeration : la reponse ne doit
// permettre a personne de deduire qu'une adresse est enregistree. C'est pour cela
// que rien dans cette fonction ne renvoie d'information sur la personne trouvee
// ou non, et que le choix de traiter ou non l'email appartient au seul appelant.

const TTL_MINUTES = parseInt(process.env.PASSWORD_RESET_TTL_MINUTES || '15', 10);

function expiresAt() {
  return new Date(Date.now() + TTL_MINUTES * 60 * 1000);
}

/**
 * Alerte envoyee apres un changement de mot de passe.
 *
 * Incontournable : une reinitialisation sans notification laisse la victime sans
 * moyen d'apprendre qu'elle a ete contrainte d'en changer un. C'est le scenario
 * d'usage abusif le plus courant, et ce message est ce qui permet d'agir — sur
 * ce compte et sur les autres qui partagent le mot de passe.
 *
 * Non attendue, comme tous les envois : elle ne doit jamais retarder la reponse
 * ni la faire echouer.
 */
export function sendSecurityAlertEmail(user) {
  return sendTemplateEmail(
    user.email,
    'Votre mot de passe AgriConnect a été modifié',
    'password-changed',
    {
      heading: 'Mot de passe modifié',
      username: `${user.firstname} ${user.lastname}`,
      // Date en francais, lisible par la personne qui recoit l'alerte.
      changedAt: new Date().toLocaleString('fr-FR', {
        dateStyle: 'long',
        timeStyle: 'short',
      }),
    }
  );
}

/**
 * Emet un jeton de reinitialisation et renvoie sa valeur claire.
 *
 * Un seul jeton valide a la fois : les anterieurs sont marques utilises plutot
 * que supprimes, ce qui garde l'historique et permet de repondre "ce lien ne vaut
 * plus" plutot que "lien inconnu". En changer de mot de passe ne doit pas
 * laisser plusieurs liens actifs, sans quoi un ancien lien reste valable.
 *
 * Ne leve jamais : l'envoi ne doit pas conditionner le comportement de
 * l'endpoint, qui doit répondre pareil dans tous les cas.
 *
 * @returns {Promise<string|null>} le jeton en clair, ou null si l'utilisateur n'existe pas.
 */
export async function issuePasswordResetToken(user, { username } = {}) {
  const maintenant = new Date();

  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: maintenant },
  });

  const rawToken = generateOneTimeToken();
  await prisma.passwordResetToken.create({
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
 * Non attendu par l'appelant, comme l'email de bienvenue : le SMTP est la
 * dependance la moins fiable du projet. L'appel a sendTemplateEmail est
 * synchrone, donc les proprietes du message sont disponibles immediatement.
 */
export function dispatchPasswordResetEmail(user, rawToken, { username } = {}) {
  return sendTemplateEmail(
    user.email,
    'Réinitialisez votre mot de passe AgriConnect',
    'forgot-password',
    {
      heading: 'Réinitialisation du mot de passe',
      username: username ?? `${user.firstname} ${user.lastname}`,
      resetUrl: backendUrl('/api/v2/auth/reset-password', { token: rawToken }),
      ttlMinutes: TTL_MINUTES,
    }
  );
}

/**
 * Verifie un jeton de reinitialisation sans l'appliquer.
 *
 * Utilise par la page GET pour dire a l'utilisateur si son lien est encore
 * valable, avant qu'il ne tape un mot de passe pour rien.
 *
 * @returns {Promise<{ ok: true; userId: number } | { ok: false; reason: string }>}
 */
export async function checkPasswordResetToken(rawToken) {
  const stored = await prisma.passwordResetToken.findUnique({
    where: { token: hashOneTimeToken(rawToken) },
    select: { userId: true, usedAt: true, expiresAt: true },
  });

  if (!stored) return { ok: false, reason: 'inconnu' };
  if (stored.usedAt) return { ok: false, reason: 'deja_utilise' };
  if (stored.expiresAt < new Date()) return { ok: false, reason: 'expire' };

  return { ok: true, userId: stored.userId };
}

/**
 * Consomme un jeton et renvoie l'identifiant du compte concerne.
 *
 * La consommation et la verification du mot de passe se font ensemble, dans une
 * transaction appelee par le controleur. Cette fonction ne valide donc que le
 * jeton et marque l'utilisation ; elle ne fixe aucun secret.
 *
 * La mise a jour est conditionnelle sur usedAt encore nul : deux reinitialisations
 * simultanees du meme lien ne doivent pas passer toutes les deux.
 *
 * @returns {Promise<{ ok: true; userId: number } | { ok: false; reason: string }>}
 */
export async function consumePasswordResetToken(rawToken) {
  const verdict = await checkPasswordResetToken(rawToken);
  if (!verdict.ok) return verdict;

  const consomme = await prisma.passwordResetToken.updateMany({
    where: { token: hashOneTimeToken(rawToken), usedAt: null },
    data: { usedAt: new Date() },
  });

  if (consomme.count === 0) return { ok: false, reason: 'deja_utilise' };
  return { ok: true, userId: verdict.userId };
}