import bcrypt from 'bcrypt';
import prisma from '../config/prisma.js';
import { generateToken } from '../utils/jwt.js';
import { hashToken } from '../utils/refreshToken.js';
import { openSession, issueRefreshToken, closeSession, isRefreshTokenUsable, rotateRefreshToken } from '../utils/session.js';
import { getLookupId } from '../utils/lookupCache.js';
import { sendTemplateEmail } from '../config/email/sendMail.js';

// Rôles autorisés à l'inscription publique. ADMIN et ROOT ne sont JAMAIS accessibles
// ici : ROOT se crée uniquement via scripts/create-root.js (CLI serveur), ADMIN
// uniquement via POST /api/admin/users (réservé à ROOT). Liste blanche volontairement
// statique dans le code, pas pilotée par la table Role, pour ne jamais faire dépendre
// une décision de sécurité d'une donnée modifiable.
const PUBLIC_ROLES = ['FARMER', 'BUYER', 'DRIVER'];

function userFullName(user) {
  return `${user.firstname} ${user.lastname}`;
}
function safeUserToApi(user) {
  return {
    id: user.id,
    firstname: user.firstname,
    lastname: user.lastname,
    email: user.email,
    phone: user.phone,
    role: user.role.label,
    userStatus: user.userStatus.label,
    vehicleType: user.vehicleType,
    isAvailable: user.isAvailable,
    emailVerified: user.emailVerified,
  };
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

  // Le champ emailSent a ete retire : sans attendre l'envoi, il ne pouvait
  // qu'etre soit toujours faux, soit toujours vrai. Les clients ne doivent pas
  // deduire de la creation d'un compte que son email a bien ete delivre.
  res.status(201).json({ user: safeUserToApi(user), accessToken, refreshToken });
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
  res.json({ user: safeUserToApi(user), accessToken, refreshToken });
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
