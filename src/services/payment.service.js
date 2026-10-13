import { asMoney, toDecimal, toNumber } from '../utils/money.js';
import { recordAudit } from '../utils/audit.js';
import { refreshPayoutReadiness, cancelPayoutsForOrder } from './payout.service.js';

// Paiements manuels idempotents (plan v2, P4.1).
//
// Chaque fonction reçoit le client Prisma en premier argument et écrit son
// AuditLog dans la même transaction que le changement qu'elle trace : un échec
// de l'audit annule l'action, et inversement.

// Erreur métier : le format { statusCode, code } est celui qu'errorHandler
// renvoie au client (réponse { error, code }).
function erreurPaiement(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

// Solde dû d'une commande : total - somme des paiements CONFIRMED. Les
// paiements REFUNDED ne comptent plus : l'argent est reparti.
async function soldeDu(tx, order) {
  const paiements = await tx.payment.findMany({
    where: { orderId: order.id, status: 'CONFIRMED' },
    select: { amount: true },
  });
  const somme = paiements.reduce((acc, p) => acc.plus(toDecimal(p.amount)), toDecimal(0));
  return toDecimal(order.total).minus(somme);
}

// Recalcule Order.paymentStatus : somme des paiements CONFIRMED = 0 -> UNPAID,
// < total -> PARTIALLY_PAID, >= total -> PAID. Quand tous les paiements sont
// REFUNDED (somme nulle, mais au moins un paiement existe), la commande est
// REFUNDED : l'argent est reparti, elle n'est plus « à payer » mais soldée
// à rebours. Renvoie le statut calculé.
async function recalculerStatut(tx, orderId) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { payments: { select: { amount: true, status: true } } },
  });
  const somme = order.payments
    .filter((p) => p.status === 'CONFIRMED')
    .reduce((acc, p) => acc.plus(toDecimal(p.amount)), toDecimal(0));
  let statut = 'UNPAID';
  if (somme.greaterThan(0)) {
    // Prisma.Decimal n'expose pas greaterThanOrEqual : « >= total » se lit
    // « non < total ».
    statut = somme.lessThan(toDecimal(order.total)) ? 'PARTIALLY_PAID' : 'PAID';
  } else if (
    order.payments.length > 0 &&
    order.payments.every((p) => p.status === 'REFUNDED')
  ) {
    statut = 'REFUNDED';
  }
  await tx.order.update({ where: { id: orderId }, data: { paymentStatus: statut } });
  return statut;
}

// Une clé d'idempotence est liée à sa requête : rejouer la même clé n'a de
// sens que si la commande, le montant et la méthode sont identiques. Sinon,
// la clé a déjà servi pour une autre opération — renvoyer le premier paiement
// satisferait faussement le client et masquerait la confusion.
function memeRequete(paiement, orderId, montant, method) {
  return (
    paiement.orderId === orderId &&
    toDecimal(paiement.amount).equals(montant) &&
    paiement.method === method
  );
}

