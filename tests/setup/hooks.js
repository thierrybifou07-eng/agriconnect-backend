import { afterAll, beforeEach } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { clearLookupCache } from '../../src/utils/lookupCache.js';
import { resetDatabase } from '../helpers/db.js';

// Chaque test repart d'une base vide : l'isolation est le prix a payer pour
// pouvoir rejouer la suite sans ordonnancement impose.
beforeEach(async () => {
  await resetDatabase();
  clearLookupCache();
});

afterAll(async () => {
  await prisma.$disconnect();
});
