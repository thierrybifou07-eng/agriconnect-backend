import { verifyToken } from '../utils/jwt.js';
import prisma from '../config/prisma.js';

// Vérifie le token JWT, charge l'utilisateur avec son rôle et son statut,
// et bloque l'accès si le compte est suspendu (1er des 3 points de blocage,
// avec login et refresh - voir auth.controller.js).
export const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentification requise' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      include: { role: true, userStatus: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'Utilisateur introuvable' });
    }
    if (user.userStatus.code === 'SUSPENDED') {
      return res.status(403).json({ error: 'Ce compte a été suspendu' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
};

// Restreint l'accès à des rôles précis (ex: requireRole('FARMER'))
export const requireRole = (...codes) => (req, res, next) => {
  if (!req.user || !codes.includes(req.user.role.code)) {
    return res.status(403).json({ error: 'Accès refusé pour ce rôle' });
  }
  next();
};

// Restreint l'accès par niveau hiérarchique (ex: requireMinLevel(50) => ADMIN ou ROOT)
export const requireMinLevel = (minLevel) => (req, res, next) => {
  if (!req.user || req.user.role.level < minLevel) {
    return res.status(403).json({ error: 'Privilèges insuffisants' });
  }
  next();
};
