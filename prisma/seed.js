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
    { code: 'FARMER', label: 'Agriculteur', level: 10 },
    { code: 'BUYER', label: 'Acheteur', level: 10 },
    { code: 'DRIVER', label: 'Livreur', level: 10 },
    { code: 'ADMIN', label: 'Administrateur', level: 50 },
    { code: 'ROOT', label: 'Super-administrateur', level: 100 },
  ]);

  await upsertByCode('userStatus', [
    { code: 'ACTIVE', label: 'Actif' },
    { code: 'SUSPENDED', label: 'Suspendu' },
  ]);

  await upsertByCode('listingStatus', [
    { code: 'ACTIVE', label: 'Active' },
    { code: 'SOLD', label: 'Vendue' },
    { code: 'INACTIVE', label: 'Inactive' },
  ]);

  await upsertByCode('listingCategory', [
    { code: 'CEREALES', label: 'Céréales' },
    { code: 'LEGUMES', label: 'Légumes' },
    { code: 'FRUITS', label: 'Fruits' },
    { code: 'TUBERCULES', label: 'Tubercules' },
    { code: 'ELEVAGE', label: 'Élevage' },
    { code: 'AUTRE', label: 'Autre' },
  ]);

  await upsertByCode('deliveryMode', [
    { code: 'PICKUP', label: 'Retrait sur place' },
    { code: 'DELIVERY', label: 'Livraison' },
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

  console.log('Seed terminé : rôles, statuts, catégories et types de médias créés.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
