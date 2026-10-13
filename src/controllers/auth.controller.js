import bcrypt from 'bcrypt';
import { randomInt } from 'node:crypto';
import prisma from '../config/prisma.js';
import { generateToken } from '../utils/jwt.js';
import { hashToken } from '../utils/refreshToken.js';
import {
  openSession,
  issueRefreshToken,
  closeSession,
  closeAllSessions,
  isRefreshTokenUsable,
  rotateRefreshToken,
} from '../utils/session.js';
import { getLookupId } from '../utils/lookupCache.js';
import { sendTemplateEmail } from '../config/email/sendMail.js';
import { userToApi } from '../utils/userApi.js';
import { renderPage } from '../utils/renderPage.js';
import {
  issueVerificationToken,
  dispatchVerificationEmail,
  consumeVerificationToken,
  resetVerificationForNewEmail,
} from '../utils/emailVerification.js';
import {
  issuePasswordResetToken,
  dispatchPasswordResetEmail,
  consumePasswordResetToken,
  checkPasswordResetToken,
  sendSecurityAlertEmail,
} from '../utils/passwordReset.js';
import { getCurrentVersion, REQUIRED_DOCUMENTS_BY_ROLE } from '../utils/legal.js';

// Rôles autorisés à l'inscription publique. ADMIN, AGENT, ROOT et DRIVER ne sont
// JAMAIS accessibles ici : ROOT se crée uniquement via scripts/create-root.js
// (CLI serveur), les comptes d'équipe (ADMIN, AGENT, DRIVER) par l'équipe elle-même
// via les routes d'administration. Liste blanche volontairement statique dans le
// code, pas pilotée par la table Role, pour ne jamais faire dépendre une décision
// de sécurité d'une donnée modifiable.
const PUBLIC_ROLES = ['SUPPLIER', 'BUYER'];

// Alphabet prive de 0, O, 1 et I : un code de parrainage se recopie a la main
// et se lit a voix haute ; deux caracteres qui se confondent n'y ont pas leur
// place.
const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateReferralCode() {
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += REFERRAL_ALPHABET[randomInt(REFERRAL_ALPHABET.length)];
  }
  return code;
}

function userFullName(user) {
  return `${user.firstname} ${user.lastname}`;
}
// Le jeton porte l'etat du compte pour que le client puisse l'afficher sans
// redemander, et la session pour qu'il reconnaisse son appareil. Voir jwt.js.
const accessTokenFor = (user, sessionId) =>
  generateToken({
    id: user.id,
    role: user.role.code,
    userStatus: user.userStatus.code,
    emailVerified: user.emailVerified,
    sessionId,
  });
