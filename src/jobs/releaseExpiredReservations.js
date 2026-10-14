import prisma from '../config/prisma.js';
import { cancelOrder } from '../services/order.service.js';

// Liberation des reservations des devis expires (plan v2, P6.3).
//
// Un devis QUOTED dont reservedUntil est depasse n'est plus confirmable :
// la commande est annulee (raison « Devis expire ») et chaque reservation
// encore vivante retourne au disponible. L'annulation passe par
// order.service.cancelOrder avec un acteur systeme : l'audit trace des
// colonnes acteur nulles, et le calcul de liberation (quantiteConsommee)
// n'est pas reimplemente ici.
//
// Idempotente : une commande CANCELLED n'est plus selectionnee, donc une
// seconde execution ne libere rien de plus.
export async function releaseExpiredReservations(db = prisma, now = new Date()) {
  const commandes = await db.order.findMany({
    where: { status: 'QUOTED', reservedUntil: { lt: now } },
    include: { items: true },
  });
  const annulees = [];
  // Sequentiel plutot que parallele : chaque commande a sa propre
  // transaction, et le volume d'un passage est faible (quelques devis).
  for (const commande of commandes) {
    await db.$transaction((tx) => cancelOrder(tx, commande.id, {}, 'Devis expiré'));
    annulees.push(commande.id);
  }
  return annulees;
}
