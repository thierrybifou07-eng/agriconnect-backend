import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser, createListingForLot } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { assertNoLeak } from '../helpers/assertNoLeak.js';

const Decimal = Prisma.Decimal;

// --- Fixtures ---

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

async function creerLot({ quantity = '100', agreedUnitPrice = '1000.00', fournisseur: f } = {}) {
  const { profile } = f ?? (await fournisseur());
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
      storageType: 'SUPPLIER_SITE',
      pickupAddress: '12 route de la ferme',
      pickupLatitude: 12.34,
      pickupLongitude: -5.67,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      status: 'AVAILABLE',
    },
  });
}

async function creerHub() {
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

function tokenPour(user) {
  return generateToken({ id: user.id, role: { code: 'AGENT', level: 30 } });
}

function tokenAdminPour(user) {
  return generateToken({ id: user.id, role: { code: 'ADMIN', level: 50 } });
}

function tokenFournisseurPour(user) {
  return generateToken({ id: user.id, role: { code: 'SUPPLIER', level: 20 } });
}

// Cree une commande QUOTED via l'API staff avec un seul lot.
async function creerCommande({ lots, quantities }) {
  const buyer = await createUser({ role: 'BUYER' });
  // ORDER_PROCESSING pour creer le devis, PAYMENT_FOLLOWUP pour le payer.
  const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP']);

  const items = [];
  for (let i = 0; i < lots.length; i++) {
    const annonce = await createListingForLot(lots[i]);
    await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1200.00' } });
    items.push({ listingId: annonce.id, quantity: quantities[i] });
  }

  const hub = await creerHub();
  const res = await api()
    .post('/api/v2/staff/orders')
    .set(authHeader(tokenPour(agentUser)))
    .send({ buyerId: buyer.id, items, deliveryMode: 'HUB_PICKUP', pickupHubId: hub.id });

  expect(res.status, res.text).toBe(201);
  return { order: res.body, buyer, agentUser };
}

// Confirme la commande en tant qu'acheteur.
async function confirmer(commande, buyer) {
  const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });
  const res = await api()
    .post(`/api/v2/orders/${commande.order.id}/confirm`)
    .set(authHeader(tokenAcheteur));
  expect(res.status, res.text).toBe(200);
}

// Enregistre un paiement complet.
async function payer(commande, agentUser) {
  const res = await api()
    .post(`/api/v2/staff/orders/${commande.order.id}/payments`)
    .set(authHeader(tokenPour(agentUser)))
    .set('Idempotency-Key', identifiant('PAY'))
    .send({ amount: 6000, method: 'CASH' });
  expect(res.status, res.text).toBe(201);
}

// Patch le statut vers un etat cible.
async function patchStatus(orderId, status, agentUser, force) {
  const res = await api()
    .patch(`/api/v2/staff/orders/${orderId}/status`)
    .set(authHeader(tokenPour(agentUser)))
    .send(force === undefined ? { status } : { status, force });
  return res;
}

// --- Tests ---

