import { describe, it, expect } from 'vitest';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser, createListingForLot } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

const Decimal = Prisma.Decimal;

const JOUR = 24 * 3600 * 1000;

// --- Fixtures ---

function identifiant(prefixe) {
  return `${prefixe}-${Date.now()}-${randomInt(1_000, 9_999)}`;
}

function tokenPour(user, role) {
  const levels = { AGENT: 30, ADMIN: 50, ROOT: 100, BUYER: 10, SUPPLIER: 10, DRIVER: 10 };
  return generateToken({ id: user.id, role: { code: role, level: levels[role] ?? 10 } });
}

async function lookupId(model, code) {
  const row = await prisma[model].findUnique({ where: { code } });
  if (!row) throw new Error(`Table de reference non peuplee : ${model}.${code}`);
  return row.id;
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

// Lot avec des compteurs de quantites connus. L'invariant du modele exige
// quantityInitial = available + reserved + sold + lost.
async function creerLot({ quantity, available, reserved = 0, sold = 0, lost = 0, status = 'AVAILABLE', fournisseur: f } = {}) {
  const { profile } = f ?? (await fournisseur());
  const product = await produit();
  const zoneTest = await zone();
  return prisma.stockLot.create({
    data: {
      lotCode: identifiant('LOT'),
      supplierId: profile.id,
      productId: product.id,
      zoneId: zoneTest.id,
      agreedUnitPrice: '1000.00',
      quantityInitial: new Decimal(quantity),
      quantityAvailable: new Decimal(available),
      quantityReserved: new Decimal(reserved),
      quantitySold: new Decimal(sold),
      quantityLost: new Decimal(lost),
      storageType: 'SUPPLIER_SITE',
      pickupAddress: '12 route de la ferme',
      pickupLatitude: 12.34,
      pickupLongitude: -5.67,
      status,
    },
  });
}

// Commande creee directement en base avec ses lignes et ses montants figes :
// le moteur de prix est teste ailleurs, ce test verifie l'agregation.
async function creerCommande({ buyer, lignes, status, paymentStatus, completedAt = null, buyerFee = 0, deliveryFee = 0, livraison = null }) {
  const modeId = await lookupId('deliveryMode', 'HUB_PICKUP');
  const order = await prisma.order.create({
    data: {
      orderNumber: identifiant('AC'),
      buyerId: buyer.id,
      deliveryModeId: modeId,
      subtotal: 0,
      total: 0,
      status,
      paymentStatus,
      buyerFee: new Decimal(buyerFee),
      deliveryFee: new Decimal(deliveryFee),
      completedAt,
    },
  });

  let sousTotal = new Decimal(0);
  let commission = new Decimal(0);
  for (const ligne of lignes) {
    const annonce = await createListingForLot(ligne.lot);
    await prisma.orderItem.create({
      data: {
        orderId: order.id,
        listingId: annonce.id,
        lotId: ligne.lot.id,
        quantity: new Decimal(ligne.quantity),
        unitPrice: new Decimal(ligne.unitPrice),
        supplierUnitPrice: new Decimal(ligne.supplierUnitPrice),
        lineTotal: new Decimal(ligne.lineTotal),
        commissionRate: new Decimal(ligne.commissionRate),
        commissionAmount: new Decimal(ligne.commissionAmount),
        supplierNetAmount: new Decimal(ligne.supplierNetAmount),
      },
    });
    sousTotal = sousTotal.add(new Decimal(ligne.lineTotal));
    commission = commission.add(new Decimal(ligne.commissionAmount));
  }

  await prisma.order.update({
    where: { id: order.id },
    data: {
      subtotal: sousTotal,
      total: sousTotal.add(new Decimal(buyerFee)).add(new Decimal(deliveryFee)),
      commissionTotal: commission,
    },
  });

  if (livraison) {
    const agence = await prisma.transportAgency.create({
      data: { name: identifiant('Agence'), phone: '+33600000000' },
    });
    await prisma.delivery.create({
      data: {
        orderId: order.id,
        agencyId: agence.id,
        dropoffAddress: '1 rue du Test',
        status: livraison.status,
        agencyCost: new Decimal(livraison.agencyCost),
      },
    });
  }

  return order;
}

// --- Tests ---

describe('GET /api/v2/admin/stats', () => {
  it('renvoie les chiffres exacts d un jeu de donnees connu', async () => {
    // Utilisateurs : 2 SUPPLIER, 1 BUYER, 1 DRIVER, 1 ADMIN.
    const f1 = await fournisseur();
    const f2 = await fournisseur();
    const buyer = await createUser({ role: 'BUYER' });
    const driver = await createUser({ role: 'DRIVER' });
    const admin = await createUser({ role: 'ADMIN' });

    // Lots : 2 AVAILABLE, 1 SOLD_OUT, 1 EXPIRED.
    const lot1 = await creerLot({ quantity: '100', available: '100', fournisseur: f1 });
    const lot2 = await creerLot({ quantity: '60', available: '50', reserved: '10', fournisseur: f2 });
    const lot3 = await creerLot({ quantity: '30', available: '0', sold: '30', status: 'SOLD_OUT', fournisseur: f1 });
    await creerLot({ quantity: '20', available: '0', lost: '20', status: 'EXPIRED', fournisseur: f2 });

    // Commande 1 (COMPLETED, dans la periode) : 2 lignes, 1 livraison.
    // commissionTotal 700, buyerFee 200, deliveryFee 3000, agencyCost 2000
    // -> 700 + 200 + (3000 - 2000) = 1900.
    await creerCommande({
      buyer,
      lignes: [
        { lot: lot1, quantity: '5', unitPrice: '1200', supplierUnitPrice: '1000', lineTotal: '6000', commissionRate: '0.1', commissionAmount: '500', supplierNetAmount: '4500' },
        { lot: lot2, quantity: '2', unitPrice: '1200', supplierUnitPrice: '1000', lineTotal: '2400', commissionRate: '0.1', commissionAmount: '200', supplierNetAmount: '1800' },
      ],
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      completedAt: new Date(),
      buyerFee: 200,
      deliveryFee: 3000,
      livraison: { status: 'DELIVERED', agencyCost: 2000 },
    });

    // Commande 2 (COMPLETED, dans la periode) : sans livraison.
    // commissionTotal 1000 -> 1000 + 0 + 0 = 1000.
    await creerCommande({
      buyer,
      lignes: [
        { lot: lot3, quantity: '10', unitPrice: '1500', supplierUnitPrice: '1000', lineTotal: '15000', commissionRate: '0.1', commissionAmount: '1000', supplierNetAmount: '9000' },
      ],
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      completedAt: new Date(),
    });

    // Commande 3 (COMPLETED, HORS periode) : ne doit pas compter dans
    // grossRevenue quand from/to l'excluent (9999 + 9999 + 0 = 19998).
    await creerCommande({
      buyer,
      lignes: [
        { lot: lot1, quantity: '1', unitPrice: '9999', supplierUnitPrice: '1000', lineTotal: '9999', commissionRate: '0.1', commissionAmount: '100', supplierNetAmount: '900' },
      ],
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      completedAt: new Date(Date.now() - 30 * JOUR),
      buyerFee: 9999,
      deliveryFee: 9999,
      livraison: { status: 'DELIVERED', agencyCost: 9999 },
    });

    // Creances : 2 commandes CONFIRMED non soldées. La QUOTED ne compte pas.
    // Un paiement CONFIRMED de 1500 a déjà recouvré la seconde : son solde
    // est de 2500, pas 4000.
    await creerCommande({
      buyer,
      lignes: [
        { lot: lot1, quantity: '6', unitPrice: '1000', supplierUnitPrice: '800', lineTotal: '6000', commissionRate: '0.1', commissionAmount: '480', supplierNetAmount: '4320' },
      ],
      status: 'CONFIRMED',
      paymentStatus: 'UNPAID',
      livraison: { status: 'PENDING', agencyCost: 0 },
    });
    const commandePartielle = await creerCommande({
      buyer,
      lignes: [
        { lot: lot2, quantity: '4', unitPrice: '1000', supplierUnitPrice: '800', lineTotal: '4000', commissionRate: '0.1', commissionAmount: '320', supplierNetAmount: '3280' },
      ],
      status: 'CONFIRMED',
      paymentStatus: 'PARTIALLY_PAID',
    });
    await prisma.payment.create({
      data: { orderId: commandePartielle.id, amount: '1500', method: 'MOBILE_MONEY', status: 'CONFIRMED' },
    });
    await creerCommande({
      buyer,
      lignes: [
        { lot: lot1, quantity: '1', unitPrice: '1000', supplierUnitPrice: '800', lineTotal: '1000', commissionRate: '0.1', commissionAmount: '80', supplierNetAmount: '720' },
      ],
      status: 'QUOTED',
      paymentStatus: 'UNPAID',
    });

    // Reversements : READY 4500 + ON_HOLD 1800 (le PAID ne compte pas).
    const commande1 = await prisma.order.findFirst({ where: { status: 'COMPLETED', paymentStatus: 'PAID' } });
    const commande2 = await prisma.order.findFirst({ where: { status: 'COMPLETED', paymentStatus: 'PAID' }, skip: 1 });
    await prisma.supplierPayout.create({
      data: { orderId: commande1.id, supplierId: f1.profile.id, grossAmount: '5000', commissionAmount: '500', netAmount: '4500', status: 'READY' },
    });
    await prisma.supplierPayout.create({
      data: { orderId: commande1.id, supplierId: f2.profile.id, grossAmount: '2000', commissionAmount: '200', netAmount: '1800', status: 'ON_HOLD' },
    });
    await prisma.supplierPayout.create({
      data: { orderId: commande2.id, supplierId: f1.profile.id, grossAmount: '10000', commissionAmount: '1000', netAmount: '9000', status: 'PAID' },
    });

    // Indemnisations : 2 PENDING_APPROVAL (10000 + 2000), 1 APPROVE exclu.
    await prisma.supplierCompensation.create({
      data: { supplierId: f1.profile.id, lotId: lot1.id, reason: 'EXPIRED_UNSOLD', quantity: '10', unitPrice: '1000', rate: '1', amount: '10000', status: 'PENDING_APPROVAL' },
    });
    await prisma.supplierCompensation.create({
      data: { supplierId: f2.profile.id, lotId: lot2.id, reason: 'LOST_OR_DAMAGED', quantity: '5', unitPrice: '800', rate: '0.5', amount: '2000', status: 'PENDING_APPROVAL' },
    });
    await prisma.supplierCompensation.create({
      data: { supplierId: f1.profile.id, lotId: lot3.id, reason: 'OTHER', quantity: '1', unitPrice: '1000', rate: '1', amount: '1000', status: 'APPROVED' },
    });

    // Parrainages : 2 ELIGIBLE (5000 + 10000), 1 PENDING exclu. referredId est
    // unique : trois filleuls distincts.
    await prisma.referral.create({
      data: { referrerId: admin.id, referredId: buyer.id, kind: 'BUYER', status: 'ELIGIBLE', rewardAmount: '5000' },
    });
    await prisma.referral.create({
      data: { referrerId: admin.id, referredId: f2.user.id, kind: 'SUPPLIER', status: 'ELIGIBLE', rewardAmount: '10000' },
    });
    await prisma.referral.create({
      data: { referrerId: f1.user.id, referredId: driver.id, kind: 'BUYER', status: 'PENDING', rewardAmount: '5000' },
    });

    // --- Appel ---
    const res = await api().get('/api/v2/admin/stats').set(authHeader(tokenPour(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(200);

    // Utilisateurs par role : tous les roles seedes figurent, meme a zero.
    expect(res.body.usersByRole).toEqual({ ROOT: 0, ADMIN: 1, AGENT: 0, SUPPLIER: 2, BUYER: 1, DRIVER: 1 });

    // Repartitions par statut.
    expect(res.body.lotsByStatus).toEqual({ AVAILABLE: 2, SOLD_OUT: 1, EXPIRED: 1 });
    expect(res.body.ordersByStatus).toEqual({ COMPLETED: 3, CONFIRMED: 2, QUOTED: 1 });
    // DELIVERED : commande 1 et commande 3 (hors periode). PENDING : commande 4.
    expect(res.body.deliveriesByStatus).toEqual({ DELIVERED: 2, PENDING: 1 });

    // Stock : instantane courant.
    expect(res.body.stock).toEqual({ available: 150, reserved: 10, sold: 30, lost: 20 });

    // Creances : solde restant dû = 6000 (UNPAID) + 2500 (4000 - 1500 payés).
    expect(res.body.receivables).toBe(8500);
    expect(res.body.receivablesCount).toBe(2);

    // Reversements en attente : READY + ON_HOLD.
    expect(res.body.pendingPayouts).toBe(6300);

    // Indemnisations : 2 PENDING_APPROVAL, 10000 + 2000 (l'APPROVE exclu).
    expect(res.body.pendingCompensations).toEqual({ count: 2, amount: 12000 });

    // Parrainages : 2 ELIGIBLE, 5000 + 10000 (le PENDING exclu).
    expect(res.body.eligibleReferrals).toEqual({ count: 2, amount: 15000 });

    // Sans periode : les 3 commandes COMPLETED comptent.
    // 1900 + 1000 + (100 + 9999 + 0) = 12999.
    expect(res.body.grossRevenue).toBe(12999);
  });

  it('grossRevenue ne compte que les commandes COMPLETED de la periode', async () => {
    const f1 = await fournisseur();
    const buyer = await createUser({ role: 'BUYER' });
    const admin = await createUser({ role: 'ADMIN' });
    const lot1 = await creerLot({ quantity: '100', available: '100', fournisseur: f1 });

    // Dans la periode : commission 10 x 900 x 0,1 = 900, sans frais ni livraison.
    await creerCommande({
      buyer,
      lignes: [
        { lot: lot1, quantity: '10', unitPrice: '1000', supplierUnitPrice: '900', lineTotal: '10000', commissionRate: '0.1', commissionAmount: '900', supplierNetAmount: '8100' },
      ],
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      completedAt: new Date(),
    });
    // Hors periode : commission 1 x 900 x 0,1 = 90, sans frais ni livraison.
    await creerCommande({
      buyer,
      lignes: [
        { lot: lot1, quantity: '1', unitPrice: '9999', supplierUnitPrice: '900', lineTotal: '9999', commissionRate: '0.1', commissionAmount: '90', supplierNetAmount: '8910' },
      ],
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      completedAt: new Date(Date.now() - 30 * JOUR),
    });

    const periode = (r) => r.query({ from: new Date(Date.now() - 7 * JOUR).toISOString(), to: new Date(Date.now() + 7 * JOUR).toISOString() });
    const avecPeriode = await periode(api().get('/api/v2/admin/stats')).set(authHeader(tokenPour(admin, 'ADMIN')));
    expect(avecPeriode.status, avecPeriode.text).toBe(200);
    expect(avecPeriode.body.grossRevenue).toBe(900);

    // Periode future : aucune commande.
    const futur = await api()
      .get('/api/v2/admin/stats')
      .set(authHeader(tokenPour(admin, 'ADMIN')))
      .query({ from: new Date(Date.now() + JOUR).toISOString(), to: new Date(Date.now() + 7 * JOUR).toISOString() });
    expect(futur.status, futur.text).toBe(200);
    expect(futur.body.grossRevenue).toBe(0);

    // Pas de periode : les deux commandes comptent (900 + 90).
    const sansPeriode = await api().get('/api/v2/admin/stats').set(authHeader(tokenPour(admin, 'ADMIN')));
    expect(sansPeriode.status, sansPeriode.text).toBe(200);
    expect(sansPeriode.body.grossRevenue).toBe(990);
  });

  it('grossRevenue ne compte pas les livraisons CANCELLED', async () => {
    const f1 = await fournisseur();
    const buyer = await createUser({ role: 'BUYER' });
    const admin = await createUser({ role: 'ADMIN' });
    const lot1 = await creerLot({ quantity: '100', available: '100', fournisseur: f1 });

    // Livraison annulée puis recréée (P5.4) : seul le coût de la livraison
    // non annulée compte dans la marge de livraison.
    const commande = await creerCommande({
      buyer,
      lignes: [
        { lot: lot1, quantity: '10', unitPrice: '1000', supplierUnitPrice: '900', lineTotal: '10000', commissionRate: '0.1', commissionAmount: '1000', supplierNetAmount: '9000' },
      ],
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      completedAt: new Date(),
      livraison: { status: 'CANCELLED', agencyCost: '2000' },
    });
    const agence = await prisma.transportAgency.create({
      data: { name: identifiant('Agence'), phone: '+33600000000' },
    });
    await prisma.delivery.create({
      data: {
        orderId: commande.id,
        agencyId: agence.id,
        dropoffAddress: '1 rue du Test',
        status: 'DELIVERED',
        agencyCost: '500',
      },
    });

    const res = await api().get('/api/v2/admin/stats').set(authHeader(tokenPour(admin, 'ADMIN')));
    expect(res.status, res.text).toBe(200);
    // commission 1000 + frais 0 + (deliveryFee 0 - 500) = 500.
    // L'ancienne définition comptait aussi les 2000 de la livraison annulée.
    expect(res.body.grossRevenue).toBe(500);
  });

  it('creances : solde restant du (paiements CONFIRMED déduits), commandes en cours incluses', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const admin = await createUser({ role: 'ADMIN' });
    const f1 = await fournisseur();
    const lot1 = await creerLot({ quantity: '100', available: '100', fournisseur: f1 });

    // CONFIRMED partiellement payée : 4000 - 1500 = 2500 dus.
    const commandePartielle = await creerCommande({
      buyer,
      lignes: [
        { lot: lot1, quantity: '4', unitPrice: '1000', supplierUnitPrice: '800', lineTotal: '4000', commissionRate: '0.1', commissionAmount: '400', supplierNetAmount: '3200' },
      ],
      status: 'CONFIRMED',
      paymentStatus: 'PARTIALLY_PAID',
    });
    await prisma.payment.create({
      data: { orderId: commandePartielle.id, amount: '1500', method: 'MOBILE_MONEY', status: 'CONFIRMED' },
    });

    // PREPARING impayée : 3000 dus.
    await creerCommande({
      buyer,
      lignes: [
        { lot: lot1, quantity: '3', unitPrice: '1000', supplierUnitPrice: '800', lineTotal: '3000', commissionRate: '0.1', commissionAmount: '300', supplierNetAmount: '2400' },
      ],
      status: 'PREPARING',
      paymentStatus: 'UNPAID',
    });

    // COMPLETED soldée : ne compte plus dans les créances.
    await creerCommande({
      buyer,
      lignes: [
        { lot: lot1, quantity: '2', unitPrice: '1000', supplierUnitPrice: '800', lineTotal: '2000', commissionRate: '0.1', commissionAmount: '200', supplierNetAmount: '1600' },
      ],
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      completedAt: new Date(),
    });

    const res = await api().get('/api/v2/admin/stats').set(authHeader(tokenPour(admin, 'ADMIN')));
    expect(res.status, res.text).toBe(200);
    expect(res.body.receivables).toBe(5500);
    expect(res.body.receivablesCount).toBe(2);
  });

  it('refuse un AGENT (403) et un appel non authentifie (401)', async () => {
    // Un AGENT, meme sans capacite : requireMinLevel(50) le bloque avant le
    // controleur.
    const agentUser = await createUser({ role: 'AGENT' });
    await prisma.agent.create({
      data: { kind: 'HUMAN', userId: agentUser.id, displayName: 'Agent Test', isActive: true },
    });

    const statsAgent = await api().get('/api/v2/admin/stats').set(authHeader(tokenPour(agentUser, 'AGENT')));
    expect(statsAgent.status, statsAgent.text).toBe(403);

    const auditAgent = await api().get('/api/v2/admin/audit-logs').set(authHeader(tokenPour(agentUser, 'AGENT')));
    expect(auditAgent.status, auditAgent.text).toBe(403);

    const sansToken = await api().get('/api/v2/admin/stats');
    expect(sansToken.status, sansToken.text).toBe(401);
  });
});

describe('GET /api/v2/admin/audit-logs', () => {
  async function jeuDeLogs() {
    const admin = await createUser({ role: 'ADMIN' });
    const agentUser = await createUser({ role: 'AGENT' });
    const agent = await prisma.agent.create({
      data: { kind: 'HUMAN', userId: agentUser.id, displayName: 'Agent Test', isActive: true },
    });
    const f1 = await fournisseur();
    const lot1 = await creerLot({ quantity: '100', available: '100', fournisseur: f1 });
    const buyer = await createUser({ role: 'BUYER' });
    const commande1 = await creerCommande({
      buyer,
      lignes: [
        { lot: lot1, quantity: '5', unitPrice: '1200', supplierUnitPrice: '1000', lineTotal: '6000', commissionRate: '0.1', commissionAmount: '500', supplierNetAmount: '4500' },
      ],
      status: 'QUOTED',
      paymentStatus: 'UNPAID',
    });

    // Quatre logs aux dates controlees, de T a T + 3 h. T est retourne : les
    // assertions de filtre doivent utiliser la meme reference que les fixtures,
    // pas un Date.now() recalcule quelques millisecondes plus tard.
    const T = Date.now() - 2 * 3600 * 1000;
    const logs = [
      { action: 'LOT_VALIDATED', entityType: 'StockLot', entityId: lot1.id, actorUserId: admin.id, createdAt: new Date(T) },
      { action: 'ORDER_QUOTED', entityType: 'Order', entityId: commande1.id, actorAgentId: agent.id, createdAt: new Date(T + 3600 * 1000) },
      { action: 'SETTINGS_UPDATED', entityType: 'PlatformSetting', entityId: 1, actorUserId: admin.id, createdAt: new Date(T + 2 * 3600 * 1000) },
      { action: 'PROFILE_VERIFIED', entityType: 'User', entityId: admin.id, actorUserId: admin.id, createdAt: new Date(T + 3 * 3600 * 1000) },
    ];
    for (const log of logs) {
      await prisma.auditLog.create({ data: log });
    }
    return { admin, agent, lot1, commande1, T };
  }

  it('renvoie tous les logs en ordre antichronologique', async () => {
    const { admin } = await jeuDeLogs();

    const res = await api().get('/api/v2/admin/audit-logs').set(authHeader(tokenPour(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(20);
    // Le plus recent d'abord.
    expect(res.body.items.map((l) => l.action)).toEqual([
      'PROFILE_VERIFIED',
      'SETTINGS_UPDATED',
      'ORDER_QUOTED',
      'LOT_VALIDATED',
    ]);
    // Champs exposes.
    expect(res.body.items[0]).toMatchObject({
      action: 'PROFILE_VERIFIED',
      entityType: 'User',
    });
  });

  it('filtre par entityType et entityId', async () => {
    const { admin, lot1 } = await jeuDeLogs();

    const parType = await api()
      .get('/api/v2/admin/audit-logs')
      .set(authHeader(tokenPour(admin, 'ADMIN')))
      .query({ entityType: 'StockLot' });
    expect(parType.status, parType.text).toBe(200);
    expect(parType.body.total).toBe(1);
    expect(parType.body.items[0].entityId).toBe(lot1.id);

    const parTypeEtId = await api()
      .get('/api/v2/admin/audit-logs')
      .set(authHeader(tokenPour(admin, 'ADMIN')))
      .query({ entityType: 'StockLot', entityId: lot1.id });
    expect(parTypeEtId.status, parTypeEtId.text).toBe(200);
    expect(parTypeEtId.body.total).toBe(1);

    // Combinaison sans resultat.
    const vide = await api()
      .get('/api/v2/admin/audit-logs')
      .set(authHeader(tokenPour(admin, 'ADMIN')))
      .query({ entityType: 'StockLot', entityId: 999999 });
    expect(vide.status, vide.text).toBe(200);
    expect(vide.body.total).toBe(0);
    expect(vide.body.items).toEqual([]);
  });

  it('filtre par acteur (utilisateur ou agent)', async () => {
    const { admin, agent } = await jeuDeLogs();

    const parUser = await api()
      .get('/api/v2/admin/audit-logs')
      .set(authHeader(tokenPour(admin, 'ADMIN')))
      .query({ actorUserId: admin.id });
    expect(parUser.status, parUser.text).toBe(200);
    expect(parUser.body.total).toBe(3);

    const parAgent = await api()
      .get('/api/v2/admin/audit-logs')
      .set(authHeader(tokenPour(admin, 'ADMIN')))
      .query({ actorAgentId: agent.id });
    expect(parAgent.status, parAgent.text).toBe(200);
    expect(parAgent.body.total).toBe(1);
    expect(parAgent.body.items[0].action).toBe('ORDER_QUOTED');
  });

  it('filtre par periode from/to', async () => {
    const { admin, T } = await jeuDeLogs();

    const apres = await api()
      .get('/api/v2/admin/audit-logs')
      .set(authHeader(tokenPour(admin, 'ADMIN')))
      .query({ from: new Date(T + 1.5 * 3600 * 1000).toISOString() });
    expect(apres.status, apres.text).toBe(200);
    // Les logs de T+3h et T+2h seulement.
    expect(apres.body.total).toBe(2);
    expect(apres.body.items.map((l) => l.action)).toEqual(['PROFILE_VERIFIED', 'SETTINGS_UPDATED']);

    const avant = await api()
      .get('/api/v2/admin/audit-logs')
      .set(authHeader(tokenPour(admin, 'ADMIN')))
      .query({ to: new Date(T + 0.5 * 3600 * 1000).toISOString() });
    expect(avant.status, avant.text).toBe(200);
    // Le log de T seulement.
    expect(avant.body.total).toBe(1);
    expect(avant.body.items[0].action).toBe('LOT_VALIDATED');
  });

  it('page correctement (page/limit/total)', async () => {
    const { admin } = await jeuDeLogs();

    const page1 = await api()
      .get('/api/v2/admin/audit-logs')
      .set(authHeader(tokenPour(admin, 'ADMIN')))
      .query({ page: 1, limit: 2 });
    expect(page1.status, page1.text).toBe(200);
    expect(page1.body.total).toBe(4);
    expect(page1.body.page).toBe(1);
    expect(page1.body.limit).toBe(2);
    expect(page1.body.items).toHaveLength(2);

    const page2 = await api()
      .get('/api/v2/admin/audit-logs')
      .set(authHeader(tokenPour(admin, 'ADMIN')))
      .query({ page: 2, limit: 2 });
    expect(page2.status, page2.text).toBe(200);
    expect(page2.body.items).toHaveLength(2);
    // Le plus recent de la page 2 suit le moins recent de la page 1.
    expect(page2.body.items[0].action).toBe('ORDER_QUOTED');
    expect(page2.body.items[1].action).toBe('LOT_VALIDATED');
  });

  it('refuse un AGENT (403) et un appel non authentifie (401)', async () => {
    const agentUser = await createUser({ role: 'AGENT' });
    await prisma.agent.create({
      data: { kind: 'HUMAN', userId: agentUser.id, displayName: 'Agent Test', isActive: true },
    });

    const agent = await api().get('/api/v2/admin/audit-logs').set(authHeader(tokenPour(agentUser, 'AGENT')));
    expect(agent.status, agent.text).toBe(403);

    const sansToken = await api().get('/api/v2/admin/audit-logs');
    expect(sansToken.status, sansToken.text).toBe(401);
  });
});
