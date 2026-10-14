import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser, createListingForLot } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { toDecimal } from '../../src/utils/money.js';
import { PROJECT_ROOT } from '../setup/env.js';

const Decimal = Prisma.Decimal;

const DANS_7_JOURS = new Date(Date.now() + 7 * 24 * 3600 * 1000);

// --- Fixtures ---

function identifiant(prefixe) {
  return `${prefixe}-${Date.now()}-${randomInt(1_000, 9_999)}`;
}

function tokenPour(user, role) {
  const levels = { AGENT: 30, ADMIN: 50, ROOT: 100, BUYER: 10, SUPPLIER: 10 };
  return generateToken({ id: user.id, role: { code: role, level: levels[role] ?? 10 } });
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
      expiresAt: DANS_7_JOURS,
      status: 'AVAILABLE',
    },
  });
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

// --- Tests ---

describe('GET /api/v2/admin/settings', () => {
  it('renvoie la ligne unique id = 1 (ADMIN)', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await api().get('/api/v2/admin/settings').set(authHeader(tokenPour(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.id).toBe(1);
    expect(res.body.currency).toBe('XAF');
    expect(res.body.buyerFeeType).toBe('NONE');
    expect(res.body.buyerFeeValue).toBe(0);
    // Valeurs par défaut du schéma, telles que le seed les a écrites.
    expect(toDecimal(res.body.supplierCommissionRate).isZero()).toBe(true);
    expect(res.body.reservationHours).toBe(24);
  });

  it('refuse un BUYER (403 — requireMinLevel(50))', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const res = await api().get('/api/v2/admin/settings').set(authHeader(tokenPour(buyer, 'BUYER')));

    expect(res.status, res.text).toBe(403);
  });
});

