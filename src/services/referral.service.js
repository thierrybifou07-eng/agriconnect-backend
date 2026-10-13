import { asMoney, toDecimal, toNumber } from '../utils/money.js';
import { recordAudit } from '../utils/audit.js';

// Parrainage à montant fixe (plan v2).
//
// Chaque fonction recoit le client de transaction `tx` en premier argument
// et ecrit son AuditLog dans la meme transaction que le changement
// qu'elle trace : un echec de l'audit annule l'action, et inversement.

// Erreur metier : le format { statusCode, code } est celui qu'errorHandler
// renvoie au client (reponse { error, code }).
function erreurReferral(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

// Lit les montants de parrainage depuis PlatformSetting (ligne unique, id = 1).
async function lireMontants(tx) {
  const settings = await tx.platformSetting.findUnique({ where: { id: 1 } });
  if (!settings) {
    throw erreurReferral('Configuration de la plateforme introuvable', 500, 'PLATFORM_SETTING_MISSING');
  }
  return {
    buyer: toDecimal(settings.referralBuyerReward),
    supplier: toDecimal(settings.referralSupplierReward),
  };
}

// Calcule le montant de la recompense selon le kind du filleul.
function montantPour(kind, montants) {
  return kind === 'SUPPLIER' ? montants.supplier : montants.buyer;
}

// Passe un Referral PENDING -> ELIGIBLE si le parrain est verifie.
// Le montant est fige au passage : meme si PlatformSetting change ensuite,
// rewardAmount conserve la valeur du moment de l'eligibilite.
async function rendreEligible(tx, referral, referrer) {
  if (referrer.profileVerificationStatus !== 'VERIFIED') return false;

  const montants = await lireMontants(tx);
  await tx.referral.update({
    where: { id: referral.id },
    data: {
      status: 'ELIGIBLE',
      rewardAmount: asMoney(montantPour(referral.kind, montants)),
      eligibleAt: new Date(),
    },
  });
  return true;
}

// Appellee depuis la validation d'un profil (P1.6), dans la MEME transaction.
//
// Cas 1 — le filleul vient d'etre verifie : pour son Referral PENDING, si le
// parrain est lui-meme VERIFIED -> ELIGIBLE avec le montant fige ; sinon
// il reste PENDING.
//
// Cas 2 — le parrain vient d'etre verifie : reevalue ses filleuls deja
// verifies (leurs Referrals PENDING passent ELIGIBLE).
export async function onProfileVerified(tx, userId) {
  // Cas 1 : le filleul est verifie, on regarde son propre Referral PENDING.
  const referralFilleul = await tx.referral.findFirst({
    where: { referredId: userId, status: 'PENDING' },
    include: { referrer: { select: { profileVerificationStatus: true } } },
  });
  if (referralFilleul) {
    await rendreEligible(tx, referralFilleul, referralFilleul.referrer);
  }

  // Cas 2 : le parrain est verifie, on reevalue ses filleuls deja verifies.
  const filleuls = await tx.referral.findMany({
    where: { referrerId: userId, status: 'PENDING' },
    include: { referred: { select: { profileVerificationStatus: true } } },
  });
  for (const referral of filleuls) {
    // Seuls les filleuls deja VERIFIED sont eligibles ; les autres restent
    // PENDING en attendant leur propre verification.
    if (referral.referred.profileVerificationStatus === 'VERIFIED') {
      const montants = await lireMontants(tx);
      await tx.referral.update({
        where: { id: referral.id },
        data: {
          status: 'ELIGIBLE',
          rewardAmount: asMoney(montantPour(referral.kind, montants)),
          eligibleAt: new Date(),
        },
      });
    }
  }
}

// GET /api/v2/auth/me/referral
//
// Vue parrain : son code, les totaux par statut, et la liste de ses
// filleuls avec le prenom seul (aucune donnee personnelle supplementaire).
export async function getMyReferral(db, userId) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { referralCode: true },
  });

  const where = { referrerId: userId };
  const [referrals, totals] = await Promise.all([
    db.referral.findMany({
      where,
      select: {
        id: true,
        status: true,
        kind: true,
        rewardAmount: true,
        createdAt: true,
        referred: { select: { firstname: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    db.referral.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    }),
  ]);

  const compte = { PENDING: 0, ELIGIBLE: 0, PAID: 0 };
  for (const row of totals) {
    compte[row.status] = row._count._all;
  }

  return {
    code: user?.referralCode ?? null,
    totals: {
      pending: compte.PENDING ?? 0,
      eligible: compte.ELIGIBLE ?? 0,
      paid: compte.PAID ?? 0,
    },
    referrals: referrals.map((r) => ({
      status: r.status,
      kind: r.kind,
      rewardAmount: toNumber(r.rewardAmount),
      createdAt: r.createdAt,
      referredFirstname: r.referred.firstname,
    })),
  };
}

// GET /api/v2/admin/referrals?status=&page=&limit=
//
// Liste paginée de tous les parrainages (vue admin complete : parrain,
// filleul, montant, statut).
export async function listAllReferrals(db, { page = 1, limit = 20, status } = {}) {
  const where = status ? { status } : {};
  const [items, total] = await Promise.all([
    db.referral.findMany({
      where,
      select: {
        id: true,
        status: true,
        kind: true,
        rewardAmount: true,
        eligibleAt: true,
        paidAt: true,
        rejectionReason: true,
        createdAt: true,
        referrer: { select: { id: true, firstname: true, lastname: true, email: true } },
        referred: { select: { id: true, firstname: true, lastname: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.referral.count({ where }),
  ]);

  return {
    items: items.map((r) => ({
      id: r.id,
      status: r.status,
      kind: r.kind,
      rewardAmount: toNumber(r.rewardAmount),
      eligibleAt: r.eligibleAt,
      paidAt: r.paidAt,
      rejectionReason: r.rejectionReason,
      createdAt: r.createdAt,
      referrer: r.referrer
        ? { id: r.referrer.id, firstname: r.referrer.firstname, lastname: r.referrer.lastname, email: r.referrer.email }
        : null,
      referred: r.referred
        ? { id: r.referred.id, firstname: r.referred.firstname, lastname: r.referred.lastname, email: r.referred.email }
        : null,
    })),
    page,
    limit,
    total,
  };
}

// PATCH /api/v2/admin/referrals/:id/pay
//
// Marque un parrainage ELIGIBLE comme paye. Seul un ELIGIBLE peut etre paye :
// un PENDING n'a pas encore les conditions remplies, un PAID est deja paye,
// un REJECTED est rejete. L'audit REFERRAL_PAID est ecrit dans la meme
// transaction que la mise a jour.
export async function payReferral(db, referralId, { reference }, acteur) {
  return db.$transaction(async (tx) => {
    const referral = await tx.referral.findUnique({ where: { id: referralId } });
    if (!referral) {
      throw erreurReferral(`Parrainage ${referralId} introuvable`, 404, 'REFERRAL_NOT_FOUND');
    }
    if (referral.status !== 'ELIGIBLE') {
      throw erreurReferral(
        `Seul un parrainage ELIGIBLE peut être payé (statut actuel : ${referral.status})`,
        409,
        'INVALID_STATE_TRANSITION'
      );
    }

    const maj = await tx.referral.update({
      where: { id: referralId },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        reference: reference ?? null,
      },
    });

    await recordAudit(tx, {
      ...acteur,
      action: 'REFERRAL_PAID',
      entityType: 'Referral',
      entityId: referralId,
      metadata: {
        referrerId: referral.referrerId,
        referredId: referral.referredId,
        kind: referral.kind,
        amount: toNumber(referral.rewardAmount),
        reference: reference ?? null,
      },
    });

    return maj;
  });
}

// PATCH /api/v2/admin/referrals/:id/reject
//
// Rejete un parrainage PENDING ou ELIGIBLE. Un PAID ne peut pas etre rejete
// (l'argent est deja parti), un REJECTED est deja rejete. L'audit
// REFERRAL_REJECTED est ecrit dans la meme transaction.
export async function rejectReferral(db, referralId, { reason }, acteur) {
  return db.$transaction(async (tx) => {
    const referral = await tx.referral.findUnique({ where: { id: referralId } });
    if (!referral) {
      throw erreurReferral(`Parrainage ${referralId} introuvable`, 404, 'REFERRAL_NOT_FOUND');
    }
    if (referral.status !== 'PENDING' && referral.status !== 'ELIGIBLE') {
      throw erreurReferral(
        `Seul un parrainage PENDING ou ELIGIBLE peut être rejeté (statut actuel : ${referral.status})`,
        409,
        'INVALID_STATE_TRANSITION'
      );
    }

    const maj = await tx.referral.update({
      where: { id: referralId },
      data: {
        status: 'REJECTED',
        rejectionReason: reason,
      },
    });

    await recordAudit(tx, {
      ...acteur,
      action: 'REFERRAL_REJECTED',
      entityType: 'Referral',
      entityId: referralId,
      metadata: {
        referrerId: referral.referrerId,
        referredId: referral.referredId,
        kind: referral.kind,
        previousStatus: referral.status,
        reason,
      },
    });

    return maj;
  });
}