// POST /api/auth/register
export const register = async (req, res) => {
  const { firstname, lastname, phone, email, password, role, location, referralCode, farmName, buyerType, businessName } = req.body;

  if (!PUBLIC_ROLES.includes(role)) {
    return res.status(400).json({ error: 'role doit être SUPPLIER ou BUYER' });
  }

  const existingPhone = await prisma.user.findUnique({ where: { phone } });
  if (existingPhone) {
    return res.status(409).json({ error: 'Un compte existe déjà avec ce numéro' });
  }
  const existingEmail = await prisma.user.findUnique({ where: { email } });
  if (existingEmail) {
    return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
  }

  const [roleId, userStatusId] = await Promise.all([
    getLookupId('role', role),
    getLookupId('userStatus', 'ACTIVE'),
  ]);

  const hashedPassword = await bcrypt.hash(password, 10);

  // Compte, profil, acceptations et parrainage dans une seule transaction : un
  // code de parrainage invalide ne doit laisser aucun compte derriere lui, et
  // un echec sur le profil ne doit pas laisser un compte orphelin.
  const inscription = await prisma.$transaction(async (tx) => {
    // Code unique : 5 essais, puis on abandonne plutot que de repondre avec
    // un code deja pris.
    let codeParrainage = null;
    for (let essai = 0; essai < 5 && !codeParrainage; essai += 1) {
      const candidat = generateReferralCode();
      const collision = await tx.user.findUnique({ where: { referralCode: candidat } });
      if (!collision) codeParrainage = candidat;
    }
    if (!codeParrainage) {
      throw Object.assign(new Error('Impossible de generer un code de parrainage unique'), {
        statusCode: 500,
        code: 'REFERRAL_CODE_UNAVAILABLE',
      });
    }

    const user = await tx.user.create({
      data: {
        firstname,
        lastname,
        phone,
        email,
        password: hashedPassword,
        roleId,
        userStatusId,
        location,
        referralCode: codeParrainage,
      },
      include: { role: true, userStatus: true },
    });

    // Le profil est cree des l'inscription : un compte sans profil est un
    // compte qui ne peut rien faire sur la plateforme.
    if (role === 'SUPPLIER') {
      await tx.supplierProfile.create({
        data: {
          userId: user.id,
          farmName: farmName ?? `${firstname} ${lastname}`,
        },
      });
    } else {
      await tx.buyerProfile.create({
        data: {
          userId: user.id,
          buyerType: buyerType ?? 'RETAILER',
          businessName: businessName ?? null,
        },
      });
    }

    // Acceptation des documents requis du role, dans leur version PUBLISHED :
    // c'est cette version que l'utilisateur a acceptee sous acceptTerms.
    for (const code of REQUIRED_DOCUMENTS_BY_ROLE[role]) {
      const version = await getCurrentVersion(code);
      if (version) {
        await tx.termsAcceptance.create({
          data: { userId: user.id, versionId: version.id, ipAddress: req.ip },
        });
      }
    }

    // Parrainage : le code est verifie dans la transaction, sinon un code
    // invalide laisserait le compte du filleul derriere lui. Le throw annule la
    // transaction : c'est le seul moyen de rollback, un simple return commiterait
    // le compte deja cree.
    if (referralCode) {
      const parrain = await tx.user.findUnique({ where: { referralCode } });
      if (!parrain) {
        throw Object.assign(new Error('Code de parrainage invalide'), {
          statusCode: 400,
          code: 'REFERRAL_CODE_UNKNOWN',
        });
      }
      await tx.referral.create({
        data: {
          referrerId: parrain.id,
          referredId: user.id,
          kind: role,
          status: 'PENDING',
        },
      });
    }

    return user;
  });

  const user = inscription;

  // Inscription et connexion ouvrent chacune une session : une session est un
  // appareil connecte, et c'est elle qui portera les jetons de rafraichissement
  // de cet appareil.
  const session = await openSession(user.id, req);
  const accessToken = accessTokenFor(user, session.id);
  const refreshToken = await issueRefreshToken(user.id, session.id);

  // Envoi de l'email de bienvenue, en arriere-plan.
//
// Le compte est deja cree : l'envoi ne doit pas pouvoir faire echouer
// l'inscription. On ne l'attend donc pas, et sendTemplateEmail ne leve jamais
// (il journalise l'echec). Le temps de reponse ne depend ainsi pas du serveur
// SMTP, qui est precisement la dependance la moins fiable.
//
// Le gabarit ne contient aucun code de verification : le projet n'a pas de
// fonction de verification d'adresse. Le code 00000 envoye precedemment ne
// correspondait a rien.
  sendTemplateEmail(
    user.email,
    'Bienvenue sur AgriConnect',
    'welcome',
    {
      heading: 'Bienvenue sur AgriConnect',
      username: userFullName(user),
      roleLabel: user.role.label,
    }
  );

  // Verification d'adresse, envoyee a part et non dans le message de bienvenue :
  // ce sont deux evenements distincts, avec des liens distincts et des durees de
  // vie distinctes.
  //
  // Le jeton est attendu — son existence en base est un fait dont la reponse a
  // besoin — mais l'envoi ne l'est pas : bloquer l'inscription sur la
  // joignabilite d'un serveur de messagerie serait le pire des deux mondes.
  const jetonVerification = await issueVerificationToken(user, { force: true });
  if (jetonVerification) {
    dispatchVerificationEmail(user, jetonVerification, { username: userFullName(user) });
  }

  // Le champ emailSent a ete retire : sans attendre l'envoi, il ne pouvait
  // qu'etre soit toujours faux, soit toujours vrai. Les clients ne doivent pas
  // deduire de la creation d'un compte que son email a bien ete delivre.
  res.status(201).json({ user: userToApi(user), accessToken, refreshToken });
};

