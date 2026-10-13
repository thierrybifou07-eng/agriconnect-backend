import { asQuantity, roundMoney, toDecimal, toNumber } from '../utils/money.js';
import { recordAudit } from '../utils/audit.js';
import { getSettings } from './pricing.service.js';
import { compensationToApi } from '../utils/dto/compensation.dto.js';

// Indemnisation des invendus et pertes (plan v2, P6.2).
//
// Chaque fonction recoit le client de transaction `tx` en premier argument
// et ecrit son AuditLog dans la meme transaction que le changement qu'elle
// trace : un echec de l'audit annule l'action, et inversement.
//
// Le montant est fige a la creation : quantity x agreedUnitPrice (prix
// convenu du lot) x expiryCompensationRate (taux de la plateforme). Le taux
// est recopie sur la ligne `rate` : un changement ulterieur de la
// configuration ne retroagit jamais sur une indemnisation deja creee.
//
// Le modele n'a ni colonne reference ni paidById : la reference du virement
// et l'identite de qui paie sont tracees dans l'AuditLog, qui reste la
// source de reconciliation (meme principe que le reste du plan).

// Erreur metier : le format { statusCode, code } est celui qu'errorHandler
// renvoie au client (reponse { error, code }).
function erreurCompensation(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

// Quantite strictement positive et inferieure ou egale a la quantite initiale
// du lot : on ne peut pas indemniser plus que ce qui a ete confie.
function quantiteIndemnisable(quantite, lot) {
  const valeur = toDecimal(quantite);
  if (!valeur.greaterThan(0)) {
    throw erreurCompensation('Quantité doit être une quantité positive', 400, 'INVALID_QUANTITY');
  }
  const initial = toDecimal(lot.quantityInitial);
  if (valeur.greaterThan(initial)) {
    throw erreurCompensation(
      `Quantité ${valeur} supérieure à la quantité du lot (${initial})`,
      400,
      'INVALID_QUANTITY'
    );
  }
  return valeur;
}

// Verifie qu'une livraison referencee existe. Le lien livraison -> lot passe
// par OrderItem : verifier cette appartenance exigerait de connaitre la
// commande, hors perimetre du prompt (deliveryId reste une trace libre).
async function livraisonExiste(tx, deliveryId) {
  if (deliveryId === null || deliveryId === undefined) return;
  const delivery = await tx.delivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) {
    throw erreurCompensation(`Livraison ${deliveryId} introuvable`, 404, 'DELIVERY_NOT_FOUND');
  }
}

// Cree une indemnisation PENDING_APPROVAL pour un lot donne.
//
// Renvoie null SANS rien creer quand le taux de la plateforme vaut zero :
// l'invendu n'est pas indemnisable, ce n'est pas une erreur de la requete.
// Le lot est charge par l'appelant (dans la meme transaction) : createForLoss
// recoit ainsi un lot deja verrouille par la transaction courante.
export async function createForLoss(tx, { lot, quantity, reason, deliveryId, note }, acteur) {
  const quantite = quantiteIndemnisable(quantity, lot);
  await livraisonExiste(tx, deliveryId);

  const settings = await getSettings(tx);
  const rate = toDecimal(settings.expiryCompensationRate);
  if (rate.isZero()) {
    return null;
  }

  // Un seul arrondi, sur le montant final : les intermediaires restent en
  // Decimal complet (jamais de Number pour l'argent).
  const amount = roundMoney(
    quantite.mul(toDecimal(lot.agreedUnitPrice)).mul(rate),
    settings.currency
  );

  const compensation = await tx.supplierCompensation.create({
    data: {
      supplierId: lot.supplierId,
      lotId: lot.id,
      deliveryId: deliveryId ?? null,
      reason,
      quantity: asQuantity(quantite),
      unitPrice: toDecimal(lot.agreedUnitPrice),
      rate,
      amount,
      status: 'PENDING_APPROVAL',
      note: note ?? null,
    },
  });

  await recordAudit(tx, {
    ...acteur,
    action: 'COMPENSATION_CREATED',
    entityType: 'SupplierCompensation',
    entityId: compensation.id,
    metadata: {
      lotId: lot.id,
      supplierId: lot.supplierId,
      reason,
      quantity: toNumber(quantite),
      amount: toNumber(amount),
      rate: toNumber(rate),
    },
  });

  return compensation;
}

