// Middleware humanActor : refuse l'accès aux agents IA sur les routes qui
// déplacent de l'argent (plan v2, P4.1).
//
// req.agent n'est renseigné que par requireCapability (agents non-admin) :
// un admin n'a jamais de fiche d'agent et passe donc toujours ce contrôle.
// L'argent ne se déplace pas tout seul : un agent IA peut suggérer, jamais
// enregistrer un paiement ni un remboursement.
export const requireHumanActor = (req, res, next) => {
  if (req.agent?.kind === 'AI') {
    return res.status(403).json({ error: 'Un agent IA ne peut pas effectuer cette action' });
  }
  next();
};
