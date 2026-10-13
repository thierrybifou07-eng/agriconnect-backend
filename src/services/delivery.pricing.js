import { computeDeliveryFee } from './pricing.service.js';
import { haversineDistanceKm } from '../utils/distance.js';

// Livraison par agence : origines d'enlèvement, distances et tarifs
// (plan v2, P5.2).
//
// La logique « origines + distance + frais » était dupliquée dans
// staffOrder.controller.js (émission du devis) et
// staffDelivery.controller.js (création des livraisons) : la moindre
// divergence entre les deux faussait le devis ou la livraison. Ce module
// est l'unique source de vérité, consommée par les deux contrôleurs.

// Erreur métier : le format { statusCode, code } est celui qu'errorHandler
// renvoie au client (réponse { error, code }).
function erreurLivraison(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

// Clé d'une origine d'enlèvement : hub:{hubId} si le lot est stocké en hub,
// sinon site:{supplierId}. Deux lots du même hub ou du même fournisseur
// partent du même point : une seule course les dessert.
export function cleOrigine(lot) {
  return lot.storageType === 'HUB' && lot.hubId ? `hub:${lot.hubId}` : `site:${lot.supplierId}`;
}

// Regroupe des lots par origine d'enlèvement. La valeur est le premier lot
// du groupe : tous ses lots partent du même point, ses coordonnées suffisent.
export function grouperParOrigine(lots) {
  const groupes = new Map();
  for (const lot of lots) {
    const cle = cleOrigine(lot);
    if (!groupes.has(cle)) groupes.set(cle, lot);
  }
  return groupes;
}

// Point d'enlèvement d'un lot : hub (coordonnées du hub) ou site fournisseur
// (coordonnées déclarées sur le lot). Jette 409 si les coordonnées
// d'enlèvement manquent : sans origine, pas de distance, donc pas de tarif.
export function pointEnlevement(lot) {
  const point =
    lot.storageType === 'HUB' && lot.hubId
      ? {
          type: 'HUB',
          hubId: lot.hubId,
          hubName: lot.hub?.name ?? null,
          address: lot.hub?.address ?? null,
          latitude: lot.hub?.latitude ?? null,
          longitude: lot.hub?.longitude ?? null,
        }
      : {
          type: 'SUPPLIER_SITE',
          hubId: null,
          hubName: null,
          address: lot.pickupAddress ?? null,
          latitude: lot.pickupLatitude ?? null,
          longitude: lot.pickupLongitude ?? null,
        };

  if (
    point.latitude === null ||
    point.latitude === undefined ||
    point.longitude === null ||
    point.longitude === undefined
  ) {
    throw erreurLivraison(
      `Coordonnées d'enlèvement manquantes pour le lot ${lot.id}`,
      409,
      'ORIGIN_COORDINATES_MISSING'
    );
  }

  return point;
}

// Distance à vol d'oiseau entre l'origine d'un lot et le point de livraison,
// en kilomètres. Jette 409 si les coordonnées de livraison manquent
// (haversineDistanceKm renvoie null).
export function distanceOrigine(lot, { latitude, longitude }) {
  const point = pointEnlevement(lot);
  const distanceKm = haversineDistanceKm(point.latitude, point.longitude, latitude, longitude);
  if (distanceKm === null) {
    throw erreurLivraison('Coordonnées de livraison manquantes', 409, 'DELIVERY_COORDINATES_MISSING');
  }
  return distanceKm;
}

// Tarif d'une origine : l'agence perçoit le coût réel (base + km), l'acheteur
// paie ce coût majoré de la marge plateforme. Délègue à computeDeliveryFee :
// une seule formule, pour le devis comme pour la livraison.
export function tarifOrigine({ agencyZone, distanceKm, markupRate, currency }) {
  return computeDeliveryFee(
    {
      baseFee: agencyZone.baseFee,
      perKmFee: agencyZone.perKmFee,
      distanceKm,
      markupRate,
    },
    currency
  );
}
