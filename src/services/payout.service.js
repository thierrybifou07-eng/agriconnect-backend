import { asMoney, toDecimal, toNumber } from '../utils/money.js';
import { recordAudit } from '../utils/audit.js';

// Reversements fournisseurs (plan v2, P4.2).
//
// Chaque fonction recoit le client de transaction `tx` en premier argument
// et ecrit son AuditLog dans la meme transaction que le changement
// qu'elle trace : un echec de l'audit annule l'action, et inversement.

// Erreur metier : le format { statusCode, code } est celui qu'errorHandler
// renvoie au client (reponse { error, code }).
function erreurPayout(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

// Les lignes d'une commande referencent un lot, et le lot appartient a un
// fournisseur : le regroupement par fournisseur passe donc par lot.supplierId.
const ITEMS_AVEC_LOT = {
  items: { include: { lot: { select: { supplierId: true } } } },
};

async function chargerCommande(tx, orderId) {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: ITEMS_AVEC_LOT });
  if (!order) {
    throw erreurPayout(`Commande ${orderId} introuvable`, 404, 'ORDER_NOT_FOUND');
  }
  return order;
}

// Compte de reversement par defaut d'un fournisseur (PayoutAccount.isDefault).
// Un fournisseur sans compte enregistre a payoutAccountId null : le reversement
// reste bloque en READY jusqu'a ce qu'il ajoute un compte (vue fournisseur).
async function compteParDefaut(tx, supplierId) {
  const fournisseur = await tx.supplierProfile.findUnique({
    where: { id: supplierId },
    select: { userId: true },
  });
  if (!fournisseur) return null;
  return tx.payoutAccount.findFirst({
    where: { userId: fournisseur.userId, isDefault: true },
    select: { id: true },
  });
}

// Calcule et cree un SupplierPayout par fournisseur pour une commande donnee.
//
// grossAmount = somme(quantite x supplierUnitPrice) : ce que le fournisseur
// doit recevoir. commissionAmount = somme des commissions de ligne deja
// calculees sur chaque OrderItem. netAmount = gross - commission : la somme
// effectivement reversee.
//
// Appelée DANS la transaction de confirmOrder : un echec annule la confirmation
// et inversement, garantissant qu'une commande CONFIRMED a toujours ses
// reversements.
export async function createPayoutsForOrder(tx, orderId) {
  const order = await chargerCommande(tx, orderId);

  // Regroupement par fournisseur : un item peut reference n'importe quel lot,
  // et chaque lot appartient a un fournisseur different.
  const parFournisseur = new Map();
  for (const item of order.items) {
    const supplierId = item.lot.supplierId;
    if (!parFournisseur.has(supplierId)) {
      parFournisseur.set(supplierId, { gross: toDecimal(0), commission: toDecimal(0) });
    }
    const groupe = parFournisseur.get(supplierId);
    // Le calcul utilise Prisma.Decimal : jamais de Number pour l'argent.
    groupe.gross = groupe.gross.plus(toDecimal(item.quantity).times(toDecimal(item.supplierUnitPrice)));
    groupe.commission = groupe.commission.plus(toDecimal(item.commissionAmount));
  }

  // Un SupplierPayout par fournisseur. Le compte par defaut est resolu
  // individuellement : deux fournisseurs peuvent avoir des comptes differents.
  for (const [supplierId, montants] of parFournisseur) {
    const compte = await compteParDefaut(tx, supplierId);
    await tx.supplierPayout.create({
      data: {
        orderId: order.id,
        supplierId,
        grossAmount: asMoney(montants.gross),
        commissionAmount: asMoney(montants.commission),
        netAmount: asMoney(montants.gross.minus(montants.commission)),
        status: 'ON_HOLD',
        payoutAccountId: compte?.id ?? null,
      },
    });
  }

  return parFournisseur.size;
}

