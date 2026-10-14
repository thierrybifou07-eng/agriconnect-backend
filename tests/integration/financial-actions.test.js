import { describe, it, expect } from 'vitest';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser, createListingForLot } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { refreshPayoutReadiness } from '../../src/services/payout.service.js';

const Decimal = Prisma.Decimal;

// --- Fabriques (pattern de staff-payments.test.js) ---

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

// Crée un compte AGENT et sa fiche d'agent avec les capacités demandées.
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

// Crée un agent IA rattaché à un compte AGENT. L'API interdit de donner
// PAYMENT_FOLLOWUP à une IA (règle C6) : les capacités sont injectées
// directement en base pour tester requireHumanActor, comme le fait
// staff-payments.test.js.
async function agentAiAvecCompte({ capabilities = [] } = {}) {
  const user = await createUser({ role: 'AGENT' });
  const agent = await prisma.agent.create({
    data: { kind: 'AI', userId: user.id, displayName: 'IA Test', isActive: true },
  });
  for (const code of capabilities) {
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

// --- Scénario financier ---
//
// Commande HUB_PICKUP (5 x 1200 = 6000) confirmée et payée, avec un
// paiement, un reversement READY, une compensation APPROVED et un
// parrainage ELIGIBLE : toutes les routes d'argent ont une cible valide.
async function scenarioFinancier() {
  const buyer = await createUser({ role: 'BUYER' });
  const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
  const annonce = await createListingForLot(lot);
  await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1200.00' } });
  const hub = await creerHub();
  const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP']);

  // Devis
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
  const orderId = res.body.id;

  // Confirmation par l'acheteur
  const tokenAcheteur = generateToken({ id: buyer.id, role: { code: 'BUYER', level: 10 } });
  const conf = await api()
    .post(`/api/v2/orders/${orderId}/confirm`)
    .set(authHeader(tokenAcheteur));
  expect(conf.status, conf.text).toBe(200);

  // Paiement complet (6000)
  const resPay = await api()
    .post(`/api/v2/staff/orders/${orderId}/payments`)
    .set(authHeader(tokenPour(agentUser)))
    .set('Idempotency-Key', identifiant('PAY'))
    .send({ amount: 6000, method: 'CASH' });
  expect(resPay.status, resPay.text).toBe(201);
  const paymentId = resPay.body.id;

  // COMPLETED + PAID : refreshPayoutReadiness fait passer le reversement READY.
  await prisma.order.update({
    where: { id: orderId },
    data: { status: 'COMPLETED', paymentStatus: 'PAID' },
  });
  await refreshPayoutReadiness(prisma, orderId);

  // Reversement READY (créé à la confirmation)
  const payout = await prisma.supplierPayout.findFirst({ where: { orderId } });
  expect(payout).toBeTruthy();
  expect(payout.status).toBe('READY');

  // Compensation APPROVED
  const compensation = await prisma.supplierCompensation.create({
    data: {
      supplierId: payout.supplierId,
      lotId: lot.id,
      reason: 'LOST_OR_DAMAGED',
      quantity: new Decimal('1'),
      unitPrice: new Decimal('1000'),
      rate: new Decimal('0.1'),
      amount: new Decimal('100'),
      status: 'APPROVED',
    },
  });

  // Parrainage ELIGIBLE
  const filleul = await createUser({ role: 'BUYER' });
  const referral = await prisma.referral.create({
    data: { referrerId: buyer.id, referredId: filleul.id, kind: 'BUYER', status: 'ELIGIBLE', rewardAmount: new Decimal('500') },
  });

  // Admin (pour vérifier que les routes fonctionnent avec un ADMIN légitime)
  const admin = await createUser({ role: 'ADMIN' });

  return { agentUser, admin, orderId, paymentId, payout, compensation, referral, buyer };
}

// --- Tests ---

describe('Règle C6 — un agent IA ne peut recevoir PAYMENT_FOLLOWUP', () => {
  it('updateAgent refuse PAYMENT_FOLLOWUP sur une fiche AI (400)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const ai = await prisma.agent.create({
      data: { kind: 'AI', displayName: 'IA Test', userId: null, aiProvider: 'openai', aiModel: 'gpt-4' },
    });

    const res = await api()
      .patch(`/api/v2/admin/agents/${ai.id}`)
      .set(authHeader(tokenAdminPour(admin)))
      .send({ capabilities: ['PAYMENT_FOLLOWUP'] });

    expect(res.status, res.text).toBe(400);
    expect(res.body.error).toContain('PAYMENT_FOLLOWUP');

    // Aucun lien n'a été écrit : le 400 arrive avant la transaction.
    const links = await prisma.agentCapabilityLink.count({ where: { agentId: ai.id } });
    expect(links).toBe(0);
  });

  it('createAiAgent crée une fiche AI sans aucune capacité', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await api()
      .post('/api/v2/admin/agents/ai')
      .set(authHeader(tokenAdminPour(admin)))
      .send({ displayName: 'Assistant IA', aiProvider: 'openai', aiModel: 'gpt-4' });

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ kind: 'AI', userId: null });

    // La fiche n'a aucune capacité : elle ne peut rien faire sur l'argent.
    const links = await prisma.agentCapabilityLink.count({ where: { agentId: res.body.id } });
    expect(links).toBe(0);
  });
});

