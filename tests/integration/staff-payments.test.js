import { describe, it, expect } from 'vitest';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser, createListingForLot } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

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

// Lot AVAILABLE avec un prix convenu et une quantité donnée.
async function creerLot({ quantity = '100', agreedUnitPrice = '1000.00' } = {}) {
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

// Crée une commande QUOTED via l'API staff (total = 6000 : 5 x 1200).
async function creerCommande(agentUser) {
  const buyer = await createUser({ role: 'BUYER' });
  const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
  const annonce = await createListingForLot(lot);
  await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1200.00' } });
  const hub = await creerHub();
  const res = await api()
    .post('/api/v2/staff/orders')
    .set(authHeader(tokenPour(agentUser)))
    .send({
      buyerId: buyer.id,
      items: [{ listingId: annonce.id, quantity: 5 }],
      deliveryMode: 'HUB_PICKUP',
      pickupHubId: hub.id,
    });
  expect(res.status).toBe(201);
  return res.body;
}

// --- Tests ---

describe('POST /api/v2/staff/orders/:id/payments', () => {
  it('enregistre un paiement partiel puis complet', async () => {
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP']);
    const commande = await creerCommande(agentUser);
    expect(commande.paymentStatus).toBe('UNPAID');

    // Paiement partiel : 3000 sur 6000
    const res1 = await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)))
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 3000, method: 'CASH' });

    expect(res1.status, res1.text).toBe(201);
    expect(res1.body.status).toBe('CONFIRMED');
    expect(res1.body.amount).toBe(3000);

    let order = await prisma.order.findUnique({ where: { id: commande.id } });
    expect(order.paymentStatus).toBe('PARTIALLY_PAID');

    // Paiement complément : 3000
    const res2 = await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)))
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 3000, method: 'CASH' });

    expect(res2.status, res2.text).toBe(201);
    order = await prisma.order.findUnique({ where: { id: commande.id } });
    expect(order.paymentStatus).toBe('PAID');

    // Deux audits PAYMENT_RECORDED
    const audits = await prisma.auditLog.findMany({
      where: { action: 'PAYMENT_RECORDED', entityType: 'Payment' },
    });
    expect(audits).toHaveLength(2);
  });

  it('refuse un surpaiement : 409 OVERPAYMENT', async () => {
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP']);
    const commande = await creerCommande(agentUser);

    // Paiement partiel : 3000 sur 6000
    await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)))
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 3000, method: 'CASH' });

    // Tentative de 4000 > 3000 restants
    const res = await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)))
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 4000, method: 'CASH' });

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('OVERPAYMENT');
    expect(res.body.error).toBe('Montant supérieur au solde');

    // Le statut de la commande est inchangé
    const order = await prisma.order.findUnique({ where: { id: commande.id } });
    expect(order.paymentStatus).toBe('PARTIALLY_PAID');
  });

  it('même clé deux fois -> un seul paiement (200, pas de doublon)', async () => {
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP']);
    const commande = await creerCommande(agentUser);
    const cle = identifiant('PAY');

    const res1 = await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)))
      .set('Idempotency-Key', cle)
      .send({ amount: 3000, method: 'CASH' });
    expect(res1.status).toBe(201);

    const res2 = await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)))
      .set('Idempotency-Key', cle)
      .send({ amount: 3000, method: 'CASH' });
    expect(res2.status, res2.text).toBe(200);
    expect(res2.body.id).toBe(res1.body.id);

    // Un seul paiement en base
    const paiements = await prisma.payment.findMany({ where: { orderId: commande.id } });
    expect(paiements).toHaveLength(1);

    // Un seul audit PAYMENT_RECORDED
    const audits = await prisma.auditLog.findMany({
      where: { action: 'PAYMENT_RECORDED', entityType: 'Payment' },
    });
    expect(audits).toHaveLength(1);
  });

  it('deux requêtes simultanées avec la même clé -> un seul paiement', async () => {
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP']);
    const commande = await creerCommande(agentUser);
    const cle = identifiant('PAY');

    const [res1, res2] = await Promise.all([
      api()
        .post(`/api/v2/staff/orders/${commande.id}/payments`)
        .set(authHeader(tokenPour(agentUser)))
        .set('Idempotency-Key', cle)
        .send({ amount: 3000, method: 'CASH' }),
      api()
        .post(`/api/v2/staff/orders/${commande.id}/payments`)
        .set(authHeader(tokenPour(agentUser)))
        .set('Idempotency-Key', cle)
        .send({ amount: 3000, method: 'CASH' }),
    ]);

    // Les deux réponses sont un succès idempotent (200 ou 201) et renvoient
    // le même paiement : l'une a créé, l'autre a rejoué. Le scénario exact
    // (200+201 ou 200+200) dépend du timing du commit.
    expect([200, 201]).toContain(res1.status);
    expect([200, 201]).toContain(res2.status);
    expect(res1.body.id).toBe(res2.body.id);

    // Un seul paiement en base : la contrainte unique a fait son œuvre.
    const paiements = await prisma.payment.findMany({ where: { orderId: commande.id } });
    expect(paiements).toHaveLength(1);
  });

  it('refuse sans en-tête Idempotency-Key : 400', async () => {
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP']);
    const commande = await creerCommande(agentUser);

    const res = await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)))
      .send({ amount: 3000, method: 'CASH' });

    expect(res.status, res.text).toBe(400);
    expect(res.body.error).toContain('Idempotency-Key');

    // Aucun paiement créé
    const paiements = await prisma.payment.findMany({ where: { orderId: commande.id } });
    expect(paiements).toHaveLength(0);
  });

  it('refuse un montant <= 0 : 409 INVALID_AMOUNT', async () => {
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP']);
    const commande = await creerCommande(agentUser);

    const res = await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)))
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 0, method: 'CASH' });

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('INVALID_AMOUNT');
  });

  it('refuse une commande CANCELLED : 409 ORDER_CANCELLED', async () => {
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP']);
    const commande = await creerCommande(agentUser);

    // Annuler la commande via l'API
    await api()
      .post(`/api/v2/staff/orders/${commande.id}/cancel`)
      .set(authHeader(tokenPour(agentUser)))
      .send({ reason: 'Test annulation' });

    const res = await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)))
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 3000, method: 'CASH' });

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('ORDER_CANCELLED');
  });

  it('un AGENT sans PAYMENT_FOLLOWUP est refusé : 403', async () => {
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);
    const commande = await creerCommande(agentUser);

    const res = await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)))
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 3000, method: 'CASH' });

    expect(res.status, res.text).toBe(403);
  });

  it('un agent IA est refusé : 403 (requireHumanActor)', async () => {
    const user = await createUser({ role: 'AGENT' });
    const agent = await prisma.agent.create({
      data: { kind: 'AI', userId: user.id, displayName: 'IA Test', isActive: true },
    });
    for (const code of ['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP']) {
      const cap = await prisma.agentCapability.findFirst({ where: { code } });
      await prisma.agentCapabilityLink.create({ data: { agentId: agent.id, capabilityId: cap.id } });
    }

    const commande = await creerCommande(user);

    const res = await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(user)))
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 3000, method: 'CASH' });

    expect(res.status, res.text).toBe(403);
  });

  it('un ADMIN peut enregistrer un paiement sans capacité spécifique', async () => {
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);
    const commande = await creerCommande(agentUser);
    const admin = await createUser({ role: 'ADMIN' });

    const res = await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenAdminPour(admin)))
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 3000, method: 'CASH' });

    expect(res.status, res.text).toBe(201);
    expect(res.body.status).toBe('CONFIRMED');
  });
});

