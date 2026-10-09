import prisma from '../config/prisma.js';

// Controle d'acces par capacite metier (plan v2, P1.4).
//
// Deux facons de passer :
//  - ADMIN et ROOT (role.level >= 50) : la direction a tous les pouvoirs, sans
//    fiche d'agent ni capacite declaree ;
//  - AGENT : il faut une fiche Agent ACTIVE rattachee a son compte (userId)
//    possedant au moins une des capacites demandees.
//
// Quand un agent passe, req.agent est renseigne ({ id, kind, capabilities }) :
// les controleurs savent ainsi QUI agit (traçabilite : createdByAgentId sur un
// lot, actorAgentId dans l'audit). Un admin ne recoit pas req.agent : il n'a
// pas de fiche, le controleur trace alors actorUser.
export const requireCapability = (...codes) => async (req, res, next) => {
  // protect a deja charge req.user avec son role ; ce middleware ne sert qu'apres lui.
  if (!req.user) {
    return res.status(401).json({ error: 'Authentification requise' });
  }

  // Niveau 50+ : acces direct, sans controle de capacite.
  if (req.user.role.level >= 50) {
    return next();
  }

  const agent = await prisma.agent.findFirst({
    where: { userId: req.user.id, isActive: true },
    include: { capabilities: { include: { capability: { select: { code: true } } } } },
  });

  // Toutes les capacites de la fiche, pas seulement l'intersection avec la
  // requete : en aval, un controleur peut avoir besoin de savoir ce que
  // l'agent peut faire au-dela du filtre courant.
  const held = agent ? agent.capabilities.map((link) => link.capability.code) : [];

  if (!agent || !codes.some((code) => held.includes(code))) {
    return res.status(403).json({ error: 'Capacité requise' });
  }

  req.agent = { id: agent.id, kind: agent.kind, capabilities: held };
  next();
};
