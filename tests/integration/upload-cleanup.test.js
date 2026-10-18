import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import prisma from '../../src/config/prisma.js';
import { UPLOADS_ROOT, deleteFile } from '../../src/services/storage.service.js';
import { listFilesOnDisk } from '../../scripts/cleanup-orphan-uploads.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

// Les fichiers vivent en dehors de la transaction qui les référence : un
// rollback annule la base, jamais le disque. Ces tests vérifient les deux
// moitiés du contrat — compensation à l'échec, nettoyage à la suppression — et
// le cas piège : une photo partagée entre un lot et son annonce.

const client = api();

const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FAKE_PDF = Buffer.from('%PDF-1.4 factice');
const DANS_7_JOURS = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

// Le fichier est-il présent sur le disque ? (le sous-dossier fait partie du
// publicId, le chemin est donc relatif à UPLOADS_ROOT)
const existe = (publicId) => readFile(join(UPLOADS_ROOT, publicId)).then(() => true, () => false);

// Ces tests écrivent dans le vrai dossier uploads/ (UPLOADS_DIR n'est pas posé
// en test) : on note ce qui s'y trouve avant chaque cas et on efface tout ce qui
// a été ajouté, pour ne pas laisser d'orphelin derrière la suite.
let fichiersAvantTest = new Set();

async function snapshotUploads() {
  const fichiers = await listFilesOnDisk(UPLOADS_ROOT);
  return new Set(fichiers.map((fichier) => fichier.publicId));
}

afterEach(async () => {
  vi.restoreAllMocks();
  const ajoutes = (await listFilesOnDisk(UPLOADS_ROOT))
    .map((fichier) => fichier.publicId)
    .filter((publicId) => !fichiersAvantTest.has(publicId));
  for (const publicId of ajoutes) {
    await deleteFile(publicId);
  }
});

// --- Fixtures ---

function tokenPour(user, role) {
  return generateToken({ id: user.id, role });
}

async function fournisseur({ verifie = false } = {}) {
  const user = await createUser({ role: 'SUPPLIER' });
  if (verifie) {
    await prisma.user.update({
      where: { id: user.id },
      data: { profileVerificationStatus: 'VERIFIED' },
    });
  }
  await prisma.supplierProfile.create({ data: { userId: user.id, farmName: 'Ferme du Test' } });
  return user;
}

async function createAgentUser({ capabilities = [] } = {}) {
  const user = await createUser({ role: 'AGENT' });
  const agent = await prisma.agent.create({
    data: { kind: 'HUMAN', userId: user.id, displayName: 'Agent Test', isActive: true },
  });
  const rows = await prisma.agentCapability.findMany({
    where: { code: { in: capabilities } },
    select: { id: true },
  });
  await prisma.agentCapabilityLink.createMany({
    data: rows.map((row) => ({ agentId: agent.id, capabilityId: row.id })),
  });
  return user;
}

async function produit({ perissable = true } = {}) {
  const [category, unit] = await Promise.all([
    prisma.productCategory.findFirst(),
    prisma.unit.findFirst(),
  ]);
  return prisma.product.create({
    data: {
      categoryId: category.id,
      unitId: unit.id,
      name: `Produit test ${Date.now()}-${randomInt(1_000, 9_999)}`,
      isPerishable: perissable,
    },
  });
}

async function zone() {
  return prisma.zone.create({ data: { name: `Zone test ${Date.now()}-${randomInt(1_000, 9_999)}` } });
}

function champsBase(product, z) {
  return {
    productId: product.id,
    zoneId: z.id,
    agreedUnitPrice: '1250.50',
    quantity: '1500',
    storageType: 'SUPPLIER_SITE',
    pickupAddress: '12 route de la ferme',
    pickupLatitude: '12.34',
    pickupLongitude: '-5.67',
    expiresAt: DANS_7_JOURS,
  };
}

