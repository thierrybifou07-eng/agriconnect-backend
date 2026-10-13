import { describe, it, expect } from 'vitest';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser, createListingForLot } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

const Decimal = Prisma.Decimal;

const DANS_7_JOURS = new Date(Date.now() + 7 * 24 * 3600 * 1000);

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

function tokenPour(user) {
  return generateToken({ id: user.id, role: { code: 'AGENT', level: 30 } });
}

function tokenAdminPour(user) {
  return generateToken({ id: user.id, role: { code: 'ADMIN', level: 50 } });
}

// Crée une commande AGENCY_DELIVERY en statut PREPARING avec les lignes données.
async function creerCommandePreparing({ items, agencyZone, buyer }) {
  const order = await prisma.order.create({
    data: {
      orderNumber: identifiant('AC'),
      buyerId: buyer.id,
      deliveryModeId: (await prisma.deliveryMode.findFirst({ where: { code: 'AGENCY_DELIVERY' } })).id,
      deliveryZoneId: agencyZone.zoneId,
      deliveryAddress: '10 avenue de la Gare',
      deliveryLatitude: 48.85,
      deliveryLongitude: 2.35,
      status: 'PREPARING',
      paymentStatus: 'PAID',
      subtotal: items.reduce((acc, i) => acc.add(i.lineTotal), new Decimal(0)),
      buyerFee: new Decimal(0),
      deliveryFee: new Decimal(0),
      total: items.reduce((acc, i) => acc.add(i.lineTotal), new Decimal(0)),
      commissionTotal: new Decimal(0),
    },
  });

  for (const item of items) {
    await prisma.orderItem.create({
      data: {
        orderId: order.id,
        listingId: item.listingId,
        lotId: item.lotId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        supplierUnitPrice: item.supplierUnitPrice,
        lineTotal: item.lineTotal,
        commissionRate: new Decimal(0),
        commissionAmount: new Decimal(0),
        supplierNetAmount: item.lineTotal,
      },
    });
  }

  return order;
}

async function creerAgenceAvecZone(zoneId, overrides = {}) {
  const agency = await prisma.transportAgency.create({
    data: {
      name: identifiant('Agence'),
      phone: '+33600000000',
      isActive: true,
      ...overrides,
    },
  });
  const agencyZone = await prisma.agencyZone.create({
    data: {
      agencyId: agency.id,
      zoneId,
      baseFee: '500',
      perKmFee: '100',
      isActive: true,
    },
  });
  return { agency, agencyZone };
}

