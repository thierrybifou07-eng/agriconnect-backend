import { toNumber } from '../utils/money.js';
import { recordAudit } from '../utils/audit.js';

// onProfileVerified(tx, userId) — appelée depuis la validation d'un profil (P1.6),
// dans la MÊME transaction. Deux rôles :
//  1. Le filleul qui vient d'être vérifié : son Referral PENDING passe à ELIGIBLE
//     si le parrain est lui-même VERIFIED.
//  2. Le parrain qui vient d'être vérifié : ses filleuls déjà vérifiés dont le
//     Referral est PENDING passent à ELIGIBLE.
export async function onProfileVerified(tx, userId) {
  const settings = await tx.platformSetting.findUnique({ where: { id: 1 } });
  if (!settings) {
    throw Object.assign(new Error('Paramètres de la plateforme manquants'), { statusCode: 500 });
  }
  const montantBUYER = settings.referralBuyerReward;
  const montantSUPPLIER = settings.referralSupplierReward;

  const maintenant = new Date();

  // Cas 1 : le filleul qui vient d'être vérifié
  const referralFilleul = await tx.referral.findFirst({
    where: { referredId: userId, status: 'PENDING' },
    include: { referrer: { select: { profileVerificationStatus: true } } },
  });
  if (referralFilleul && referralFilleul.referrer.profileVerificationStatus === 'VERIFIED') {
    const montant = referralFilleul.kind === 'BUYER' ? montantBUYER : montantSUPPLIER;
    await tx.referral.update({
      where: { id: referralFilleul.id },
      data: { status: 'ELIGIBLE', rewardAmount: montant, eligibleAt: maintenant },
    });
  }

  // Cas 2 : le parrain qui vient d'être vérifié — réévalue ses filleuls déjà vérifiés
  const referralsParrain = await tx.referral.findMany({
    where: { referrerId: userId, status: 'PENDING' },
    include: { referred: { select: { profileVerificationStatus: true } } },
  });
  for (const referral of referralsParrain) {
    if (referral.referred.profileVerificationStatus === 'VERIFIED') {
      const montant = referral.kind === 'BUYER' ? montantBUYER : montantSUPPLIER;
      await tx.referral.update({
        where: { id: referral.id },
        data: { status: 'ELIGIBLE', rewardAmount: montant, eligibleAt: maintenant },
      });
    }
  }
}

// payReferral(tx, referralId, { reference, actor }) — ELIGIBLE -> PAID.
//
// La référence du paiement et l'utilisateur qui l'a effectué sont écrits dans
// la ligne Referral (comme SupplierPayout), EN PLUS de l'audit qui la conserve
// dans sa metadata.
//
// Transition atomique : updateMany filtré sur le statut ELIGIBLE. Deux appels
// simultanés ne peuvent pas réussir tous les deux — le second a count = 0,
// relit la ligne et reçoit exactement le 404 ou le 409 qu'une lecture préalable
// aurait renvoyé. L'audit n'est écrit que par l'appel gagnant.
export async function payReferral(tx, referralId, { reference, actor }) {
  const maj = await tx.referral.updateMany({
    where: { id: referralId, status: 'ELIGIBLE' },
    data: {
      status: 'PAID',
      reference,
      paidById: actor.user?.id ?? null,
      paidAt: new Date(),
    },
  });

  if (maj.count === 0) {
    // Soit le parrainage n'existe pas, soit un appel concurrent l'a déjà payé :
    // la relecture tranche entre le 404 et le 409 exact.
    const referral = await tx.referral.findUnique({ where: { id: referralId } });
    if (!referral) {
      throw Object.assign(new Error('Parrainage introuvable'), { statusCode: 404 });
    }
    throw Object.assign(new Error('Ce parrainage n\'est pas payable'), {
      statusCode: 409,
      code: 'INVALID_STATE_TRANSITION',
    });
  }

  const misAJour = await tx.referral.findUnique({ where: { id: referralId } });

  await recordAudit(tx, {
    actorUser: actor.user,
    actorAgent: actor.agent ?? null,
    action: 'REFERRAL_PAID',
    entityType: 'Referral',
    entityId: referralId,
    metadata: { reference, rewardAmount: toNumber(misAJour.rewardAmount) },
  });

  return misAJour;
}

// rejectReferral(tx, referralId, { reason, actor }) — PENDING ou ELIGIBLE -> REJECTED.
//
// Même transition atomique que payReferral : le filtre { id, status: { in: [...] } }
// fait qu'un seul appel gagne ; le second relit la ligne pour le 404/409 exact.
export async function rejectReferral(tx, referralId, { reason, actor }) {
  const maj = await tx.referral.updateMany({
    where: { id: referralId, status: { in: ['PENDING', 'ELIGIBLE'] } },
    data: { status: 'REJECTED', rejectionReason: reason },
  });

  if (maj.count === 0) {
    const referral = await tx.referral.findUnique({ where: { id: referralId } });
    if (!referral) {
      throw Object.assign(new Error('Parrainage introuvable'), { statusCode: 404 });
    }
    throw Object.assign(new Error('Ce parrainage ne peut pas être rejeté'), {
      statusCode: 409,
      code: 'INVALID_STATE_TRANSITION',
    });
  }

  const misAJour = await tx.referral.findUnique({ where: { id: referralId } });

  await recordAudit(tx, {
    actorUser: actor.user,
    actorAgent: actor.agent ?? null,
    action: 'REFERRAL_REJECTED',
    entityType: 'Referral',
    entityId: referralId,
    metadata: { reason },
  });

  return misAJour;
}
