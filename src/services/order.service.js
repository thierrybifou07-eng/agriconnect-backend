import { toDecimal } from '../utils/money.js';
import { recordAudit } from '../utils/audit.js';
import { assertTransition } from './order.state.js';
import { releaseReservation, commitSale } from './stock.service.js';

// Cycle de vie de la commande (plan v2, P3.5) : confirmation, annulation,
// completion et changement de statut manuel par l'equipe.
//
// Chaque fonction recoit le client de transaction `tx` en premier argument
// et ecrit son AuditLog dans la meme transaction que le changement
// qu'elle trace : un echec de l'audit annule l'action, et inversement.

// Erreur metier : le format { statusCode, code } est celui qu'errorHandler
// renvoie au client (reponse { error, code }).
function erreurCommande(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

// Items + mode de livraison : le minimum pour appliquer les regles de
// transition (mode de livraison) et deplacement de stock (items).
const ORDER_INCLUDE = {
  items: true,
  deliveryMode: true,
};

async function chargerCommande(tx, orderId) {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
  if (!order) {
    throw erreurCommande(`Commande ${orderId} introuvable`, 404, 'ORDER_NOT_FOUND');
  }
  return order;
}

// Quantite d'une reservation de ligne deja consommee : les mouvements
// RESERVATION_RELEASED (devis expire) et SOLD (completion) rattaches a la
// ligne. Le mouvement RESERVED initial est cree avant la ligne (sans
// orderItemId) : il est le point de depart du calcul, pas un element de
// la somme. Sans ce calcul, une commande expiree puis annulee libererait
// deux fois la meme quantite.
async function quantiteConsommee(tx, orderItemId) {
  const mouvements = await tx.stockMovement.findMany({
    where: { orderItemId, type: { in: ['RESERVATION_RELEASED', 'SOLD'] } },
    select: { quantityDelta: true },
  });
  return mouvements.reduce((acc, m) => acc.plus(toDecimal(m.quantityDelta).abs()), toDecimal(0));
}

// Libere les reservations encore vivantes d'une commande (annulation, devis
// expire). Chaque mouvement est rattache a sa ligne (orderItemId) : le
// journal de stock garde la trace de ce qui a ete promis a la commande.
// greaterThan(0) et non isPositive() : decimal.js considère 0 comme positif,
// et une liberation de zero creerait un mouvement fantôme.
async function libererReservations(tx, order, acteur, note) {
  for (const item of order.items) {
    const aLiberer = toDecimal(item.quantity).minus(await quantiteConsommee(tx, item.id));
    if (aLiberer.greaterThan(0)) {
      await releaseReservation(tx, item.lotId, aLiberer, {
        actorUserId: acteur.actorUser?.id ?? null,
        actorAgentId: acteur.actorAgent?.id ?? null,
        orderItemId: item.id,
        note,
      });
    }
  }
}

// Confirmation d'un devis (acheteur ou staff).
//
// Un devis dont reservedUntil est depasse n'est plus confirmable : le 409
// QUOTE_EXPIRED est leve, et la libération du stock est faite par
// confirmerAvecExpiration (voir plus bas) — pas ici. confirmedAt pose,
// reservedUntil efface : la confirmation delache la commande de la limite
// de temps du devis.
export async function confirmOrder(tx, orderId, acteur = {}) {
  const order = await chargerCommande(tx, orderId);
  if (order.reservedUntil && order.reservedUntil <= new Date()) {
    throw erreurCommande('Devis expiré', 409, 'QUOTE_EXPIRED');
  }
  assertTransition(order.status, 'CONFIRMED');
  await tx.order.update({
    where: { id: orderId },
    data: { status: 'CONFIRMED', confirmedAt: new Date(), reservedUntil: null },
  });
  await recordAudit(tx, {
    ...acteur,
    action: 'ORDER_CONFIRMED',
    entityType: 'Order',
    entityId: orderId,
  });
  return order;
}

// Libere les reservations d'un devis expire : appelee APRES le 409, dans sa
// propre transaction. Chaque mouvement est rattache a sa ligne.
async function libererDevisExpire(tx, orderId, acteur) {
  const order = await chargerCommande(tx, orderId);
  await libererReservations(tx, order, acteur, 'Devis expiré');
  await recordAudit(tx, {
    ...acteur,
    action: 'ORDER_QUOTE_EXPIRED',
    entityType: 'Order',
    entityId: orderId,
  });
}

// Confirmation d'un devis avec gestion de l'expiration (acheteur ou staff).
//
// Un devis expire n'est plus confirmable : le 409 QUOTE_EXPIRED est renvoye
// au client, MAIS le stock reserve doit etre libere. Les deux ne peuvent pas
// vivre dans la meme transaction : le throw qui porte le 409 annulerait la
// libération. La libération a donc sa propre transaction, commitee avant
// que l'erreur ne soit levee.
export async function confirmerAvecExpiration(db, orderId, acteur = {}) {
  try {
    return await db.$transaction((tx) => confirmOrder(tx, orderId, acteur));
  } catch (err) {
    if (err.code !== 'QUOTE_EXPIRED') throw err;
    await db.$transaction((tx) => libererDevisExpire(tx, orderId, acteur));
    throw err;
  }
}

// Annulation (QUOTED, CONFIRMED ou PREPARING) : libere chaque reservation
// encore vivante et trace la raison. Les lignes deja liberees (devis expire)
// ne sont pas reliberees : quantiteEncoreReservee connait l'historique.
export async function cancelOrder(tx, orderId, acteur = {}, raison = null) {
  const order = await chargerCommande(tx, orderId);
  assertTransition(order.status, 'CANCELLED');
  await libererReservations(tx, order, acteur, 'Commande annulée');
  await tx.order.update({
    where: { id: orderId },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: raison },
  });
  await recordAudit(tx, {
    ...acteur,
    action: 'ORDER_CANCELLED',
    entityType: 'Order',
    entityId: orderId,
    ...(raison ? { metadata: { reason: raison } } : {}),
  });
  return order;
}

