import cron from 'node-cron';
import prisma from '../config/prisma.js';
import { releaseExpiredReservations } from './releaseExpiredReservations.js';
import { expireLots } from './expireLots.js';
import { expiryAlerts } from './expiryAlerts.js';

// Tâches planifiées (plan v2, P6.3). Chaque fonction est idempotente et
// ecrit dans ses propres transactions : un echec ponctuel laisse la base
// coherente, et le travail est repris au passage suivant.
//
// Planification :
//  - devis expires : toutes les 5 minutes
//  - peremption des lots : toutes les heures
//  - alertes d'expiration : chaque jour a 7 h
export function startJobs(io = null) {
  cron.schedule('*/5 * * * *', () => {
    releaseExpiredReservations().catch((err) => {
      console.error('[jobs] releaseExpiredReservations a échoué', err);
    });
  });
  cron.schedule('0 * * * *', () => {
    expireLots().catch((err) => {
      console.error('[jobs] expireLots a échoué', err);
    });
  });
  cron.schedule('0 7 * * *', () => {
    expiryAlerts(prisma, new Date(), io).catch((err) => {
      console.error('[jobs] expiryAlerts a échoué', err);
    });
  });
}
