import { asQuantity, roundMoney, toDecimal, toNumber } from '../utils/money.js';
import { recordAudit } from '../utils/audit.js';

// Indemnisation des fournisseurs : invendus périmés, pertes, casse (plan v2, P6.2).
//
// Chaque fonction ecrit son AuditLog dans la meme transaction que le
// changement qu'elle trace : un echec de l'audit annule l'action, et
// inversement.

// Erreur metier : le format { statusCode, code } est celui qu'errorHandler
// renvoie au client (reponse { error, code }).
function erreurCompensation(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

// Machine a etats d'une indemnisation :
//   PENDING_APPROVAL -> APPROVED | REJECTED ; APPROVED -> PAID.
// REJECTED et PAID sont terminaux : une indemnisation refusee ne redevient
// jamais payable, une indemnisation payee ne peut pas etre repayee.
const TRANSITIONS = {
  PENDING_APPROVAL: ['APPROVED', 'REJECTED'],
  APPROVED: ['PAID'],
  REJECTED: [],
  PAID: [],
};

// Cree une indemnisation pour perte ou invendus.
//
// amount = quantite x prix convenu (agreedUnitPrice du lot) x taux
// d'indemnisation (expiryCompensationRate de la plateforme). Le taux est
// FIGE sur la ligne : un changement ulterieur des parametres ne remet pas en
// cause une indemnisation deja creee. Si le taux vaut 0, aucune indemnisation
// n'est due : la fonction ne cree rien et renvoie null.
//
// Plafond CUMUL : la quantite totale indemnisee sur un lot (indemnisations
// dont le statut n'est pas REJECTED) ne peut pas depasser quantityInitial.
// Sans ce plafond, une indemnisation automatique (expiration) plus une
// indemnisation manuelle sur le meme lot paieraient deux fois la meme perte.
// La ligne du lot est verrouillee (SELECT ... FOR UPDATE) avant le calcul du
// reste : deux creations simultanees se serialisent au lieu de toutes les
// deux passer.
//
// strict (vrai par défaut, appel manuel) : quantite > reste -> 409
// COMPENSATION_QUANTITY_EXCEEDED. strict: false (job d'expiration) : indemnise
// seulement le reste, la reduction etant tracee dans la note ; a reste nul,
// ne cree rien.
export async function createForLoss(tx, { lot, quantity, reason, deliveryId = null, note = null, strict = true }) {
  const quantite = asQuantity(quantity);
  if (!quantite.greaterThan(0)) {
    throw erreurCompensation('Quantité à indemniser doit être positive', 400, 'INVALID_QUANTITY');
  }

  // Verrouille la ligne du lot AVANT toute lecture : le calcul du reste et la
  // creation doivent voir le meme etat, sinon deux appels concurrents (manuel
  // + automatique) peuvent depasser le plafond cumul.
  await tx.$queryRaw`SELECT id FROM StockLot WHERE id = ${lot.id} FOR UPDATE`;
  const lotVerrou = await tx.stockLot.findUnique({ where: { id: lot.id } });
  if (!lotVerrou) {
    throw erreurCompensation(`Lot ${lot.id} introuvable`, 404, 'LOT_NOT_FOUND');
  }

  // Quantite deja indemnisee : toutes les indemnisations du lot sauf les
  // REJECTES (une indemnisation refusee n'a rien paye).
  const { _sum } = await tx.supplierCompensation.aggregate({
    where: { lotId: lot.id, status: { not: 'REJECTED' } },
    _sum: { quantity: true },
  });
  const deja = toDecimal(_sum.quantity ?? 0);
  const reste = toDecimal(lotVerrou.quantityInitial).sub(deja);

  let quantiteFinale = quantite;
  let noteFinale = note;
  if (quantite.greaterThan(reste)) {
    if (strict) {
      throw erreurCompensation(
        'Quantité supérieure au reste indemnisable du lot',
        409,
        'COMPENSATION_QUANTITY_EXCEEDED'
      );
    }
    if (!reste.greaterThan(0)) {
      // Rien a indemniser : le lot est deja integralement couvert.
      return null;
    }
    quantiteFinale = reste;
    noteFinale = 'Quantité réduite au reste indemnisable';
  }

  const settings = await tx.platformSetting.findUnique({ where: { id: 1 } });
  if (!settings) {
    throw erreurCompensation('Paramètres de la plateforme manquants', 500, 'SETTINGS_MISSING');
  }
  const taux = toDecimal(settings.expiryCompensationRate);
  if (taux.isZero()) {
    return null;
  }

  const montant = roundMoney(quantiteFinale.mul(toDecimal(lotVerrou.agreedUnitPrice)).mul(taux), settings.currency);

  const compensation = await tx.supplierCompensation.create({
    data: {
      supplierId: lotVerrou.supplierId,
      lotId: lotVerrou.id,
      deliveryId,
      reason,
      quantity: quantiteFinale,
      unitPrice: toDecimal(lotVerrou.agreedUnitPrice),
      rate: taux,
      amount: montant,
      status: 'PENDING_APPROVAL',
      note: noteFinale,
    },
  });

  await recordAudit(tx, {
    action: 'COMPENSATION_CREATED',
    entityType: 'SupplierCompensation',
    entityId: compensation.id,
    metadata: {
      supplierId: lotVerrou.supplierId,
      lotId: lotVerrou.id,
      reason,
      quantity: toNumber(quantiteFinale),
      amount: toNumber(montant),
    },
  });

  return compensation;
}

// Applique une transition d'etat. updateMany filtre sur le statut courant :
// deux appels simultanes ne peuvent pas reussir tous les deux — le second a
// count = 0, relit la ligne et recoit exactement le 404 ou le 409 qu'une
// lecture prealable aurait renvoye.
async function appliquerTransition(tx, id, statutCible, acteur, donnees = {}) {
  const ligne = await tx.supplierCompensation.findUnique({ where: { id } });
  if (!ligne) {
    throw erreurCompensation(`Indemnisation ${id} introuvable`, 404, 'COMPENSATION_NOT_FOUND');
  }
  const autorises = TRANSITIONS[ligne.status] ?? [];
  if (!autorises.includes(statutCible)) {
    throw erreurCompensation(
      `Transition ${ligne.status} -> ${statutCible} refusée (statut actuel : ${ligne.status})`,
      409,
      'INVALID_STATE_TRANSITION'
    );
  }
  const { count } = await tx.supplierCompensation.updateMany({
    where: { id, status: ligne.status },
    data: { status: statutCible, ...donnees },
  });
  if (count === 0) {
    // Un appel concurrent a modifie la ligne entre-temps : relire pour
    // renvoyer le 409 exact.
    const majUnique = await tx.supplierCompensation.findUnique({ where: { id } });
    if (!majUnique) {
      throw erreurCompensation(`Indemnisation ${id} introuvable`, 404, 'COMPENSATION_NOT_FOUND');
    }
    throw erreurCompensation(
      `Transition ${majUnique.status} -> ${statutCible} refusée (statut actuel : ${majUnique.status})`,
      409,
      'INVALID_STATE_TRANSITION'
    );
  }
  return tx.supplierCompensation.findUnique({ where: { id } });
}

// APPROBATION : PENDING_APPROVAL -> APPROVED. L'audit COMPENSATION_APPROVED
// est ecrit dans la meme transaction que la mise a jour.
export async function approveCompensation(db, id, acteur = {}) {
  return db.$transaction(async (tx) => {
    const maj = await appliquerTransition(tx, id, 'APPROVED', acteur, {
      approvedAt: new Date(),
      approvedById: acteur.actorUser?.id ?? null,
    });
    await recordAudit(tx, {
      ...acteur,
      action: 'COMPENSATION_APPROVED',
      entityType: 'SupplierCompensation',
      entityId: id,
      metadata: { status: 'APPROVED' },
    });
    return maj;
  });
}

// REJET : PENDING_APPROVAL -> REJECTED. La justification (note) est ecrite
// sur la ligne : un rejet doit pouvoir etre explique a posteriori.
export async function rejectCompensation(db, id, { note }, acteur = {}) {
  return db.$transaction(async (tx) => {
    const maj = await appliquerTransition(tx, id, 'REJECTED', acteur, { note });
    await recordAudit(tx, {
      ...acteur,
      action: 'COMPENSATION_REJECTED',
      entityType: 'SupplierCompensation',
      entityId: id,
      metadata: { note },
    });
    return maj;
  });
}

// PAIEMENT : APPROVED -> PAID. Ecrit reference, paidAt ET paidById : qui a
// paye, avec quelle reference, est une exigence comptable (jamais un agent
// IA : requireHumanActor sur la route).
export async function payCompensation(db, id, { reference }, acteur = {}) {
  return db.$transaction(async (tx) => {
    const maj = await appliquerTransition(tx, id, 'PAID', acteur, {
      reference,
      paidAt: new Date(),
      paidById: acteur.actorUser?.id ?? null,
    });
    await recordAudit(tx, {
      ...acteur,
      action: 'COMPENSATION_PAID',
      entityType: 'SupplierCompensation',
      entityId: id,
      metadata: { reference, amount: toNumber(maj.amount) },
    });
    return maj;
  });
}

// Liste paginée de toutes les indemnisations (vue admin complete : identite
// du fournisseur et compte de paiement par defaut, comme la vue admin des
// reversements : l'administrateur a besoin du numero complet pour le virement).
export async function listCompensations(db, { page = 1, limit = 20, status } = {}) {
  const where = status ? { status } : {};
  const [items, total] = await Promise.all([
    db.supplierCompensation.findMany({
      where,
      include: {
        supplier: {
          include: {
            user: {
              select: {
                firstname: true,
                lastname: true,
                email: true,
                payoutAccounts: { where: { isDefault: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.supplierCompensation.count({ where }),
  ]);

  return {
    items: items.map((c) => ({
      id: c.id,
      supplierId: c.supplierId,
      lotId: c.lotId,
      deliveryId: c.deliveryId,
      reason: c.reason,
      quantity: toNumber(c.quantity),
      unitPrice: toNumber(c.unitPrice),
      rate: toNumber(c.rate),
      amount: toNumber(c.amount),
      status: c.status,
      note: c.note,
      reference: c.reference,
      approvedById: c.approvedById,
      approvedAt: c.approvedAt,
      paidById: c.paidById,
      paidAt: c.paidAt,
      createdAt: c.createdAt,
      supplier: c.supplier
        ? {
            farmName: c.supplier.farmName,
            firstname: c.supplier.user.firstname,
            lastname: c.supplier.user.lastname,
            email: c.supplier.user.email,
            payoutAccount: c.supplier.user.payoutAccounts[0]
              ? {
                  method: c.supplier.user.payoutAccounts[0].method,
                  provider: c.supplier.user.payoutAccounts[0].provider,
                  accountNumber: c.supplier.user.payoutAccounts[0].accountNumber,
                  accountName: c.supplier.user.payoutAccounts[0].accountName,
                }
              : null,
          }
        : null,
    })),
    page,
    limit,
    total,
  };
}

// Liste paginée des indemnisations d'un fournisseur (DTO fournisseur : motif,
// quantité, montant, statut ; aucun prix, taux ni donnee plateforme).
export async function listCompensationsPourFournisseur(db, supplierId, { page = 1, limit = 20 } = {}) {
  const where = { supplierId };
  const [items, total] = await Promise.all([
    db.supplierCompensation.findMany({
      where,
      select: {
        id: true,
        lotId: true,
        deliveryId: true,
        reason: true,
        quantity: true,
        amount: true,
        status: true,
        note: true,
        reference: true,
        paidAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.supplierCompensation.count({ where }),
  ]);

  return {
    items: items.map((c) => ({
      id: c.id,
      lotId: c.lotId,
      deliveryId: c.deliveryId,
      reason: c.reason,
      quantity: toNumber(c.quantity),
      amount: toNumber(c.amount),
      status: c.status,
      note: c.note,
      reference: c.reference,
      paidAt: c.paidAt,
      createdAt: c.createdAt,
    })),
    page,
    limit,
    total,
  };
}
