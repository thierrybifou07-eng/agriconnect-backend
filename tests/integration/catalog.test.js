import { describe, it, expect, beforeEach } from 'vitest';
import { randomInt } from 'node:crypto';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { assertNoLeak } from '../helpers/assertNoLeak.js';

// Clés interdites dans toute réponse du module catalogue : le lot, le promoteur
// et l'identité de l'équipe ne doivent jamais transparaître côté acheteur.
const CLES_INTERDITES = [
  'lotId', 'lotCode', 'supplierId', 'farmName', 'agreedUnitPrice', 'supplierUnitPrice',
  'pickupAddress', 'pickupLatitude', 'pickupLongitude',
  'firstname', 'lastname', 'phone', 'email',
  'createdByUserId', 'createdByAgentId', 'validatedByAgentId',
];

const client = api();

// createUser ne charge pas la relation role : le code est passé explicitement.
function tokenPour(user, role) {
  return generateToken({ id: user.id, role });
}

// Dates relatives : un lot dont expiresAt est dans le passé est exclu du
// stock disponible, même si son statut reste AVAILABLE.
const DANS_7_JOURS = new Date(Date.now() + 7 * 24 * 3600 * 1000);
const DANS_30_JOURS = new Date(Date.now() + 30 * 24 * 3600 * 1000);
const HIER = new Date(Date.now() - 24 * 3600 * 1000);

// Chaque test repart d'un ensemble complet : produit, zone, fournisseur, lots
// (actifs, expirés, épuisés) et annonces dans tous les statuts.
let fixture = {};

async function creerLot(produit, zone, profil, { lotCode, agreedUnitPrice, quantityInitial, quantityAvailable, qualityGrade, expiresAt, status }) {
  return prisma.stockLot.create({
    data: {
      lotCode,
      supplierId: profil.id,
      productId: produit.id,
      zoneId: zone.id,
      agreedUnitPrice,
      quantityInitial,
      quantityAvailable,
      qualityGrade,
      expiresAt,
      status,
      pickupAddress: '12 route de la ferme',
      pickupLatitude: 12.34,
      pickupLongitude: -5.67,
    },
  });
}

async function creerAnnonce(produit, zone, statut, { reference, title, description, unitPrice, publishedAt }) {
  return prisma.listing.create({
    data: {
      reference,
      title,
      description,
      unitPrice,
      productId: produit.id,
      zoneId: zone.id,
      statusId: statut.id,
      publishedAt,
    },
  });
}

// Reproduit le comportement de POST /staff/listings sans images : les photos
// du lot sont copiées sur l'annonce (nouvelles lignes Media ownerListingId).
async function copierPhotosLot(listingId, lotId, mediaTypeId, mimeTypeId) {
  const photos = await prisma.media.findMany({
    where: { ownerLotId: lotId },
    orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
  });
  for (const photo of photos) {
    await prisma.media.create({
      data: {
        ownerListingId: listingId,
        mediaTypeId: photo.mediaTypeId,
        mimeTypeId: photo.mimeTypeId,
        url: photo.url,
        publicId: photo.publicId,
        isPrivate: false,
        isPrimary: photo.isPrimary,
        position: photo.position,
      },
    });
  }
}