// Readiness BIDIRECTIONNELLE des reversements d'une commande.
//
// La commande est « débitable » seulement quand elle est COMPLETED et PAID :
// les reversements ON_HOLD passent a READY. Dès qu'elle ne l'est plus
// (remboursement partiel qui repasse le statut sous PAID, annulation,
// changement de statut), les reversements READY repassent a ON_HOLD : un
// fournisseur n'est payé que sur une commande intégralement payée.
//
// Les reversements PAID ne sont jamais modifies : l'argent est deja parti
// (gestion de litige separee, hors perimetre P4.2). Les CANCELLED non plus.
//
// Appelee depuis completeOrder, recordPayment et refundPayment : selon
// l'ordre des evenements, c'est l'un ou l'autre qui declenche la mise a jour.
export async function refreshPayoutReadiness(tx, orderId) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { status: true, paymentStatus: true },
  });
  if (!order) return;

  if (order.status === 'COMPLETED' && order.paymentStatus === 'PAID') {
    await tx.supplierPayout.updateMany({
      where: { orderId, status: 'ON_HOLD' },
      data: { status: 'READY' },
    });
  } else {
    await tx.supplierPayout.updateMany({
      where: { orderId, status: 'READY' },
      data: { status: 'ON_HOLD' },
    });
  }
}

// Annulation des reversements d'une commande (ON_HOLD ou READY -> CANCELLED).
//
// Appelee depuis cancelOrder : une commande annulee ne doit jamais debiter
// un fournisseur. Les reversements PAID ne sont pas touches : l'argent est
// deja parti (gestion de litige separee, hors perimetre P4.2).
export async function cancelPayoutsForOrder(tx, orderId) {
  await tx.supplierPayout.updateMany({
    where: { orderId, status: { in: ['ON_HOLD', 'READY'] } },
    data: { status: 'CANCELLED' },
  });
}