// Enregistre un paiement manuel de façon idempotente.
//
// L'en-tête Idempotency-Key est la clé d'idempotence : la contrainte unique
// sur Payment.idempotencyKey tranche entre les appels concurrents. Le premier
// create gagne ; le second reçoit P2002 et sa transaction est annulée : on
// relit alors le paiement d'origine (déjà commité) et on le retourne sans
// doublon, sans audit ni recalcul (déjà faits par l'appel gagnant).
//
// Rejeu séquentiel ou après P2002 : la clé n'est rendue que si la requête est
// identique (même commande, même montant, même méthode) ; sinon 409
// IDEMPOTENCY_KEY_CONFLICT.
//
// Retourne { payment, rejoue } : rejoue = true quand la clé avait déjà été
// utilisée (séquentiellement ou en concurrence).
export async function recordPayment(db, orderId, { amount, method, reference, paidAt }, idempotencyKey, acteur) {
  const montant = asMoney(amount);
  try {
    return await db.$transaction(async (tx) => {
      // Rejeu séquentiel : la clé a déjà été utilisée. On retourne le
      // paiement d'origine SANS refaire les validations de montant : la
      // sémantique idempotente est « même clé = même résultat ».
      const existant = await tx.payment.findUnique({ where: { idempotencyKey } });
      if (existant) {
        if (!memeRequete(existant, orderId, montant, method)) {
          throw erreurPaiement(
            "Clé d'idempotence déjà utilisée pour une autre opération",
            409,
            'IDEMPOTENCY_KEY_CONFLICT'
          );
        }
        return { payment: existant, rejoue: true };
      }

      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) {
        throw erreurPaiement(`Commande ${orderId} introuvable`, 404, 'ORDER_NOT_FOUND');
      }
      if (order.status === 'CANCELLED') {
        throw erreurPaiement('Commande annulée', 409, 'ORDER_CANCELLED');
      }

      if (!montant.greaterThan(0)) {
        throw erreurPaiement('Montant invalide', 409, 'INVALID_AMOUNT');
      }
      const solde = await soldeDu(tx, order);
      if (montant.greaterThan(solde)) {
        throw erreurPaiement('Montant supérieur au solde', 409, 'OVERPAYMENT');
      }

      const payment = await tx.payment.create({
        data: {
          orderId,
          amount: montant,
          method,
          reference: reference ?? null,
          status: 'CONFIRMED',
          paidAt: paidAt ?? null,
          idempotencyKey,
          recordedById: acteur.actorUser?.id ?? null,
        },
      });

      await recalculerStatut(tx, orderId);
      // Le paiement a peut-etre fait passer la commande en PAID : si elle est
      // deja COMPLETED, les reversements passent a READY. Sinon, c'est la
      // completion qui declenchera le passage (P4.2).
      await refreshPayoutReadiness(tx, orderId);
      await recordAudit(tx, {
        ...acteur,
        action: 'PAYMENT_RECORDED',
        entityType: 'Payment',
        entityId: payment.id,
        metadata: { orderId, amount: toNumber(montant), method },
      });

      return { payment, rejoue: false };
    });
  } catch (err) {
    // P2002 : un appel concurrent a déjà enregistré un paiement avec cette
    // clé. La transaction interactive est morte (le P2002 la ferme) : la
    // relecture se fait hors transaction, sur le paiement déjà commité.
    if (err.code === 'P2002') {
      const payment = await db.payment.findUnique({ where: { idempotencyKey } });
      if (payment && !memeRequete(payment, orderId, montant, method)) {
        throw erreurPaiement(
          "Clé d'idempotence déjà utilisée pour une autre opération",
          409,
          'IDEMPOTENCY_KEY_CONFLICT'
        );
      }
      return { payment, rejoue: true };
    }
    throw err;
  }
}

// Rembourse un paiement CONFIRMED : CONFIRMED -> REFUNDED, recalcul du statut
// de la commande, audit dans la même transaction.
//
// Trois gardes-fous autour du reversement fournisseur :
//   - un reversement déjà PAID ne peut pas être annulé par un remboursement
//     (l'argent est parti) : 409 PAYOUT_ALREADY_PAID, SAUF dérogation d'un
//     administrateur (ADMIN ou ROOT) avec force: true — la dérogation est
//     tracée dans l'audit (forcedAfterPayout) ;
//   - le recalcul du statut rafraîchit la readiness des reversements : un
//     remboursement partiel repasse les reversements READY en ON_HOLD ;
//   - un remboursement total (paymentStatus REFUNDED) annule les reversements
//     encore vivants : la commande ne doit jamais débiter un fournisseur.
export async function refundPayment(db, paymentId, acteur, force = false) {
  return db.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment) {
      throw erreurPaiement(`Paiement ${paymentId} introuvable`, 404, 'PAYMENT_NOT_FOUND');
    }
    if (payment.status !== 'CONFIRMED') {
      throw erreurPaiement(`Paiement ${payment.status} non remboursable`, 409, 'PAYMENT_NOT_CONFIRMED');
    }

    const reversementPaye = await tx.supplierPayout.findFirst({
      where: { orderId: payment.orderId, status: 'PAID' },
      select: { id: true },
    });
    // force n'est un pouvoir de direction qu'avec un compte de niveau 50 ou
    // plus (ADMIN ou ROOT) : un AGENT qui force est ignoré, comme partout
    // ailleurs dans l'application.
    const forceAutorise = (acteur.actorUser?.role?.level ?? 0) >= 50;
    if (reversementPaye && !(force && forceAutorise)) {
      throw erreurPaiement(
        'Reversement déjà payé : à traiter manuellement',
        409,
        'PAYOUT_ALREADY_PAID'
      );
    }

    const maj = await tx.payment.update({
      where: { id: paymentId },
      data: { status: 'REFUNDED' },
    });
    const statut = await recalculerStatut(tx, payment.orderId);
    await refreshPayoutReadiness(tx, payment.orderId);
    if (statut === 'REFUNDED') {
      await cancelPayoutsForOrder(tx, payment.orderId);
    }
    await recordAudit(tx, {
      ...acteur,
      action: 'PAYMENT_REFUNDED',
      entityType: 'Payment',
      entityId: paymentId,
      metadata: {
        orderId: payment.orderId,
        amount: toNumber(payment.amount),
        ...(reversementPaye ? { forcedAfterPayout: true } : {}),
      },
    });
    return maj;
  });
}

// Liste les paiements d'une commande, du plus ancien au plus récent.
export async function listPayments(db, orderId) {
  return db.payment.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
  });
}