// POST /api/auth/login
export const login = async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({
    where: { email },
    include: { role: true, userStatus: true },
  });
  if (!user) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }

  // Blocage 1/3 : connexion refusée pour un compte suspendu
  if (user.userStatus.code === 'SUSPENDED') {
    return res.status(403).json({ error: 'Ce compte a été suspendu' });
  }

  const session = await openSession(user.id, req);
  const accessToken = accessTokenFor(user, session.id);
  const refreshToken = await issueRefreshToken(user.id, session.id);

  // const { password: _pw, ...userSafe } = user;
  res.json({ user: userToApi(user), accessToken, refreshToken });
};

// POST /api/auth/refresh
export const refresh = async (req, res) => {
  const { refreshToken } = req.body;

  const tokenHash = hashToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { token: tokenHash },
    include: { session: true },
  });

  // La session est verifiee avec son jeton : un jeton peut rester valide alors
  // que la session qui le porte a ete close, et ce serait une deconnexion sans
  // effet. Un jeton remplace par rotation passe aussi ici : c'est la rotation
  // qui decide ensuite entre tolerance et fermeture de session.
  if (!isRefreshTokenUsable(stored)) {
    return res.status(401).json({ error: 'Refresh token invalide ou expiré' });
  }

  const user = await prisma.user.findUnique({
    where: { id: stored.userId },
    include: { role: true, userStatus: true },
  });
  if (!user) {
    return res.status(401).json({ error: 'Utilisateur introuvable' });
  }

  // Blocage 2/3 : un compte suspendu après l'émission de l'access token ne peut
  // pas en obtenir un nouveau au moment du refresh
  if (user.userStatus.code === 'SUSPENDED') {
    return res.status(403).json({ error: 'Ce compte a été suspendu' });
  }

  // Rotation : le jeton presente est remplace dans la meme session. Un jeton
  // represente hors tolerance est traite comme un vol et detruit la session
  // entiere, car elle a pu ete volee avec.
  const rotation = await rotateRefreshToken(stored);
  if (rotation.outcome === 'stolen') {
    return res.status(401).json({
      error: 'Session révoquée. Reconnectez-vous.',
    });
  }

  const accessToken = accessTokenFor(user, stored.sessionId);
  res.json({ accessToken, refreshToken: rotation.rawToken });
};

// POST /api/auth/forgot-password
//
// La reponse ne doit rien dire sur l'existence du compte. Deux raisons, une
// seule regle : distinguer les cas permettrait d'enumerer les adresses enregistrees,
// et repondre "compte inconnu" invite l'utilisateur a essayer une autre adresse
// sur une liste. Le message dit ce qui est vrai dans les deux cas — nous acceptons
// la demande — et laisse le silence faire le reste.
export const forgotPassword = async (req, res) => {
  const { email } = req.body;
  const message = 'Si un compte est enregistre avec cette adresse, un email vient de lui etre envoye.';

  const user = await prisma.user.findUnique({ where: { email } });

  // Un jeton n'est emis que pour un compte existant, mais la reponse est la meme.
  if (!user) {
    return res.status(200).json({ message });
  }

  const jeton = await issuePasswordResetToken(user);
  // L'envoi n'est pas attendu : la reponse ne doit pas dependre du serveur de
  // messagerie, ni pour son contenu ni pour son delai.
  dispatchPasswordResetEmail(user, jeton);

  res.status(200).json({ message });
};

// GET /api/auth/reset-password?token=...
//
// Affiche le formulaire, sans consommer le jeton.
//
// separation volontaire : plusieurs clients de messagerie et la plupart des
// antivirus prechargent les liens. Un GET qui consomme le jeton pourrait changer un
// mot de passe avant que son proprietaire n'ait vu la page — et laisserait
// l'utilisateur devant un formulaire qui ne fonctionne plus. C'est le meme
// raisonnement que pour la verification d'adresse.
export const resetPasswordPage = async (req, res) => {
  const brut = req.query.token ?? '';
  const verdict = brut ? await checkPasswordResetToken(brut) : { ok: false, reason: 'inconnu' };

  const messages = {
    inconnu: 'Ce lien est invalide. Demandez-en un nouveau.',
    expire: 'Ce lien a expire. Demandez-en un nouveau.',
    deja_utilise: 'Ce lien a deja servi.',
  };

  const html = await renderPage('formulaire', {
    title: 'Nouveau mot de passe',
    // L'erreur est dite avant le formulaire : mieux vaut que l'utilisateur
    // sache qu'il doit repartir d'une demande plutot qu'il tape un mot de passe
    // qui serait refuse apres coup.
    erreur: verdict.ok ? null : messages[verdict.reason],
    description: 'Choisissez un nouveau mot de passe pour votre compte AgriConnect.',
    action: '/api/auth/reset-password',
    token: brut,
    champMotDePasse: verdict.ok,
    libelle: 'Enregistrer',
  });

  if (html === null) return res.status(500).send('Page indisponible');
  res.type('html').send(html);
};