async function declarerLot(token, champs, images = []) {
  let requete = client.post('/api/v2/supplier/lots').set(authHeader(token));
  for (const [cle, valeur] of Object.entries(champs)) {
    requete = requete.field(cle, String(valeur));
  }
  images.forEach((buffer, i) => {
    const jpeg = i % 2 === 0;
    requete = requete.attach('images', buffer, {
      filename: `photo${i + 1}.${jpeg ? 'jpg' : 'png'}`,
      contentType: jpeg ? 'image/jpeg' : 'image/png',
    });
  });
  return requete;
}

async function declarerLotValide(agent, supplier, images = []) {
  const prod = await produit();
  const z = await zone();
  const res = await declarerLot(tokenPour(supplier, 'SUPPLIER'), champsBase(prod, z), images);
  expect(res.status, res.text).toBe(201);
  const validation = await client
    .post(`/api/v2/staff/lots/${res.body.id}/validate`)
    .set(authHeader(tokenPour(agent, 'AGENT')))
    .send({ reason: 'Qualité conforme' });
  expect(validation.status, validation.text).toBe(200);
  return res.body;
}

// Remplace prisma.$transaction par un tx qui ne touche à rien et qui échoue à
// la N-ième écriture : les fichiers, eux, sont réellement écrits avant l'échec,
// exactement comme en production. Le spy est restauré dans le finally — un spy
// Prisma survit à vi.restoreAllMocks et casserait le reset de base des tests
// suivants.
async function avecTransactionQuiEchoue(fauxTx, requete) {
  const journal = vi.spyOn(console, 'error').mockImplementation(() => {});
  const transactionReelle = prisma.$transaction;
  prisma.$transaction = async (callback) => callback(fauxTx);
  try {
    return await requete();
  } finally {
    prisma.$transaction = transactionReelle;
    journal.mockRestore();
  }
}