describe('POST /api/v2/staff/orders/:id/deliveries', () => {
  it('un seul fournisseur -> une livraison dont deliveryFee égale celui du devis', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const lot = await creerLot({ quantity: '50', agreedUnitPrice: '800.00' });
    const annonce = await createListingForLot(lot);
    await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1000.00' } });

    const zoneLivraison = await zone();
    await creerAgenceAvecZone(zoneLivraison.id);

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'DISPATCH_COORDINATION']);

    // Crée d'abord le devis pour obtenir le deliveryFee.
    const devisRes = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: buyer.id,
        items: [{ listingId: annonce.id, quantity: 10 }],
        deliveryMode: 'AGENCY_DELIVERY',
        delivery: {
          zoneId: zoneLivraison.id,
          address: '10 avenue de la Gare',
          latitude: 48.85,
          longitude: 2.35,
        },
      });
    expect(devisRes.status, devisRes.text).toBe(201);
    const deliveryFeeDevis = devisRes.body.deliveryFee;

    // Passe la commande en PREPARING.
    await prisma.order.update({
      where: { id: devisRes.body.id },
      data: { status: 'PREPARING', paymentStatus: 'PAID' },
    });

    // Crée les livraisons.
    const res = await api()
      .post(`/api/v2/staff/orders/${devisRes.body.id}/deliveries`)
      .set(authHeader(tokenPour(agentUser)))
      .send({});

    expect(res.status, res.text).toBe(201);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].deliveryFee).toBe(deliveryFeeDevis);
    expect(res.body[0].agencyCost).toBeGreaterThan(0);
    expect(res.body[0].insuredValue).toBe(10000); // 10 x 1000
    expect(res.body[0].insurancePolicyNumber).toBeNull();
    expect(res.body[0].status).toBe('PENDING');

    // Les lignes sont rattachées.
    const items = await prisma.orderItem.findMany({ where: { orderId: devisRes.body.id } });
    expect(items).toHaveLength(1);
    expect(items[0].deliveryId).toBe(res.body[0].id);

    // Audit.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'DELIVERIES_CREATED', entityType: 'Order', entityId: devisRes.body.id },
    });
    expect(audit).toBeTruthy();
  });

  it('deux origines -> deux livraisons', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const lotA = await creerLot({ quantity: '50', agreedUnitPrice: '800.00' });
    const annonceA = await createListingForLot(lotA);
    await prisma.listing.update({ where: { id: annonceA.id }, data: { unitPrice: '1000.00' } });

    const lotB = await creerLot({ quantity: '50', agreedUnitPrice: '600.00' });
    const annonceB = await createListingForLot(lotB);
    await prisma.listing.update({ where: { id: annonceB.id }, data: { unitPrice: '800.00' } });

    const zoneLivraison = await zone();
    await creerAgenceAvecZone(zoneLivraison.id);

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'DISPATCH_COORDINATION']);

    const devisRes = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: buyer.id,
        items: [
          { listingId: annonceA.id, quantity: 5 },
          { listingId: annonceB.id, quantity: 3 },
        ],
        deliveryMode: 'AGENCY_DELIVERY',
        delivery: {
          zoneId: zoneLivraison.id,
          address: '10 avenue de la Gare',
          latitude: 48.85,
          longitude: 2.35,
        },
      });
    expect(devisRes.status, devisRes.text).toBe(201);

    await prisma.order.update({
      where: { id: devisRes.body.id },
      data: { status: 'PREPARING', paymentStatus: 'PAID' },
    });

    const res = await api()
      .post(`/api/v2/staff/orders/${devisRes.body.id}/deliveries`)
      .set(authHeader(tokenPour(agentUser)))
      .send({});

    expect(res.status, res.text).toBe(201);
    expect(res.body).toHaveLength(2);

    // insuredValue correcte par groupe.
    const insuredValues = res.body.map((d) => d.insuredValue).sort();
    expect(insuredValues).toEqual([2400, 5000]); // 3x800 et 5x1000
  });

  it('refus si la commande n\'est pas PREPARING : 409 INVALID_ORDER_STATUS', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const lot = await creerLot({ quantity: '50' });
    const annonce = await createListingForLot(lot);

    const zoneLivraison = await zone();
    await creerAgenceAvecZone(zoneLivraison.id);

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'DISPATCH_COORDINATION']);

    // Crée un devis (QUOTED, pas PREPARING).
    const devisRes = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: buyer.id,
        items: [{ listingId: annonce.id, quantity: 2 }],
        deliveryMode: 'AGENCY_DELIVERY',
        delivery: {
          zoneId: zoneLivraison.id,
          address: '10 avenue de la Gare',
          latitude: 48.85,
          longitude: 2.35,
        },
      });
    expect(devisRes.status, devisRes.text).toBe(201);

    const res = await api()
      .post(`/api/v2/staff/orders/${devisRes.body.id}/deliveries`)
      .set(authHeader(tokenPour(agentUser)))
      .send({});

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('INVALID_ORDER_STATUS');
  });

  it('refus si déjà créées : 409 DELIVERIES_ALREADY_CREATED', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const lot = await creerLot({ quantity: '50', agreedUnitPrice: '800.00' });
    const annonce = await createListingForLot(lot);
    await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1000.00' } });

    const zoneLivraison = await zone();
    await creerAgenceAvecZone(zoneLivraison.id);

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'DISPATCH_COORDINATION']);

    const devisRes = await api()
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
      });
    expect(devisRes.status, devisRes.text).toBe(201);

    await prisma.order.update({
      where: { id: devisRes.body.id },
      data: { status: 'PREPARING', paymentStatus: 'PAID' },
    });

    // Première création.
    const res1 = await api()
      .post(`/api/v2/staff/orders/${devisRes.body.id}/deliveries`)
      .set(authHeader(tokenPour(agentUser)))
      .send({});
    expect(res1.status, res1.text).toBe(201);

    // Seconde création -> 409.
    const res2 = await api()
      .post(`/api/v2/staff/orders/${devisRes.body.id}/deliveries`)
      .set(authHeader(tokenPour(agentUser)))
      .send({});
    expect(res2.status, res2.text).toBe(409);
    expect(res2.body.code).toBe('DELIVERIES_ALREADY_CREATED');
  });

  it('assurance expirée : 409 AGENCY_INSURANCE_EXPIRED', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const lot = await creerLot({ quantity: '50', agreedUnitPrice: '800.00' });
    const annonce = await createListingForLot(lot);
    await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1000.00' } });

    const zoneLivraison = await zone();
    await creerAgenceAvecZone(zoneLivraison.id, {
      insuranceExpiresAt: new Date(Date.now() - 24 * 3600 * 1000), // expirée hier
    });

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'DISPATCH_COORDINATION']);

    const devisRes = await api()
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
      });
    expect(devisRes.status, devisRes.text).toBe(201);

    await prisma.order.update({
      where: { id: devisRes.body.id },
      data: { status: 'PREPARING', paymentStatus: 'PAID' },
    });

    const res = await api()
      .post(`/api/v2/staff/orders/${devisRes.body.id}/deliveries`)
      .set(authHeader(tokenPour(agentUser)))
      .send({});

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('AGENCY_INSURANCE_EXPIRED');
  });

  it('un AGENT sans DISPATCH_COORDINATION est refusé : 403', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const lot = await creerLot({ quantity: '50' });
    const annonce = await createListingForLot(lot);

    const zoneLivraison = await zone();
    await creerAgenceAvecZone(zoneLivraison.id);

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

    const devisRes = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: buyer.id,
        items: [{ listingId: annonce.id, quantity: 2 }],
        deliveryMode: 'AGENCY_DELIVERY',
        delivery: {
          zoneId: zoneLivraison.id,
          address: '10 avenue de la Gare',
          latitude: 48.85,
          longitude: 2.35,
        },
      });
    expect(devisRes.status, devisRes.text).toBe(201);

    await prisma.order.update({
      where: { id: devisRes.body.id },
      data: { status: 'PREPARING', paymentStatus: 'PAID' },
    });

    const res = await api()
      .post(`/api/v2/staff/orders/${devisRes.body.id}/deliveries`)
      .set(authHeader(tokenPour(agentUser)))
      .send({});

    expect(res.status, res.text).toBe(403);
  });

  it('un ADMIN peut créer des livraisons sans capacité spécifique', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const lot = await creerLot({ quantity: '50', agreedUnitPrice: '800.00' });
    const annonce = await createListingForLot(lot);
    await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1000.00' } });

    const zoneLivraison = await zone();
    await creerAgenceAvecZone(zoneLivraison.id);

    const admin = await createUser({ role: 'ADMIN' });

    const devisRes = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenAdminPour(admin)))
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
      });
    expect(devisRes.status, devisRes.text).toBe(201);

    await prisma.order.update({
      where: { id: devisRes.body.id },
      data: { status: 'PREPARING', paymentStatus: 'PAID' },
    });

    const res = await api()
      .post(`/api/v2/staff/orders/${devisRes.body.id}/deliveries`)
      .set(authHeader(tokenAdminPour(admin)))
      .send({});

    expect(res.status, res.text).toBe(201);
    expect(res.body).toHaveLength(1);
  });
});

