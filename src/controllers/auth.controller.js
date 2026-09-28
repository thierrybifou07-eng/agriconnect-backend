import bcrypt from 'bcrypt';
import prisma from '../config/prisma.js';
import { generateToken } from '../utils/jwt.js';
import { generateRefreshTokenValue, hashToken } from '../utils/refreshToken.js';
import { getLookupId } from '../utils/lookupCache.js';
import { sendMail } from '../utils/sendMail.js';

const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10);

// Rôles autorisés à l'inscription publique. ADMIN et ROOT ne sont JAMAIS accessibles
// ici : ROOT se crée uniquement via scripts/create-root.js (CLI serveur), ADMIN
// uniquement via POST /api/admin/users (réservé à ROOT). Liste blanche volontairement
// statique dans le code, pas pilotée par la table Role, pour ne jamais faire dépendre
// une décision de sécurité d'une donnée modifiable.
const PUBLIC_ROLES = ['FARMER', 'BUYER', 'DRIVER'];

async function issueRefreshToken(userId) {
  const rawToken = generateRefreshTokenValue();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({ data: { token: hashToken(rawToken), userId, expiresAt } });
  return rawToken;
}
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
  };
}
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

  const accessToken = generateToken({ id: user.id, role: user.role.code });
  const refreshToken = await issueRefreshToken(user.id);

  // Non-bloquant : un email non envoyé ne doit jamais faire échouer l'inscription
  if (user.email) {
    sendMail({
      to: user.email,
      subject: 'Bienvenue sur AgriConnect',
      template: 'welcome',
      data: { fullName: userFullName(user), roleLabel: user.role.label },
    }).catch((err) => console.error('Email de bienvenue non envoyé:', err.message));
  }

  // const { password: _pw, ...userSafe } = user;
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

  const accessToken = generateToken({ id: user.id, role: user.role.code });
  const refreshToken = await issueRefreshToken(user.id);

  // const { password: _pw, ...userSafe } = user;
  res.json({ user: safeUserToApi(user), accessToken, refreshToken });
};

// POST /api/auth/refresh
export const refresh = async (req, res) => {
  const { refreshToken } = req.body;

  const tokenHash = hashToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({ where: { token: tokenHash } });

  if (!stored || stored.revoked || stored.expiresAt < new Date()) {
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

  const accessToken = generateToken({ id: user.id, role: user.role.code });
  res.json({ accessToken });
};

// POST /api/auth/logout
export const logout = async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken est requis' });
  }
  const tokenHash = hashToken(refreshToken);
  await prisma.refreshToken.updateMany({ where: { token: tokenHash }, data: { revoked: true } });
  res.status(204).send();
};
