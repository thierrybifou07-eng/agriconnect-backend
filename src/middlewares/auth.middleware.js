import { verifyToken } from '../utils/jwt.js';
import prisma from '../config/prisma.js';

// Vérifie le token JWT, charge l'utilisateur avec son rôle et son statut,
// et bloque l'accès si le compte est suspendu (1er des 3 points de blocage,
// avec login et refresh - voir auth.controller.js).
//
// La base est la reference, jamais le jeton. Le jeton porte bien le statut et la
// verification d'adresse, mais uniquement pour que le client n'ait pas a les
// redemander. Aucune autorisation n'est delivree sur la foi de ces claims : un
// jeton anterieur a une suspension est donc refuse, et un jeton anterieur a une
// verification reste utilisable parce que la base, elle, a rattrape.
export const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentification requise' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);

    // Selection explicite, sans `password`. Le middleware ne peut pas se fier a
    // la discrétion de chaque controleur : il suffit qu'un jour quelqu'un
    // reponde avec req.user pour que le hash parte en clair. On ne charge donc
    // jamais la colonne.
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        email: true,
        phone: true,
        location: true,
        latitude: true,
        longitude: true,
        isAvailable: true,
        vehicleType: true,
        emailVerified: true,
        role: true,
        userStatus: true,
      },
    });

    if (!user) {
      return res.status(401).json({ error: 'Utilisateur introuvable' });
    }
    if (user.userStatus.code === 'SUSPENDED') {
      return res.status(403).json({ error: 'Ce compte a été suspendu' });
    }

    req.user = user;
    // La session est conservee telle qu'elle est dans le jeton, sans
    // relecture : elle sert au client a reconnaitre son appareil, pas a
    // autoriser quoi que ce soit. Une session fermee est traitee par les routes
    // qui controlent un acces prolonge (refresh, liste des sessions).
    req.sessionId = decoded.sessionId ?? null;
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