// POST /api/auth/reset-password
export const resetPassword = async (req, res) => {
  const { token, password } = req.body;

  const reinitialisation = await prisma.$transaction(async (tx) => {
    const verdict = await consumePasswordResetToken(token);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    // Le mot de passe et la consommation du jeton dans la meme transaction : si
    // l'echec du hachage laissait le jeton consomme, l'utilisateur devrait
    // redemander un lien pour une raison qui n'a rien a voir avec lui.
    await tx.user.update({
      where: { id: verdict.userId },
      data: { password: await bcrypt.hash(password, 10) },
    });

    return { ok: true, userId: verdict.userId };
  });

  const messages = {
    inconnu: 'Ce lien est invalide ou a expire.',
    expire: 'Ce lien est invalide ou a expire.',
    deja_utilise: 'Ce lien a deja servi.',
  };

  if (!reinitialisation.ok) {
    return res.status(400).json({ error: messages[reinitialisation.reason] });
  }

  const user = await prisma.user.findUnique({
    where: { id: reinitialisation.userId },
    include: { role: true, userStatus: true },
  });

  // Toutes les sessions tombent, session courante comprise. Changer de mot de
  // passe sans couper les acces laisses un voleur tranquillement connecte avec
  // l'ancien mot de passe ; c'est le scenario d'abus le plus courant. La
  // session qui portrait le lien est elle-meme close : elle porte l'ancien mot
  // passe et ne peut plus rien garantir.
  await closeAllSessions(user.id);

  // Alerte de securite : une reinitialisation sans notification laisse la
  // victime sans moyen de savoir qu'elle a ete contrainte de changer. C'est ce
  // message qui lui permet d'agir sur ses autres comptes.
  sendSecurityAlertEmail(user);

  const html = await renderPage('formulaire', {
    title: 'Mot de passe modifie',
    description: '',
    action: '',
    token: '',
    libelle: '',
    succes: 'Votre mot de passe a ete modifie. Reconnectez-vous sur vos appareils.',
  });
  if (html === null) return res.status(200).json({ message: 'Mot de passe modifie' });
  res.type('html').send(html);
};

// GET /api/auth/verify-email?token=...
//
// Affiche une page de confirmation, sans consommer le jeton.
//
// Cette separation n'est pas un detail : beaucoup de clients de messagerie et
// d'antivirus prechargent les liens pour detecter les menaces. Un GET qui
// consomme le jeton pourrait donc verifier une adresse sans que son proprietaire
// l'ait jamais vue. Le meme principe governera la reinitialisation de mot de
// passe, ou l'enjeu est plus grave encore.
export const verifyEmailPage = async (req, res) => {
  const html = await renderPage('formulaire', {
    title: 'Confirmer votre adresse',
    description:
      'Confirmez que cette adresse email est bien la votre. Vous pourrez continuer a utiliser AgriConnect dans tous les cas.',
    action: '/api/auth/verify-email',
    token: req.query.token ?? '',
    libelle: 'Confirmer mon adresse',
    succes: null,
    erreur: null,
  });

  if (html === null) return res.status(500).send('Page indisponible');
  res.type('html').send(html);
};

