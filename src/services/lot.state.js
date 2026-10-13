// Table des transitions de lot (plan v2, P2.4).
//
// Chaque fonction métier (validate, reject, retour, retrait) vérifie ici que
// le statut courant du lot autorise la transition demandée. Une transition
// interdite lève une erreur 409 INVALID_STATE_TRANSITION, jamais un silence
// qui laisserait le lot dans un statut incohérent.

// Toutes les transitions autorisées, par statut de départ :
//  - PENDING_VALIDATION -> AVAILABLE (validate), REJECTED (reject)
//  - AVAILABLE -> RETURNED (return par l'équipe)
//  - FULLY_RESERVED -> RETURNED (return par l'équipe, sans réservation)
//  - AVAILABLE -> WITHDRAWN (retrait fournisseur, sans réservation)
const TRANSITIONS_AUTORISEES = {
  PENDING_VALIDATION: ['AVAILABLE', 'REJECTED'],
  AVAILABLE: ['RETURNED', 'WITHDRAWN'],
  FULLY_RESERVED: ['RETURNED'],
  SOLD_OUT: [],
  EXPIRED: [],
  RETURNED: [],
  REJECTED: [],
  WITHDRAWN: [],
};

// Vérifie que la transition statutActuel -> statutCible est autorisée.
// Lève une erreur 409 INVALID_STATE_TRANSITION sinon.
export function assertTransition(statutActuel, statutCible) {
  const autorisees = TRANSITIONS_AUTORISEES[statutActuel] ?? [];
  if (!autorisees.includes(statutCible)) {
    throw Object.assign(
      new Error(`Transition ${statutActuel} -> ${statutCible} refusée`),
      { statusCode: 409, code: 'INVALID_STATE_TRANSITION' }
    );
  }
}
