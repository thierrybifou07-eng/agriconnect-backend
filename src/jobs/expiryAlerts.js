import prisma from '../config/prisma.js';
import { STAFF_ROOM } from '../services/message.service.js';

// Alertes d'expiration vers l'equipe (plan v2, P6.3).
//
// Lots expirant sous 48 h et assurances d'agence expirant sous 30 jours :
// un seul evenement `alert:expiring` vers la room `staff`. AUCUNE ecriture
// en base : c'est une notification, pas une action metier.
export async function expiryAlerts(db = prisma, now = new Date(), io = null) {
  const dans48h = new Date(now.getTime() + 48 * 3600 * 1000);
  const dans30j = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  const [lots, agences] = await Promise.all([
    db.stockLot.findMany({
      where: {
        expiresAt: { gt: now, lte: dans48h },
        // Un lot sans stock a perdre, ou deja vendu/rejete/retire/retourne, n'a
        // rien a sauver : l'alerte ne doit pas declencher d'action inutile.
        quantityAvailable: { gt: 0 },
        status: { notIn: ['REJECTED', 'RETURNED', 'WITHDRAWN', 'SOLD_OUT'] },
      },
      select: {
        id: true,
        lotCode: true,
        expiresAt: true,
        quantityAvailable: true,
        product: { select: { name: true } },
      },
    }),
    db.transportAgency.findMany({
      where: { insuranceExpiresAt: { gt: now, lte: dans30j } },
      select: { id: true, name: true, insuranceProvider: true, insuranceExpiresAt: true },
    }),
  ]);
  if (io) {
    io.to(STAFF_ROOM).emit('alert:expiring', {
      type: 'EXPIRY_ALERT',
      emittedAt: now.toISOString(),
      lots,
      agences,
    });
  }
  return { lots, agences };
}