// Completion (READY_FOR_PICKUP ou OUT_FOR_DELIVERY) : le reserved de
// chaque ligne devient vendu (commitSale par ligne). Pas de reversement
// fournisseur ici : c'est l'objet de P4.2.
export async function completeOrder(tx, orderId, acteur = {}) {
  const order = await chargerCommande(tx, orderId);
  assertTransition(order.status, 'COMPLETED');
  for (const item of order.items) {
    const aVendre = toDecimal(item.quantity).minus(await quantiteConsommee(tx, item.id));
    if (aVendre.greaterThan(0)) {
      await commitSale(tx, item.lotId, aVendre, {
        actorUserId: acteur.actorUser?.id ?? null,
        actorAgentId: acteur.actorAgent?.id ?? null,
        orderItemId: item.id,
      });
    }
  }
  await tx.order.update({
    where: { id: orderId },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });
  await recordAudit(tx, {
    ...acteur,
    action: 'ORDER_COMPLETED',
    entityType: 'Order',
    entityId: orderId,
  });
  return order;
}

// Changement de statut manuel par l'equipe (ORDER_PROCESSING).
//
// Deux regles metallieres s'ajoutent a la table des transitions :
//  - PREPARING exige un paiement enregistre (PAID). force: true contourne,
//    mais c'est un pouvoir de direction (niveau >= 50) : un agent ne peut
//    pas forcer, et l'audit trace le forcage.
//  - READY_FOR_PICKUP exige HUB_PICKUP ; OUT_FOR_DELIVERY exige
//    AGENCY_DELIVERY et ne peut etre pose que par le flux livraison (P5.3),
//    jamais a la main.
export async function changeStatus(tx, orderId, statutCible, acteur = {}, { force = false } = {}) {
  const order = await chargerCommande(tx, orderId);
  assertTransition(order.status, statutCible);

  if (statutCible === 'PREPARING' && order.paymentStatus !== 'PAID') {
    if (!force) {
      throw erreurCommande(
        'Le paiement doit être enregistré avant la préparation',
        409,
        'PAYMENT_REQUIRED'
      );
    }
    if ((acteur.actorUser?.role?.level ?? 0) < 50) {
      throw erreurCommande(
        'Le forcage du statut est réservé aux administrateurs',
        403,
        'FORCE_FORBIDDEN'
      );
    }
  }

  if (statutCible === 'READY_FOR_PICKUP' && order.deliveryMode.code !== 'HUB_PICKUP') {
    throw erreurCommande(
      `Transition ${order.status} -> ${statutCible} refusée (READY_FOR_PICKUP exige HUB_PICKUP)`,
      409,
      'INVALID_STATE_TRANSITION'
    );
  }

  if (statutCible === 'OUT_FOR_DELIVERY') {
    if (order.deliveryMode.code !== 'AGENCY_DELIVERY') {
      throw erreurCommande(
        `Transition ${order.status} -> ${statutCible} refusée (OUT_FOR_DELIVERY exige AGENCY_DELIVERY)`,
        409,
        'INVALID_STATE_TRANSITION'
      );
    }
    // Le statut decoule d'un fait de transport (P5.3), pas d'une decision
    // d'equipe : tant que le flux livraison n'existe pas, il est interdit.
    throw erreurCommande(
      'OUT_FOR_DELIVERY ne peut être posé que par le flux livraison',
      409,
      'INVALID_STATE_TRANSITION'
    );
  }

  if (statutCible === 'COMPLETED') {
    // La completion deplace du stock (commitSale par ligne) : elle est
    // deleguee a completeOrder, qui pose completedAt et ecrit l'audit
    // ORDER_COMPLETED. Pas de route /complete dediee : le PATCH status
    // est la voie d'entree, et l'effet est identique.
    return completeOrder(tx, orderId, acteur);
  }

  await tx.order.update({
    where: { id: orderId },
    data: { status: statutCible },
  });
  await recordAudit(tx, {
    ...acteur,
    action: 'ORDER_STATUS_CHANGED',
    entityType: 'Order',
    entityId: orderId,
    metadata: { from: order.status, to: statutCible, ...(force ? { forced: true } : {}) },
  });
  return order;
}