describe('PATCH /api/v2/admin/settings', () => {
  // PlatformSetting n'est pas vidée entre les tests (REFERENCE_TABLES : seedée
  // une fois). Ces tests modifient des taux : ils mémorisent la valeur d'origine
  // et la restaurent après la suite, comme tests/integration/supplier-payouts.test.js.
  const ORIGINAL = {};
  const DEFAUT = {
    supplierCommissionRate: 0,
    buyerFeeType: 'NONE',
    buyerFeeValue: 0,
    transportMarkupRate: 0,
    referralBuyerReward: 5000,
    referralSupplierReward: 10000,
    reservationHours: 24,
    expiryCompensationRate: 1,
  };

  beforeAll(async () => {
    const settings = await prisma.platformSetting.findUnique({ where: { id: 1 } });
    if (settings) Object.assign(ORIGINAL, settings);
  });

  afterAll(async () => {
    await prisma.platformSetting.update({ where: { id: 1 }, data: DEFAUT });
  });

  it('modifie les réglages (ROOT), immédiatement visibles à la lecture', async () => {
    const root = await createUser({ role: 'ROOT' });

    const res = await api()
      .patch('/api/v2/admin/settings')
      .set(authHeader(tokenPour(root, 'ROOT')))
      .send({ supplierCommissionRate: 0.1, transportMarkupRate: 0.15, reservationHours: 48 });

    expect(res.status, res.text).toBe(200);
    expect(res.body.supplierCommissionRate).toBe(0.1);
    expect(res.body.transportMarkupRate).toBe(0.15);
    expect(res.body.reservationHours).toBe(48);

    // Aucun cache : la requête suivante lit les nouvelles valeurs en base.
    const lecture = await api().get('/api/v2/admin/settings').set(authHeader(tokenPour(root, 'ROOT')));
    expect(lecture.status, lecture.text).toBe(200);
    expect(lecture.body.supplierCommissionRate).toBe(0.1);
    expect(lecture.body.reservationHours).toBe(48);
  });

  it('refuse un ADMIN (403) et n écrit rien', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    // Valeur avant la tentative : un 403 ne doit rien écrire.
    const avant = await prisma.platformSetting.findUnique({ where: { id: 1 } });

    const res = await api()
      .patch('/api/v2/admin/settings')
      .set(authHeader(tokenPour(admin, 'ADMIN')))
      .send({ supplierCommissionRate: 0.1 });

    expect(res.status, res.text).toBe(403);

    const settings = await prisma.platformSetting.findUnique({ where: { id: 1 } });
    expect(toDecimal(settings.supplierCommissionRate).equals(avant.supplierCommissionRate)).toBe(true);
    expect(settings.reservationHours).toBe(avant.reservationHours);
    expect(settings.buyerFeeType).toBe(avant.buyerFeeType);
  });

  it('refuse hors bornes et cas limites (400)', async () => {
    const root = await createUser({ role: 'ROOT' });

    const cas = [
      ['supplierCommissionRate 0,6 (max 0,5)', { supplierCommissionRate: 0.6 }],
      ['transportMarkupRate -0,1 (négatif)', { transportMarkupRate: -0.1 }],
      ['reservationHours 0 (min 1)', { reservationHours: 0 }],
      ['reservationHours 169 (max 168)', { reservationHours: 169 }],
      ['reservationHours 12,5 (non entier)', { reservationHours: 12.5 }],
      ['referralBuyerReward -1 (négatif)', { referralBuyerReward: -1 }],
      ['expiryCompensationRate 1,2 (max 1)', { expiryCompensationRate: 1.2 }],
      ['currency (lecture seule)', { currency: 'EUR' }],
      ['corps vide', {}],
    ];

    for (const [nom, corps] of cas) {
      const res = await api()
        .patch('/api/v2/admin/settings')
        .set(authHeader(tokenPour(root, 'ROOT')))
        .send(corps);
      expect(res.status, `${nom}: ${res.text}`).toBe(400);
    }
  });

  it('accepte les valeurs aux bornes (200)', async () => {
    const root = await createUser({ role: 'ROOT' });

    const res = await api()
      .patch('/api/v2/admin/settings')
      .set(authHeader(tokenPour(root, 'ROOT')))
      .send({
        supplierCommissionRate: 0.5,
        transportMarkupRate: 1,
        reservationHours: 168,
        expiryCompensationRate: 0,
        buyerFeeType: 'PERCENT',
        buyerFeeValue: 1,
      });

    expect(res.status, res.text).toBe(200);
    expect(res.body.supplierCommissionRate).toBe(0.5);
    expect(res.body.buyerFeeType).toBe('PERCENT');
    expect(res.body.buyerFeeValue).toBe(1);
  });

  it('refuse buyerFeeType NONE avec une valeur non nulle (400)', async () => {
    const root = await createUser({ role: 'ROOT' });

    const res = await api()
      .patch('/api/v2/admin/settings')
      .set(authHeader(tokenPour(root, 'ROOT')))
      .send({ buyerFeeType: 'NONE', buyerFeeValue: 500 });

    expect(res.status, res.text).toBe(400);
    expect(res.body.error).toContain('buyerFeeValue');
  });

  it('refuse NONE après fusion quand la valeur en base est non nulle (400)', async () => {
    const root = await createUser({ role: 'ROOT' });

    // Étape 1 : FIXED avec une valeur — autorisé.
    const fixe = await api()
      .patch('/api/v2/admin/settings')
      .set(authHeader(tokenPour(root, 'ROOT')))
      .send({ buyerFeeType: 'FIXED', buyerFeeValue: 250 });
    expect(fixe.status, fixe.text).toBe(200);

    // Étape 2 : passer à NONE sans remettre la valeur à zéro — refusé, car la
    // valeur fusionnée (250, celle en base) n'est pas nulle.
    const none = await api()
      .patch('/api/v2/admin/settings')
      .set(authHeader(tokenPour(root, 'ROOT')))
      .send({ buyerFeeType: 'NONE' });
    expect(none.status, none.text).toBe(400);

    // Étape 3 : NONE avec valeur 0 explicite — accepté.
    const noneZero = await api()
      .patch('/api/v2/admin/settings')
      .set(authHeader(tokenPour(root, 'ROOT')))
      .send({ buyerFeeType: 'NONE', buyerFeeValue: 0 });
    expect(noneZero.status, noneZero.text).toBe(200);
    expect(noneZero.body.buyerFeeType).toBe('NONE');
    expect(noneZero.body.buyerFeeValue).toBe(0);
  });

  it('écrit un AuditLog SETTINGS_UPDATED avec before/after limités aux champs modifiés', async () => {
    const root = await createUser({ role: 'ROOT' });

    // Valeur avant le PATCH : before doit la reprendre exactement (les tests
    // précédents ont pu modifier les réglages : PlatformSetting n est pas videe
    // entre deux tests).
    const avant = await prisma.platformSetting.findUnique({ where: { id: 1 } });

    const res = await api()
      .patch('/api/v2/admin/settings')
      .set(authHeader(tokenPour(root, 'ROOT')))
      .send({ supplierCommissionRate: 0.125, reservationHours: 48 });

    expect(res.status, res.text).toBe(200);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'SETTINGS_UPDATED', entityType: 'PlatformSetting', entityId: 1 },
    });
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(root.id);

    // before/after ne portent que les deux champs modifiés, avec les valeurs
    // d'avant pour before.
    expect(audit.metadata).toMatchObject({
      before: { supplierCommissionRate: avant.supplierCommissionRate.toNumber(), reservationHours: avant.reservationHours },
      after: { supplierCommissionRate: 0.125, reservationHours: 48 },
    });
    expect(audit.metadata.before).not.toHaveProperty('currency');
    expect(audit.metadata.before).not.toHaveProperty('transportMarkupRate');
    expect(audit.metadata.after).not.toHaveProperty('buyerFeeType');
  });

  it('fige la commission sur chaque devis au taux en vigueur (ni cache, ni rétroactivité)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);
    const lot = await creerLot({ agreedUnitPrice: '1000.00' });
    const annonce = await createListingForLot(lot);
    // Prix public ≠ prix convenu : la commission porte sur le prix convenu.
    await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1200.00' } });
    const hub = await creerHub();

    // Taux en vigueur AVANT tout changement : le premier devis doit le garder
    // (les tests précédents ont pu modifier les réglages : PlatformSetting n est
    // pas videe entre deux tests).
    const tauxAvant = toDecimal(
      (await prisma.platformSetting.findUnique({ where: { id: 1 } })).supplierCommissionRate
    );

    const devis = async () => {
      const res = await api()
        .post('/api/v2/staff/orders')
        .set(authHeader(tokenPour(agentUser, 'AGENT')))
        .send({
          buyerId: buyer.id,
          items: [{ listingId: annonce.id, quantity: 5 }],
          deliveryMode: 'HUB_PICKUP',
          pickupHubId: hub.id,
        });
      expect(res.status, res.text).toBe(201);
      return res;
    };

    // Devis 1 : commission au taux alors en vigueur.
    const premier = await devis();

    // ROOT passe la commission à 10 %.
    const root = await createUser({ role: 'ROOT' });
    const patch = await api()
      .patch('/api/v2/admin/settings')
      .set(authHeader(tokenPour(root, 'ROOT')))
      .send({ supplierCommissionRate: 0.1 });
    expect(patch.status, patch.text).toBe(200);
    expect(patch.body.supplierCommissionRate).toBe(0.1);

    // Devis 2 : nouveau taux.
    const second = await devis();

    // Le taux est figé sur chaque ligne : le premier devis garde l'ancien taux,
    // le second prend le nouveau — getSettings ne touche jamais une commande
    // existante.
    const baseFournisseur = new Decimal('5000'); // 5 x 1000
    const items = await prisma.orderItem.findMany({
      where: { orderId: { in: [premier.body.id, second.body.id] } },
      orderBy: { id: 'asc' },
    });
    expect(items[0].commissionRate.equals(tauxAvant)).toBe(true);
    expect(items[1].commissionRate.toFixed(4)).toBe('0.1000');
    // commission = base x taux, arrondie comme le moteur de prix.
    expect(items[0].commissionAmount.toFixed(0)).toBe(
      baseFournisseur.mul(tauxAvant).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0)
    );
    // 5 x 1000 x 10 % = 500.
    expect(items[1].commissionAmount.toFixed(0)).toBe('500');
  });

  it('le seed ne réécrit pas une valeur modifiée', async () => {
    const root = await createUser({ role: 'ROOT' });

    const patch = await api()
      .patch('/api/v2/admin/settings')
      .set(authHeader(tokenPour(root, 'ROOT')))
      .send({ transportMarkupRate: 0.15 });
    expect(patch.status, patch.text).toBe(200);

    // Ré-exécute le seed exactement comme le global setup (sous-processus,
    // base de test) : son upsert a update vide et ne doit pas écraser la valeur.
    execFileSync(process.execPath, [path.join('prisma', 'seed.js')], {
      cwd: PROJECT_ROOT,
      env: { ...process.env },
      stdio: 'pipe',
    });

    const settings = await prisma.platformSetting.findUnique({ where: { id: 1 } });
    expect(toDecimal(settings.transportMarkupRate).toFixed(4)).toBe('0.1500');
  });
});
