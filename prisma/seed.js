import pkg from '@prisma/client';
const { PrismaClient } = pkg;
const prisma = new PrismaClient();

async function upsertByCode(model, rows) {
  for (const row of rows) {
    await prisma[model].upsert({ where: { code: row.code }, update: {}, create: row });
  }
}

async function main() {
  await upsertByCode('role', [
    { code: 'ROOT', label: 'Super-administrateur', level: 100 },
    { code: 'ADMIN', label: 'Administrateur', level: 50 },
    { code: 'AGENT', label: 'Agent AgriConnect', level: 30 },
    { code: 'SUPPLIER', label: 'Fournisseur', level: 10 },
    { code: 'BUYER', label: 'Acheteur', level: 10 },
    { code: 'DRIVER', label: 'Livreur', level: 10 },
  ]);

  await upsertByCode('userStatus', [
    { code: 'ACTIVE', label: 'Actif' },
    { code: 'SUSPENDED', label: 'Suspendu' },
  ]);

  // listingStatus et listingCategory n'existent plus dans le schéma v2
  // (remplacés par ProductCategory ; les statuts d'annonce arrivent avec P2.5).

  await upsertByCode('productCategory', [
    { code: 'CEREALES', label: 'Céréales' },
    { code: 'LEGUMES', label: 'Légumes' },
    { code: 'FRUITS', label: 'Fruits' },
    { code: 'TUBERCULES', label: 'Tubercules' },
    { code: 'ELEVAGE', label: 'Élevage' },
    { code: 'AUTRE', label: 'Autre' },
  ]);

  await upsertByCode('unit', [
    { code: 'KG', label: 'Kilogramme' },
    { code: 'TON', label: 'Tonne' },
    { code: 'BAG', label: 'Sac' },
    { code: 'CRATE', label: 'Caisse' },
    { code: 'PIECE', label: 'Pièce' },
    { code: 'LITER', label: 'Litre' },
    { code: 'BUNCH', label: 'Botte' },
  ]);

  await upsertByCode('agentCapability', [
    { code: 'BUYER_SUPPORT', label: 'Support acheteur' },
    { code: 'SUPPLIER_SUPPORT', label: 'Support fournisseur' },
    { code: 'LISTING_MANAGEMENT', label: 'Gestion des annonces' },
    { code: 'ORDER_PROCESSING', label: 'Traitement des commandes' },
    { code: 'STOCK_VALIDATION', label: 'Validation des stocks' },
    { code: 'PAYMENT_FOLLOWUP', label: 'Suivi des paiements' },
    { code: 'DISPATCH_COORDINATION', label: 'Coordination des expéditions' },
    { code: 'USER_VERIFICATION', label: 'Vérification des utilisateurs' },
    { code: 'DISPUTE_HANDLING', label: 'Gestion des litiges' },
  ]);

  // Les lignes PICKUP/DELIVERY ont été renommées HUB_PICKUP/AGENCY_DELIVERY
  // par la migration v2_domain (mêmes ids).
  await upsertByCode('deliveryMode', [
    { code: 'HUB_PICKUP', label: 'Retrait en point de dépôt' },
    { code: 'AGENCY_DELIVERY', label: "Livraison par l'agence" },
  ]);

  await upsertByCode('mediaType', [
    { code: 'IMAGE', label: 'Image' },
    { code: 'VIDEO', label: 'Vidéo' },
    { code: 'DOCUMENT', label: 'Document' },
  ]);

  const imageType = await prisma.mediaType.findUnique({ where: { code: 'IMAGE' } });
  const videoType = await prisma.mediaType.findUnique({ where: { code: 'VIDEO' } });
  const documentType = await prisma.mediaType.findUnique({ where: { code: 'DOCUMENT' } });

  await upsertByCode('mimeType', [
    { code: 'image/jpeg', extension: '.jpg', mediaTypeId: imageType.id },
    { code: 'image/png', extension: '.png', mediaTypeId: imageType.id },
    { code: 'image/webp', extension: '.webp', mediaTypeId: imageType.id },
    { code: 'video/mp4', extension: '.mp4', mediaTypeId: videoType.id },
    { code: 'application/pdf', extension: '.pdf', mediaTypeId: documentType.id },
  ]);

  // Réglages plateforme : ligne unique (id = 1), valeurs par défaut du schéma.
  // Les taux sont figés sur chaque OrderItem à la commande : ne pas les
  // modifier à la légère.
  await prisma.platformSetting.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      currency: 'XAF',
      supplierCommissionRate: 0,
      buyerFeeType: 'NONE',
      buyerFeeValue: 0,
      transportMarkupRate: 0,
      referralBuyerReward: 5000,
      referralSupplierReward: 10000,
      reservationHours: 24,
      expiryCompensationRate: 1,
    },
  });

  // CGU versionnées FR/EN (P1.1) : voir prisma/seed-data/legal.js
  const { seedLegalDocuments } = await import('./seed-data/legal.js');
  await seedLegalDocuments();

  console.log('Seed terminé : rôles, statuts, catégories, unités, capacités, modes de livraison, réglages et CGU créés.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