describe('Échec de transaction — aucun fichier écrit ne doit subsister', () => {
  it('POST /supplier/lots : les photos écrites avant l\'échec sont supprimées', async () => {
    fichiersAvantTest = await snapshotUploads();
    const supplier = await fournisseur();
    const token = tokenPour(supplier, 'SUPPLIER');
    const prod = await produit();
    const z = await zone();

    // La première ligne Media passe, la seconde échoue : DEUX fichiers ont donc
    // été écrits sur disque avant le rollback.
    let appels = 0;
    const fauxTx = {
      stockLot: {
        create: vi.fn().mockResolvedValue({ id: 424242 }),
        update: vi.fn().mockResolvedValue({ id: 424242 }),
      },
      media: {
        create: vi.fn().mockImplementation(async () => {
          appels += 1;
          if (appels === 2) throw new Error('Échec simulé de la transaction');
          return { id: appels };
        }),
      },
    };

    const res = await avecTransactionQuiEchoue(
      fauxTx,
      () => declarerLot(token, champsBase(prod, z), [FAKE_JPEG, FAKE_PNG])
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Échec simulé de la transaction');
    // Les deux fichiers ont bien été écrits avant que la transaction n'échoue.
    expect(appels).toBe(2);

    // Rien en base : le lot n'a jamais existé.
    expect(await prisma.stockLot.count({ where: { supplier: { userId: supplier.id } } })).toBe(0);

    // Et rien sur le disque : uploads/ est strictement inchangé.
    const apres = (await listFilesOnDisk(UPLOADS_ROOT)).map((fichier) => fichier.publicId);
    expect(apres.filter((publicId) => !fichiersAvantTest.has(publicId))).toEqual([]);
  });

  it('POST /staff/lots : les photos écrites avant l\'échec sont supprimées', async () => {
    fichiersAvantTest = await snapshotUploads();
    const agent = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });
    const supplier = await fournisseur();
    const prod = await produit();
    const z = await zone();

    const fauxTx = {
      stockLot: {
        create: vi.fn().mockResolvedValue({ id: 424243 }),
        update: vi.fn().mockResolvedValue({ id: 424243 }),
      },
      media: { create: vi.fn().mockRejectedValue(new Error('Échec simulé de la transaction')) },
    };

    const res = await avecTransactionQuiEchoue(
      fauxTx,
      () =>
        client
          .post('/api/v2/staff/lots')
          .set(authHeader(tokenPour(agent, 'AGENT')))
          .field('supplierUserId', String(supplier.id))
          .field('productId', String(prod.id))
          .field('zoneId', String(z.id))
          .field('agreedUnitPrice', '1250.50')
          .field('quantity', '1500')
          .field('storageType', 'SUPPLIER_SITE')
          .field('pickupAddress', '12 route de la ferme')
          .field('pickupLatitude', '12.34')
          .field('pickupLongitude', '-5.67')
          .field('expiresAt', DANS_7_JOURS)
          .attach('images', FAKE_JPEG, { filename: 'photo1.jpg', contentType: 'image/jpeg' })
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Échec simulé de la transaction');

    const apres = (await listFilesOnDisk(UPLOADS_ROOT)).map((fichier) => fichier.publicId);
    expect(apres.filter((publicId) => !fichiersAvantTest.has(publicId))).toEqual([]);
  });

  it('POST /staff/listings : les photos écrites avant l\'échec sont supprimées', async () => {
    fichiersAvantTest = await snapshotUploads();
    const agent = await createAgentUser({
      capabilities: ['STOCK_VALIDATION', 'LISTING_MANAGEMENT'],
    });
    const supplier = await fournisseur({ verifie: true });
    const lot = await declarerLotValide(agent, supplier);

    const fauxTx = {
      listing: {
        create: vi.fn().mockResolvedValue({ id: 424244 }),
        update: vi.fn().mockResolvedValue({ id: 424244 }),
      },
      listingLot: { create: vi.fn().mockResolvedValue({ id: 424244 }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 424244 }) },
      media: { create: vi.fn().mockRejectedValue(new Error('Échec simulé de la transaction')) },
    };

    const res = await avecTransactionQuiEchoue(
      fauxTx,
      () =>
        client
          .post('/api/v2/staff/listings')
          .set(authHeader(tokenPour(agent, 'AGENT')))
          // lotIds est un tableau : en multipart il arrive sous la forme
          // lotIds[]=42, que multer reconstitue en tableau.
          .field('lotIds[]', String(lot.id))
          .field('title', 'Annonce qui échoue')
          .attach('images', FAKE_JPEG, { filename: 'photo1.jpg', contentType: 'image/jpeg' })
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Échec simulé de la transaction');
    expect(await prisma.listing.count()).toBe(0);

    const apres = (await listFilesOnDisk(UPLOADS_ROOT)).map((fichier) => fichier.publicId);
    expect(apres.filter((publicId) => !fichiersAvantTest.has(publicId))).toEqual([]);
  });

  it('POST /auth/me/documents : le document écrit avant l\'échec est supprimé', async () => {
    fichiersAvantTest = await snapshotUploads();
    const user = await createUser({ role: 'BUYER' });
    const token = tokenPour(user, 'BUYER');

    const fauxTx = {
      verificationDocument: { create: vi.fn().mockResolvedValue({ id: 424245 }) },
      user: {
        findUnique: vi.fn().mockResolvedValue({ profileVerificationStatus: 'UNVERIFIED' }),
        update: vi.fn().mockResolvedValue({}),
      },
      media: { create: vi.fn().mockRejectedValue(new Error('Échec simulé de la transaction')) },
    };

    const res = await avecTransactionQuiEchoue(
      fauxTx,
      () =>
        client
          .post('/api/v2/auth/me/documents')
          .set(authHeader(token))
          .field('type', 'ID_CARD')
          .attach('file', FAKE_PDF, { filename: 'doc.pdf', contentType: 'application/pdf' })
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Échec simulé de la transaction');
    expect(await prisma.verificationDocument.count()).toBe(0);

    const apres = (await listFilesOnDisk(UPLOADS_ROOT)).map((fichier) => fichier.publicId);
    expect(apres.filter((publicId) => !fichiersAvantTest.has(publicId))).toEqual([]);
  });
});

describe('DELETE /api/v2/supplier/lots/:id — nettoyage des photos sur disque', () => {
  it('supprime du disque les photos qui ne sont plus référencées', async () => {
    fichiersAvantTest = await snapshotUploads();
    const supplier = await fournisseur();
    const token = tokenPour(supplier, 'SUPPLIER');
    const prod = await produit();
    const z = await zone();

    const res = await declarerLot(token, champsBase(prod, z), [FAKE_JPEG, FAKE_PNG]);
    expect(res.status, res.text).toBe(201);
    const medias = await prisma.media.findMany({ where: { ownerLotId: res.body.id } });
    expect(medias).toHaveLength(2);
    for (const media of medias) expect(await existe(media.publicId)).toBe(true);

    const suppression = await client
      .delete(`/api/v2/supplier/lots/${res.body.id}`)
      .set(authHeader(token));
    expect(suppression.status, suppression.text).toBe(204);

    // Lignes Media supprimées en cascade, fichiers supprimés après le commit.
    expect(await prisma.media.findMany({ where: { ownerLotId: res.body.id } })).toHaveLength(0);
    for (const media of medias) {
      expect(await existe(media.publicId)).toBe(false);
    }
  });

  it('conserve le fichier tant qu\'une annonce partage la photo du lot', async () => {
    fichiersAvantTest = await snapshotUploads();
    const agent = await createAgentUser({
      capabilities: ['STOCK_VALIDATION', 'LISTING_MANAGEMENT'],
    });
    const supplier = await fournisseur({ verifie: true });
    const lot = await declarerLotValide(agent, supplier, [FAKE_JPEG]);

    const [photoLot] = await prisma.media.findMany({ where: { ownerLotId: lot.id } });
    expect(await existe(photoLot.publicId)).toBe(true);

    // Annonce créée SANS photo : elle copie la photo du lot avec le même
    // publicId, donc deux lignes Media référencent désormais le même fichier.
    const annonce = await client
      .post('/api/v2/staff/listings')
      .set(authHeader(tokenPour(agent, 'AGENT')))
      .send({ lotIds: [lot.id], title: 'Maïs jaune de la ferme' });
    expect(annonce.status, annonce.text).toBe(201);
    const photosAnnonce = await prisma.media.findMany({
      where: { ownerListingId: annonce.body.id },
    });
    expect(photosAnnonce).toHaveLength(1);
    expect(photosAnnonce[0].publicId).toBe(photoLot.publicId);

    // Trois raccourcis de fixture, faute de cycle métier qui mène à cet état
    // (un lot listé est AVAILABLE, donc il porte un mouvement de stock et un
    // lien d'annonce qui l'empêchent d'être supprimé) :
    //  - ListingLot.lotId et StockMovement.lotId ne sont PAS en cascade ;
    //  - le fournisseur ne supprime qu'un lot PENDING_VALIDATION ou REJECTED.
    // Ce qui est vérifié ici est la répartition des fichiers, pas le cycle de
    // vie du lot.
    await prisma.listingLot.deleteMany({ where: { lotId: lot.id } });
    await prisma.stockMovement.deleteMany({ where: { lotId: lot.id } });
    await prisma.stockLot.update({
      where: { id: lot.id },
      data: { status: 'REJECTED', rejectionReason: 'Rejet de la fixture' },
    });

    const suppression = await client
      .delete(`/api/v2/supplier/lots/${lot.id}`)
      .set(authHeader(tokenPour(supplier, 'SUPPLIER')));
    expect(suppression.status, suppression.text).toBe(204);

    // La ligne du lot a disparu (cascade), celle de l'annonce est toujours là…
    expect(await prisma.media.findMany({ where: { ownerLotId: lot.id } })).toHaveLength(0);
    const restantes = await prisma.media.findMany({ where: { ownerListingId: annonce.body.id } });
    expect(restantes).toHaveLength(1);

    // …donc le fichier partagé est conservé.
    expect(await existe(photoLot.publicId)).toBe(true);
  });
});