import prisma from '../../src/config/prisma.js';

// Tables métier vidées entre chaque test. Les tables de référence (Role,
// UserStatus, MediaType, MimeType, DeliveryMode, ProductCategory, Unit,
// AgentCapability) et la configuration (PlatformSetting, LegalDocument,
// LegalDocumentVersion, LegalDocumentTranslation) sont volontairement
// conservées : le seed les remplit et chaque test en a besoin.
const BUSINESS_TABLES = [
  // auth
  'Session',
  'RefreshToken',
  'EmailVerificationToken',
  'PasswordResetToken',
  // utilisateurs et profils
  'User',
  'SupplierProfile',
  'BuyerProfile',
  'DriverProfile',
  'PayoutAccount',
  'VerificationDocument',
  'TermsAcceptance',
  // agents
  'Agent',
  'AgentCapabilityLink',
  // géographie et logistique
  'Zone',
  'TransportAgency',
  'AgencyZone',
  'Hub',
  // catalogue et stock
  'Product',
  'StockLot',
  'StockMovement',
  // messagerie
  'Conversation',
  'Message',
  // commandes et paiements
  'Order',
  'OrderItem',
  'Payment',
  'SupplierPayout',
  'SupplierCompensation',
  'Delivery',
  // divers
  'Referral',
  'Media',
  'AuditLog',
];

// DELETE, et non TRUNCATE.
//
// TRUNCATE est plus rapide, mais MySQL le refuse sur une table référencée par
// une clé étrangère — et ce refus ne cède pas à FOREIGN_KEY_CHECKS=0, contrairement
// à ce que la désactivation autour de l'opération laisse croire. Il ne passe que
// si la table référente a été vidée juste avant, ce qui rend le nettoyage
// dépendant de l'ordre de cette liste : ajouter une table sans la placer au bon
// endroit fait échouer la suite entière.
//
// DELETE respecte réellement FOREIGN_KEY_CHECKS=0, donc l'ordre n'a plus d'importance
// et la liste n'a plus à être maintenue. Le surcoût est négligeable à cette échelle.
export async function resetDatabase() {
  // SET et SET SESSION sont deux commandes distinctes : PRISMA n'accepte pas
  // de plusieurs instructions dans un seul $executeRawUnsafe.
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of BUSINESS_TABLES) {
      await prisma.$executeRawUnsafe(`DELETE FROM \`${table}\``);
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