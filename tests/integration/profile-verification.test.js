import { describe, it, expect } from 'vitest';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser, createVerifiedUser, createListingForLot } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

// requireVerifiedProfile (D2) : seules quelques actions sont reservees aux
// comptes dont le profil est VERIFIED. Ces tests verrouillent les deux moities
// du comportement : le refus des trois statuts non verifies, et l'absence
// d'effet sur tout le reste de l'API.

const Decimal = Prisma.Decimal;
const DANS_7_JOURS = new Date(Date.now() + 7 * 24 * 3600 * 1000);
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const FAKE_PDF = Buffer.from('%PDF-1.4 factice');

const STATUTS_REFUSES = ['UNVERIFIED', 'PENDING', 'REJECTED'];

function identifiant(prefixe) {
  return `${prefixe}-${Date.now()}-${randomInt(1_000, 9_999)}`;
}

function tokenAcheteurPour(user) {
  return generateToken({ id: user.id, role: { code: 'BUYER', level: 10 } });
}

function tokenFournisseurPour(user) {
  return generateToken({ id: user.id, role: { code: 'SUPPLIER', level: 20 } });
}

async function statutDe(user, statut) {
  return prisma.user.update({ where: { id: user.id }, data: { profileVerificationStatus: statut } });
}

// --- Fixtures ---

// Fournisseur avec profil fournisseur et profil vérifié : c'est lui qui déclare
// les lots que les tests vont ensuite modifier ou retirer.
async function fournisseurVerifie() {
  const user = await createVerifiedUser({ role: 'SUPPLIER' });
  await prisma.supplierProfile.create({
    data: { userId: user.id, farmName: 'Ferme du Test' },
  });
  return user;
}

async function produit() {
  const [category, unit] = await Promise.all([
    prisma.productCategory.findFirst(),
    prisma.unit.findFirst(),
  ]);
  return prisma.product.create({
    data: {
      categoryId: category.id,
      unitId: unit.id,
      name: identifiant('Produit'),
      isPerishable: false,
    },
  });
}

async function zone() {
  return prisma.zone.create({ data: { name: identifiant('Zone') } });
}

async function lotPour(supplierId, zoneId, productId) {
  return prisma.stockLot.create({
    data: {
      lotCode: identifiant('LOT'),
      supplierId,
      productId,
      zoneId,
      agreedUnitPrice: '1000.00',
      quantityInitial: new Decimal('10'),
      quantityAvailable: new Decimal('10'),
      storageType: 'SUPPLIER_SITE',
      pickupAddress: '12 route de la ferme',
      pickupLatitude: 12.34,
      pickupLongitude: -5.67,
      expiresAt: DANS_7_JOURS,
      status: 'AVAILABLE',
    },
  });
}

async function agentAvecCapacite(capacites) {
  const user = await createUser({ role: 'AGENT' });
  const agent = await prisma.agent.create({
    data: { kind: 'HUMAN', userId: user.id, displayName: 'Agent Test', isActive: true },
  });
  for (const code of capacites) {
    const cap = await prisma.agentCapability.findFirst({ where: { code } });
    await prisma.agentCapabilityLink.create({ data: { agentId: agent.id, capabilityId: cap.id } });
  }
  return user;
}

// Devis QUOTED cree par la vraie route staff, comme en production. Le
// fournisseur du lot est verifie (sinon staffLot.validateLot le refuse).
async function creerDevisPour(buyerId) {
  const supplierUser = await fournisseurVerifie();
  const supplierProfile = await prisma.supplierProfile.findUnique({ where: { userId: supplierUser.id } });
  const [prod, z] = await Promise.all([produit(), zone()]);
  const lot = await lotPour(supplierProfile.id, z.id, prod.id);
  const annonce = await createListingForLot(lot);
  await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1200.00' } });
  const hub = await prisma.hub.create({
    data: {
      name: 'Hub Test',
      address: '1 rue du Hub',
      city: 'Ville',
      latitude: 12.34,
      longitude: -5.67,
      zoneId: z.id,
      acceptsPickup: true,
      isActive: true,
    },
  });
  const agentUser = await agentAvecCapacite(['ORDER_PROCESSING']);

  const res = await api()
    .post('/api/v2/staff/orders')
    .set(authHeader(generateToken({ id: agentUser.id, role: { code: 'AGENT', level: 30 } })))
    .send({
      buyerId,
      items: [{ listingId: annonce.id, quantity: 5 }],
      deliveryMode: 'HUB_PICKUP',
      pickupHubId: hub.id,
    });
  expect(res.status, res.text).toBe(201);
  return { order: res.body, lot, supplierUser };
}

function champsBase(prod, z) {
  return {
    productId: prod.id,
    zoneId: z.id,
    agreedUnitPrice: '1250.50',
    quantity: '1500',
    storageType: 'SUPPLIER_SITE',
    pickupAddress: '12 route de la ferme',
    pickupLatitude: '12.34',
    pickupLongitude: '-5.67',
    expiresAt: DANS_7_JOURS.toISOString(),
  };
}

