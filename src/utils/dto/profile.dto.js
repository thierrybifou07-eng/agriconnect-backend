// DTOs des profils utilisateur (plan v2, M1/M6).
//
// Un profil est une donnée personnelle : seuls les champs que le client
// peut lire et écrire via /api/v2/auth/me/profile sortent de l'API. Les
// colonnes techniques (id du profil, userId, createdAt, updatedAt) et
// les objets liés (user, zone, lots) restent internes : ils n'ont aucune
// valeur pour le client et exposeraient la structure de la base.

// Profil fournisseur : le nom de la ferme et la zone de production.
export function supplierProfileToApi(profile) {
  return {
    farmName: profile.farmName,
    description: profile.description ?? null,
    zoneId: profile.zoneId ?? null,
  };
}

// Profil acheteur : le type d'acheteur et le nom commercial.
export function buyerProfileToApi(profile) {
  return {
    buyerType: profile.buyerType,
    businessName: profile.businessName ?? null,
    zoneId: profile.zoneId ?? null,
  };
}

// Profil livreur : le véhicule et la plaque (l'appartenance à l'agence est
// un fait organisationnel, pas une donnée privée).
export function driverProfileToApi(profile) {
  return {
    vehicleType: profile.vehicleType ?? null,
    plateNumber: profile.plateNumber ?? null,
    agencyId: profile.agencyId,
  };
}

// Dispatch selon le rôle : /me et /me/profile renvoient la même forme,
// quelle que soit la table de profil sous-jacente.
export function profileToApi(profile, roleCode) {
  if (!profile) return null;
  switch (roleCode) {
    case 'SUPPLIER':
      return supplierProfileToApi(profile);
    case 'BUYER':
      return buyerProfileToApi(profile);
    case 'DRIVER':
      return driverProfileToApi(profile);
    default:
      return null;
  }
}