describe('GET /api/v2/staff/deliveries', () => {
  it('liste paginée avec filtres status et orderId', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const lot = await creerLot({ quantity: '50', agreedUnitPrice: '800.00' });
    const annonce = await createListingForLot(lot);
    await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1000.00' } });

    const zoneLivraison = await zone();
    await creerAgenceAvecZone(zoneLivraison.id);

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'DISPATCH_COORDINATION']);

    const devisRes = await api()
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
      });
    expect(devisRes.status, devisRes.text).toBe(201);

    await prisma.order.update({
      where: { id: devisRes.body.id },
      data: { status: 'PREPARING', paymentStatus: 'PAID' },
    });

    const livraisonsRes = await api()
      .post(`/api/v2/staff/orders/${devisRes.body.id}/deliveries`)
      .set(authHeader(tokenPour(agentUser)))
      .send({});
    expect(livraisonsRes.status, livraisonsRes.text).toBe(201);

    // Liste sans filtre.
    const liste = await api()
      .get('/api/v2/staff/deliveries')
      .set(authHeader(tokenPour(agentUser)));
    expect(liste.status, liste.text).toBe(200);
    expect(liste.body.items.length).toBeGreaterThanOrEqual(1);
    expect(liste.body.total).toBeGreaterThanOrEqual(1);

    // Filtre par orderId.
    const filtreOrder = await api()
      .get(`/api/v2/staff/deliveries?orderId=${devisRes.body.id}`)
      .set(authHeader(tokenPour(agentUser)));
    expect(filtreOrder.status, filtreOrder.text).toBe(200);
    expect(filtreOrder.body.items).toHaveLength(1);
    expect(filtreOrder.body.items[0].orderId).toBe(devisRes.body.id);

    // Filtre par status.
    const filtreStatus = await api()
      .get('/api/v2/staff/deliveries?status=PENDING')
      .set(authHeader(tokenPour(agentUser)));
    expect(filtreStatus.status, filtreStatus.text).toBe(200);
    expect(filtreStatus.body.items.length).toBeGreaterThanOrEqual(1);
  });
});
