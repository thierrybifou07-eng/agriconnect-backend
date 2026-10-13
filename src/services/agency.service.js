import prisma from '../config/prisma.js';

// Couverture des zones par les agences de transport (plan v2, P5.1).
//
// findActiveAgencyForZone(zoneId) renvoie l'agence active couvrant la zone.
// Au MVP la couverture est simple : la première agence par identifiant dont
// la ligne AgencyZone est active. Un algorithme de priorité (distance,
// charge, tarif) pourra remplacer ce tri sans changer la signature.
//
// Deux refus métier, tous deux en 409 :
//   - aucune agence active ne couvre la zone -> 'Zone non couverte' ;
//   - l'assurance de l'agence est expirée -> 'Assurance de l'agence expirée'.
// Une agence dont l'assurance expire ne peut pas prendre de livraison :
// la vérification porte sur la date du jour, pas sur le moment de la course.
//
// `db` est le client Prisma de la transaction courante (ou prisma lui-même
// hors transaction) : comme recordAudit, ce helper ne masque jamais ses
// erreurs.

export async function findActiveAgencyForZone(zoneId, db = prisma) {
  const agencyZone = await db.agencyZone.findFirst({
    where: {
      zoneId,
      isActive: true,
      agency: { isActive: true },
    },
    orderBy: { agencyId: 'asc' },
    include: { agency: true },
  });

  if (!agencyZone) {
    throw Object.assign(new Error('Zone non couverte'), {
      statusCode: 409,
      code: 'ZONE_NOT_COVERED',
    });
  }

  const agency = agencyZone.agency;

  // insuranceExpiresAt est nullable : une agence sans date d'expiration
  // n'est jamais bloquée par cette règle.
  if (agency.insuranceExpiresAt && agency.insuranceExpiresAt < new Date()) {
    throw Object.assign(new Error("Assurance de l'agence expirée"), {
      statusCode: 409,
      code: 'AGENCY_INSURANCE_EXPIRED',
    });
  }

  return agency;
}