// POST /api/auth/verify-email
export const verifyEmail = async (req, res) => {
  const resultat = await consumeVerificationToken(req.body.token);

  if (!resultat.ok) {
    const messages = {
      inconnu: 'Ce lien est invalide.',
      expire: 'Ce lien a expire. Demandez-en un nouveau.',
      deja_utilise: 'Ce lien a deja servi.',
    };
    const html = await renderPage('formulaire', {
      title: 'Confirmation impossible',
      description: '',
      action: '/api/auth/verify-email',
      token: '',
      libelle: 'Confirmer mon adresse',
      succes: null,
      erreur: messages[resultat.reason],
    });
    if (html === null) return res.status(500).send('Page indisponible');
    // 400 et non 404 : le lien existe, il n'est simplement plus valable.
    return res.status(400).type('html').send(html);
  }

  const html = await renderPage('formulaire', {
    title: 'Adresse confirmee',
    description: '',
    action: '',
    token: '',
    libelle: '',
    succes: 'Votre adresse email est verifiee.',
    erreur: null,
  });
  if (html === null) return res.status(500).send('Page indisponible');
  res.type('html').send(html);
};

// POST /api/auth/resend-verification
export const resendVerification = async (req, res) => {
  // force : l'utilisateur vient d'appeler explicitement, le cooldown protege la
  // boite mais ne doit pas transformer un renvoi manuel en echec.
  const jeton = await issueVerificationToken(req.user, { force: true });
  if (jeton) dispatchVerificationEmail(req.user, jeton);

  // 202 et rien de plus. Rapporter si l'email est parti transformerait la reponse
  // en sonde de l'etat du SMTP, et le client n'a rien a y faire : sa seule
  // question est "mon adresse sera verifiee", a laquelle la reponse repond deja.
  res.status(202).json({
    message: 'Si cette adresse est valide, un email vient de lui etre envoye.',
  });
};

// GET /api/auth/sessions
//
// Sans cette surface, un appareil vole ne peut etre coupe qu'en changeant de
// mot de passe, ce qui deconnecte partout et ne dit rien a l'utilisateur. Lister
// ses sessions est la premiere etape pour reconnaitre celle qui ne devrait pas
// etre la sienne.
export const listSessions = async (req, res) => {
  const sessions = await prisma.session.findMany({
    where: { userId: req.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastActivityAt: 'desc' },
    select: {
      id: true,
      userAgent: true,
      ip: true,
      createdAt: true,
      lastActivityAt: true,
      expiresAt: true,
    },
  });

  res.json({
    sessions: sessions.map((session) => ({
      ...session,
      // Le jeton porte le sessionId de la connexion courante : c'est ce qui
      // permet au client de se reconnaitre sans deviner.
      isCurrent: session.id === req.sessionId,
    })),
  });
};

// DELETE /api/auth/sessions/:id
export const closeSessionById = async (req, res) => {
  const sessionId = Number(req.params.id);

  // Le filtre porte sur l'utilisateur ET sur l'identifiant. Sans le premier, un
  // compte pourrait fermer les sessions d'un autre.
  //
  // La session est recherchee sans condition sur revokedAt : refermer une
  // session deja fermee renvoie 204 plutot que 404. Le client peut avoir perdu la
  // reponse et reessayer, et "cet appareil n'a plus acces" reste vrai au second
  // essai. Filtrer sur les sessions ouvertes ferait dependre la reponse de
  // l'etat anterieur, ce qui n'apprend rien de plus a l'appelant.
  const fermee = await prisma.session.findFirst({ where: { id: sessionId, userId: req.user.id } });
  if (!fermee) {
    return res.status(404).json({ error: 'Session introuvable' });
  }

  await closeSession(fermee.id);
  res.status(204).send();
};

// POST /api/auth/logout-all
export const logoutAll = async (req, res) => {
  // La session courante est preservee : l'utilisateur demande de couper les
  // autres appareils, pas de se deconnecter lui-meme en appelant la route.
  await closeAllSessions(req.user.id, req.sessionId ?? null);
  res.status(204).send();
};

// POST /api/auth/logout
export const logout = async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken est requis' });
  }

  // On ferme la session plutot que le seul jeton. Le logout doit couper cet
  // appareil la, ou le client pourrait continuer a rafraichir avec le meme jeton
  // jusqu'a son expiration.
  //
  // Fermer une session deja fermee est sans effet, ce qui rend la deconnexion
  // idempotente : un second appel, ou un jeton inconnu, ne renvoie pas d'erreur.
  const stored = await prisma.refreshToken.findUnique({ where: { token: hashToken(refreshToken) } });
  if (stored) {
    await closeSession(stored.sessionId);
  }

  res.status(204).send();
};
