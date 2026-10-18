import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomInt } from 'node:crypto';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { commitSale, expireAvailable, reserve } from '../../src/services/stock.service.js';

// --- Mock Cloudinary ---
const { uploadStream } = vi.hoisted(() => ({
  uploadStream: vi.fn(),
}));

vi.mock('cloudinary', () => ({
  v2: {
    config: vi.fn(),
    uploader: { upload_stream: uploadStream },
  },
}));

const client = api();

let numeroImage;
beforeEach(() => {
  numeroImage = 0;
  uploadStream.mockImplementation((options, callback) => ({
    end: () => {
      numeroImage += 1;
      setImmediate(() =>
        callback(null, {
          public_id: `listing_${numeroImage}`,
          secure_url: `https://res.cloudinary.com/test/listing_${numeroImage}`,
        })
      );
    },
  }));
});

function tokenPour(user, role) {
  return generateToken({ id: user.id, role });
}

const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const DANS_7_JOURS = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const HIER = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

// --- Fixtures ---

async function fournisseur({ verifie = false } = {}) {
  const user = await createUser({ role: 'SUPPLIER' });
  if (verifie) {
    await prisma.user.update({
      where: { id: user.id },
      data: { profileVerificationStatus: 'VERIFIED' },
    });
  }
  await prisma.supplierProfile.create({
    data: { userId: user.id, farmName: 'Ferme du Test' },
  });
  return user;
}

async function createAgentUser({ capabilities = [], isActive = true } = {}) {
  const user = await createUser({ role: 'AGENT' });
  const agent = await prisma.agent.create({
    data: { kind: 'HUMAN', userId: user.id, displayName: 'Agent Test', isActive },
  });
  if (capabilities.length > 0) {
    const rows = await prisma.agentCapability.findMany({
      where: { code: { in: capabilities } },
      select: { id: true },
    });
    await prisma.agentCapabilityLink.createMany({
      data: rows.map((row) => ({ agentId: agent.id, capabilityId: row.id })),
    });
  }
  return { user, agent };
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
  return prisma.zone.create({
    data: { name: `Zone test ${Date.now()}-${randomInt(1_000, 9_999)}` },
  });
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
    requete = requete.attach('images', buffer, {
      filename: `photo${i + 1}.jpg`,
      contentType: 'image/jpeg',
    });
  });
  return requete;
}

async function declarentLotSurSite(token, overrides = {}) {
  const prod = await produit();
  const z = await zone();
  const res = await declarerLot(token, { ...champsBase(prod, z), ...overrides });
  expect(res.status, res.text).toBe(201);
  return res;
}

// Crée un agent avec STOCK_VALIDATION (pour valider le lot) et
// LISTING_MANAGEMENT (pour créer l'annonce), un fournisseur vérifié, puis
// déclare et valide un lot : le cas nominal pour tester les annonces.
async function setupAgentEtLot() {
  const { user: agentUser } = await createAgentUser({
    capabilities: ['STOCK_VALIDATION', 'LISTING_MANAGEMENT'],
  });
  const supplier = await fournisseur({ verifie: true });
  const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));
  await client
    .post(`/api/v2/staff/lots/${lotRes.body.id}/validate`)
    .set(authHeader(tokenPour(agentUser, 'AGENT')));
  return { agentUser, supplier, lot: lotRes.body };
}

async function creerAnnonce(agentUser, lotId, overrides = {}) {
  return client
    .post('/api/v2/staff/listings')
    .set(authHeader(tokenPour(agentUser, 'AGENT')))
    .send({ lotIds: [lotId], title: 'Maïs jaune de la ferme', ...overrides });
}

