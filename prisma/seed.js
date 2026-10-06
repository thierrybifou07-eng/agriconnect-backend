import pkg from '@prisma/client';
const { PrismaClient } = pkg;
const prisma = new PrismaClient();

async function main() {
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

  const zone = await prisma.zone.upsert({
    where: { id: '11111111-1111-1111-1111-111111111111' },
    update: {},
    create: {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Zone MVP',
      city: 'Yaoundé',
      region: 'Centre',
      isActive: true,
    },
  });

  const agency = await prisma.transportAgency.upsert({
    where: { id: '22222222-2222-2222-2222-222222222222' },
    update: {},
    create: {
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Agence partenaire MVP',
      contactName: 'AgriConnect',
      phone: '+237600000000',
      isActive: true,
    },
  });

  await prisma.agencyZone.upsert({
    where: {
      agencyId_zoneId: {
        agencyId: agency.id,
        zoneId: zone.id,
      },
    },
    update: {},
    create: {
      agencyId: agency.id,
      zoneId: zone.id,
      baseFee: 1000,
      perKmFee: 200,
      isActive: true,
    },
  });

  await prisma.hub.upsert({
    where: { id: '33333333-3333-3333-3333-333333333333' },
    update: {},
    create: {
      id: '33333333-3333-3333-3333-333333333333',
      name: 'Point de dépôt MVP',
      address: 'Centre-ville',
      city: 'Yaoundé',
      latitude: 3.848,
      longitude: 11.5021,
      zoneId: zone.id,
      acceptsDropoff: true,
      acceptsPickup: true,
      isActive: true,
    },
  });

  const categories = [
    { id: '44444444-4444-4444-4444-444444444444', name: 'Céréales' },
    { id: '55555555-5555-5555-5555-555555555555', name: 'Légumes' },
    { id: '66666666-6666-6666-6666-666666666666', name: 'Fruits' },
    { id: '77777777-7777-7777-7777-777777777777', name: 'Tubercules' },
  ];

  for (const category of categories) {
    await prisma.productCategory.upsert({
      where: { id: category.id },
      update: {},
      create: category,
    });
  }

  const products = [
    {
      id: '88888888-8888-8888-8888-888888888888',
      categoryId: categories[0].id,
      name: 'Maïs',
      unit: 'KG',
      description: 'Maïs sec',
      isPerishable: false,
      isActive: true,
    },
    {
      id: '99999999-9999-9999-9999-999999999999',
      categoryId: categories[1].id,
      name: 'Tomates',
      unit: 'KG',
      description: 'Tomates fraîches',
      isPerishable: true,
      isActive: true,
    },
    {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      categoryId: categories[2].id,
      name: 'Mangues',
      unit: 'KG',
      description: 'Mangues mûres',
      isPerishable: true,
      isActive: true,
    },
    {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      categoryId: categories[3].id,
      name: 'Igname',
      unit: 'KG',
      description: 'Igname fraîche',
      isPerishable: true,
      isActive: true,
    },
  ];

  for (const product of products) {
    await prisma.product.upsert({
      where: {
        categoryId_name: {
          categoryId: product.categoryId,
          name: product.name,
        },
      },
      update: {},
      create: product,
    });
  }

  console.log('Seed v2 terminé : PlatformSetting, zone, agence, hub, catégories et produits créés.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