async function declarerLot(token, prod, z) {
  let requete = api().post('/api/v2/supplier/lots').set(authHeader(token));
  for (const [cle, valeur] of Object.entries(champsBase(prod, z))) {
    requete = requete.field(cle, String(valeur));
  }
  return requete.attach('images', FAKE_JPEG, { filename: 'photo.jpg', contentType: 'image/jpeg' });
}

// Un lot AVAILABLE détenu par le fournisseur : PENDING_VALIDATION puis validation
// par le staff, seule façon d'atteindre AVAILABLE.
async function lotAvailable(token) {
  const [prod, z] = await Promise.all([produit(), zone()]);
  const res = await declarerLot(token, prod, z);
  expect(res.status, res.text).toBe(201);

  const agentUser = await agentAvecCapacite(['STOCK_VALIDATION']);
  const validation = await api()
    .post(`/api/v2/staff/lots/${res.body.id}/validate`)
    .set(authHeader(generateToken({ id: agentUser.id, role: { code: 'AGENT', level: 30 } })));
  expect(validation.status, validation.text).toBe(200);

  return { id: res.body.id };
}

describe('requireVerifiedProfile — routes réservées aux profils vérifiés (D2)', () => {
  describe('POST /api/v2/orders/:id/confirm', () => {
    it.each(STATUTS_REFUSES)('un acheteur %s est refusé : 403 PROFILE_NOT_VERIFIED', async (statut) => {
      const buyer = await createUser({ role: 'BUYER' });
      await statutDe(buyer, statut);
      const { order } = await creerDevisPour(buyer.id);

      const res = await api()
        .post(`/api/v2/orders/${order.id}/confirm`)
        .set(authHeader(tokenAcheteurPour(buyer)));

      expect(res.status, res.text).toBe(403);
      expect(res.body).toMatchObject({
        error: 'Votre profil doit être vérifié pour effectuer cette action',
        code: 'PROFILE_NOT_VERIFIED',
        profileVerificationStatus: statut,
      });

      // Le devis n'a pas bougé : le refus est bien antérieur au contrôleur.
      const enBase = await prisma.order.findUnique({ where: { id: order.id } });
      expect(enBase.status).toBe('QUOTED');
      expect(enBase.confirmedAt).toBeNull();
    });

    it('un acheteur VERIFIED confirme son devis : 200 CONFIRMED', async () => {
      const buyer = await createVerifiedUser({ role: 'BUYER' });
      const { order } = await creerDevisPour(buyer.id);

      const res = await api()
        .post(`/api/v2/orders/${order.id}/confirm`)
        .set(authHeader(tokenAcheteurPour(buyer)));

      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('CONFIRMED');
      expect(res.body.confirmedAt).toBeTruthy();
    });
  });

  describe('POST /api/v2/supplier/lots', () => {
    it.each(STATUTS_REFUSES)('un fournisseur %s est refusé : 403 PROFILE_NOT_VERIFIED', async (statut) => {
      const supplierUser = await fournisseurVerifie();
      await statutDe(supplierUser, statut);
      const [prod, z] = await Promise.all([produit(), zone()]);

      const res = await declarerLot(tokenFournisseurPour(supplierUser), prod, z);

      expect(res.status, res.text).toBe(403);
      expect(res.body).toMatchObject({
        error: 'Votre profil doit être vérifié pour effectuer cette action',
        code: 'PROFILE_NOT_VERIFIED',
        profileVerificationStatus: statut,
      });

      // Aucun lot, aucune photo : le refus precede multer et le controleur.
      expect(await prisma.stockLot.count()).toBe(0);
      expect(await prisma.media.count()).toBe(0);
    });

    it('un fournisseur VERIFIED declare un lot : 201', async () => {
      const supplierUser = await fournisseurVerifie();
      const [prod, z] = await Promise.all([produit(), zone()]);

      const res = await declarerLot(tokenFournisseurPour(supplierUser), prod, z);

      expect(res.status, res.text).toBe(201);
      expect(res.body.status).toBe('PENDING_VALIDATION');
    });
  });

  describe('PATCH /api/v2/supplier/lots/:id', () => {
    it.each(STATUTS_REFUSES)('un fournisseur %s ne modifie pas son lot : 403 PROFILE_NOT_VERIFIED', async (statut) => {
      const supplierUser = await fournisseurVerifie();
      const token = tokenFournisseurPour(supplierUser);
      const { id } = await lotAvailable(token);
      await statutDe(supplierUser, statut);

      const res = await api()
        .patch(`/api/v2/supplier/lots/${id}`)
        .set(authHeader(token))
        .send({ quantity: '999' });

      expect(res.status, res.text).toBe(403);
      expect(res.body).toMatchObject({
        code: 'PROFILE_NOT_VERIFIED',
        profileVerificationStatus: statut,
      });

      const enBase = await prisma.stockLot.findUnique({ where: { id } });
      expect(enBase.quantityInitial.toNumber()).toBe(1500);
    });

    it('un fournisseur VERIFIED modifie son lot : 200', async () => {
      const supplierUser = await fournisseurVerifie();
      const token = tokenFournisseurPour(supplierUser);
      // PENDING_VALIDATION : seul état modifiable.
      const [prod, z] = await Promise.all([produit(), zone()]);
      const res = await declarerLot(token, prod, z);
      expect(res.status, res.text).toBe(201);

      const patch = await api()
        .patch(`/api/v2/supplier/lots/${res.body.id}`)
        .set(authHeader(token))
        .send({ quantity: '2000' });

      expect(patch.status, patch.text).toBe(200);
      expect(patch.body.quantityInitial).toBe(2000);
    });
  });

  describe('POST /api/v2/supplier/lots/:id/withdraw', () => {
    it.each(STATUTS_REFUSES)('un fournisseur %s ne retire pas son lot : 403 PROFILE_NOT_VERIFIED', async (statut) => {
      const supplierUser = await fournisseurVerifie();
      const token = tokenFournisseurPour(supplierUser);
      const { id } = await lotAvailable(token);
      await statutDe(supplierUser, statut);

      const res = await api()
        .post(`/api/v2/supplier/lots/${id}/withdraw`)
        .set(authHeader(token))
        .send({ reason: 'Plus besoin' });

      expect(res.status, res.text).toBe(403);
      expect(res.body).toMatchObject({
        code: 'PROFILE_NOT_VERIFIED',
        profileVerificationStatus: statut,
      });

      const enBase = await prisma.stockLot.findUnique({ where: { id } });
      expect(enBase.status).toBe('AVAILABLE');
    });

    it('un fournisseur VERIFIED retire son lot : 200', async () => {
      const supplierUser = await fournisseurVerifie();
      const token = tokenFournisseurPour(supplierUser);
      const { id } = await lotAvailable(token);

      const res = await api()
        .post(`/api/v2/supplier/lots/${id}/withdraw`)
        .set(authHeader(token))
        .send({ reason: 'Plus besoin' });

      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('WITHDRAWN');
    });
  });
});

