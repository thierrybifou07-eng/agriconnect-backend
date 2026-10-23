import 'dotenv/config';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import pkg from '@prisma/client';

if (process.env.NODE_ENV === 'production') {
  throw new Error('Le seed de démonstration est interdit en production.');
}

const { PrismaClient } = pkg;
const prisma = new PrismaClient();
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const demoPassword = 'Demo@2026x';
const capabilities = [
  'BUYER_SUPPORT',
  'SUPPLIER_SUPPORT',
  'LISTING_MANAGEMENT',
  'ORDER_PROCESSING',
  'STOCK_VALIDATION',
  'PAYMENT_FOLLOWUP',
  'DISPATCH_COORDINATION',
  'USER_VERIFICATION',
  'DISPUTE_HANDLING',
];

function seedBaseData() {
  const result = spawnSync(process.execPath, [join(scriptDirectory, 'seed.js')], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Le seed de base a échoué (code ${result.status ?? 'inconnu'}).`);
  }
}

async function lookupId(model, code) {
  const row = await prisma[model].findUnique({ where: { code }, select: { id: true } });
  if (!row) throw new Error(`Référentiel manquant après seed : ${model}.${code}`);
  return row.id;
}

async function seedCatalog() {
  const categories = await Promise.all([
    prisma.productCategory.upsert({
      where: { code: 'DEMO_CEREALES' },
      update: { label: 'Céréales démo', isActive: true },
      create: { code: 'DEMO_CEREALES', label: 'Céréales démo', isActive: true },
    }),
    prisma.productCategory.upsert({
      where: { code: 'DEMO_LEGUMES' },
      update: { label: 'Légumes démo', isActive: true },
      create: { code: 'DEMO_LEGUMES', label: 'Légumes démo', isActive: true },
    }),
    prisma.productCategory.upsert({
      where: { code: 'DEMO_FRUITS' },
      update: { label: 'Fruits démo', isActive: true },
      create: { code: 'DEMO_FRUITS', label: 'Fruits démo', isActive: true },
    }),
  ]);
  const units = await Promise.all([
    prisma.unit.upsert({
      where: { code: 'DEMO_KG' },
      update: { label: 'Kilogramme démo' },
      create: { code: 'DEMO_KG', label: 'Kilogramme démo' },
    }),
    prisma.unit.upsert({
      where: { code: 'DEMO_CRATE' },
      update: { label: 'Caisse démo' },
      create: { code: 'DEMO_CRATE', label: 'Caisse démo' },
    }),
    prisma.unit.upsert({
      where: { code: 'DEMO_BAG' },
      update: { label: 'Sac démo' },
      create: { code: 'DEMO_BAG', label: 'Sac démo' },
    }),
  ]);

  const products = await Promise.all([
    prisma.product.upsert({
      where: { categoryId_name: { categoryId: categories[0].id, name: 'Maïs démo' } },
      update: { unitId: units[0].id, isActive: true, isPerishable: false },
      create: {
        categoryId: categories[0].id,
        unitId: units[0].id,
        name: 'Maïs démo',
        description: 'Produit de démonstration non périssable.',
        isPerishable: false,
        isActive: true,
      },
    }),
    prisma.product.upsert({
      where: { categoryId_name: { categoryId: categories[1].id, name: 'Tomate démo' } },
      update: { unitId: units[1].id, isActive: true, isPerishable: true },
      create: {
        categoryId: categories[1].id,
        unitId: units[1].id,
        name: 'Tomate démo',
        description: 'Produit périssable de démonstration.',
        isPerishable: true,
        isActive: true,
      },
    }),
    prisma.product.upsert({
      where: { categoryId_name: { categoryId: categories[2].id, name: 'Mangue démo' } },
      update: { unitId: units[2].id, isActive: true, isPerishable: true },
      create: {
        categoryId: categories[2].id,
        unitId: units[2].id,
        name: 'Mangue démo',
        description: 'Produit de démonstration.',
        isPerishable: true,
        isActive: true,
      },
    }),
  ]);
  return { products };
}

async function upsertUser({
  email,
  phone,
  firstname,
  lastname,
  role,
  profileVerificationStatus = 'UNVERIFIED',
}) {
  const [roleId, userStatusId, password] = await Promise.all([
    lookupId('role', role),
    lookupId('userStatus', 'ACTIVE'),
    bcrypt.hash(demoPassword, 10),
  ]);
  return prisma.user.upsert({
    where: { email },
    update: {
      firstname,
      lastname,
      phone,
      password,
      roleId,
      userStatusId,
      profileVerificationStatus,
      referralCode: `DEMO${createHash('sha256').update(email).digest('hex').slice(0, 16).toUpperCase()}`,
    },
    create: {
      email,
      phone,
      firstname,
      lastname,
      password,
      roleId,
      userStatusId,
      profileVerificationStatus,
      referralCode: `DEMO${createHash('sha256').update(email).digest('hex').slice(0, 16).toUpperCase()}`,
    },
  });
}

async function setCapabilities(agentId, codes) {
  const rows = await prisma.agentCapability.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true },
  });
  if (rows.length !== codes.length) {
    throw new Error(`Capacités manquantes : ${codes.filter((code) => !rows.some((row) => row.code === code)).join(', ')}`);
  }
  await prisma.agentCapabilityLink.deleteMany({ where: { agentId } });
  await prisma.agentCapabilityLink.createMany({
    data: rows.map(({ id }) => ({ agentId, capabilityId: id })),
  });
}

async function seedAccounts(zoneId, agencyId) {
  const accounts = await Promise.all([
    upsertUser({
      email: 'admin@demo.agriconnect.test',
      phone: '+237690000001',
      firstname: 'Demo',
      lastname: 'Admin',
      role: 'ADMIN',
    }),
    upsertUser({
      email: 'agent.complet@demo.agriconnect.test',
      phone: '+237690000002',
      firstname: 'Amina',
      lastname: 'Agent',
      role: 'AGENT',
    }),
    upsertUser({
      email: 'agent.support@demo.agriconnect.test',
      phone: '+237690000003',
      firstname: 'Samuel',
      lastname: 'Support',
      role: 'AGENT',
    }),
    upsertUser({
      email: 'livreur@demo.agriconnect.test',
      phone: '+237690000004',
      firstname: 'Paul',
      lastname: 'Livreur',
      role: 'DRIVER',
    }),
    upsertUser({
      email: 'fournisseur.verifie@demo.agriconnect.test',
      phone: '+237690000005',
      firstname: 'Marie',
      lastname: 'Fournisseur',
      role: 'SUPPLIER',
      profileVerificationStatus: 'VERIFIED',
    }),
    upsertUser({
      email: 'fournisseur.nonverifie@demo.agriconnect.test',
      phone: '+237690000006',
      firstname: 'Jean',
      lastname: 'Fournisseur',
      role: 'SUPPLIER',
    }),
    upsertUser({
      email: 'acheteur.verifie@demo.agriconnect.test',
      phone: '+237690000007',
      firstname: 'Claire',
      lastname: 'Acheteur',
      role: 'BUYER',
      profileVerificationStatus: 'VERIFIED',
    }),
    upsertUser({
      email: 'acheteur.nonverifie@demo.agriconnect.test',
      phone: '+237690000008',
      firstname: 'David',
      lastname: 'Acheteur',
      role: 'BUYER',
    }),
  ]);
  const [
    admin,
    fullAgentUser,
    supportAgentUser,
    driver,
    verifiedSupplier,
    unverifiedSupplier,
    verifiedBuyer,
    unverifiedBuyer,
  ] = accounts;

  await Promise.all([
    prisma.supplierProfile.upsert({
      where: { userId: verifiedSupplier.id },
      update: { farmName: 'Ferme Démo Yaoundé', zoneId },
      create: { userId: verifiedSupplier.id, farmName: 'Ferme Démo Yaoundé', zoneId },
    }),
    prisma.supplierProfile.upsert({
      where: { userId: unverifiedSupplier.id },
      update: { farmName: 'Ferme Démo Non Vérifiée', zoneId },
      create: { userId: unverifiedSupplier.id, farmName: 'Ferme Démo Non Vérifiée', zoneId },
    }),
    prisma.buyerProfile.upsert({
      where: { userId: verifiedBuyer.id },
      update: { buyerType: 'RETAILER', businessName: 'Acheteur démo vérifié', zoneId },
      create: { userId: verifiedBuyer.id, buyerType: 'RETAILER', businessName: 'Acheteur démo vérifié', zoneId },
    }),
    prisma.buyerProfile.upsert({
      where: { userId: unverifiedBuyer.id },
      update: { buyerType: 'FARMER', businessName: 'Acheteur démo non vérifié', zoneId },
      create: { userId: unverifiedBuyer.id, buyerType: 'FARMER', businessName: 'Acheteur démo non vérifié', zoneId },
    }),
    prisma.driverProfile.upsert({
      where: { userId: driver.id },
      update: { agencyId, vehicleType: 'Moto', plateNumber: 'DEMO-001' },
      create: { userId: driver.id, agencyId, vehicleType: 'Moto', plateNumber: 'DEMO-001' },
    }),
  ]);

  const fullAgent = await prisma.agent.upsert({
    where: { userId: fullAgentUser.id },
    update: { displayName: 'Agent complet Démo', kind: 'HUMAN', isActive: true, autonomy: null },
    create: { userId: fullAgentUser.id, displayName: 'Agent complet Démo', kind: 'HUMAN', isActive: true },
  });
  const supportAgent = await prisma.agent.upsert({
    where: { userId: supportAgentUser.id },
    update: { displayName: 'Agent support Démo', kind: 'HUMAN', isActive: true, autonomy: null },
    create: { userId: supportAgentUser.id, displayName: 'Agent support Démo', kind: 'HUMAN', isActive: true },
  });
  await setCapabilities(fullAgent.id, capabilities);
  await setCapabilities(supportAgent.id, ['BUYER_SUPPORT']);

  let aiAgent = await prisma.agent.findFirst({
    where: { kind: 'AI', displayName: 'Assistant IA (local)' },
    select: { id: true },
  });
  const aiData = {
    displayName: 'Assistant IA (local)',
    kind: 'AI',
    userId: null,
    aiProvider: 'ollama',
    aiModel: process.env.OLLAMA_MODEL || 'granite',
    autonomy: 'SUGGEST_ONLY',
    isActive: true,
  };
  aiAgent = aiAgent
    ? await prisma.agent.update({ where: { id: aiAgent.id }, data: aiData })
    : await prisma.agent.create({ data: aiData });
  await setCapabilities(aiAgent.id, ['BUYER_SUPPORT', 'SUPPLIER_SUPPORT', 'LISTING_MANAGEMENT']);

  return { admin, fullAgent, verifiedSupplier, verifiedBuyer };
}

async function seedDemoData() {
  const zone = await prisma.zone.upsert({
    where: { name: 'Yaoundé Centre' },
    update: { city: 'Yaoundé', region: 'Centre', isActive: true },
    create: { name: 'Yaoundé Centre', city: 'Yaoundé', region: 'Centre', isActive: true },
  });

  const hubData = {
    name: 'Hub Yaoundé Centre Démo',
    address: 'Avenue Kennedy, Yaoundé',
    city: 'Yaoundé',
    latitude: 3.8667,
    longitude: 11.5167,
    zoneId: zone.id,
    acceptsDropoff: true,
    acceptsPickup: true,
    isActive: true,
  };
  const existingHub = await prisma.hub.findFirst({ where: { name: hubData.name } });
  const hub = existingHub
    ? await prisma.hub.update({ where: { id: existingHub.id }, data: hubData })
    : await prisma.hub.create({ data: hubData });

  const agency = await prisma.transportAgency.upsert({
    where: { name: 'Agence Démo Yaoundé' },
    update: {
      contactName: 'Contact Démo',
      phone: '+237690000009',
      email: 'agence@demo.agriconnect.test',
      insuranceProvider: 'Assurance Démo',
      insurancePolicyNumber: 'DEMO-POLICY-001',
      insuranceExpiresAt: new Date('2030-12-31T23:59:59.000Z'),
      isActive: true,
    },
    create: {
      name: 'Agence Démo Yaoundé',
      contactName: 'Contact Démo',
      phone: '+237690000009',
      email: 'agence@demo.agriconnect.test',
      insuranceProvider: 'Assurance Démo',
      insurancePolicyNumber: 'DEMO-POLICY-001',
      insuranceExpiresAt: new Date('2030-12-31T23:59:59.000Z'),
      isActive: true,
    },
  });
  await prisma.agencyZone.upsert({
    where: { agencyId_zoneId: { agencyId: agency.id, zoneId: zone.id } },
    update: { baseFee: 500, perKmFee: 100, isActive: true },
    create: { agencyId: agency.id, zoneId: zone.id, baseFee: 500, perKmFee: 100, isActive: true },
  });

  await prisma.platformSetting.upsert({
    where: { id: 1 },
    update: {
      supplierCommissionRate: 0.1,
      reservationHours: 48,
      expiryCompensationRate: 0.5,
      buyerFeeType: 'NONE',
      buyerFeeValue: 0,
    },
    create: {
      id: 1,
      supplierCommissionRate: 0.1,
      reservationHours: 48,
      expiryCompensationRate: 0.5,
      buyerFeeType: 'NONE',
      buyerFeeValue: 0,
    },
  });

  const { products } = await seedCatalog();
  const { admin, fullAgent, verifiedSupplier, verifiedBuyer } = await seedAccounts(zone.id, agency.id);
  const supplierProfile = await prisma.supplierProfile.findUnique({ where: { userId: verifiedSupplier.id } });
  const availableLot = await prisma.stockLot.upsert({
    where: { lotCode: 'LOT-DEMO-AVAILABLE' },
    update: {
      supplierId: supplierProfile.id,
      productId: products[1].id,
      zoneId: zone.id,
      hubId: hub.id,
      storageType: 'HUB',
      agreedUnitPrice: 1000,
      quantityInitial: 100,
      quantityAvailable: 100,
      status: 'AVAILABLE',
      expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    },
    create: {
      lotCode: 'LOT-DEMO-AVAILABLE',
      supplierId: supplierProfile.id,
      productId: products[1].id,
      zoneId: zone.id,
      hubId: hub.id,
      storageType: 'HUB',
      agreedUnitPrice: 1000,
      quantityInitial: 100,
      quantityAvailable: 100,
      status: 'AVAILABLE',
      expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    },
  });
  const activeStatusId = await lookupId('listingStatus', 'ACTIVE');
  const listing = await prisma.listing.upsert({
    where: { reference: 'ANN-DEMO-0001' },
    update: {
      title: 'Tomates fraîches — Yaoundé Centre',
      description: 'Annonce de démonstration AgriConnect.',
      unitPrice: 1500,
      productId: products[1].id,
      zoneId: zone.id,
      statusId: activeStatusId,
      publishedAt: new Date(),
      createdByUserId: admin.id,
      createdByAgentId: fullAgent.id,
    },
    create: {
      reference: 'ANN-DEMO-0001',
      title: 'Tomates fraîches — Yaoundé Centre',
      description: 'Annonce de démonstration AgriConnect.',
      unitPrice: 1500,
      productId: products[1].id,
      zoneId: zone.id,
      statusId: activeStatusId,
      publishedAt: new Date(),
      createdByUserId: admin.id,
      createdByAgentId: fullAgent.id,
    },
  });
  await prisma.listingLot.upsert({
    where: { listingId_lotId: { listingId: listing.id, lotId: availableLot.id } },
    update: {},
    create: { listingId: listing.id, lotId: availableLot.id },
  });

  let conversation = await prisma.conversation.findFirst({
    where: { customerId: verifiedBuyer.id, listingId: listing.id },
    select: { id: true },
  });
  conversation = conversation
    ? await prisma.conversation.update({
      where: { id: conversation.id },
      data: { type: 'BUYER_SUPPORT', status: 'OPEN', subject: 'Question sur les tomates démo' },
    })
    : await prisma.conversation.create({
      data: {
        customerId: verifiedBuyer.id,
        listingId: listing.id,
        type: 'BUYER_SUPPORT',
        subject: 'Question sur les tomates démo',
      },
    });
  const existingMessage = await prisma.message.findFirst({
    where: {
      conversationId: conversation.id,
      senderUserId: verifiedBuyer.id,
      content: 'Bonjour, ce lot est-il disponible au hub de Yaoundé ?',
    },
    select: { id: true },
  });
  if (!existingMessage) {
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: 'CUSTOMER',
        senderUserId: verifiedBuyer.id,
        content: 'Bonjour, ce lot est-il disponible au hub de Yaoundé ?',
      },
    });
  }

  console.log('Seed de démonstration terminé.');
}

async function main() {
  seedBaseData();
  await seedDemoData();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
