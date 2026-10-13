// Table des transitions de commande (plan v2, P3.5).
//
// Chaque mutation de statut passe par assertTransition : une transition
// interdite leve une erreur 409 INVALID_STATE_TRANSITION, jamais un silence
// qui laisserait la commande dans un statut incohérent avec son stock.
//
// La table ne connait que les statuts, pas le mode de livraison : les
// conditions HUB_PICKUP / AGENCY_DELIVERY (dans les transitions vers
// READY_FOR_PICKUP et OUT_FOR_DELIVERY) sont verifiees par order.service,
// qui connait la commande. OUT_FOR_DELIVERY ne peut etre pose que par le
// flux livraison (P5.3), jamais a la main.
//
// Toutes les transitions autorisees, par statut de depart :
//  - QUOTED -> CONFIRMED (confirmation acheteur ou staff), CANCELLED
//  - CONFIRMED -> PREPARING (exige le paiement, voir order.service), CANCELLED
//  - PREPARING -> READY_FOR_PICKUP (HUB_PICKUP seulement), OUT_FOR_DELIVERY
//    (AGENCY_DELIVERY seulement, flux livraison), CANCELLED
//  - READY_FOR_PICKUP -> COMPLETED
//  - OUT_FOR_DELIVERY -> COMPLETED
const TRANSITIONS_AUTORISEES = {
  QUOTED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'CANCELLED'],
  READY_FOR_PICKUP: ['COMPLETED'],
  OUT_FOR_DELIVERY: ['COMPLETED'],
  COMPLETED: [],
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