describe('POST /api/v2/staff/listings — création', () => {
  it('crée une annonce DRAFT avec référence ANN-000001, prix et zone du lot', async () => {
    const { agentUser, lot } = await setupAgentEtLot();

    const res = await creerAnnonce(agentUser, lot.id);

    expect(res.status, res.text).toBe(201);
    // L'auto-incrément MySQL ne se réinitialise pas entre les tests : seule
    // la forme de la référence est garantie, pas sa valeur.
    expect(res.body.reference).toMatch(/^ANN-\d{6}$/);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.title).toBe('Maïs jaune de la ferme');
    // Prix public par défaut = prix convenu du lot ; zone par défaut = zone du lot.
    expect(res.body.unitPrice).toBe(1250.5);
    expect(res.body.zone.id).toBe(lot.zone.id);
    expect(res.body.product.id).toBe(lot.product.id);
    expect(res.body.publishedAt).toBeNull();
    expect(res.body.createdByUserId).toBe(agentUser.id);
    // L'acteur est un agent : requireCapability a renseigné req.agent.
    const agent = await prisma.agent.findFirst({ where: { userId: agentUser.id } });
    expect(res.body.createdByAgentId).toBe(agent.id);

    // La ligne ListingLot relie l'annonce à son lot.
    const lien = await prisma.listingLot.findUnique({
      where: { listingId_lotId: { listingId: res.body.id, lotId: lot.id } },
    });
    expect(lien).toBeTruthy();

    // L'audit LISTING_CREATED a été écrit.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'LISTING_CREATED', entityType: 'Listing', entityId: res.body.id },
    });
    expect(audit).toBeTruthy();
    expect(audit.metadata.lotId).toBe(lot.id);
  });

  it('refuse 2 lots : 400 Une annonce correspond à un seul lot', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    const autreFournisseur = await fournisseur({ verifie: true });
    const lot2Res = await declarentLotSurSite(tokenPour(autreFournisseur, 'SUPPLIER'));
    await client
      .post(`/api/v2/staff/lots/${lot2Res.body.id}/validate`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    const res = await creerAnnonce(agentUser, lot.id, { lotIds: [lot.id, lot2Res.body.id] });

    expect(res.status, res.text).toBe(400);
    expect(res.body.error).toBe('Une annonce correspond à un seul lot');
  });

  it('refuse un lot non AVAILABLE : 409 LOT_NOT_AVAILABLE', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['LISTING_MANAGEMENT'] });
    const supplier = await fournisseur({ verifie: true });
    // Lot non validé : PENDING_VALIDATION.
    const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));

    const res = await creerAnnonce(agentUser, lotRes.body.id);

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('LOT_NOT_AVAILABLE');
  });

  it('refuse un lot inconnu : 404', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['LISTING_MANAGEMENT'] });

    const res = await creerAnnonce(agentUser, 999999);

    expect(res.status, res.text).toBe(404);
  });

  it('refuse une seconde annonce sur le même lot : 409 LOT_ALREADY_LINKED', async () => {
    const { agentUser, lot } = await setupAgentEtLot();

    const premiere = await creerAnnonce(agentUser, lot.id);
    expect(premiere.status, premiere.text).toBe(201);

    const seconde = await creerAnnonce(agentUser, lot.id);

    expect(seconde.status, seconde.text).toBe(409);
    expect(seconde.body.error).toBe('Lot déjà relié à une annonce');
    expect(seconde.body.code).toBe('LOT_ALREADY_LINKED');
  });

  it('un AGENT sans LISTING_MANAGEMENT reçoit 403', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: [] });
    const { lot } = await setupAgentEtLot();

    const res = await creerAnnonce(agentUser, lot.id);

    expect(res.status, res.text).toBe(403);
  });

  it('un BUYER reçoit 403', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const { lot } = await setupAgentEtLot();

    const res = await client
      .post('/api/v2/staff/listings')
      .set(authHeader(tokenPour(buyer, 'BUYER')))
      .send({ lotIds: [lot.id], title: 'Maïs jaune de la ferme' });

    expect(res.status, res.text).toBe(403);
  });

  it('copie les photos du lot quand aucune image n\'est envoyée', async () => {
    const { agentUser, lot } = await setupAgentEtLot();

    // Deux photos sur le lot, avec publicId (comme si elles venaient d'un
    // upload réel) : la copie doit reprendre url et publicId.
    const mediaType = await prisma.mediaType.findUnique({ where: { code: 'IMAGE' } });
    const mimeType = await prisma.mimeType.findUnique({ where: { code: 'image/jpeg' } });
    await prisma.media.createMany({
      data: [
        {
          ownerLotId: lot.id,
          mediaTypeId: mediaType.id,
          mimeTypeId: mimeType.id,
          url: 'https://res.cloudinary.com/test/lot_1',
          publicId: 'lot_1',
          isPrimary: true,
          position: 0,
        },
        {
          ownerLotId: lot.id,
          mediaTypeId: mediaType.id,
          mimeTypeId: mimeType.id,
          url: 'https://res.cloudinary.com/test/lot_2',
          publicId: 'lot_2',
          isPrimary: false,
          position: 1,
        },
      ],
    });

    const res = await creerAnnonce(agentUser, lot.id);

    expect(res.status, res.text).toBe(201);
    expect(res.body.images).toHaveLength(2);
    expect(res.body.images[0]).toMatchObject({
      url: 'https://res.cloudinary.com/test/lot_1',
      isPrimary: true,
      position: 0,
    });

    // Les nouvelles lignes Media reprennent url et publicId, isPrivate false.
    const photos = await prisma.media.findMany({
      where: { ownerListingId: res.body.id },
      orderBy: { position: 'asc' },
    });
    expect(photos).toHaveLength(2);
    expect(photos[0]).toMatchObject({
      url: 'https://res.cloudinary.com/test/lot_1',
      publicId: 'lot_1',
      isPrivate: false,
      isPrimary: true,
    });
    expect(photos[1]).toMatchObject({
      url: 'https://res.cloudinary.com/test/lot_2',
      publicId: 'lot_2',
      isPrivate: false,
      isPrimary: false,
    });
  });

  it('uploade les photos envoyées avec url et publicId', async () => {
    const { agentUser, lot } = await setupAgentEtLot();

    const res = await client
      .post('/api/v2/staff/listings')
      .set(authHeader(tokenPour(agentUser, 'AGENT')))
      .field('lotIds[]', String(lot.id))
      .field('title', 'Maïs jaune de la ferme')
      .attach('images', FAKE_JPEG, { filename: 'photo1.jpg', contentType: 'image/jpeg' });

    expect(res.status, res.text).toBe(201);
    expect(res.body.images).toHaveLength(1);
    expect(res.body.images[0].url).toMatch(/^\/uploads\/LISTING_PHOTO\//);

    const photos = await prisma.media.findMany({ where: { ownerListingId: res.body.id } });
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({
      isPrivate: false,
      isPrimary: true,
    });
    expect(photos[0].url).toMatch(/^\/uploads\/LISTING_PHOTO\//);
    expect(photos[0].publicId).toMatch(/^LISTING_PHOTO\//);
  });
});

describe('PATCH /api/v2/staff/listings/:id — modification', () => {
  it('modifie titre, description, prix et zone', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    const cree = await creerAnnonce(agentUser, lot.id);
    expect(cree.status, cree.text).toBe(201);

    const z2 = await zone();
    const res = await client
      .patch(`/api/v2/staff/listings/${cree.body.id}`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')))
      .send({ title: 'Nouveau titre', description: 'Description détaillée', unitPrice: '1500.00', zoneId: z2.id });

    expect(res.status, res.text).toBe(200);
    expect(res.body.title).toBe('Nouveau titre');
    expect(res.body.description).toBe('Description détaillée');
    expect(res.body.unitPrice).toBe(1500);
    expect(res.body.zone.id).toBe(z2.id);
  });

  it('trace le changement de prix dans l\'audit avec ancienne et nouvelle valeur', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    const cree = await creerAnnonce(agentUser, lot.id);
    expect(cree.status, cree.text).toBe(201);

    const res = await client
      .patch(`/api/v2/staff/listings/${cree.body.id}`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')))
      .send({ unitPrice: '1800.00' });

    expect(res.status, res.text).toBe(200);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'LISTING_PRICE_UPDATED', entityType: 'Listing', entityId: cree.body.id },
    });
    expect(audit).toBeTruthy();
    expect(audit.metadata.oldUnitPrice).toBe(1250.5);
    expect(audit.metadata.newUnitPrice).toBe(1800);
  });

  it('refuse de modifier une annonce SOLD : 409 INVALID_STATE_TRANSITION', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    const cree = await creerAnnonce(agentUser, lot.id);
    expect(cree.status, cree.text).toBe(201);
    // Publier puis épuiser le lot : l'annonce passe en SOLD.
    await client
      .post(`/api/v2/staff/listings/${cree.body.id}/publish`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));
    await prisma.$transaction(async (tx) => {
      await reserve(tx, lot.id, 1500, {});
      await commitSale(tx, lot.id, 1500, {});
    });

    const res = await client
      .patch(`/api/v2/staff/listings/${cree.body.id}`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')))
      .send({ title: 'Titre modifié' });

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('répond 404 pour une annonce inconnue', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['LISTING_MANAGEMENT'] });

    const res = await client
      .patch('/api/v2/staff/listings/999999')
      .set(authHeader(tokenPour(agentUser, 'AGENT')))
      .send({ title: 'Titre' });

    expect(res.status, res.text).toBe(404);
  });
});

