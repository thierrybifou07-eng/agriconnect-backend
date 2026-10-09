import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomInt } from 'node:crypto';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

// --- Mock Cloudinary ---
// upload_stream : objet avec end() qui déclenche le callback, comme le vrai
// SDK. Le module npm 'cloudinary' est mocké (et non config/cloudinary.js) :
// les deux importent { v2 } de 'cloudinary', donc un seul mock couvre les deux.
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

// Compteur : chaque photo reçoit une URL et un public_id distincts, comme le
// ferait Cloudinary pour deux uploads différents.
let numeroImage;
beforeEach(() => {
  numeroImage = 0;
  uploadStream.mockImplementation((options, callback) => ({
    end: () => {
      numeroImage += 1;
      setImmediate(() =>
        callback(null, {
          public_id: `lot_${numeroImage}`,
          secure_url: `https://res.cloudinary.com/test/lot_${numeroImage}`,
        })
      );
    },
  }));
});

function tokenPour(user, role) {
  return generateToken({ id: user.id, role });
}

// Buffers minimaux : multer ne regarde que le mimetype déclaré, pas le contenu.
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// Le setup global (tests/setup/hooks.js) vide la base avant chaque test ; ici
// on configure seulement le mock Cloudinary.

// --- Fixtures ---

// Un compte SUPPLIER avec son profil : le lot appartient au profil, pas au
// compte. createUser ne crée pas de profil (l'inscription, si : P1.2).
async function fournisseur() {
  const user = await createUser({ role: 'SUPPLIER' });
  await prisma.supplierProfile.create({
    data: { userId: user.id, farmName: 'Ferme du Test' },
  });
  return user;
}

// Catégorie et unité viennent du seed (référentiels non vidés entre tests).
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

async function hub(zoneId, { isActive = true, acceptsDropoff = true } = {}) {
  return prisma.hub.create({
    data: {
      name: 'Hub Test',
      address: '12 rue du dépôt',
      latitude: 12.34,
      longitude: -5.67,
      zoneId,
      isActive,
      acceptsDropoff,
    },
  });
}

// Date de péremption dans 7 jours.
const DANS_7_JOURS = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

// Corps de déclaration minimal pour un lot sur site (storageType par défaut
// du schéma). Les tests fusionnent ce qu'ils veulent modifier par-dessus.
function champsBase(product, zone) {
  return {
    productId: product.id,
    zoneId: zone.id,
    agreedUnitPrice: '1250.50',
    quantity: '1500',
    storageType: 'SUPPLIER_SITE',
    pickupAddress: '12 route de la ferme',
    pickupLatitude: '12.34',
    pickupLongitude: '-5.67',
    expiresAt: DANS_7_JOURS,
  };
}

// Déclare un lot via l'API : champs texte avec .field, photos avec .attach
// (même nom de champ 'images', comme le client Flutter enverrait).
async function declarerLot(token, champs, images = []) {
  let requete = client.post('/api/v2/supplier/lots').set(authHeader(token));
  for (const [cle, valeur] of Object.entries(champs)) {
    requete = requete.field(cle, String(valeur));
  }
  images.forEach((buffer, i) => {
    const jpeg = i % 2 === 0;
    const contentType = jpeg ? 'image/jpeg' : 'image/png';
    const extension = jpeg ? 'jpg' : 'png';
    requete = requete.attach('images', buffer, {
      filename: `photo${i + 1}.${extension}`,
      contentType,
    });
  });
  return requete;
}

// Déclare un lot sur site et renvoie sa réponse (201 attendu).
async function declarentLotSurSite(token, overrides = {}, images = []) {
  const prod = await produit();
  const z = await zone();
  const res = await declarerLot(token, { ...champsBase(prod, z), ...overrides }, images);
  expect(res.status, res.text).toBe(201);
  return res;
}