// Transition centralisee : verrouillage de la ligne, controle du statut
// depart, mise a jour et audit dans la meme transaction. Une transition
// invalide est un conflit (409), jamais un silence : le client doit savoir
// que l'indemnisation a deja change d'etat.
async function transition(tx, id, depuis, vers, donnees, acteur, action, metadata) {
  const compensation = await tx.supplierCompensation.findUnique({ where: { id } });
  if (!compensation) {
    throw erreurCompensation(`Indemnisation ${id} introuvable`, 404, 'COMPENSATION_NOT_FOUND');
  }
  if (compensation.status !== depuis) {
    throw erreurCompensation(
      `Transition ${compensation.status} -> ${vers} refusée`,
      409,
      'INVALID_STATE_TRANSITION'
    );
  }

  const maj = await tx.supplierCompensation.update({
    where: { id },
    data: { ...donnees, status: vers },
  });

  await recordAudit(tx, {
    ...acteur,
    action,
    entityType: 'SupplierCompensation',
    entityId: id,
    metadata: metadata ?? { lotId: compensation.lotId, supplierId: compensation.supplierId },
  });

  return maj;
}

// PENDING_APPROVAL -> APPROVED : l'equipe valide le bien-fonde de la perte.
export async function approveCompensation(tx, id, acteur) {
  return transition(
    tx,
    id,
    'PENDING_APPROVAL',
    'APPROVED',
    { approvedById: acteur.actorUser.id, approvedAt: new Date() },
    acteur,
    'COMPENSATION_APPROVED'
  );
}

// PENDING_APPROVAL -> REJECTED : la note de rejet remplace la note initiale :
// c'est la justification de la decision qui doit rester lisible par le
// fournisseur, pas le motif de la demande.
export async function rejectCompensation(tx, id, note, acteur) {
  return transition(
    tx,
    id,
    'PENDING_APPROVAL',
    'REJECTED',
    { note },
    acteur,
    'COMPENSATION_REJECTED'
  );
}

// APPROVED -> PAID : le virement est enregistre avec sa reference (tracee
// dans l'audit, le modele n'a pas de colonne reference). Une indemnisation
// APPROVED non payee reste visible comme telle : l'argent ne se deplace
// pas tout seul.
export async function payCompensation(tx, id, reference, acteur) {
  return transition(
    tx,
    id,
    'APPROVED',
    'PAID',
    { paidAt: new Date() },
    acteur,
    'COMPENSATION_PAID',
    { reference }
  );
}

// Liste paginee des indemnisations d'un fournisseur (DTO fournisseur : motif,
// quantite, montant, statut ; aucune donnee d'un fournisseur concurrent).
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
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.supplierCompensation.count({ where }),
  ]);

  return {
    items: items.map(compensationToApi),
    page,
    limit,
    total,
  };
}

// Liste paginee de toutes les indemnisations (vue admin complete : identite
// du fournisseur pour le virement, comme GET /admin/payouts).
export async function listAllCompensations(db, { page = 1, limit = 20, status } = {}) {
  const where = status ? { status } : {};
  const [items, total] = await Promise.all([
    db.supplierCompensation.findMany({
      where,
      select: {
        id: true,
        supplierId: true,
        supplier: {
          select: {
            farmName: true,
            user: { select: { firstname: true, lastname: true, email: true } },
          },
        },
        lotId: true,
        deliveryId: true,
        reason: true,
        quantity: true,
        unitPrice: true,
        rate: true,
        amount: true,
        status: true,
        note: true,
        approvedById: true,
        approvedAt: true,
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
      ...compensationToApi(c),
      supplierId: c.supplierId,
      supplier: c.supplier
        ? {
            farmName: c.supplier.farmName,
            firstname: c.supplier.user.firstname,
            lastname: c.supplier.user.lastname,
            email: c.supplier.user.email,
          }
        : null,
    })),
    page,
    limit,
    total,
  };
}
