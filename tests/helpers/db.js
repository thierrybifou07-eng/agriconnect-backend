import prisma from '../../src/config/prisma.js';
import { PRODUCT_CATEGORIES, UNITS } from '../../prisma/seed-data/referentials.js';

// Tables métier vidées entre chaque test. Les tables de référence
// (REFERENCE_TABLES : Role, UserStatus, ..., LegalDocumentTranslation) et la
// configuration (PlatformSetting, LegalDocument*) sont volontairement
// conservées : le seed les remplit et chaque test en a besoin.
//
// Une table métier doit atterrir ici dès qu'elle porte des données de test.
export const BUSINESS_TABLES = [
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
  'LotQualityCheck',
  // annonces
  'Listing',
  'ListingLot',
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

// Tables de référence et de configuration : préservées entre deux tests, car
// le seed les remplit une seule fois au démarrage de la suite.
export const REFERENCE_TABLES = [
  // référentiels seedés
  'Role',
  'UserStatus',
  'MediaType',
  'MimeType',
  'DeliveryMode',
  'ListingStatus',
  'ProductCategory',
  'Unit',
  'AgentCapability',
  // configuration et documents juridiques
  'PlatformSetting',
  'LegalDocument',
  'LegalDocumentVersion',
  'LegalDocumentTranslation',
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
  //
  // Tout tient dans une transaction interactive : FOREIGN_KEY_CHECKS est une
  // variable de SESSION, et le pool de connexions de Prisma peut sinon
  // exécuter un DELETE sur une autre connexion que celle du SET — le DELETE
  // échoue alors sur une contrainte, de façon non déterministe. La
  // transaction interactive garantit une seule connexion pour tout le reset.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
    try {
      for (const table of BUSINESS_TABLES) {
        await tx.$executeRawUnsafe(`DELETE FROM \`${table}\``);
      }

      // Les référentiels ne sont pas vidés, mais les lignes que les tests
      // ajoutent directement sur ProductCategory et Unit ne doivent pas
      // survivre au test suivant : elles s'accumuleraient et contamineraient
      // les listes paginées des routes admin. On ne garde que les codes du
      // seed (prisma/seed-data/referentials.js).
      await tx.productCategory.deleteMany({
        where: { code: { notIn: PRODUCT_CATEGORIES.map((c) => c.code) } },
      });
      await tx.unit.deleteMany({
        where: { code: { notIn: UNITS.map((u) => u.code) } },
      });
    } finally {
      await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
    }
  });
}

// Supprime les jetons de rafraîchissement expirés : le test de rotation en
// dépend et ils s'accumulent d'un test à l'autre.
export async function expireAllRefreshTokens() {
  await prisma.refreshToken.updateMany({
    where: { revoked: false },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
}