async function creerFixtures() {
  const [categorie, unite, mediaType, mimeType] = await Promise.all([
    prisma.productCategory.findUnique({ where: { code: 'CEREALES' } }),
    prisma.unit.findUnique({ where: { code: 'KG' } }),
    prisma.mediaType.findUnique({ where: { code: 'IMAGE' } }),
    prisma.mimeType.findUnique({ where: { code: 'image/jpeg' } }),
  ]);
  const statuts = {};
  for (const code of ['DRAFT', 'ACTIVE', 'SOLD', 'INACTIVE']) {
    statuts[code] = await prisma.listingStatus.findUnique({ where: { code } });
  }

  const produit = await prisma.product.create({
    data: { categoryId: categorie.id, unitId: unite.id, name: `Maïs jaune ${Date.now()}` },
  });
  const zone = await prisma.zone.create({
    data: { name: `Zone test ${Date.now()}`, city: 'Testville' },
  });

  const fournisseur = await createUser({ role: 'SUPPLIER' });
  const profil = await prisma.supplierProfile.create({
    data: { userId: fournisseur.id, farmName: 'Ferme du Test', zoneId: zone.id },
  });

  // Annonce A : deux lots actifs (200 + 300) et un lot expiré (500, exclu).
  // Quantité agrégée attendue : 500. qualityGrade le plus bas : 'C'.
  // expiresAt le plus proche : DANS_7_JOURS.
  const lotA1 = await creerLot(produit, zone, profil, {
    lotCode: `LOT-A1-${randomInt(1000, 9999)}`,
    agreedUnitPrice: '800.00', quantityInitial: '200', quantityAvailable: '200',
    qualityGrade: 'A', expiresAt: DANS_7_JOURS, status: 'AVAILABLE',
  });
  const lotA2 = await creerLot(produit, zone, profil, {
    lotCode: `LOT-A2-${randomInt(1000, 9999)}`,
    agreedUnitPrice: '850.00', quantityInitial: '300', quantityAvailable: '300',
    qualityGrade: 'C', expiresAt: DANS_30_JOURS, status: 'AVAILABLE',
  });
  const lotA3 = await creerLot(produit, zone, profil, {
    lotCode: `LOT-A3-${randomInt(1000, 9999)}`,
    agreedUnitPrice: '820.00', quantityInitial: '500', quantityAvailable: '500',
    qualityGrade: 'A', expiresAt: HIER, status: 'AVAILABLE',
  });

  // Photos réalistes sur lotA1 : la première est la photo principale.
  await prisma.media.createMany({
    data: [
      { ownerLotId: lotA1.id, mediaTypeId: mediaType.id, mimeTypeId: mimeType.id, url: 'https://res.cloudinary.com/test/lot_a1_1', publicId: 'lot_a1_1', isPrimary: true, position: 0 },
      { ownerLotId: lotA1.id, mediaTypeId: mediaType.id, mimeTypeId: mimeType.id, url: 'https://res.cloudinary.com/test/lot_a1_2', publicId: 'lot_a1_2', isPrimary: false, position: 1 },
    ],
  });

  const annonceA = await creerAnnonce(produit, zone, statuts.ACTIVE, {
    reference: `ANN-A-${randomInt(1000, 9999)}`,
    title: 'Maïs jaune',
    description: 'Maïs de qualité supérieure',
    unitPrice: '1500.00',
    publishedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000),
  });
  await prisma.listingLot.createMany({
    data: [
      { listingId: annonceA.id, lotId: lotA1.id },
      { listingId: annonceA.id, lotId: lotA2.id },
      { listingId: annonceA.id, lotId: lotA3.id },
    ],
  });
  await copierPhotosLot(annonceA.id, lotA1.id, mediaType.id, mimeType.id);

  // Annonce B : un lot actif sans date d'expiration, publié hier.
  const lotB = await creerLot(produit, zone, profil, {
    lotCode: `LOT-B-${randomInt(1000, 9999)}`,
    agreedUnitPrice: '700.00', quantityInitial: '1000', quantityAvailable: '1000',
    qualityGrade: 'B', expiresAt: null, status: 'AVAILABLE',
  });
  const annonceB = await creerAnnonce(produit, zone, statuts.ACTIVE, {
    reference: `ANN-B-${randomInt(1000, 9999)}`,
    title: 'Maïs blanc',
    description: 'Maïs blanc traditionnel',
    unitPrice: '1200.00',
    publishedAt: new Date(Date.now() - 24 * 3600 * 1000),
  });
  await prisma.listingLot.create({ data: { listingId: annonceB.id, lotId: lotB.id } });

  // Annonce C : un petit lot sans grade, publié il y a trois jours.
  const lotC = await creerLot(produit, zone, profil, {
    lotCode: `LOT-C-${randomInt(1000, 9999)}`,
    agreedUnitPrice: '950.00', quantityInitial: '50', quantityAvailable: '50',
    qualityGrade: null, expiresAt: DANS_30_JOURS, status: 'AVAILABLE',
  });
  const annonceC = await creerAnnonce(produit, zone, statuts.ACTIVE, {
    reference: `ANN-C-${randomInt(1000, 9999)}`,
    title: 'Maïs rouge',
    description: 'Maïs rouge bio',
    unitPrice: '1800.00',
    publishedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
  });
  await prisma.listingLot.create({ data: { listingId: annonceC.id, lotId: lotC.id } });

  // Annonces exclues du catalogue : DRAFT, SOLD, INACTIVE et sans stock.
  const lotDraft = await creerLot(produit, zone, profil, {
    lotCode: `LOT-D-${randomInt(1000, 9999)}`,
    agreedUnitPrice: '600.00', quantityInitial: '100', quantityAvailable: '100',
    qualityGrade: 'A', expiresAt: DANS_7_JOURS, status: 'AVAILABLE',
  });
  const annonceDraft = await creerAnnonce(produit, zone, statuts.DRAFT, {
    reference: `ANN-D-${randomInt(1000, 9999)}`,
    title: 'Brouillon de maïs',
    description: 'Annonce en cours de rédaction',
    unitPrice: '1100.00',
    publishedAt: null,
  });
  await prisma.listingLot.create({ data: { listingId: annonceDraft.id, lotId: lotDraft.id } });

  const lotSold = await creerLot(produit, zone, profil, {
    lotCode: `LOT-S-${randomInt(1000, 9999)}`,
    agreedUnitPrice: '650.00', quantityInitial: '100', quantityAvailable: '100',
    qualityGrade: 'A', expiresAt: DANS_7_JOURS, status: 'AVAILABLE',
  });
  const annonceSold = await creerAnnonce(produit, zone, statuts.SOLD, {
    reference: `ANN-S-${randomInt(1000, 9999)}`,
    title: 'Maïs vendu',
    description: 'Annonce épuisée',
    unitPrice: '1300.00',
    publishedAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
  });
  await prisma.listingLot.create({ data: { listingId: annonceSold.id, lotId: lotSold.id } });

  const lotSansStock = await creerLot(produit, zone, profil, {
    lotCode: `LOT-E-${randomInt(1000, 9999)}`,
    agreedUnitPrice: '750.00', quantityInitial: '100', quantityAvailable: '0',
    qualityGrade: 'A', expiresAt: DANS_7_JOURS, status: 'AVAILABLE',
  });
  const annonceSansStock = await creerAnnonce(produit, zone, statuts.ACTIVE, {
    reference: `ANN-E-${randomInt(1000, 9999)}`,
    title: 'Maïs épuisé',
    description: 'Plus de stock disponible',
    unitPrice: '1400.00',
    publishedAt: new Date(Date.now() - 4 * 24 * 3600 * 1000),
  });
  await prisma.listingLot.create({ data: { listingId: annonceSansStock.id, lotId: lotSansStock.id } });

  const lotInactive = await creerLot(produit, zone, profil, {
    lotCode: `LOT-I-${randomInt(1000, 9999)}`,
    agreedUnitPrice: '680.00', quantityInitial: '100', quantityAvailable: '100',
    qualityGrade: 'A', expiresAt: DANS_7_JOURS, status: 'AVAILABLE',
  });
  const annonceInactive = await creerAnnonce(produit, zone, statuts.INACTIVE, {
    reference: `ANN-I-${randomInt(1000, 9999)}`,
    title: 'Maïs dépublié',
    description: 'Annonce retirée de la vente',
    unitPrice: '1600.00',
    publishedAt: new Date(Date.now() - 6 * 24 * 3600 * 1000),
  });
  await prisma.listingLot.create({ data: { listingId: annonceInactive.id, lotId: lotInactive.id } });

  const [buyer, agent, admin, root, supplier] = await Promise.all([
    createUser({ role: 'BUYER' }),
    createUser({ role: 'AGENT' }),
    createUser({ role: 'ADMIN' }),
    createUser({ role: 'ROOT' }),
    createUser({ role: 'SUPPLIER' }),
  ]);

  fixture = {
    produit, zone, fournisseur, profil,
    annonceA, annonceB, annonceC,
    annonceDraft, annonceSold, annonceSansStock, annonceInactive,
    buyer, agent, admin, root, supplier,
  };
}