describe('Reversements fournisseurs (P4.2)', () => {
  // Le taux de commission seedé est 0 : les reversements testeraient un cas
  // dégénéré (toujours zéro). On le fixe explicitement à 10 % pour vérifier le
  // calcul réel, et on restaure la valeur d'origine après la suite.
  let TAUX_ORIGINAL = new Decimal(0);
  const TAUX_TEST = new Decimal('0.10');

  beforeAll(async () => {
    const settings = await prisma.platformSetting.findUnique({ where: { id: 1 } });
    if (settings) {
      TAUX_ORIGINAL = new Decimal(settings.supplierCommissionRate);
    }
    await prisma.platformSetting.update({
      where: { id: 1 },
      data: { supplierCommissionRate: TAUX_TEST },
    });
  });

  afterAll(async () => {
    await prisma.platformSetting.update({
      where: { id: 1 },
      data: { supplierCommissionRate: TAUX_ORIGINAL },
    });
  });

  describe('GET /api/v2/supplier/payouts', () => {
    it('un fournisseur = un reversement avec les bons montants', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00', fournisseur: f });
      const commande = await creerCommande({ lots: [lot], quantities: [5] });

      // Confirmer la commande
      await confirmer(commande, commande.buyer);

      // Un reversement en ON_HOLD pour ce fournisseur
      const payout = await prisma.supplierPayout.findFirst({
        where: { orderId: commande.order.id, supplierId: f.profile.id },
      });
      expect(payout).toBeTruthy();
      expect(payout.status).toBe('ON_HOLD');
      // grossAmount = 5 x 1000 = 5000
      expect(payout.grossAmount.toString()).toBe('5000');
      // commissionAmount = 5000 * commissionRate (0.10 par defaut) = 500
      expect(payout.commissionAmount.toString()).toBe('500');
      // netAmount = 5000 - 500 = 4500
      expect(payout.netAmount.toString()).toBe('4500');

      // Le fournisseur voit son reversement
      const res = await api()
        .get('/api/v2/supplier/payouts')
        .set(authHeader(tokenFournisseurPour(f.user)));

      expect(res.status, res.text).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.total).toBe(1);
      expect(res.body.items[0].grossAmount).toBe(5000);
      expect(res.body.items[0].commissionAmount).toBe(500);
      expect(res.body.items[0].netAmount).toBe(4500);
      expect(res.body.items[0].status).toBe('ON_HOLD');

      // Aucune donnee acheteur
      assertNoLeak(res.body, ['buyerId', 'buyer', 'userId', 'firstname', 'lastname', 'email', 'phone']);
    });

    it('deux fournisseurs dans une commande = deux reversements aux bons montants', async () => {
      const f1 = await fournisseur();
      const f2 = await fournisseur();
      const lot1 = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00', fournisseur: f1 });
      const lot2 = await creerLot({ quantity: '10', agreedUnitPrice: '800.00', fournisseur: f2 });
      const commande = await creerCommande({ lots: [lot1, lot2], quantities: [3, 4] });

      await confirmer(commande, commande.buyer);

      const payouts = await prisma.supplierPayout.findMany({
        where: { orderId: commande.order.id },
        orderBy: { supplierId: 'asc' },
      });
      expect(payouts).toHaveLength(2);

      // Fournisseur 1 : 3 x 1000 = 3000, commission 300, net 2700
      const p1 = payouts.find((p) => p.supplierId === f1.profile.id);
      expect(p1.grossAmount.toString()).toBe('3000');
      expect(p1.commissionAmount.toString()).toBe('300');
      expect(p1.netAmount.toString()).toBe('2700');

      // Fournisseur 2 : 4 x 800 = 3200, commission 320, net 2880
      const p2 = payouts.find((p) => p.supplierId === f2.profile.id);
      expect(p2.grossAmount.toString()).toBe('3200');
      expect(p2.commissionAmount.toString()).toBe('320');
      expect(p2.netAmount.toString()).toBe('2880');

      // Chacun ne voit que le sien
      const res1 = await api()
        .get('/api/v2/supplier/payouts')
        .set(authHeader(tokenFournisseurPour(f1.user)));
      expect(res1.body.items).toHaveLength(1);
      expect(res1.body.items[0].grossAmount).toBe(3000);

      const res2 = await api()
        .get('/api/v2/supplier/payouts')
        .set(authHeader(tokenFournisseurPour(f2.user)));
      expect(res2.body.items).toHaveLength(1);
      expect(res2.body.items[0].grossAmount).toBe(3200);
    });

    it('assertNoLeak : aucune donnee acheteur côté fournisseur', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00', fournisseur: f });
      const commande = await creerCommande({ lots: [lot], quantities: [5] });
      await confirmer(commande, commande.buyer);

      const res = await api()
        .get('/api/v2/supplier/payouts')
        .set(authHeader(tokenFournisseurPour(f.user)));

      expect(res.status).toBe(200);
      // Les cles suivantes ne doivent jamais apparaitre
      assertNoLeak(res.body, [
        'buyerId',
        'buyer',
        'userId',
        'firstname',
        'lastname',
        'email',
        'phone',
        'supplierUnitPrice',
        'commissionRate',
        'lot',
        'listing',
      ]);
    });
  });

  describe('Cycle de vie des reversements', () => {
    it('passage READY seulement quand COMPLETED et PAID (paiement puis completion)', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00', fournisseur: f });
      const commande = await creerCommande({ lots: [lot], quantities: [5] });
      await confirmer(commande, commande.buyer);

      // Paiement avant completion : pas encore READY
      await payer(commande, commande.agentUser);
      let payout = await prisma.supplierPayout.findFirst({
        where: { orderId: commande.order.id, supplierId: f.profile.id },
      });
      expect(payout.status).toBe('ON_HOLD');

      // PREPARING (exige PAID : ok), READY_FOR_PICKUP, COMPLETED
      let res = await patchStatus(commande.order.id, 'PREPARING', commande.agentUser);
      expect(res.status, res.text).toBe(200);
      res = await patchStatus(commande.order.id, 'READY_FOR_PICKUP', commande.agentUser);
      expect(res.status, res.text).toBe(200);
      res = await patchStatus(commande.order.id, 'COMPLETED', commande.agentUser);
      expect(res.status, res.text).toBe(200);

      payout = await prisma.supplierPayout.findFirst({
        where: { orderId: commande.order.id, supplierId: f.profile.id },
      });
      expect(payout.status).toBe('READY');
    });

    it('passage READY seulement quand COMPLETED et PAID (completion puis paiement)', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00', fournisseur: f });
      const commande = await creerCommande({ lots: [lot], quantities: [5] });
      await confirmer(commande, commande.buyer);

      // Completion avant paiement : PREPARING exige PAID, mais un admin
      // (niveau 50) peut forcer. La commande est COMPLETED mais UNPAID.
      const admin = await createUser({ role: 'ADMIN' });
      const tokenAdmin = tokenAdminPour(admin);
      let res = await api()
        .patch(`/api/v2/staff/orders/${commande.order.id}/status`)
        .set(authHeader(tokenAdmin))
        .send({ status: 'PREPARING', force: true });
      expect(res.status, res.text).toBe(200);
      res = await patchStatus(commande.order.id, 'READY_FOR_PICKUP', commande.agentUser);
      expect(res.status, res.text).toBe(200);
      res = await patchStatus(commande.order.id, 'COMPLETED', commande.agentUser);
      expect(res.status, res.text).toBe(200);

      let payout = await prisma.supplierPayout.findFirst({
        where: { orderId: commande.order.id, supplierId: f.profile.id },
      });
      expect(payout.status).toBe('ON_HOLD');

      // Paiement : maintenant READY
      await payer(commande, commande.agentUser);
      payout = await prisma.supplierPayout.findFirst({
        where: { orderId: commande.order.id, supplierId: f.profile.id },
      });
      expect(payout.status).toBe('READY');
    });

    it('annulation de commande annule les reversements', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00', fournisseur: f });
      const commande = await creerCommande({ lots: [lot], quantities: [5] });
      await confirmer(commande, commande.buyer);

      // Annuler via l'API staff
      const res = await api()
        .post(`/api/v2/staff/orders/${commande.order.id}/cancel`)
        .set(authHeader(tokenPour(commande.agentUser)))
        .send({ reason: 'Test annulation' });
      expect(res.status, res.text).toBe(200);

      const payout = await prisma.supplierPayout.findFirst({
        where: { orderId: commande.order.id, supplierId: f.profile.id },
      });
      expect(payout.status).toBe('CANCELLED');
    });

    it('la contrainte unique (commande, fournisseur) tient', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00', fournisseur: f });
      const commande = await creerCommande({ lots: [lot], quantities: [5] });
      await confirmer(commande, commande.buyer);

      // Tentative de creation d'un doublon : P2002 attendu
      await expect(
        prisma.supplierPayout.create({
          data: {
            orderId: commande.order.id,
            supplierId: f.profile.id,
            grossAmount: new Decimal('5000'),
            commissionAmount: new Decimal('500'),
            netAmount: new Decimal('4500'),
            status: 'ON_HOLD',
          },
        })
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('GET /api/v2/admin/payouts', () => {
    it('retourne tous les reversements avec donnees complet', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00', fournisseur: f });
      const commande = await creerCommande({ lots: [lot], quantities: [5] });
      await confirmer(commande, commande.buyer);

      const admin = await createUser({ role: 'ADMIN' });
      const res = await api()
        .get('/api/v2/admin/payouts')
        .set(authHeader(tokenAdminPour(admin)));

      expect(res.status, res.text).toBe(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
      const item = res.body.items.find((p) => p.orderId === commande.order.id);
      expect(item).toBeTruthy();
      expect(item.grossAmount).toBe(5000);
      expect(item.supplier).toBeTruthy();
      expect(item.supplier.farmName).toBe('Ferme du Test');
    });

    it('filtre par statut', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00', fournisseur: f });
      const commande = await creerCommande({ lots: [lot], quantities: [5] });
      await confirmer(commande, commande.buyer);

      const admin = await createUser({ role: 'ADMIN' });
      const res = await api()
        .get('/api/v2/admin/payouts?status=ON_HOLD')
        .set(authHeader(tokenAdminPour(admin)));

      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
      expect(res.body.items.every((p) => p.status === 'ON_HOLD')).toBe(true);
    });

    it('un AGENT sans level 50 est refuse : 403', async () => {
      const res = await api()
        .get('/api/v2/admin/payouts')
        .set(authHeader(tokenPour((await agentAvecCapacite(['ORDER_PROCESSING'])).user)));
      expect(res.status, res.text).toBe(403);
    });
  });

  describe('PATCH /api/v2/admin/payouts/:id/pay', () => {
    async function preparerPayoutReady() {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00', fournisseur: f });
      const commande = await creerCommande({ lots: [lot], quantities: [5] });
      await confirmer(commande, commande.buyer);
      await payer(commande, commande.agentUser);
      // PREPARING exige PAID : ok. Puis READY_FOR_PICKUP et COMPLETED.
      let res = await patchStatus(commande.order.id, 'PREPARING', commande.agentUser);
      expect(res.status, res.text).toBe(200);
      res = await patchStatus(commande.order.id, 'READY_FOR_PICKUP', commande.agentUser);
      expect(res.status, res.text).toBe(200);
      res = await patchStatus(commande.order.id, 'COMPLETED', commande.agentUser);
      expect(res.status, res.text).toBe(200);

      const payout = await prisma.supplierPayout.findFirst({
        where: { orderId: commande.order.id, supplierId: f.profile.id },
      });
      expect(payout.status).toBe('READY');
      return { f, commande, payout };
    }

    it('paiement d un reversement READY -> PAID avec audit', async () => {
      const { payout } = await preparerPayoutReady();
      const admin = await createUser({ role: 'ADMIN' });

      const res = await api()
        .patch(`/api/v2/admin/payouts/${payout.id}/pay`)
        .set(authHeader(tokenAdminPour(admin)))
        .send({ reference: identifiant('VIR') });

      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('PAID');
      expect(res.body.paidAt).toBeTruthy();
      expect(res.body.reference).toBeTruthy();

      // Verif en base
      const maj = await prisma.supplierPayout.findUnique({ where: { id: payout.id } });
      expect(maj.status).toBe('PAID');
      expect(maj.paidAt).toBeTruthy();
      expect(maj.paidById).toBe(admin.id);

      // Audit PAYOUT_PAID
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'PAYOUT_PAID', entityType: 'SupplierPayout', entityId: payout.id },
      });
      expect(audit).toBeTruthy();
    });

    it('paiement d un reversement non READY -> 409', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00', fournisseur: f });
      const commande = await creerCommande({ lots: [lot], quantities: [5] });
      await confirmer(commande, commande.buyer);

      const payout = await prisma.supplierPayout.findFirst({
        where: { orderId: commande.order.id, supplierId: f.profile.id },
      });
      expect(payout.status).toBe('ON_HOLD');

      const admin = await createUser({ role: 'ADMIN' });
      const res = await api()
        .patch(`/api/v2/admin/payouts/${payout.id}/pay`)
        .set(authHeader(tokenAdminPour(admin)))
        .send({ reference: identifiant('VIR') });

      expect(res.status, res.text).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('un agent IA est refuse : 403 (requireHumanActor)', async () => {
      const { payout } = await preparerPayoutReady();
      const user = await createUser({ role: 'AGENT' });
      await prisma.agent.create({
        data: { kind: 'AI', userId: user.id, displayName: 'IA Test', isActive: true },
      });

      const res = await api()
        .patch(`/api/v2/admin/payouts/${payout.id}/pay`)
        .set(authHeader(tokenPour(user)))
        .send({ reference: identifiant('VIR') });

      expect(res.status, res.text).toBe(403);
    });

    it('un AGENT (niveau 30) est refuse : 403', async () => {
      const { payout } = await preparerPayoutReady();
      const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

      const res = await api()
        .patch(`/api/v2/admin/payouts/${payout.id}/pay`)
        .set(authHeader(tokenPour(agentUser)))
        .send({ reference: identifiant('VIR') });

      expect(res.status, res.text).toBe(403);
    });

    it('sans reference -> 400', async () => {
      const { payout } = await preparerPayoutReady();
      const admin = await createUser({ role: 'ADMIN' });

      const res = await api()
        .patch(`/api/v2/admin/payouts/${payout.id}/pay`)
        .set(authHeader(tokenAdminPour(admin)))
        .send({});

      expect(res.status, res.text).toBe(400);
    });
  });
});