describe("Routes d'argent — AGENT sans la capacité", () => {
  it('toutes les routes d\'argent refusent un AGENT sans PAYMENT_FOLLOWUP (403)', async () => {
    const ctx = await scenarioFinancier();

    // Agent avec ORDER_PROCESSING seul : pas PAYMENT_FOLLOWUP.
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);
    const token = authHeader(tokenPour(agentUser));

    // Paiement (POST /staff/orders/:id/payments)
    const resPay = await api()
      .post(`/api/v2/staff/orders/${ctx.orderId}/payments`)
      .set(token)
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 3000, method: 'CASH' });
    expect(resPay.status, resPay.text).toBe(403);

    // Liste des paiements (GET /staff/orders/:id/payments)
    const resList = await api()
      .get(`/api/v2/staff/orders/${ctx.orderId}/payments`)
      .set(token);
    expect(resList.status, resList.text).toBe(403);

    // Remboursement (POST /staff/payments/:id/refund)
    const resRefund = await api()
      .post(`/api/v2/staff/payments/${ctx.paymentId}/refund`)
      .set(token);
    expect(resRefund.status, resRefund.text).toBe(403);

    // Reversement (PATCH /admin/payouts/:id/pay)
    const resPayout = await api()
      .patch(`/api/v2/admin/payouts/${ctx.payout.id}/pay`)
      .set(token)
      .send({ reference: 'TEST' });
    expect(resPayout.status, resPayout.text).toBe(403);

    // Indemnisation (PATCH /admin/compensations/:id/pay)
    const resComp = await api()
      .patch(`/api/v2/admin/compensations/${ctx.compensation.id}/pay`)
      .set(token)
      .send({ reference: 'TEST' });
    expect(resComp.status, resComp.text).toBe(403);

    // Parrainage (PATCH /admin/referrals/:id/pay)
    const resRef = await api()
      .patch(`/api/v2/admin/referrals/${ctx.referral.id}/pay`)
      .set(token)
      .send({ reference: 'TEST' });
    expect(resRef.status, resRef.text).toBe(403);
  });
});

describe("Routes d'argent — agent IA", () => {
  it('toutes les routes d\'argent refusent un agent IA (403)', async () => {
    const ctx = await scenarioFinancier();

    // Agent IA avec un compte AGENT (le cas réaliste : createAiAgent ne
    // crée pas de compte, mais une fiche AI peut être rattachée à un compte
    // AGENT directement en base — comme dans staff-payments.test.js).
    const { user: aiUser } = await agentAiAvecCompte({
      capabilities: ['ORDER_PROCESSING', 'PAYMENT_FOLLOWUP'],
    });
    const token = authHeader(tokenPour(aiUser));

    // Paiement (POST /staff/orders/:id/payments) — requireHumanActor
    const resPay = await api()
      .post(`/api/v2/staff/orders/${ctx.orderId}/payments`)
      .set(token)
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 3000, method: 'CASH' });
    expect(resPay.status, resPay.text).toBe(403);

    // Liste des paiements (GET /staff/orders/:id/payments) — requireHumanActor
    const resList = await api()
      .get(`/api/v2/staff/orders/${ctx.orderId}/payments`)
      .set(token);
    expect(resList.status, resList.text).toBe(403);

    // Remboursement (POST /staff/payments/:id/refund) — requireMinLevel(50) + requireHumanActor
    const resRefund = await api()
      .post(`/api/v2/staff/payments/${ctx.paymentId}/refund`)
      .set(token);
    expect(resRefund.status, resRefund.text).toBe(403);

    // Reversement (PATCH /admin/payouts/:id/pay) — requireMinLevel(50) + requireHumanActor
    const resPayout = await api()
      .patch(`/api/v2/admin/payouts/${ctx.payout.id}/pay`)
      .set(token)
      .send({ reference: 'TEST' });
    expect(resPayout.status, resPayout.text).toBe(403);

    // Indemnisation (PATCH /admin/compensations/:id/pay) — requireMinLevel(50) + requireHumanActor
    const resComp = await api()
      .patch(`/api/v2/admin/compensations/${ctx.compensation.id}/pay`)
      .set(token)
      .send({ reference: 'TEST' });
    expect(resComp.status, resComp.text).toBe(403);

    // Parrainage (PATCH /admin/referrals/:id/pay) — requireMinLevel(50) + requireHumanActor
    const resRef = await api()
      .patch(`/api/v2/admin/referrals/${ctx.referral.id}/pay`)
      .set(token)
      .send({ reference: 'TEST' });
    expect(resRef.status, resRef.text).toBe(403);
  });

  it('un agent IA sans capacité est aussi refusé sur les routes d\'argent (403)', async () => {
    const ctx = await scenarioFinancier();

    // Agent IA sans aucune capacité : requireCapability bloque avant requireHumanActor.
    const { user: aiUser } = await agentAiAvecCompte({ capabilities: [] });
    const token = authHeader(tokenPour(aiUser));

    const resPay = await api()
      .post(`/api/v2/staff/orders/${ctx.orderId}/payments`)
      .set(token)
      .set('Idempotency-Key', identifiant('PAY'))
      .send({ amount: 3000, method: 'CASH' });
    expect(resPay.status, resPay.text).toBe(403);

    const resList = await api()
      .get(`/api/v2/staff/orders/${ctx.orderId}/payments`)
      .set(token);
    expect(resList.status, resList.text).toBe(403);
  });
});