beforeEach(async () => {
  await creerFixtures();
});

describe('GET /api/v2/catalog/categories', () => {
  it('retourne les catégories de produits actives', async () => {
    const res = await client
      .get('/api/v2/catalog/categories')
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));

    expect(res.status, res.text).toBe(200);
    assertNoLeak(res.body, CLES_INTERDITES);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toMatchObject({
      id: expect.any(Number),
      code: expect.any(String),
      label: expect.any(String),
    });
  });

  it('un SUPPLIER reçoit 403', async () => {
    const res = await client
      .get('/api/v2/catalog/categories')
      .set(authHeader(tokenPour(fixture.supplier, 'SUPPLIER')));

    expect(res.status, res.text).toBe(403);
  });
});

describe('GET /api/v2/catalog/listings', () => {
  it('ne retourne que les annonces ACTIVE avec du stock', async () => {
    const res = await client
      .get('/api/v2/catalog/listings')
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));

    expect(res.status, res.text).toBe(200);
    assertNoLeak(res.body, CLES_INTERDITES);

    expect(res.body).toMatchObject({ page: 1, limit: 20, total: 3 });
    const ids = res.body.items.map((i) => i.id);
    expect(ids).toContain(fixture.annonceA.id);
    expect(ids).toContain(fixture.annonceB.id);
    expect(ids).toContain(fixture.annonceC.id);
    // DRAFT, SOLD, INACTIVE et sans stock sont exclus.
    expect(ids).not.toContain(fixture.annonceDraft.id);
    expect(ids).not.toContain(fixture.annonceSold.id);
    expect(ids).not.toContain(fixture.annonceInactive.id);
    expect(ids).not.toContain(fixture.annonceSansStock.id);
  });

  it('expose exactement les champs du DTO acheteur', async () => {
    const res = await client
      .get('/api/v2/catalog/listings')
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));

    expect(res.status, res.text).toBe(200);
    const item = res.body.items.find((i) => i.id === fixture.annonceA.id);
    expect(Object.keys(item).sort()).toEqual([
      'category', 'description', 'expiresAt', 'id', 'images', 'qualityGrade',
      'quantityAvailable', 'reference', 'title', 'unit', 'unitPrice', 'zone',
    ]);
  });

  it('agrège la quantité disponible de ses lots non expirés', async () => {
    const res = await client
      .get('/api/v2/catalog/listings')
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));

    expect(res.status, res.text).toBe(200);
    // 200 (lotA1) + 300 (lotA2) ; le lot expiré lotA3 (500) ne compte pas.
    const item = res.body.items.find((i) => i.id === fixture.annonceA.id);
    expect(item.quantityAvailable).toBe(500);
    const itemB = res.body.items.find((i) => i.id === fixture.annonceB.id);
    expect(itemB.quantityAvailable).toBe(1000);
  });

  it('expose qualityGrade le plus bas et expiresAt le plus proche', async () => {
    const res = await client
      .get('/api/v2/catalog/listings')
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));

    expect(res.status, res.text).toBe(200);
    const item = res.body.items.find((i) => i.id === fixture.annonceA.id);
    expect(item.qualityGrade).toBe('C'); // plus bas de A (lotA1) et C (lotA2)
    expect(new Date(item.expiresAt).getTime()).toBe(DANS_7_JOURS.getTime());

    // L'annonce B n'a pas de date d'expiration ; l'annonce C n'a pas de grade.
    const itemB = res.body.items.find((i) => i.id === fixture.annonceB.id);
    expect(itemB.expiresAt).toBeNull();
    const itemC = res.body.items.find((i) => i.id === fixture.annonceC.id);
    expect(itemC.qualityGrade).toBeNull();
  });

  it('expose les photos copiées du lot sous forme d\'URLs', async () => {
    const res = await client
      .get('/api/v2/catalog/listings')
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));

    expect(res.status, res.text).toBe(200);
    const item = res.body.items.find((i) => i.id === fixture.annonceA.id);
    expect(item.images).toEqual([
      'https://res.cloudinary.com/test/lot_a1_1',
      'https://res.cloudinary.com/test/lot_a1_2',
    ]);
  });

  it('trie par prix croissant', async () => {
    const res = await client
      .get('/api/v2/catalog/listings?sort=price')
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));

    expect(res.status, res.text).toBe(200);
    assertNoLeak(res.body, CLES_INTERDITES);
    expect(res.body.items.map((i) => i.unitPrice)).toEqual([1200, 1500, 1800]);
  });

  it('trie par récence (publishedAt décroissant)', async () => {
    const res = await client
      .get('/api/v2/catalog/listings?sort=recent')
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));

    expect(res.status, res.text).toBe(200);
    // B publié hier, A il y a deux jours, C il y a trois jours.
    expect(res.body.items.map((i) => i.id)).toEqual([
      fixture.annonceB.id,
      fixture.annonceA.id,
      fixture.annonceC.id,
    ]);
  });

  it('trie par péremption (expiresAt le plus proche d\'abord)', async () => {
    const res = await client
      .get('/api/v2/catalog/listings?sort=expiry')
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));

    expect(res.status, res.text).toBe(200);
    // A expire dans 7 jours, C dans 30 jours, B n expire jamais (en dernier).
    expect(res.body.items.map((i) => i.id)).toEqual([
      fixture.annonceA.id,
      fixture.annonceC.id,
      fixture.annonceB.id,
    ]);
  });

  it('page les résultats avec total, page et limit', async () => {
    const premiere = await client
      .get('/api/v2/catalog/listings?page=1&limit=2')
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));
    expect(premiere.status, premiere.text).toBe(200);
    expect(premiere.body).toMatchObject({ page: 1, limit: 2, total: 3 });
    expect(premiere.body.items).toHaveLength(2);

    const seconde = await client
      .get('/api/v2/catalog/listings?page=2&limit=2')
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));
    expect(seconde.status, seconde.text).toBe(200);
    expect(seconde.body).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(seconde.body.items).toHaveLength(1);
  });

  it('un SUPPLIER reçoit 403', async () => {
    const res = await client
      .get('/api/v2/catalog/listings')
      .set(authHeader(tokenPour(fixture.supplier, 'SUPPLIER')));

    expect(res.status, res.text).toBe(403);
  });

  it('AGENT, ADMIN et ROOT ont accès au catalogue', async () => {
    for (const [user, role] of [[fixture.agent, 'AGENT'], [fixture.admin, 'ADMIN'], [fixture.root, 'ROOT']]) {
      const res = await client
        .get('/api/v2/catalog/listings')
        .set(authHeader(tokenPour(user, role)));
      expect(res.status, res.text).toBe(200);
      assertNoLeak(res.body, CLES_INTERDITES);
    }
  });
});

