import { describe, it, expect } from 'vitest';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser, createListingForLot } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { assertNoLeak } from '../helpers/assertNoLeak.js';

const Decimal = Prisma.Decimal;

const DANS_7_JOURS = new Date(Date.now() + 7 * 24 * 3600 * 1000);

// --- Fixtures (reprises de staff-orders.test.js : la creation d'un devis
// passe par la vraie route staff, comme en production) ---

function identifiant(prefixe) {
  return `${prefixe}-${Date.now()}-${randomInt(1_000, 9_999)}`;
}

async function fournisseur() {
  const user = await createUser({ role: 'SUPPLIER' });
  const profile = await prisma.supplierProfile.create({
    data: { userId: user.id, farmName: 'Ferme du Test' },
  });
  return { user, profile };
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

async function creerLot({ quantity = '100', agreedUnitPrice = '1000.00', storageType = 'SUPPLIER_SITE', overrides = {} } = {}) {
  const { profile } = await fournisseur();
  const product = await produit();
  const zoneTest = await zone();
  return prisma.stockLot.create({
    data: {
      lotCode: identifiant('LOT'),
      supplierId: profile.id,
      productId: product.id,
      zoneId: zoneTest.id,
      agreedUnitPrice,
      quantityInitial: new Decimal(quantity),
      quantityAvailable: new Decimal(quantity),
      storageType,
      pickupAddress: '12 route de la ferme',
      pickupLatitude: 12.34,
      pickupLongitude: -5.67,
      expiresAt: DANS_7_JOURS,
      status: 'AVAILABLE',
      ...overrides,
    },
  });
}

async function annoncePour(lot, overrides = {}) {
  return createListingForLot(lot, overrides);
}

async function creerHub(overrides = {}) {
  return prisma.hub.create({
    data: {
      name: 'Hub Test',
      address: '1 rue du Hub',
      city: 'Ville',
      latitude: 12.34,
      longitude: -5.67,
      zoneId: (await zone()).id,
      acceptsPickup: true,
      isActive: true,
      ...overrides,
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
  return { user, agent };
}

async function admin() {
  return createUser({ role: 'ADMIN' });
}

function tokenPour(user) {
  return generateToken({ id: user.id, role: { code: 'AGENT', level: 30 } });
}

function tokenAdminPour(user) {
  return generateToken({ id: user.id, role: { code: 'ADMIN', level: 50 } });
}

// Zone de livraison couverte par une agence (AGENCY_DELIVERY).
async function zoneCouverte() {
  const zoneLivraison = await zone();
  const agency = await prisma.transportAgency.create({
    data: { name: 'Agence Test', phone: '+33600000000', isActive: true },
  });
  await prisma.agencyZone.create({
    data: {
      agencyId: agency.id,
      zoneId: zoneLivraison.id,
      baseFee: '500',
      perKmFee: '100',
      isActive: true,
    },
  });
  return zoneLivraison;
}

// Devis HUB_PICKUP complet : acheteur, lot, annonce, hub, route staff.
async function creerDevisHub(overrides = {}) {
  const buyer = await createUser({ role: 'BUYER' });
  const monLot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
  const annonce = await annoncePour(monLot);
  await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1200.00' } });
  const hub = await creerHub();
  const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

  const res = await api()
    .post('/api/v2/staff/orders')
    .set(authHeader(tokenPour(agentUser)))
    .send({
      buyerId: buyer.id,
      items: [{ listingId: annonce.id, quantity: 5 }],
      deliveryMode: 'HUB_PICKUP',
      pickupHubId: hub.id,
      ...overrides,
    });
  expect(res.status, res.text).toBe(201);
  return { order: res.body, buyer, lot: monLot, annonce, hub };
}

// Devis AGENCY_DELIVERY complet.
async function creerDevisAgency(overrides = {}) {
  const buyer = await createUser({ role: 'BUYER' });
  const monLot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
  const annonce = await annoncePour(monLot);
  await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1200.00' } });
  const zoneLivraison = await zoneCouverte();
  const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

  const res = await api()
    .post('/api/v2/staff/orders')
    .set(authHeader(tokenPour(agentUser)))
    .send({
      buyerId: buyer.id,
      items: [{ listingId: annonce.id, quantity: 5 }],
      deliveryMode: 'AGENCY_DELIVERY',
      delivery: {
        zoneId: zoneLivraison.id,
        address: '10 avenue de la Gare',
        latitude: 48.85,
        longitude: 2.35,
      },
      ...overrides,
    });
  expect(res.status, res.text).toBe(201);
  return { order: res.body, buyer, lot: monLot, annonce };
}

// PATCH /status par un agent ORDER_PROCESSING (ou un jeton fourni).
async function patchStatus(orderId, status, { force } = {}, token) {
  const agentUser = token ? null : (await agentAvecCapacite(['ORDER_PROCESSING'])).user;
  return api()
    .patch(`/api/v2/staff/orders/${orderId}/status`)
    .set(authHeader(token ?? tokenPour(agentUser)))
    .send(force === undefined ? { status } : { status, force });
}

describe('Cycle de vie de la commande (P3.5)', () => {
  describe('Confirmation par l\'acheteur', () => {
    it('confirme un devis QUOTED : confirmedAt pose, reservedUntil efface', async () => {
      const { order, buyer } = await creerDevisHub();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      const res = await api()
        .post(`/api/v2/orders/${order.id}/confirm`)
        .set(authHeader(tokenAcheteur));

      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('CONFIRMED');
      expect(res.body.confirmedAt).toBeTruthy();
      expect(res.body.reservedUntil).toBeNull();

      // Audit ORDER_CONFIRMED
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'ORDER_CONFIRMED', entityType: 'Order', entityId: order.id },
      });
      expect(audit).toBeTruthy();
    });

    it('un acheteur ne peut pas lire la commande d\'un autre acheteur : 404', async () => {
      const { order, buyer } = await creerDevisHub();
      const autreAcheteur = await createUser({ role: 'BUYER' });
      const tokenAutre = generateToken({ id: autreAcheteur.id, role: { code: 'BUYER', level: 10 } });

      const res = await api()
        .get(`/api/v2/orders/${order.id}`)
        .set(authHeader(tokenAutre));

      expect(res.status, res.text).toBe(404);
      expect(res.body.error).toBe('Commande introuvable');

      // Le propriétaire la lit sans probleme (le 404 ne concerne que les autres).
      const sien = await api()
        .get(`/api/v2/orders/${order.id}`)
        .set(authHeader(generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } })));
      expect(sien.status, sien.text).toBe(200);
    });

    it('un acheteur ne peut pas confirmer la commande d\'un autre : 404', async () => {
      const { order } = await creerDevisHub();
      const autreAcheteur = await createUser({ role: 'BUYER' });
      const tokenAutre = generateToken({ id: autreAcheteur.id, role: { code: 'BUYER', level: 10 } });

      const res = await api()
        .post(`/api/v2/orders/${order.id}/confirm`)
        .set(authHeader(tokenAutre));

      expect(res.status, res.text).toBe(404);
    });

    it('une deuxieme confirmation est refusee : 409 INVALID_STATE_TRANSITION', async () => {
      const { order, buyer } = await creerDevisHub();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      const premiere = await api()
        .post(`/api/v2/orders/${order.id}/confirm`)
        .set(authHeader(tokenAcheteur));
      expect(premiere.status, premiere.text).toBe(200);

      const deuxieme = await api()
        .post(`/api/v2/orders/${order.id}/confirm`)
        .set(authHeader(tokenAcheteur));

      expect(deuxieme.status, deuxieme.text).toBe(409);
      expect(deuxieme.body.code).toBe('INVALID_STATE_TRANSITION');
    });
  });

  describe('Confirmation apres expiration du devis', () => {
    it('409 QUOTE_EXPIRED et liberation des réservations (compteurs et mouvements)', async () => {
      const { order, buyer, lot } = await creerDevisHub();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      // Force l'expiration du devis.
      await prisma.order.update({
        where: { id: order.id },
        data: { reservedUntil: new Date(Date.now() - 60 * 1000) },
      });

      const res = await api()
        .post(`/api/v2/orders/${order.id}/confirm`)
        .set(authHeader(tokenAcheteur));

      expect(res.status, res.text).toBe(409);
      expect(res.body.code).toBe('QUOTE_EXPIRED');
      expect(res.body.error).toBe('Devis expiré');

      // Le stock est rendu disponible : 5 avaient ete reserves, tout est libere.
      const lotApres = await prisma.stockLot.findUnique({ where: { id: lot.id } });
      expect(Number(lotApres.quantityAvailable)).toBe(10);
      expect(Number(lotApres.quantityReserved)).toBe(0);

      // Un mouvement RESERVATION_RELEASED trace la libération, rattache a la ligne.
      const ligne = await prisma.orderItem.findFirst({ where: { orderId: order.id } });
      const mouvements = await prisma.stockMovement.findMany({
        where: { orderItemId: ligne.id, type: 'RESERVATION_RELEASED' },
      });
      expect(mouvements).toHaveLength(1);
      expect(Number(mouvements[0].quantityDelta)).toBe(-5);

      // La commande reste QUOTED (l'expiration n'annule pas le devis).
      const commande = await prisma.order.findUnique({ where: { id: order.id } });
      expect(commande.status).toBe('QUOTED');

      // Audit ORDER_QUOTE_EXPIRED
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'ORDER_QUOTE_EXPIRED', entityType: 'Order', entityId: order.id },
      });
      expect(audit).toBeTruthy();
    });

    it('l\'expiration s\'applique aussi a la confirmation par le staff', async () => {
      const { order } = await creerDevisHub();
      const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

      await prisma.order.update({
        where: { id: order.id },
        data: { reservedUntil: new Date(Date.now() - 60 * 1000) },
      });

      const res = await api()
        .post(`/api/v2/staff/orders/${order.id}/confirm`)
        .set(authHeader(tokenPour(agentUser)));

      expect(res.status, res.text).toBe(409);
      expect(res.body.code).toBe('QUOTE_EXPIRED');
    });

    it('une commande expiree peut encore etre annulee : pas de double liberation', async () => {
      const { order } = await creerDevisHub();
      const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

      await prisma.order.update({
        where: { id: order.id },
        data: { reservedUntil: new Date(Date.now() - 60 * 1000) },
      });

      // L'expiration lors de la tentative de confirmation libere le stock...
      await api()
        .post(`/api/v2/staff/orders/${order.id}/confirm`)
        .set(authHeader(tokenPour(agentUser)));

      // ...et l'annulation ne libere plus rien : un seul RESERVATION_RELEASED.
      const res = await api()
        .post(`/api/v2/staff/orders/${order.id}/cancel`)
        .set(authHeader(tokenPour(agentUser)))
        .send({ reason: 'Devis expiré abandonné' });

      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.cancellationReason).toBe('Devis expiré abandonné');

      const ligne = await prisma.orderItem.findFirst({ where: { orderId: order.id } });
      const liberations = await prisma.stockMovement.findMany({
        where: { orderItemId: ligne.id, type: 'RESERVATION_RELEASED' },
      });
      expect(liberations).toHaveLength(1);

      // L'invariant du lot tient toujours.
      const lotApres = await prisma.stockLot.findUnique({ where: { id: ligne.lotId } });
      expect(Number(lotApres.quantityAvailable) + Number(lotApres.quantityReserved)).toBe(10);
    });
  });

  describe('Annulation', () => {
    it('l\'acheteur annule son devis QUOTED : stock libere, cancelledAt et raison traces', async () => {
      const { order, buyer, lot } = await creerDevisHub();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      const res = await api()
        .post(`/api/v2/orders/${order.id}/cancel`)
        .set(authHeader(tokenAcheteur))
        .send({ reason: 'A changé d\'avis' });

      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.cancelledAt).toBeTruthy();
      expect(res.body.cancellationReason).toBe('A changé d\'avis');

      // Stock libéré : les 5 unités réservées sont redevenues disponibles.
      const lotApres = await prisma.stockLot.findUnique({ where: { id: lot.id } });
      expect(Number(lotApres.quantityAvailable)).toBe(10);
      expect(Number(lotApres.quantityReserved)).toBe(0);

      // Mouvement RESERVATION_RELEASED rattache a la ligne de la commande.
      const ligne = await prisma.orderItem.findFirst({ where: { orderId: order.id } });
      const mouvements = await prisma.stockMovement.findMany({
        where: { orderItemId: ligne.id, type: 'RESERVATION_RELEASED' },
      });
      expect(mouvements).toHaveLength(1);
      expect(Number(mouvements[0].quantityDelta)).toBe(-5);

      // Audit ORDER_CANCELLED avec la raison.
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'ORDER_CANCELLED', entityType: 'Order', entityId: order.id },
      });
      expect(audit).toBeTruthy();
      expect(audit.metadata.reason).toBe('A changé d\'avis');
    });

    it('le staff annule une commande CONFIRMED : memes effets', async () => {
      const { order, buyer, lot } = await creerDevisHub();
      const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      await api().post(`/api/v2/orders/${order.id}/confirm`).set(authHeader(tokenAcheteur));

      const res = await api()
        .post(`/api/v2/staff/orders/${order.id}/cancel`)
        .set(authHeader(tokenPour(agentUser)));

      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('CANCELLED');

      const lotApres = await prisma.stockLot.findUnique({ where: { id: lot.id } });
      expect(Number(lotApres.quantityAvailable)).toBe(10);
      expect(Number(lotApres.quantityReserved)).toBe(0);
    });

    it('une commande COMPLETED ne peut plus etre annulee : 409', async () => {
      const { order, buyer } = await creerDevisHub();
      const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      await api().post(`/api/v2/orders/${order.id}/confirm`).set(authHeader(tokenAcheteur));
      await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });
      await patchStatus(order.id, 'PREPARING');
      await patchStatus(order.id, 'READY_FOR_PICKUP');
      await patchStatus(order.id, 'COMPLETED');

      const res = await api()
        .post(`/api/v2/staff/orders/${order.id}/cancel`)
        .set(authHeader(tokenPour(agentUser)));

      expect(res.status, res.text).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });
  });

  describe('Completion : le réservé devient vendu', () => {
    it('READY_FOR_PICKUP -> COMPLETED : commitSale par ligne, completedAt', async () => {
      const { order, buyer, lot } = await creerDevisHub();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      await api().post(`/api/v2/orders/${order.id}/confirm`).set(authHeader(tokenAcheteur));
      await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });
      await patchStatus(order.id, 'PREPARING');
      await patchStatus(order.id, 'READY_FOR_PICKUP');

      const res = await patchStatus(order.id, 'COMPLETED');

      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('COMPLETED');
      expect(res.body.completedAt).toBeTruthy();

      // Compteurs du lot : les 5 réservés sont devenus vendus.
      const lotApres = await prisma.stockLot.findUnique({ where: { id: lot.id } });
      expect(Number(lotApres.quantityAvailable)).toBe(5);
      expect(Number(lotApres.quantityReserved)).toBe(0);
      expect(Number(lotApres.quantitySold)).toBe(5);

      // Un mouvement SOLD rattache a la ligne.
      const ligne = await prisma.orderItem.findFirst({ where: { orderId: order.id } });
      const mouvements = await prisma.stockMovement.findMany({
        where: { orderItemId: ligne.id, type: 'SOLD' },
      });
      expect(mouvements).toHaveLength(1);
      expect(Number(mouvements[0].quantityDelta)).toBe(5);

      // Audit ORDER_COMPLETED
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'ORDER_COMPLETED', entityType: 'Order', entityId: order.id },
      });
      expect(audit).toBeTruthy();
    });
  });

  describe('PREPARING exige le paiement', () => {
    it('sans paiement enregistre : 409 PAYMENT_REQUIRED', async () => {
      const { order, buyer } = await creerDevisHub();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      await api().post(`/api/v2/orders/${order.id}/confirm`).set(authHeader(tokenAcheteur));

      const res = await patchStatus(order.id, 'PREPARING');

      expect(res.status, res.text).toBe(409);
      expect(res.body.code).toBe('PAYMENT_REQUIRED');
    });

    it('avec paymentStatus PAID : 200', async () => {
      const { order, buyer } = await creerDevisHub();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      await api().post(`/api/v2/orders/${order.id}/confirm`).set(authHeader(tokenAcheteur));
      await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });

      const res = await patchStatus(order.id, 'PREPARING');

      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('PREPARING');
    });

    it('force: true par un AGENT : 403 FORCE_FORBIDDEN', async () => {
      const { order, buyer } = await creerDevisHub();
      const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      await api().post(`/api/v2/orders/${order.id}/confirm`).set(authHeader(tokenAcheteur));

      const res = await api()
        .patch(`/api/v2/staff/orders/${order.id}/status`)
        .set(authHeader(tokenPour(agentUser)))
        .send({ status: 'PREPARING', force: true });

      expect(res.status, res.text).toBe(403);
      expect(res.body.code).toBe('FORCE_FORBIDDEN');
    });

    it('force: true par un ADMIN : 200 et forcage trace dans l\'audit', async () => {
      const { order, buyer } = await creerDevisHub();
      const adminUser = await admin();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      await api().post(`/api/v2/orders/${order.id}/confirm`).set(authHeader(tokenAcheteur));

      const res = await api()
        .patch(`/api/v2/staff/orders/${order.id}/status`)
        .set(authHeader(tokenAdminPour(adminUser)))
        .send({ status: 'PREPARING', force: true });

      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('PREPARING');

      // L'audit trace le forcage.
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'ORDER_STATUS_CHANGED', entityType: 'Order', entityId: order.id },
      });
      expect(audit).toBeTruthy();
      expect(audit.metadata.forced).toBe(true);
      expect(audit.metadata.from).toBe('CONFIRMED');
      expect(audit.metadata.to).toBe('PREPARING');
    });
  });

  describe('Mode de livraison et transitions', () => {
    it('READY_FOR_PICKUP sur une commande AGENCY_DELIVERY : 409', async () => {
      const { order, buyer } = await creerDevisAgency();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      await api().post(`/api/v2/orders/${order.id}/confirm`).set(authHeader(tokenAcheteur));
      await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });
      await patchStatus(order.id, 'PREPARING');

      const res = await patchStatus(order.id, 'READY_FOR_PICKUP');

      expect(res.status, res.text).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('OUT_FOR_DELIVERY sur une commande HUB_PICKUP : 409', async () => {
      const { order, buyer } = await creerDevisHub();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      await api().post(`/api/v2/orders/${order.id}/confirm`).set(authHeader(tokenAcheteur));
      await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });
      await patchStatus(order.id, 'PREPARING');

      const res = await patchStatus(order.id, 'OUT_FOR_DELIVERY');

      expect(res.status, res.text).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('OUT_FOR_DELIVERY est interdit en manuel, meme sur AGENCY_DELIVERY : 409', async () => {
      const { order, buyer } = await creerDevisAgency();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      await api().post(`/api/v2/orders/${order.id}/confirm`).set(authHeader(tokenAcheteur));
      await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });
      await patchStatus(order.id, 'PREPARING');

      const res = await patchStatus(order.id, 'OUT_FOR_DELIVERY');

      expect(res.status, res.text).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });
  });

  describe('Transitions interdites via l\'API staff', () => {
    it('QUOTED -> PREPARING : 409', async () => {
      const { order } = await creerDevisHub();
      const res = await patchStatus(order.id, 'PREPARING');
      expect(res.status, res.text).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('QUOTED -> COMPLETED : 409', async () => {
      const { order } = await creerDevisHub();
      const res = await patchStatus(order.id, 'COMPLETED');
      expect(res.status, res.text).toBe(409);
    });

    it('CONFIRMED -> COMPLETED : 409', async () => {
      const { order, buyer } = await creerDevisHub();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });
      await api().post(`/api/v2/orders/${order.id}/confirm`).set(authHeader(tokenAcheteur));

      const res = await patchStatus(order.id, 'COMPLETED');
      expect(res.status, res.text).toBe(409);
    });

    it('CONFIRMED -> READY_FOR_PICKUP : 409', async () => {
      const { order, buyer } = await creerDevisHub();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });
      await api().post(`/api/v2/orders/${order.id}/confirm`).set(authHeader(tokenAcheteur));

      const res = await patchStatus(order.id, 'READY_FOR_PICKUP');
      expect(res.status, res.text).toBe(409);
    });

    it('PREPARING -> COMPLETED : 409', async () => {
      const { order, buyer } = await creerDevisHub();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });
      await api().post(`/api/v2/orders/${order.id}/confirm`).set(authHeader(tokenAcheteur));
      await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });
      await patchStatus(order.id, 'PREPARING');

      const res = await patchStatus(order.id, 'COMPLETED');
      expect(res.status, res.text).toBe(409);
    });

    it('COMPLETED -> CANCELLED : 409 (statut terminal)', async () => {
      const { order, buyer } = await creerDevisHub();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });
      await api().post(`/api/v2/orders/${order.id}/confirm`).set(authHeader(tokenAcheteur));
      await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });
      await patchStatus(order.id, 'PREPARING');
      await patchStatus(order.id, 'READY_FOR_PICKUP');
      await patchStatus(order.id, 'COMPLETED');

      const res = await patchStatus(order.id, 'CANCELLED');
      expect(res.status, res.text).toBe(409);
    });

    it('CANCELLED -> CONFIRMED : 409 (statut terminal)', async () => {
      const { order } = await creerDevisHub();
      const annulation = await patchStatus(order.id, 'CANCELLED');
      expect(annulation.status, annulation.text).toBe(200);

      const res = await patchStatus(order.id, 'CONFIRMED');
      expect(res.status, res.text).toBe(409);
    });
  });

  describe('Consultation', () => {
    it('GET /api/v2/orders liste les commandes de l\'acheteur (paginé, sans fuite)', async () => {
      const { order, buyer } = await creerDevisHub();
      // Une seconde commande d'un autre acheteur ne doit pas apparaitre.
      await creerDevisHub();
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      const res = await api()
        .get('/api/v2/orders')
        .set(authHeader(tokenAcheteur));

      expect(res.status, res.text).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(res.body).toHaveProperty('page');
      expect(res.body).toHaveProperty('limit');
      expect(res.body.total).toBe(1);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].id).toBe(order.id);

      // Le DTO acheteur n'expose aucune donnee interne.
      assertNoLeak(res.body.items[0], [
        'supplierId',
        'farmName',
        'lotId',
        'lotCode',
        'agreedUnitPrice',
        'supplierUnitPrice',
        'pickupAddress',
        'pickupLatitude',
        'pickupLongitude',
        'commissionRate',
        'commissionAmount',
        'supplierNetAmount',
        'origins',
      ]);
    });

    it('GET /api/v2/staff/orders liste toutes les commandes (DTO staff complet)', async () => {
      const { order } = await creerDevisHub();
      const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

      const res = await api()
        .get('/api/v2/staff/orders')
        .set(authHeader(tokenPour(agentUser)));

      expect(res.status, res.text).toBe(200);
      expect(res.body.total).toBeGreaterThanOrEqual(1);
      const laCommande = res.body.items.find((o) => o.id === order.id);
      expect(laCommande).toBeTruthy();
      // Le DTO staff expose les donnees internes.
      expect(laCommande.items[0].lotId).toBeTruthy();
      expect(laCommande.items[0].supplierUnitPrice).toBeTruthy();
      expect(laCommande.commissionTotal).toBeDefined();
    });

    it('GET /api/v2/staff/orders/:id sur une commande inconnue : 404', async () => {
      const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

      const res = await api()
        .get('/api/v2/staff/orders/999999')
        .set(authHeader(tokenPour(agentUser)));

      expect(res.status, res.text).toBe(404);
      expect(res.body.error).toBe('Commande introuvable');
    });

    it('un AGENT sans ORDER_PROCESSING est refuse sur les routes staff : 403', async () => {
      const { user: agentUser } = await agentAvecCapacite(['BUYER_SUPPORT']);

      const res = await api()
        .get('/api/v2/staff/orders')
        .set(authHeader(tokenPour(agentUser)));

      expect(res.status, res.text).toBe(403);
    });

    it('un BUYER est refuse sur les routes staff : 403', async () => {
      const buyer = await createUser({ role: 'BUYER' });
      const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });

      const res = await api()
        .get('/api/v2/staff/orders')
        .set(authHeader(tokenAcheteur));

      expect(res.status, res.text).toBe(403);
    });
  });
});
