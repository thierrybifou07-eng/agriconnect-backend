import prisma from '../config/prisma.js';
import { expireAvailable } from '../services/stock.service.js';
import { createForLoss } from '../services/compensation.service.js';

// Peremption des lots invendus (plan v2, P6.3).
//
// Tout lot dont expiresAt est passe et qui a encore du disponible, QUEL QUE
// SOIT son statut : une reservation liberee entre-temps peut remettre du
// disponible dans un lot deja EXPIRED. expireAvailable place le disponible
// en perte, puis cree l'indemnisation fournisseur (PENDING_APPROVAL, raison
// EXPIRED_UNSOLD). Le statut du lot est recalcule par expireAvailable via
// computeLotStatus, jamais force ici.
//
// Idempotente : apres le premier passage, quantityAvailable = 0 et le lot
// n'est plus selectionne — la quantite perdue n'est indemnisee qu'une fois.
export async function expireLots(db = prisma, now = new Date()) {
  const lots = await db.stockLot.findMany({
    where: { expiresAt: { lt: now }, quantityAvailable: { gt: 0 } },
  });
  const resultats = [];
  // Sequentiel : chaque lot a sa propre transaction, et le volume d'un
  // passage est faible (quelques lots perimes).
  for (const lot of lots) {
    const resultat = await db.$transaction(async (tx) => {
      const perdue = await expireAvailable(tx, lot.id, { note: 'Péremption automatique' });
      if (!perdue.greaterThan(0)) {
        return null;
      }
      // createForLoss travaille sur le lot relu apres ecriture : ses champs
      // (supplierId, agreedUnitPrice, quantityInitial) ne sont pas modifies
      // par expireAvailable, mais relire coute peu et evite de ceder un lot
      // perime a un lot mis a jour.
      const lotMaj = await tx.stockLot.findUnique({ where: { id: lot.id } });
      const indemnisation = await createForLoss(tx, {
        lot: lotMaj,
        quantity: perdue,
        reason: 'EXPIRED_UNSOLD',
        note: 'Invendus périmés',
        // Appel automatique : borne au reste indemnisable au lieu d'echouer —
        // une indemnisation manuelle anterieure a pu reduire le reste.
        strict: false,
      });
      return { lotId: lot.id, quantite: perdue, compensationId: indemnisation?.id ?? null };
    });
    if (resultat) resultats.push(resultat);
  }
  return resultats;
}
