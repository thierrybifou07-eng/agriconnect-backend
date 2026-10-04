import prisma from '../../src/config/prisma.js';

// Tables métier vidées entre chaque test. Les tables de référence (Role,
// UserStatus, ListingStatus...) sont volontairement conservées : le seed les
// remplit et chaque test en a besoin.
const BUSINESS_TABLES = [
  'RefreshToken',
  'Session',
  'Message',
  'Conversation',
  'Delivery',
  'Order',
  'Media',
  'Listing',
  'User',
];

// TRUNCATE est plus rapide que DELETE mais refuse de vérifier les clés
// étrangères, d'où la désactivation autour de l'opération. L'ordre n'importe
// donc pas.
export async function resetDatabase() {
  // SET et SET SESSION sont deux commandes distinctes : PRISMA n'accepte pas
  // de plusieurs instructions dans un seul $executeRawUnsafe.
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of BUSINESS_TABLES) {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\``);
    }
  } finally {
    await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
  }
}

// Supprime les jetons de rafraîchissement expirés : le test de rotation en
// dépend et ils s'accumulent d'un test à l'autre.
export async function expireAllRefreshTokens() {
  await prisma.refreshToken.updateMany({
    where: { revoked: false },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
}