describe('requireVerifiedProfile — les autres routes restent ouvertes', () => {
  it('un compte UNVERIFIED peut toujours déposer un document (PENDING)', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const res = await api()
      .post('/api/v2/auth/me/documents')
      .set(authHeader(tokenAcheteurPour(buyer)))
      .attach('file', FAKE_PDF, { filename: 'doc.pdf', contentType: 'application/pdf' })
      .field('type', 'ID_CARD');

    expect(res.status, res.text).toBe(201);
    const user = await prisma.user.findUnique({ where: { id: buyer.id } });
    expect(user.profileVerificationStatus).toBe('PENDING');
  });

  it('un compte UNVERIFIED lit, annule et manages ses commandes', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const { order } = await creerDevisPour(buyer.id);
    const token = tokenAcheteurPour(buyer);

    const liste = await api().get('/api/v2/orders').set(authHeader(token));
    expect(liste.status, liste.text).toBe(200);

    const detail = await api().get(`/api/v2/orders/${order.id}`).set(authHeader(token));
    expect(detail.status, detail.text).toBe(200);

    const annulation = await api().post(`/api/v2/orders/${order.id}/cancel`).set(authHeader(token)).send({});
    expect(annulation.status, annulation.text).toBe(200);
    expect(annulation.body.status).toBe('CANCELLED');
  });

  it('un fournisseur UNVERIFIED lit et supprime ses lots', async () => {
    const supplierUser = await fournisseurVerifie();
    const token = tokenFournisseurPour(supplierUser);
    const [prod, z] = await Promise.all([produit(), zone()]);
    const creation = await declarerLot(token, prod, z);
    expect(creation.status, creation.text).toBe(201);
    await statutDe(supplierUser, 'REJECTED');

    const liste = await api().get('/api/v2/supplier/lots').set(authHeader(token));
    expect(liste.status, liste.text).toBe(200);

    const detail = await api().get(`/api/v2/supplier/lots/${creation.body.id}`).set(authHeader(token));
    expect(detail.status, detail.text).toBe(200);

    const suppression = await api().delete(`/api/v2/supplier/lots/${creation.body.id}`).set(authHeader(token));
    expect(suppression.status, suppression.text).toBe(204);
  });

  it('un compte UNVERIFIED lit le catalogue et ouvre une conversation', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const token = tokenAcheteurPour(buyer);

    const catalogue = await api().get('/api/v2/catalog/listings').set(authHeader(token));
    expect(catalogue.status, catalogue.text).toBe(200);

    const conversation = await api()
      .post('/api/v2/conversations')
      .set(authHeader(token))
      .send({ content: 'Comment passer une commande ?' });
    expect(conversation.status, conversation.text).toBe(201);
  });
});
