// Table des transitions de livraison (plan v2, P5.3).
//
// Chaque mutation de statut passe par assertTransition : une transition
// interdite leve une erreur 409 INVALID_STATE_TRANSITION, jamais un silence
// qui laisserait la livraison dans un statut incoherent.
//
// Le livreur fait avancer sa course : PENDING -> ACCEPTED -> PICKED_UP ->
// IN_TRANSIT -> DELIVERED. FAILED est possible depuis PICKED_UP ou IN_TRANSIT
// (marchandise endommagee, adresse introuvable...). CANCELLED est reserve au
// staff : un livreur ne peut pas annuler une course qu'il a acceptee, il
// peut seulement la declarer FAILED.

const TRANSITIONS_AUTORISEES = {
  PENDING: ['ACCEPTED'],
  ACCEPTED: ['PICKED_UP'],
  PICKED_UP: ['IN_TRANSIT', 'FAILED'],
  IN_TRANSIT: ['DELIVERED', 'FAILED'],
  DELIVERED: [],
  FAILED: [],
  CANCELLED: [],
};

// Verifie que la transition statutActuel -> statutCible est autorisee.
// Leve une erreur 409 INVALID_STATE_TRANSITION sinon.
export function assertTransition(statutActuel, statutCible) {
  const autorisees = TRANSITIONS_AUTORISEES[statutActuel] ?? [];
  if (!autorisees.includes(statutCible)) {
    throw Object.assign(
      new Error(`Transition ${statutActuel} -> ${statutCible} refusee`),
      { statusCode: 409, code: 'INVALID_STATE_TRANSITION' }
    );
  }
}
