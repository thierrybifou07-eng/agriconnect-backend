// Synchronisation du statut des annonces reliées à un lot (plan v2, P2.5).
//
// L'annonce est la SEULE chose que voient les acheteurs : quand le lot
// s'épuise ou quitte le cycle de vie, l'annonce doit suivre, sans intervention
// manuelle. C'est pourquoi chaque fonction de stock.service qui change un lot
// appelle syncListingsForLot à la fin : le statut de l'annonce ne dépend jamais
// d'un oubli côté publication.

// Statuts qui clôtuent la vie commerciale d'un lot : l'annonce qui ne porte
// plus que des lots dans ces statuts n'a plus rien à vendre.
const STATUTS_LOTS_INACTIFS = ['EXPIRED', 'RETURNED', 'WITHDRAWN', 'REJECTED'];

// Résout un code de statut d'annonce dans la transaction appelante : le cache
// mémoire de getLookupId vit hors transaction et ne verrait pas les écritures
// en cours.
import {ListingStatusCode, LotStatusCode} from "../utils/enums/enums.helpers.js";

async function statutId(tx, code) {
  const row = await tx.listingStatus.findUnique({ where: { code } });
  if (!row) {
    throw new Error(`Valeur de référence introuvable : listingStatus.${code}`);
  }
  return row.id;
}

// Synchronise le statut des annonces reliées à un lot dont le statut vient de
// changer :
//  - annonce ACTIVE dont tous les lots sont SOLD_OUT -> SOLD (tout est vendu) ;
//  - annonce ACTIVE dont tous les lots sont EXPIRED, RETURNED, WITHDRAWN ou
//    REJECTED -> INACTIVE (plus rien à vendre).
// Un lot AVAILABLE ou FULLY_RESERVED ne change rien : l'annonce reste ACTIVE.
// Une annonce DRAFT, SOLD ou INACTIVE n'est jamais recalculée : son statut est
// un fait de publication, pas une conséquence des quantités.
export async function syncListingsForLot(tx, lotId) {
  const liens = await tx.listingLot.findMany({
    where: { lotId },
    include: { listing: { include: { status: true } } },
  });
  for (const lien of liens) {
    const annonce = lien.listing;
    if (annonce.status.code !== ListingStatusCode.ACTIVE) {
      continue;
    }
    const lots = await tx.listingLot.findMany({
      where: { listingId: annonce.id },
      include: { lot: true },
    });
    if (lots.length === 0) {
      continue;
    }
    const statuts = lots.map((l) => l.lot.status);
    let cible = null;
    if (statuts.every((s) => s === LotStatusCode.SOLD_OUT)) {
      cible = ListingStatusCode.SOLD;
    } else if (statuts.every((s) => STATUTS_LOTS_INACTIFS.includes(s))) {
     cible = ListingStatusCode.INACTIVE;
    }
    if (cible) {
      await tx.listing.update({
        where: { id: annonce.id },
        data: { statusId: await statutId(tx, cible) },
      });
    }
  }
}
