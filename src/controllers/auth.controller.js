import bcrypt from 'bcrypt';
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
} from '../utils/passwordReset.js';

// Rôles autorisés à l'inscription publique. ADMIN et ROOT ne sont JAMAIS accessibles
// ici : ROOT se crée uniquement via scripts/create-root.js (CLI serveur), ADMIN
// uniquement via POST /api/admin/users (réservé à ROOT). Liste blanche volontairement
// statique dans le code, pas pilotée par la table Role, pour ne jamais faire dépendre
// une décision de sécurité d'une donnée modifiable.
const PUBLIC_ROLES = ['FARMER', 'BUYER', 'DRIVER'];

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
  const { firstname, lastname, phone, email, password, role, location, vehicleType } = req.body;

  if (!PUBLIC_ROLES.includes(role)) {
    return res.status(400).json({ error: 'role doit être FARMER, BUYER ou DRIVER' });
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

  const user = await prisma.user.create({
    data: {
      firstname,
      lastname,
      phone,
      email,
      password: hashedPassword,
      roleId,
      userStatusId,
      location,
      ...(role === 'DRIVER' && vehicleType && { vehicleType }),
    },
    include: { role: true, userStatus: true },
  });

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