describe('GET /api/v2/staff/orders/:id/payments', () => {
  it('liste les paiements d\'une commande', async () => {
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP']);
    const commande = await creerCommande(agentUser);

    // Deux paiements : 3000 + 3000
    for (let i = 0; i < 2; i++) {
      await api()
        .post(`/api/v2/staff/orders/${commande.id}/payments`)
        .set(authHeader(tokenPour(agentUser)))
        .set('Idempotency-Key', identifiant('PAY'))
        .send({ amount: 3000, method: 'CASH' });
    }

    const res = await api()
      .get(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)));

    expect(res.status, res.text).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].amount).toBe(3000);
    expect(res.body.items[0].status).toBe('CONFIRMED');
  });

  it('un AGENT sans PAYMENT_FOLLOWUP est refusé : 403', async () => {
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);
    const commande = await creerCommande(agentUser);

    const res = await api()
      .get(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)));

    expect(res.status, res.text).toBe(403);
  });
});

describe('POST /api/v2/staff/payments/:id/refund', () => {
  it('rembourse un paiement CONFIRMED et recalcule le statut', async () => {
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP']);
    const commande = await creerCommande(agentUser);

    const resPay = await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)))
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 6000, method: 'CASH' });
    expect(resPay.status).toBe(201);

    let order = await prisma.order.findUnique({ where: { id: commande.id } });
    expect(order.paymentStatus).toBe('PAID');

    const admin = await createUser({ role: 'ADMIN' });
    const res = await api()
      .post(`/api/v2/staff/payments/${resPay.body.id}/refund`)
      .set(authHeader(tokenAdminPour(admin)));

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('REFUNDED');

    // Le statut de la commande est recalculé : plus aucun paiement CONFIRMED
    order = await prisma.order.findUnique({ where: { id: commande.id } });
    expect(order.paymentStatus).toBe('UNPAID');

    // Audit PAYMENT_REFUNDED
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'PAYMENT_REFUNDED', entityType: 'Payment', entityId: resPay.body.id },
    });
    expect(audit).toBeTruthy();
  });

  it('recalcule le statut à PARTIALLY_PAID après remboursement partiel', async () => {
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP']);
    const commande = await creerCommande(agentUser);

    // Deux paiements : 3000 + 3000 = 6000 (PAID)
    const cle1 = await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)))
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 3000, method: 'CASH' });
    await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)))
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 3000, method: 'CASH' });

    let order = await prisma.order.findUnique({ where: { id: commande.id } });
    expect(order.paymentStatus).toBe('PAID');

    // Rembourser le premier paiement : il reste 3000 CONFIRMED sur 6000
    const admin = await createUser({ role: 'ADMIN' });
    const res = await api()
      .post(`/api/v2/staff/payments/${cle1.body.id}/refund`)
      .set(authHeader(tokenAdminPour(admin)));

    expect(res.status, res.text).toBe(200);

    order = await prisma.order.findUnique({ where: { id: commande.id } });
    expect(order.paymentStatus).toBe('PARTIALLY_PAID');
  });

  it('refuse un remboursement par un AGENT : 403', async () => {
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP']);
    const commande = await creerCommande(agentUser);

    const resPay = await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)))
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 6000, method: 'CASH' });

    const res = await api()
      .post(`/api/v2/staff/payments/${resPay.body.id}/refund`)
      .set(authHeader(tokenPour(agentUser)));

    expect(res.status, res.text).toBe(403);
  });

  it('refuse un remboursement double : 409 PAYMENT_NOT_CONFIRMED', async () => {
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP']);
    const commande = await creerCommande(agentUser);

    const resPay = await api()
      .post(`/api/v2/staff/orders/${commande.id}/payments`)
      .set(authHeader(tokenPour(agentUser)))
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 6000, method: 'CASH' });

    const admin = await createUser({ role: 'ADMIN' });

    // Premier remboursement : OK
    await api()
      .post(`/api/v2/staff/payments/${resPay.body.id}/refund`)
      .set(authHeader(tokenAdminPour(admin)));

    // Second remboursement : le paiement est déjà REFUNDED
    const res = await api()
      .post(`/api/v2/staff/payments/${resPay.body.id}/refund`)
      .set(authHeader(tokenAdminPour(admin)));

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('PAYMENT_NOT_CONFIRMED');
  });

  it('refuse un remboursement d\'un paiement inexistant : 404', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await api()
      .post('/api/v2/staff/payments/999999/refund')
      .set(authHeader(tokenAdminPour(admin)));

    expect(res.status, res.text).toBe(404);
    expect(res.body.code).toBe('PAYMENT_NOT_FOUND');
  });
});
