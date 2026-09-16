const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { generateToken } = require('../utils/jwt');
const { generateRefreshTokenValue, hashToken } = require('../utils/refreshToken');

const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10);

// Crée un refresh token en base (hashé) et retourne sa valeur brute (à envoyer au client une seule fois)
async function issueRefreshToken(userId) {
  const rawToken = generateRefreshTokenValue();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({
    data: { token: hashToken(rawToken), userId, expiresAt },
  });

  return rawToken;
}

// POST /api/auth/register
// La validation de format (téléphone, mot de passe, role...) est faite en amont par express-validator
const register = asyncHandler(async (req, res) => {
  const { fullName, phone, email, password, role, location, vehicleType } = req.body;

  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    return res.status(409).json({ error: 'Un compte existe déjà avec ce numéro' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: {
      fullName,
      phone,
      email,
      password: hashedPassword,
      role,
      location,
      ...(role === 'DRIVER' && vehicleType && { vehicleType }),
    },
  });

  const accessToken = generateToken({ id: user.id, role: user.role });
  const refreshToken = await issueRefreshToken(user.id);

  const { password: _pw, ...userSafe } = user;
  res.status(201).json({ user: userSafe, accessToken, refreshToken });
});

// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { phone, password } = req.body;

  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }

  const accessToken = generateToken({ id: user.id, role: user.role });
  const refreshToken = await issueRefreshToken(user.id);

  const { password: _pw, ...userSafe } = user;
  res.json({ user: userSafe, accessToken, refreshToken });
});

// POST /api/auth/refresh
// Échange un refresh token valide (non expiré, non révoqué) contre un nouvel access token.
// Le refresh token n'est PAS régénéré ici (pas de rotation) pour rester simple en MVP.
const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  const tokenHash = hashToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({ where: { token: tokenHash } });

  if (!stored || stored.revoked || stored.expiresAt < new Date()) {
    return res.status(401).json({ error: 'Refresh token invalide ou expiré' });
  }

  const user = await prisma.user.findUnique({ where: { id: stored.userId } });
  if (!user) {
    return res.status(401).json({ error: 'Utilisateur introuvable' });
  }

  const accessToken = generateToken({ id: user.id, role: user.role });
  res.json({ accessToken });
});

// POST /api/auth/logout
// Révoque le refresh token fourni (déconnexion de cet appareil uniquement)
const logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken est requis' });
  }

  const tokenHash = hashToken(refreshToken);
  await prisma.refreshToken.updateMany({ where: { token: tokenHash }, data: { revoked: true } });

  res.status(204).send();
});

module.exports = { register, login, refresh, logout };