// Liste paginée des reversements d'un fournisseur (DTO fournisseur : aucune
// donnee acheteur, aucun lot, aucun fournisseur concurrent).
export async function listPayoutsPourFournisseur(db, supplierId, { page = 1, limit = 20 } = {}) {
  const where = { supplierId };
  const [items, total] = await Promise.all([
    db.supplierPayout.findMany({
      where,
      select: {
        id: true,
        orderId: true,
        grossAmount: true,
        commissionAmount: true,
        netAmount: true,
        status: true,
        reference: true,
        payoutAccountId: true,
        paidAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.supplierPayout.count({ where }),
  ]);

  return {
    items: items.map((p) => ({
      id: p.id,
      orderId: p.orderId,
      grossAmount: toNumber(p.grossAmount),
      commissionAmount: toNumber(p.commissionAmount),
      netAmount: toNumber(p.netAmount),
      status: p.status,
      reference: p.reference,
      payoutAccountId: p.payoutAccountId,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
    })),
    page,
    limit,
    total,
  };
}

// Liste paginée de tous les reversements (vue admin complete avec numero de
// compte, nom du compte et montant net).
export async function listAllPayouts(db, { page = 1, limit = 20, status } = {}) {
  const where = status ? { status } : {};
  const [items, total] = await Promise.all([
    db.supplierPayout.findMany({
      where,
      select: {
        id: true,
        orderId: true,
        supplierId: true,
        supplier: {
          select: {
            farmName: true,
            user: { select: { firstname: true, lastname: true, email: true } },
          },
        },
        grossAmount: true,
        commissionAmount: true,
        netAmount: true,
        status: true,
        reference: true,
        payoutAccountId: true,
        payoutAccount: {
          select: {
            method: true,
            provider: true,
            accountNumber: true,
            accountName: true,
          },
        },
        paidAt: true,
        paidById: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.supplierPayout.count({ where }),
  ]);

  return {
    items: items.map((p) => ({
      id: p.id,
      orderId: p.orderId,
      supplierId: p.supplierId,
      supplier: p.supplier
        ? {
            farmName: p.supplier.farmName,
            firstname: p.supplier.user.firstname,
            lastname: p.supplier.user.lastname,
            email: p.supplier.user.email,
          }
        : null,
      grossAmount: toNumber(p.grossAmount),
      commissionAmount: toNumber(p.commissionAmount),
      netAmount: toNumber(p.netAmount),
      status: p.status,
      reference: p.reference,
      payoutAccountId: p.payoutAccountId,
      payoutAccount: p.payoutAccount
        ? {
            method: p.payoutAccount.method,
            provider: p.payoutAccount.provider,
            accountNumber: p.payoutAccount.accountNumber,
            accountName: p.payoutAccount.accountName,
          }
        : null,
      paidAt: p.paidAt,
      paidById: p.paidById,
      createdAt: p.createdAt,
    })),
    page,
    limit,
    total,
  };
}

// Marque un reversement READY comme paye.
//
// Seul un reversement READY peut etre paye : un reversement ON_HOLD n'a pas
// encore les fonds, un PAID est deja paye, un CANCELLED est annule.
// Le changement de compte (payoutAccountId) est optionnel : l'admin peut
// choisir un compte different de celui par defaut.
//
// Transition atomique : updateMany filtré sur le statut READY. Deux appels
// simultanés ne peuvent pas réussir tous les deux — le second a count = 0,
// relit la ligne et reçoit exactement le 404 ou le 409 qu'une lecture
// préalable aurait renvoyé. L'audit n'est écrit que par l'appel gagnant.
export async function payPayout(db, payoutId, { reference, payoutAccountId }, acteur) {
  return db.$transaction(async (tx) => {
    const payout = await tx.supplierPayout.findUnique({ where: { id: payoutId } });
    if (!payout) {
      throw erreurPayout(`Reversement ${payoutId} introuvable`, 404, 'PAYOUT_NOT_FOUND');
    }
    if (payout.status !== 'READY') {
      throw erreurPayout(
        `Seul un reversement READY peut être payé (statut actuel : ${payout.status})`,
        409,
        'INVALID_STATE_TRANSITION'
      );
    }

    // Verification du compte fourni : il doit appartenir au meme fournisseur.
    if (payoutAccountId !== undefined && payoutAccountId !== null) {
      const compte = await tx.payoutAccount.findUnique({
        where: { id: payoutAccountId },
        include: { user: { include: { supplierProfile: { select: { id: true } } } } },
      });
      if (!compte || compte.user.supplierProfile?.id !== payout.supplierId) {
        throw erreurPayout('Compte de reversement invalide pour ce fournisseur', 400, 'INVALID_PAYOUT_ACCOUNT');
      }
    }

    const maj = await tx.supplierPayout.updateMany({
      where: { id: payoutId, status: 'READY' },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        paidById: acteur.actorUser?.id ?? null,
        reference: reference ?? null,
        ...(payoutAccountId !== undefined ? { payoutAccountId } : {}),
      },
    });

    if (maj.count === 0) {
      // Un appel concurrent a paye entre-temps : relire pour renvoyer le 409
      // exact (le reversement n'est plus READY).
      const majUnique = await tx.supplierPayout.findUnique({ where: { id: payoutId } });
      if (!majUnique) {
        throw erreurPayout(`Reversement ${payoutId} introuvable`, 404, 'PAYOUT_NOT_FOUND');
      }
      throw erreurPayout(
        `Seul un reversement READY peut être payé (statut actuel : ${majUnique.status})`,
        409,
        'INVALID_STATE_TRANSITION'
      );
    }

    const misAJour = await tx.supplierPayout.findUnique({ where: { id: payoutId } });

    await recordAudit(tx, {
      ...acteur,
      action: 'PAYOUT_PAID',
      entityType: 'SupplierPayout',
      entityId: payoutId,
      metadata: {
        orderId: payout.orderId,
        supplierId: payout.supplierId,
        amount: toNumber(payout.netAmount),
        reference: reference ?? null,
        payoutAccountId: payoutAccountId ?? payout.payoutAccountId,
      },
    });

    return misAJour;
  });
}
