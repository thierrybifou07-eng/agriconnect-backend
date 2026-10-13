import { toDecimal } from '../utils/money.js';
import { syncListingsForLot } from './listing.service.js';

// Cœur transactionnel du stock : chaque fonction reçoit un client de
// transaction `tx` en premier argument et ne s'exécute JAMAIS hors
// transaction. L'invariant du domaine est :
//
//   quantityInitial = quantityAvailable + quantityReserved + quantitySold + quantityLost
//
// Il est vérifié après chaque écriture (assertInvariant) : une rupture
// signale un bug de logique, jamais une donnée à « réparer » en silence.

// Statuts jamais recalculés depuis les quantités : le statut est alors un fait
// métier (décision de l'équipe ou attente de validation), pas une conséquence
// des compteurs. Un lot dans l'un de ces statuts le reste, quoi qu'il arrive.
const STATUTS_NON_RECALCULES = new Set(['REJECTED', 'RETURNED', 'WITHDRAWN', 'PENDING_VALIDATION']);

// Erreur métier : le format { statusCode, code } est celui qu'errorHandler
// renvoie au client (réponse { error, code }).
function erreurStock(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

// Relit le lot après écriture et vérifie l'invariant. Centralisé ici pour
// qu'aucune fonction transactionnelle ne puisse oublier la vérification.
async function relireEtVerifier(tx, lotId) {
  const lot = await tx.stockLot.findUnique({ where: { id: lotId } });
  if (!lot) {
    throw erreurStock(`Lot ${lotId} introuvable`, 404, 'LOT_NOT_FOUND');
  }
  assertInvariant(lot);
  return lot;
}

// Écrit une ligne de journal. quantityDelta est signé : positif quand la
// quantité rejoint le compteur du mouvement (réservation, vente, perte),
// négatif quand elle le quitte (libération de réservation). La somme des
// deltas d'un lot redonne ainsi ses compteurs courants.
async function ecrireMouvement(tx, { lotId, type, quantite, ctx = {} }) {
  await tx.stockMovement.create({
    data: {
      lotId,
      type,
      quantityDelta: toDecimal(quantite),
      actorUserId: ctx.actorUserId ?? null,
      actorAgentId: ctx.actorAgentId ?? null,
      orderItemId: ctx.orderItemId ?? null,
      note: ctx.note ?? null,
    },
  });
}

// Quantité strictement positive attendue par les fonctions qui déplacent du
// stock : une réservation ou une vente de zéro n'a pas de sens métier.
// greaterThan(0) et non isPositive() : decimal.js considère 0 comme positif,
// ce qui laisserait passer une réservation de zéro.
function quantitePositive(quantite, nom) {
  const valeur = toDecimal(quantite);
  if (!valeur.greaterThan(0)) {
    throw erreurStock(`${nom} doit être une quantité positive`, 400, 'INVALID_QUANTITY');
  }
  return valeur;
}

// ---------------------------------------------------------------------------
// Fonctions pures (testables sans base de données)
// ---------------------------------------------------------------------------

// Lève une erreur si l'invariant du lot est rompu. Accepte un objet littéral
// (test unitaire) ou un lot Prisma : les quantités sont normalisées en Decimal.
export function assertInvariant(lot) {
  const initial = toDecimal(lot.quantityInitial);
  const somme = toDecimal(lot.quantityAvailable)
    .plus(lot.quantityReserved)
    .plus(lot.quantitySold)
    .plus(lot.quantityLost);
  if (!initial.equals(somme)) {
    throw new Error(
      `Invariant de stock rompu sur le lot ${lot.id ?? lot.lotCode ?? '?'} : ` +
        `initial ${initial} ≠ disponible ${lot.quantityAvailable} + réservé ${lot.quantityReserved} ` +
        `+ vendu ${lot.quantitySold} + perdu ${lot.quantityLost} = ${somme}`
    );
  }
}

// Statut dérivé d'un lot à un instant donné. Un lot REJECTED, RETURNED,
// WITHDRAWN ou PENDING_VALIDATION n'est jamais recalculé : son statut est un
// fait métier, pas une conséquence des quantités. Sinon, dans l'ordre :
//  - plus rien (disponible = 0 et réservé = 0) : EXPIRED si du stock a été
//    perdu (quantityLost > 0), sinon SOLD_OUT. Un lot vendu entièrement reste
//    SOLD_OUT même après sa date : la vente a eu lieu, l'annonce est vendue,
//    pas inactive ;
//  - date d'expiration passée : FULLY_RESERVED si une réservation est en cours
//    (elle va à son terme, une réservation n'est jamais « périmée »), EXPIRED
//    sinon ;
//  - date future ou absente : FULLY_RESERVED si le disponible est épuisé,
//    AVAILABLE sinon.
export function computeLotStatus(lot, now = new Date()) {
  if (STATUTS_NON_RECALCULES.has(lot.status)) {
    return lot.status;
  }
  const disponible = toDecimal(lot.quantityAvailable);
  const reserves = toDecimal(lot.quantityReserved);
  if (disponible.isZero() && reserves.isZero()) {
    return toDecimal(lot.quantityLost).greaterThan(0) ? 'EXPIRED' : 'SOLD_OUT';
  }
  // null <= now vaut true en JavaScript (null devient 0) : le garde-fou sur
  // expiresAt est indispensable, un lot sans date n'est jamais expiré.
  if (lot.expiresAt && lot.expiresAt <= now) {
    return reserves.greaterThan(0) ? 'FULLY_RESERVED' : 'EXPIRED';
  }
  return disponible.isZero() ? 'FULLY_RESERVED' : 'AVAILABLE';
}

// ---------------------------------------------------------------------------
// Fonctions transactionnelles
// ---------------------------------------------------------------------------

// Validation d'un lot PENDING_VALIDATION par l'équipe : le stock déclaré
// devient disponible à la vente. Le mouvement RECEIVED trace la quantité
// initiale, point de départ de tous les compteurs.
export async function receiveLot(tx, lotId, actor = {}) {
  const lot = await tx.stockLot.findUnique({ where: { id: lotId } });
  if (!lot) {
    throw erreurStock(`Lot ${lotId} introuvable`, 404, 'LOT_NOT_FOUND');
  }
  if (lot.status !== 'PENDING_VALIDATION') {
    throw erreurStock(
      `Lot ${lotId} : transition PENDING_VALIDATION -> AVAILABLE refusée (statut ${lot.status})`,
      409,
      'INVALID_STATE_TRANSITION'
    );
  }
  await tx.stockLot.update({
    where: { id: lotId },
    data: { status: 'AVAILABLE' },
  });
  await ecrireMouvement(tx, { lotId, type: 'RECEIVED', quantite: lot.quantityInitial, ctx: actor });
  await syncListingsForLot(tx, lotId);
  return relireEtVerifier(tx, lotId);
}

// Réserve du stock disponible. L'updateMany porte la condition anti-survente
// (statut AVAILABLE, quantité suffisante, date non passée) : si une
// transaction concurrente a déjà pris le stock, count vaut 0 et on refuse
// plutôt que de débiter à découvert. Un lot périmé n'est plus vendable, même
// si son statut est encore AVAILABLE : on relit le lot pour distinguer la
// cause (LOT_EXPIRED) du simple stock insuffisant (INSUFFICIENT_STOCK).
export async function reserve(tx, lotId, qty, ctx = {}) {
  const quantite = quantitePositive(qty, 'Quantité à réserver');
  const maintenant = new Date();
  const { count } = await tx.stockLot.updateMany({
    where: {
      id: lotId,
      status: 'AVAILABLE',
      quantityAvailable: { gte: quantite },
      OR: [{ expiresAt: null }, { expiresAt: { gt: maintenant } }],
    },
    data: {
      quantityAvailable: { decrement: quantite },
      quantityReserved: { increment: quantite },
    },
  });
  if (count === 0) {
    const lot = await tx.stockLot.findUnique({ where: { id: lotId } });
    if (!lot) {
      throw erreurStock(`Lot ${lotId} introuvable`, 404, 'LOT_NOT_FOUND');
    }
    if (lot.expiresAt && lot.expiresAt <= maintenant) {
      throw erreurStock(`Lot ${lotId} : date d'expiration dépassée`, 409, 'LOT_EXPIRED');
    }
    throw erreurStock(
      `Lot ${lotId} : stock insuffisant pour réserver ${quantite}`,
      409,
      'INSUFFICIENT_STOCK'
    );
  }
  const lot = await relireEtVerifier(tx, lotId);
  // Le disponible peut d'un coup passer à zéro : le statut dérivé suit.
  await tx.stockLot.update({
    where: { id: lotId },
    data: { status: computeLotStatus(lot, new Date()) },
  });
  await ecrireMouvement(tx, { lotId, type: 'RESERVED', quantite, ctx });
  await syncListingsForLot(tx, lotId);
  return relireEtVerifier(tx, lotId);
}

// Libère une réservation (commande annulée, devis expiré) : la quantité
// retourne au disponible. La condition quantityReserved >= qty empêche de
// libérer plus que ce qui est réservé.
export async function releaseReservation(tx, lotId, qty, ctx = {}) {
  const quantite = quantitePositive(qty, 'Quantité à libérer');
  const { count } = await tx.stockLot.updateMany({
    where: { id: lotId, quantityReserved: { gte: quantite } },
    data: {
      quantityReserved: { decrement: quantite },
      quantityAvailable: { increment: quantite },
    },
  });
  if (count === 0) {
    throw erreurStock(
      `Lot ${lotId} : réservation insuffisante pour libérer ${quantite}`,
      409,
      'INSUFFICIENT_RESERVATION'
    );
  }
  const lot = await relireEtVerifier(tx, lotId);
  await tx.stockLot.update({
    where: { id: lotId },
    data: { status: computeLotStatus(lot, new Date()) },
  });
  await ecrireMouvement(tx, { lotId, type: 'RESERVATION_RELEASED', quantite: quantite.negated(), ctx });
  await syncListingsForLot(tx, lotId);
  return relireEtVerifier(tx, lotId);
}

// Concrétise une vente : la quantité réservée devient vendue. Le statut
// SOLD_OUT tombe de lui-même quand il ne reste ni disponible ni réservé.
export async function commitSale(tx, lotId, qty, ctx = {}) {
  const quantite = quantitePositive(qty, 'Quantité à vendre');
  const { count } = await tx.stockLot.updateMany({
    where: { id: lotId, quantityReserved: { gte: quantite } },
    data: {
      quantityReserved: { decrement: quantite },
      quantitySold: { increment: quantite },
    },
  });
  if (count === 0) {
    throw erreurStock(
      `Lot ${lotId} : réservation insuffisante pour vendre ${quantite}`,
      409,
      'INSUFFICIENT_RESERVATION'
    );
  }
  const lot = await relireEtVerifier(tx, lotId);
  await tx.stockLot.update({
    where: { id: lotId },
    data: { status: computeLotStatus(lot, new Date()) },
  });
  await ecrireMouvement(tx, { lotId, type: 'SOLD', quantite, ctx });
  await syncListingsForLot(tx, lotId);
  return relireEtVerifier(tx, lotId);
}

// Péremption : tout le disponible restant devient perdu. Renvoie la quantité
// perdue (Decimal), seule information utile à l'indemnisation du fournisseur.
// Le statut n'est plus forcé à EXPIRED : il est dérivé (computeLotStatus).
// Les tâches d'expiration (P6.3) sélectionnent les lots par quantityAvailable
// > 0 et expiresAt passé, QUEL QUE SOIT leur statut : une réservation libérée
// peut remettre du disponible dans un lot déjà EXPIRED.
export async function expireAvailable(tx, lotId, ctx = {}) {
  const lot = await tx.stockLot.findUnique({ where: { id: lotId } });
  if (!lot) {
    throw erreurStock(`Lot ${lotId} introuvable`, 404, 'LOT_NOT_FOUND');
  }
  const perdue = toDecimal(lot.quantityAvailable);
  if (perdue.greaterThan(0)) {
    await tx.stockLot.update({
      where: { id: lotId },
      data: {
        quantityAvailable: { decrement: perdue },
        quantityLost: { increment: perdue },
      },
    });
    await ecrireMouvement(tx, { lotId, type: 'EXPIRED', quantite: perdue, ctx });
  }
  const aJour = await relireEtVerifier(tx, lotId);
  await tx.stockLot.update({
    where: { id: lotId },
    data: { status: computeLotStatus(aJour, new Date()) },
  });
  await syncListingsForLot(tx, lotId);
  return perdue;
}

// Retour ou retrait d'un lot : une partie du disponible devient perdue et le
// lot quitte le cycle de vie (RETURNED par l'équipe, WITHDRAWN par le
// fournisseur). finalStatus est imposé par l'appelant, jamais déduit.
export async function returnAvailable(tx, lotId, qty, ctx = {}, finalStatus) {
  if (finalStatus !== 'RETURNED' && finalStatus !== 'WITHDRAWN') {
    throw erreurStock(
      `finalStatus doit être RETURNED ou WITHDRAWN (reçu ${finalStatus})`,
      400,
      'INVALID_FINAL_STATUS'
    );
  }
  const quantite = quantitePositive(qty, 'Quantité à retourner');
  const { count } = await tx.stockLot.updateMany({
    where: { id: lotId, quantityAvailable: { gte: quantite } },
    data: {
      quantityAvailable: { decrement: quantite },
      quantityLost: { increment: quantite },
    },
  });
  if (count === 0) {
    throw erreurStock(
      `Lot ${lotId} : stock insuffisant pour retourner ${quantite}`,
      409,
      'INSUFFICIENT_STOCK'
    );
  }
  await tx.stockLot.update({
    where: { id: lotId },
    data: { status: finalStatus },
  });
  await ecrireMouvement(tx, { lotId, type: 'RETURNED', quantite, ctx });
  await syncListingsForLot(tx, lotId);
  return relireEtVerifier(tx, lotId);
}
