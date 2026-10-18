import { ProfileVerification } from '../utils/enums/enums.helpers.js';

// Exige un profil vérifié pour les actions réservées aux comptes SUPPLIER et
// BUYER : confirmer un devis, déclarer ou gérer un lot (décision D2).
//
// Le statut est déjà dans req.user : protect le charge à chaque requête
// (auth.middleware.js), le middleware ne fait donc aucune lecture en base.
//
// Il se monte juste après protect/requireRole, jamais sur une route d'équipe
// (ADMIN, ROOT, AGENT) : ces comptes n'ont pas de profil à vérifier et le
// contrôle ne doit pas les concerner.
//
// Réponse 403 PROFILE_NOT_VERIFIED. Le statut courant est renvoyé pour que le
// client sache quoi afficher : PENDING ("dossier en cours d'examen") ou REJECTED
// ("redéposer des documents"), et qu'il puisse rediriger vers le dépôt.
export const requireVerifiedProfile = (req, res, next) => {
  const statut = req.user?.profileVerificationStatus;
  if (statut !== ProfileVerification.VERIFIED) {
    return res.status(403).json({
      error: 'Votre profil doit être vérifié pour effectuer cette action',
      code: 'PROFILE_NOT_VERIFIED',
      profileVerificationStatus: statut,
    });
  }
  next();
};