describe('POST /api/v2/staff/listings/:id/publish et unpublish', () => {
  it('publie une annonce DRAFT : ACTIVE, publishedAt, audit', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    const cree = await creerAnnonce(agentUser, lot.id);
    expect(cree.status, cree.text).toBe(201);

    const res = await client
      .post(`/api/v2/staff/listings/${cree.body.id}/publish`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.publishedAt).toBeTruthy();

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'LISTING_PUBLISHED', entityType: 'Listing', entityId: cree.body.id },
    });
    expect(audit).toBeTruthy();
  });

  it('dépublique une annonce ACTIVE : INACTIVE, audit', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    const cree = await creerAnnonce(agentUser, lot.id);
    await client
      .post(`/api/v2/staff/listings/${cree.body.id}/publish`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    const res = await client
      .post(`/api/v2/staff/listings/${cree.body.id}/unpublish`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('INACTIVE');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'LISTING_UNPUBLISHED', entityType: 'Listing', entityId: cree.body.id },
    });
    expect(audit).toBeTruthy();
  });

  it('republie une annonce INACTIVE', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    const cree = await creerAnnonce(agentUser, lot.id);
    await client
      .post(`/api/v2/staff/listings/${cree.body.id}/publish`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));
    await client
      .post(`/api/v2/staff/listings/${cree.body.id}/unpublish`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    const res = await client
      .post(`/api/v2/staff/listings/${cree.body.id}/publish`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
  });

  it('refuse de publier sans stock : 409 LOT_NOT_AVAILABLE', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    const cree = await creerAnnonce(agentUser, lot.id);
    // Épuiser le lot : plus rien à vendre.
    await prisma.$transaction(async (tx) => {
      await reserve(tx, lot.id, 1500, {});
      await commitSale(tx, lot.id, 1500, {});
    });

    const res = await client
      .post(`/api/v2/staff/listings/${cree.body.id}/publish`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('LOT_NOT_AVAILABLE');
  });

  it('refuse de dépublier une annonce DRAFT : 409 INVALID_STATE_TRANSITION', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    const cree = await creerAnnonce(agentUser, lot.id);

    const res = await client
      .post(`/api/v2/staff/listings/${cree.body.id}/unpublish`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('Statut automatique — syncListingsForLot', () => {
  it('passe une annonce ACTIVE en SOLD quand le lot est épuisé (commitSale)', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    const cree = await creerAnnonce(agentUser, lot.id);
    await client
      .post(`/api/v2/staff/listings/${cree.body.id}/publish`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    // Vendre tout le stock : le lot passe SOLD_OUT, l'annonce doit suivre.
    await prisma.$transaction(async (tx) => {
      await reserve(tx, lot.id, 1500, {});
      await commitSale(tx, lot.id, 1500, {});
    });

    const annonce = await prisma.listing.findUnique({
      where: { id: cree.body.id },
      include: { status: true },
    });
    expect(annonce.status.code).toBe('SOLD');
  });

  it('passe une annonce ACTIVE en INACTIVE quand le lot expire', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    const cree = await creerAnnonce(agentUser, lot.id);
    await client
      .post(`/api/v2/staff/listings/${cree.body.id}/publish`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    await prisma.$transaction((tx) => expireAvailable(tx, lot.id, {}));

    const annonce = await prisma.listing.findUnique({
      where: { id: cree.body.id },
      include: { status: true },
    });
    expect(annonce.status.code).toBe('INACTIVE');
  });

  it('annonce SOLD (et non INACTIVE) quand le lot est entièrement vendu après sa date', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    const cree = await creerAnnonce(agentUser, lot.id);
    await client
      .post(`/api/v2/staff/listings/${cree.body.id}/publish`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    // La réservation est prise avant la date ; la date passe ; la vente est
    // concrétisée après. SOLD_OUT prime sur EXPIRED : l'annonce est SOLD.
    await prisma.$transaction((tx) => reserve(tx, lot.id, 1500, {}));
    await prisma.stockLot.update({ where: { id: lot.id }, data: { expiresAt: HIER } });
    await prisma.$transaction((tx) => commitSale(tx, lot.id, 1500, {}));

    const annonce = await prisma.listing.findUnique({
      where: { id: cree.body.id },
      include: { status: true },
    });
    expect(annonce.status.code).toBe('SOLD');
  });

  it('ne touche pas une annonce DRAFT quand le lot expire', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    const cree = await creerAnnonce(agentUser, lot.id);
    // L'annonce reste DRAFT : le statut n'est pas recalculé.
    await prisma.$transaction((tx) => expireAvailable(tx, lot.id, {}));

    const annonce = await prisma.listing.findUnique({
      where: { id: cree.body.id },
      include: { status: true },
    });
    expect(annonce.status.code).toBe('DRAFT');
  });
});

describe('GET /api/v2/staff/listings — liste et détail', () => {
  it('liste les annonces avec filtres statut, produit et fournisseur', async () => {
    const { agentUser, supplier, lot } = await setupAgentEtLot();
    const cree = await creerAnnonce(agentUser, lot.id);
    expect(cree.status, cree.text).toBe(201);

    const res = await client
      .get('/api/v2/staff/listings')
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ page: 1, limit: 20, total: 1 });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(cree.body.id);
    expect(res.body.items[0].lot.id).toBe(lot.id);
    expect(res.body.items[0].lot.supplier.farmName).toBe('Ferme du Test');

    // Filtre par statut.
    const actives = await client
      .get('/api/v2/staff/listings?status=ACTIVE')
      .set(authHeader(tokenPour(agentUser, 'AGENT')));
    expect(actives.body.total).toBe(0);
    const brouillons = await client
      .get('/api/v2/staff/listings?status=DRAFT')
      .set(authHeader(tokenPour(agentUser, 'AGENT')));
    expect(brouillons.body.total).toBe(1);

    // Filtre par produit.
    const parProduit = await client
      .get(`/api/v2/staff/listings?productId=${lot.product.id}`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));
    expect(parProduit.body.total).toBe(1);

    // Filtre par fournisseur (via le lot relié).
    const profilFournisseur = await prisma.supplierProfile.findFirst({
      where: { userId: supplier.id },
    });
    const parFournisseur = await client
      .get(`/api/v2/staff/listings?supplierId=${profilFournisseur.id}`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));
    expect(parFournisseur.body.total).toBe(1);
  });

  it('rejette un statut inconnu : 400', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['LISTING_MANAGEMENT'] });

    const res = await client
      .get('/api/v2/staff/listings?status=INCONNU')
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(400);
  });

  it('renvoie le détail d\'une annonce avec lot et promoteur', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    const cree = await creerAnnonce(agentUser, lot.id);

    const res = await client
      .get(`/api/v2/staff/listings/${cree.body.id}`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.id).toBe(cree.body.id);
    expect(res.body.reference).toBe(cree.body.reference);
    expect(res.body.lot.id).toBe(lot.id);
    expect(res.body.lot.lotCode).toBe(lot.lotCode);
    expect(res.body.lot.supplier.farmName).toBe('Ferme du Test');
  });

  it('répond 404 pour une annonce inconnue', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['LISTING_MANAGEMENT'] });

    const res = await client
      .get('/api/v2/staff/listings/999999')
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(404);
  });

  it('un AGENT sans LISTING_MANAGEMENT reçoit 403', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: [] });

    const res = await client
      .get('/api/v2/staff/listings')
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(403);
  });
});