describe('POST /api/v2/supplier/lots — déclaration', () => {
  it('un fournisseur déclare un lot avec 2 photos : 201, PENDING_VALIDATION, lotCode, Media', async () => {
    const user = await fournisseur();
    const prod = await produit();
    const z = await zone();

    const res = await declarerLot(tokenPour(user, 'SUPPLIER'), champsBase(prod, z), [FAKE_JPEG, FAKE_PNG]);

    expect(res.status, res.text).toBe(201);
    expect(res.body.lotCode).toMatch(/^LOT-\d{6}$/);
    expect(res.body.status).toBe('PENDING_VALIDATION');
    expect(res.body.product.name).toBe(prod.name);
    expect(res.body.agreedUnitPrice).toBe(1250.5);
    // quantityInitial = quantityAvailable = quantité déclarée ; aucun
    // mouvement n'a encore eu lieu.
    expect(res.body.quantityInitial).toBe(1500);
    expect(res.body.quantityAvailable).toBe(1500);
    expect(res.body.quantityReserved).toBe(0);
    expect(res.body.quantitySold).toBe(0);
    expect(res.body.quantityLost).toBe(0);
    expect(res.body.zone.id).toBe(z.id);
    expect(res.body.storageType).toBe('SUPPLIER_SITE');
    expect(res.body.pickupAddress).toBe('12 route de la ferme');
    // Photos triées : principale d'abord, puis par position.
    expect(res.body.images).toEqual([
      { url: 'https://res.cloudinary.com/test/lot_1', position: 0, isPrimary: true },
      { url: 'https://res.cloudinary.com/test/lot_2', position: 1, isPrimary: false },
    ]);
    // Aucune donnée acheteur dans la réponse.
    expect(res.body).not.toHaveProperty('buyerId');

    const enBase = await prisma.stockLot.findUnique({ where: { id: res.body.id } });
    expect(enBase.status).toBe('PENDING_VALIDATION');
    expect(enBase.quantityInitial.toNumber()).toBe(1500);
    expect(enBase.quantityAvailable.toNumber()).toBe(1500);

    // Deux lignes Media rattachées au lot, la première en principale.
    const media = await prisma.media.findMany({
      where: { ownerLotId: res.body.id },
      include: { mimeType: true },
      orderBy: { position: 'asc' },
    });
    expect(media).toHaveLength(2);
    expect(media[0].isPrimary).toBe(true);
    expect(media[0].mimeType.code).toBe('image/jpeg');
    expect(media[1].isPrimary).toBe(false);
    expect(media[1].mimeType.code).toBe('image/png');
  });

  it('déclare un lot sans photo : 201, aucune ligne Media', async () => {
    const user = await fournisseur();

    const res = await declarentLotSurSite(tokenPour(user, 'SUPPLIER'));

    expect(res.status, res.text).toBe(201);
    expect(res.body.images).toEqual([]);
    const media = await prisma.media.findMany({ where: { ownerLotId: res.body.id } });
    expect(media).toHaveLength(0);
  });

  it('un produit non périssable se déclare sans expiresAt : 201', async () => {
    const user = await fournisseur();
    const prod = await produit({ perissable: false });
    const z = await zone();
    const corps = champsBase(prod, z);
    delete corps.expiresAt;

    const res = await declarerLot(tokenPour(user, 'SUPPLIER'), corps);

    expect(res.status, res.text).toBe(201);
    expect(res.body.expiresAt).toBeNull();
  });

  it('refuse un stockage HUB sans hubId (400)', async () => {
    const user = await fournisseur();
    const prod = await produit({ perissable: false });
    const z = await zone();

    const res = await declarerLot(tokenPour(user, 'SUPPLIER'), {
      ...champsBase(prod, z),
      storageType: 'HUB',
    });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un hubId inconnu (400)', async () => {
    const user = await fournisseur();
    const prod = await produit({ perissable: false });
    const z = await zone();

    const res = await declarerLot(tokenPour(user, 'SUPPLIER'), {
      ...champsBase(prod, z),
      storageType: 'HUB',
      hubId: 999999,
    });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un hub inactif (400)', async () => {
    const user = await fournisseur();
    const prod = await produit({ perissable: false });
    const z = await zone();
    const hubInactif = await hub(z.id, { isActive: false });

    const res = await declarerLot(tokenPour(user, 'SUPPLIER'), {
      ...champsBase(prod, z),
      storageType: 'HUB',
      hubId: hubInactif.id,
    });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un hub qui n accepte pas la dépose (400)', async () => {
    const user = await fournisseur();
    const prod = await produit({ perissable: false });
    const z = await zone();
    const hubSansDepose = await hub(z.id, { acceptsDropoff: false });

    const res = await declarerLot(tokenPour(user, 'SUPPLIER'), {
      ...champsBase(prod, z),
      storageType: 'HUB',
      hubId: hubSansDepose.id,
    });

    expect(res.status, res.text).toBe(400);
  });

  it('accepte un lot HUB avec un hub valide : 201, hub dans la réponse', async () => {
    const user = await fournisseur();
    const prod = await produit({ perissable: false });
    const z = await zone();
    const hubValide = await hub(z.id);

    const res = await declarerLot(tokenPour(user, 'SUPPLIER'), {
      ...champsBase(prod, z),
      storageType: 'HUB',
      hubId: hubValide.id,
    });

    expect(res.status, res.text).toBe(201);
    expect(res.body.storageType).toBe('HUB');
    expect(res.body.hub.id).toBe(hubValide.id);
  });

  it('refuse un lot sur site sans pickupAddress (400)', async () => {
    const user = await fournisseur();
    const prod = await produit();
    const z = await zone();
    const corps = champsBase(prod, z);
    delete corps.pickupAddress;

    const res = await declarerLot(tokenPour(user, 'SUPPLIER'), corps);

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un lot sur site sans coordonnées (400)', async () => {
    const user = await fournisseur();
    const prod = await produit();
    const z = await zone();
    const corps = champsBase(prod, z);
    delete corps.pickupLatitude;
    delete corps.pickupLongitude;

    const res = await declarerLot(tokenPour(user, 'SUPPLIER'), corps);

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un produit périssable sans expiresAt (400)', async () => {
    const user = await fournisseur();
    const prod = await produit({ perissable: true });
    const z = await zone();
    const corps = champsBase(prod, z);
    delete corps.expiresAt;

    const res = await declarerLot(tokenPour(user, 'SUPPLIER'), corps);

    expect(res.status, res.text).toBe(400);
  });

  it('refuse une expiresAt dans le passé (400)', async () => {
    const user = await fournisseur();
    const prod = await produit();
    const z = await zone();

    const res = await declarerLot(tokenPour(user, 'SUPPLIER'), {
      ...champsBase(prod, z),
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un produit inconnu (400)', async () => {
    const user = await fournisseur();
    const z = await zone();

    const res = await declarerLot(tokenPour(user, 'SUPPLIER'), {
      ...champsBase({ id: 999999 }, z),
    });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse une zone inconnue (400)', async () => {
    const user = await fournisseur();
    const prod = await produit({ perissable: false });

    const res = await declarerLot(tokenPour(user, 'SUPPLIER'), {
      ...champsBase(prod, { id: 999999 }),
    });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un prix négatif (400)', async () => {
    const user = await fournisseur();
    const prod = await produit();
    const z = await zone();

    const res = await declarerLot(tokenPour(user, 'SUPPLIER'), {
      ...champsBase(prod, z),
      agreedUnitPrice: '-10',
    });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un storageType invalide (400)', async () => {
    const user = await fournisseur();
    const prod = await produit();
    const z = await zone();

    const res = await declarerLot(tokenPour(user, 'SUPPLIER'), {
      ...champsBase(prod, z),
      storageType: 'WAREHOUSE',
    });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un BUYER (403)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const prod = await produit();
    const z = await zone();

    const res = await declarerLot(tokenPour(buyer, 'BUYER'), champsBase(prod, z));

    expect(res.status, res.text).toBe(403);
  });
});

describe('GET /api/v2/supplier/lots — lecture', () => {
  it('liste les lots du connecté, paginés { items, page, limit, total }', async () => {
    const user = await fournisseur();
    const token = tokenPour(user, 'SUPPLIER');
    await declarentLotSurSite(token);
    await declarentLotSurSite(token);

    const res = await client.get('/api/v2/supplier/lots').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ page: 1, limit: 20, total: 2 });
    expect(res.body.items).toHaveLength(2);
    // Les lots d'un autre fournisseur n'apparaissent pas.
    expect(res.body.items.every((l) => l.lotCode)).toBe(true);
  });

  it('ne liste pas les lots des autres fournisseurs', async () => {
    const user = await fournisseur();
    const autre = await fournisseur();
    await declarentLotSurSite(tokenPour(autre, 'SUPPLIER'));

    const res = await client
      .get('/api/v2/supplier/lots')
      .set(authHeader(tokenPour(user, 'SUPPLIER')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it('filtre sur ?status=', async () => {
    const user = await fournisseur();
    const token = tokenPour(user, 'SUPPLIER');
    const premier = await declarentLotSurSite(token);
    await declarentLotSurSite(token);
    // Un lot validé (transition P2.4, écrite directement en base ici).
    await prisma.stockLot.update({
      where: { id: premier.body.id },
      data: { status: 'AVAILABLE' },
    });

    const res = await client.get('/api/v2/supplier/lots?status=AVAILABLE').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(premier.body.id);
  });

  it('refuse un ?status= invalide (400)', async () => {
    const user = await fournisseur();

    const res = await client
      .get('/api/v2/supplier/lots?status=INCONNU')
      .set(authHeader(tokenPour(user, 'SUPPLIER')));

    expect(res.status, res.text).toBe(400);
  });

  it('renvoie le détail d un lot avec toutes les informations du DTO', async () => {
    const user = await fournisseur();
    const token = tokenPour(user, 'SUPPLIER');
    const res = await declarentLotSurSite(token, {}, [FAKE_JPEG]);

    const detail = await client.get(`/api/v2/supplier/lots/${res.body.id}`).set(authHeader(token));

    expect(detail.status, detail.text).toBe(200);
    expect(detail.body.lotCode).toBe(res.body.lotCode);
    expect(detail.body.product.name).toBe(res.body.product.name);
    expect(detail.body.quantityInitial).toBe(1500);
    expect(detail.body.quantityAvailable).toBe(1500);
    expect(detail.body.status).toBe('PENDING_VALIDATION');
    expect(detail.body.images).toHaveLength(1);
    expect(detail.body.createdAt).toBeTruthy();
    expect(detail.body.expiresAt).toBeTruthy();
  });

  it('répond 404 pour un lot qui n est pas à lui', async () => {
    const proprietaire = await fournisseur();
    const autre = await fournisseur();
    const res = await declarentLotSurSite(tokenPour(proprietaire, 'SUPPLIER'));

    const detail = await client
      .get(`/api/v2/supplier/lots/${res.body.id}`)
      .set(authHeader(tokenPour(autre, 'SUPPLIER')));

    expect(detail.status, detail.text).toBe(404);
  });

  it('répond 404 pour un lot inconnu', async () => {
    const user = await fournisseur();

    const res = await client.get('/api/v2/supplier/lots/999999').set(authHeader(tokenPour(user, 'SUPPLIER')));

    expect(res.status, res.text).toBe(404);
  });

  it('refuse un BUYER (403)', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const res = await client.get('/api/v2/supplier/lots').set(authHeader(tokenPour(buyer, 'BUYER')));

    expect(res.status, res.text).toBe(403);
  });
});

describe('PATCH /api/v2/supplier/lots/:id — modification', () => {
  it('modifie prix et quantité : 201, quantityInitial = quantityAvailable = nouvelle quantité', async () => {
    const user = await fournisseur();
    const token = tokenPour(user, 'SUPPLIER');
    const res = await declarentLotSurSite(token);

    const patch = await client
      .patch(`/api/v2/supplier/lots/${res.body.id}`)
      .set(authHeader(token))
      .send({ agreedUnitPrice: '1500.75', quantity: '2000' });

    expect(patch.status, patch.text).toBe(200);
    expect(patch.body.agreedUnitPrice).toBe(1500.75);
    expect(patch.body.quantityInitial).toBe(2000);
    expect(patch.body.quantityAvailable).toBe(2000);

    const enBase = await prisma.stockLot.findUnique({ where: { id: res.body.id } });
    expect(enBase.agreedUnitPrice.toNumber()).toBe(1500.75);
    expect(enBase.quantityInitial.toNumber()).toBe(2000);
    expect(enBase.quantityAvailable.toNumber()).toBe(2000);
  });

  it('modifie dates et notes : 200', async () => {
    const user = await fournisseur();
    const token = tokenPour(user, 'SUPPLIER');
    const res = await declarentLotSurSite(token);
    const newHarvested = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

    const patch = await client
      .patch(`/api/v2/supplier/lots/${res.body.id}`)
      .set(authHeader(token))
      .send({
        harvestedAt: newHarvested,
        packagingNote: 'Sacs de 50 kg',
        qualityNote: 'Calibres moyens',
      });

    expect(patch.status, patch.text).toBe(200);
    expect(patch.body.packagingNote).toBe('Sacs de 50 kg');
    expect(patch.body.qualityNote).toBe('Calibres moyens');
    expect(patch.body.harvestedAt).toBeTruthy();
  });

  it('refuse la modification après validation : 409 INVALID_STATE_TRANSITION', async () => {
    const user = await fournisseur();
    const token = tokenPour(user, 'SUPPLIER');
    const res = await declarentLotSurSite(token);
    // Lot validé (transition P2.4, écrite directement en base ici).
    await prisma.stockLot.update({
      where: { id: res.body.id },
      data: { status: 'AVAILABLE' },
    });

    const patch = await client
      .patch(`/api/v2/supplier/lots/${res.body.id}`)
      .set(authHeader(token))
      .send({ agreedUnitPrice: '900' });

    expect(patch.status, patch.text).toBe(409);
    expect(patch.body.code).toBe('INVALID_STATE_TRANSITION');

    // Le prix n'a pas changé.
    const enBase = await prisma.stockLot.findUnique({ where: { id: res.body.id } });
    expect(enBase.agreedUnitPrice.toNumber()).toBe(1250.5);
  });

  it('refuse un PATCH sans champ modifiable (400)', async () => {
    const user = await fournisseur();
    const token = tokenPour(user, 'SUPPLIER');
    const res = await declarentLotSurSite(token);

    const patch = await client.patch(`/api/v2/supplier/lots/${res.body.id}`).set(authHeader(token)).send({});

    expect(patch.status, patch.text).toBe(400);
  });

  it('refuse un prix invalide (400)', async () => {
    const user = await fournisseur();
    const token = tokenPour(user, 'SUPPLIER');
    const res = await declarentLotSurSite(token);

    const patch = await client
      .patch(`/api/v2/supplier/lots/${res.body.id}`)
      .set(authHeader(token))
      .send({ agreedUnitPrice: '12.555' });

    expect(patch.status, patch.text).toBe(400);
  });

  it('répond 404 pour un lot qui n est pas à lui', async () => {
    const proprietaire = await fournisseur();
    const autre = await fournisseur();
    const res = await declarentLotSurSite(tokenPour(proprietaire, 'SUPPLIER'));

    const patch = await client
      .patch(`/api/v2/supplier/lots/${res.body.id}`)
      .set(authHeader(tokenPour(autre, 'SUPPLIER')))
      .send({ agreedUnitPrice: '900' });

    expect(patch.status, patch.text).toBe(404);
  });
});

describe('DELETE /api/v2/supplier/lots/:id — suppression', () => {
  it('supprime définitivement un lot PENDING_VALIDATION et ses photos (204)', async () => {
    const user = await fournisseur();
    const token = tokenPour(user, 'SUPPLIER');
    const res = await declarentLotSurSite(token, {}, [FAKE_JPEG, FAKE_PNG]);
    const lotId = res.body.id;

    const suppression = await client.delete(`/api/v2/supplier/lots/${lotId}`).set(authHeader(token));

    expect(suppression.status, suppression.text).toBe(204);

    // Lot et lignes Media supprimés en base (ON DELETE CASCADE).
    const enBase = await prisma.stockLot.findUnique({ where: { id: lotId } });
    expect(enBase).toBeNull();
    const media = await prisma.media.findMany({ where: { ownerLotId: lotId } });
    expect(media).toHaveLength(0);
  });

  it('supprime un lot REJECTED (204)', async () => {
    const user = await fournisseur();
    const token = tokenPour(user, 'SUPPLIER');
    const res = await declarentLotSurSite(token);
    await prisma.stockLot.update({
      where: { id: res.body.id },
      data: { status: 'REJECTED', rejectionReason: 'Qualité insuffisante' },
    });

    const suppression = await client
      .delete(`/api/v2/supplier/lots/${res.body.id}`)
      .set(authHeader(token));

    expect(suppression.status, suppression.text).toBe(204);
  });

  it('refuse la suppression d un lot AVAILABLE : 409 INVALID_STATE_TRANSITION', async () => {
    const user = await fournisseur();
    const token = tokenPour(user, 'SUPPLIER');
    const res = await declarentLotSurSite(token);
    await prisma.stockLot.update({
      where: { id: res.body.id },
      data: { status: 'AVAILABLE' },
    });

    const suppression = await client
      .delete(`/api/v2/supplier/lots/${res.body.id}`)
      .set(authHeader(token));

    expect(suppression.status, suppression.text).toBe(409);
    expect(suppression.body.code).toBe('INVALID_STATE_TRANSITION');

    // Le lot existe toujours.
    const enBase = await prisma.stockLot.findUnique({ where: { id: res.body.id } });
    expect(enBase).toBeTruthy();
  });

  it('répond 404 pour un lot qui n est pas à lui', async () => {
    const proprietaire = await fournisseur();
    const autre = await fournisseur();
    const res = await declarentLotSurSite(tokenPour(proprietaire, 'SUPPLIER'));

    const suppression = await client
      .delete(`/api/v2/supplier/lots/${res.body.id}`)
      .set(authHeader(tokenPour(autre, 'SUPPLIER')));

    expect(suppression.status, suppression.text).toBe(404);
  });

  it('refuse un BUYER (403)', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const res = await client
      .delete('/api/v2/supplier/lots/1')
      .set(authHeader(tokenPour(buyer, 'BUYER')));

    expect(res.status, res.text).toBe(403);
  });
});
