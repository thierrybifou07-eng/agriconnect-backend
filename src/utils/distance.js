const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Distance à vol d'oiseau entre deux points GPS, en kilomètres.
// Retourne null si une des coordonnées manque (évite les faux calculs).
function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v === null || v === undefined)) {
    return null;
  }

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(EARTH_RADIUS_KM * c * 100) / 100; // arrondi à 2 décimales
}

// Tarif de livraison simple : frais de base + tarif au km.
// Valeurs volontairement en dur pour le MVP - à faire évoluer vers une
// configuration back-office une fois qu'on aura des données réelles d'usage
// (cf. décision de ne pas automatiser le dispatch avant d'avoir mesuré les volumes).
const BASE_FEE = 500;
const RATE_PER_KM = 150;

function calculateDeliveryFee(distanceKm) {
  if (distanceKm === null || distanceKm === undefined) return null;
  return Math.round(BASE_FEE + distanceKm * RATE_PER_KM);
}

module.exports = { haversineDistanceKm, calculateDeliveryFee };