describe('GET /api/v2/catalog/listings/:id', () => {
  it('expose le DTO acheteur complet sans fuite de données', async () => {
    const res = await client
      .get(`/api/v2/catalog/listings/${fixture.annonceA.id}`)
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));

    expect(res.status, res.text).toBe(200);
    assertNoLeak(res.body, CLES_INTERDITES);
    expect(res.body).toMatchObject({
      id: fixture.annonceA.id,
      title: 'Maïs jaune',
      description: 'Maïs de qualité supérieure',
      category: { code: 'CEREALES', label: 'Céréales' },
      unit: { code: 'KG', label: 'Kilogramme' },
      unitPrice: 1500,
      quantityAvailable: 500,
      qualityGrade: 'C',
      zone: { id: fixture.zone.id, name: fixture.zone.name, city: 'Testville' },
    });
    expect(res.body.images).toEqual([
      'https://res.cloudinary.com/test/lot_a1_1',
      'https://res.cloudinary.com/test/lot_a1_2',
    ]);
  });

  it('répond 404 pour une annonce DRAFT', async () => {
    const res = await client
      .get(`/api/v2/catalog/listings/${fixture.annonceDraft.id}`)
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));

    expect(res.status, res.text).toBe(404);
  });

  it('répond 404 pour une annonce SOLD', async () => {
    const res = await client
      .get(`/api/v2/catalog/listings/${fixture.annonceSold.id}`)
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));

    expect(res.status, res.text).toBe(404);
  });

  it('répond 404 pour une annonce sans stock', async () => {
    const res = await client
      .get(`/api/v2/catalog/listings/${fixture.annonceSansStock.id}`)
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));

    expect(res.status, res.text).toBe(404);
  });

  it('répond 404 pour une annonce inconnue', async () => {
    const res = await client
      .get('/api/v2/catalog/listings/999999')
      .set(authHeader(tokenPour(fixture.buyer, 'BUYER')));

    expect(res.status, res.text).toBe(404);
  });

  it('un SUPPLIER reçoit 403', async () => {
    const res = await client
      .get(`/api/v2/catalog/listings/${fixture.annonceA.id}`)
      .set(authHeader(tokenPour(fixture.supplier, 'SUPPLIER')));

    expect(res.status, res.text).toBe(403);
  });
});
