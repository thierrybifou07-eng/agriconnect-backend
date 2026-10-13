import { describe, it, expect } from 'vitest';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { assertNoLeak } from '../helpers/assertNoLeak.js';
import { confirmOrder, changeStatus } from '../../src/services/order.service.js';

const Decimal = Prisma.Decimal;

function identifiant(prefixe) {
  return `${prefixe}-${Date.now()}-${randomInt(1_000, 9_999)}`;
}

// --- Fabriques locales ---

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

async function agenceAvecZone(zoneId) {
  const agency = await prisma.transportAgency.create({
    data: {
      name: identifiant('Agence'),
      phone: '+33600000000',
      isActive: true,
    },
  });
  await prisma.agencyZone.create({
    data: {
      agencyId: agency.id,
      zoneId,
      baseFee: '500',
      perKmFee: '100',
      isActive: true,
    },
  });
  return agency;
}

async function livreurAvecAgence(agencyId) {
  const user = await createUser({ role: 'DRIVER' });
  const driverProfile = await prisma.driverProfile.create({
    data: { userId: user.id, agencyId },
  });
  return { user, driverProfile };
}

function tokenPour(user) {
  return generateToken({ id: user.id, role: { code: 'DRIVER', level: 10 } });
}

// Cles interdites dans le DTO livreur : aucun prix, aucun montant.
// "total" est exclu : c est le total de pagination ({ items, page, limit, total }),
// pas un montant.
const CLES_INTERDITES_LIVREUR = [
  'deliveryFee',
  'agencyCost',
  'insuredValue',
  'lineTotal',
  'unitPrice',
  'supplierUnitPrice',
  'subtotal',
  'commissionTotal',
  'buyerFee',
  'agreedUnitPrice',
  'grossAmount',
  'commissionAmount',
  'netAmount',
];

// Cree une commande AGENCY_DELIVERY PREPARING avec un item et une livraison PENDING.
// Passe par confirmOrder (cree les reversements) puis changeStatus -> PREPARING.
async function creerCommandeAvecLivraison({ agencyId, buyerId, lotId, listingId, quantity = '5', unitPrice = '1000' }) {
  const order = await prisma.order.create({
    data: {
      orderNumber: identifiant('AC'),
      buyerId,
      deliveryModeId: (await prisma.deliveryMode.findFirst({ where: { code: 'AGENCY_DELIVERY' } })).id,
      deliveryZoneId: (await prisma.stockLot.findUnique({ where: { id: lotId } })).zoneId,
      deliveryAddress: '10 avenue de la Gare',
      deliveryLatitude: 48.85,
      deliveryLongitude: 2.35,
      status: 'QUOTED',
      paymentStatus: 'PAID',
      subtotal: new Decimal(quantity).times(new Decimal(unitPrice)),
      buyerFee: new Decimal(0),
      deliveryFee: new Decimal(500),
      total: new Decimal(quantity).times(new Decimal(unitPrice)).plus(new Decimal(500)),
      commissionTotal: new Decimal(0),
    },
  });

  const livraison = await prisma.delivery.create({
    data: {
      orderId: order.id,
      agencyId,
      dropoffAddress: '10 avenue de la Gare',
      dropoffLatitude: 48.85,
      dropoffLongitude: 2.35,
      distanceKm: 5.2,
      status: 'PENDING',
    },
  });

  await prisma.orderItem.create({
    data: {
      orderId: order.id,
      listingId,
      lotId,
      quantity: new Decimal(quantity),
      unitPrice: new Decimal(unitPrice),
      supplierUnitPrice: new Decimal(unitPrice),
      lineTotal: new Decimal(quantity).times(new Decimal(unitPrice)),
      commissionRate: new Decimal(0),
      commissionAmount: new Decimal(0),
      supplierNetAmount: new Decimal(quantity).times(new Decimal(unitPrice)),
      deliveryId: livraison.id,
    },
  });

  // ConfirmOrder cree les reversements (ON_HOLD) ; changeStatus passe en PREPARING.
  await prisma.$transaction(async (tx) => {
    await confirmOrder(tx, order.id);
    await changeStatus(tx, order.id, 'PREPARING');
  });

  return { order, livraison };
}

describe('GET /api/v2/driver/deliveries/available', () => {
  it('retourne les livraisons PENDING de l agence, DTO sans prix', async () => {
    const zoneTest = await zone();
    const agency = await agenceAvecZone(zoneTest.id);
    const { user: livreur } = await livreurAvecAgence(agency.id);
    const buyer = await createUser({ role: 'BUYER' });
    const supplierUser = await createUser({ role: 'SUPPLIER' });
    const supplierProfile = await prisma.supplierProfile.create({
      data: { userId: supplierUser.id, farmName: 'Ferme Test' },
    });
    const product = await produit();
    const lot = await prisma.stockLot.create({
      data: {
        lotCode: identifiant('LOT'),
        supplierId: supplierProfile.id,
        productId: product.id,
        zoneId: zoneTest.id,
        agreedUnitPrice: '1000.00',
        quantityInitial: new Decimal(10),
        quantityAvailable: new Decimal(10),
        storageType: 'SUPPLIER_SITE',
        pickupAddress: '12 route de la ferme',
        pickupLatitude: 12.34,
        pickupLongitude: -5.67,
        status: 'AVAILABLE',
      },
    });
    const listing = await prisma.listing.create({
      data: {
        reference: identifiant('ANN'),
        title: 'Annonce Test',
        unitPrice: '1000.00',
        productId: product.id,
        zoneId: zoneTest.id,
        statusId: (await prisma.listingStatus.findFirst({ where: { code: 'ACTIVE' } })).id,
        publishedAt: new Date(),
      },
    });

    await creerCommandeAvecLivraison({ agencyId: agency.id, buyerId: buyer.id, lotId: lot.id, listingId: listing.id });

    const res = await api()
      .get('/api/v2/driver/deliveries/available')
      .set(authHeader(tokenPour(livreur)));

    expect(res.status, res.text).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items).toHaveLength(1);
    assertNoLeak(res.body, CLES_INTERDITES_LIVREUR);
  });

  it('une livraison d une autre agence est invisible', async () => {
    const zoneTest = await zone();
    const agencyA = await agenceAvecZone(zoneTest.id);
    const agencyB = await agenceAvecZone(zoneTest.id);
    const { user: livreurB } = await livreurAvecAgence(agencyB.id);
    const buyer = await createUser({ role: 'BUYER' });
    const supplierUser = await createUser({ role: 'SUPPLIER' });
    const supplierProfile = await prisma.supplierProfile.create({
      data: { userId: supplierUser.id, farmName: 'Ferme Test' },
    });
    const product = await produit();
    const lot = await prisma.stockLot.create({
      data: {
        lotCode: identifiant('LOT'),
        supplierId: supplierProfile.id,
        productId: product.id,
        zoneId: zoneTest.id,
        agreedUnitPrice: '1000.00',
        quantityInitial: new Decimal(10),
        quantityAvailable: new Decimal(10),
        storageType: 'SUPPLIER_SITE',
        pickupAddress: '12 route de la ferme',
        pickupLatitude: 12.34,
        pickupLongitude: -5.67,
        status: 'AVAILABLE',
      },
    });
    const listing = await prisma.listing.create({
      data: {
        reference: identifiant('ANN'),
        title: 'Annonce Test',
        unitPrice: '1000.00',
        productId: product.id,
        zoneId: zoneTest.id,
        statusId: (await prisma.listingStatus.findFirst({ where: { code: 'ACTIVE' } })).id,
        publishedAt: new Date(),
      },
    });

    // Livraison de l agence A.
    await creerCommandeAvecLivraison({ agencyId: agencyA.id, buyerId: buyer.id, lotId: lot.id, listingId: listing.id });

    const res = await api()
      .get('/api/v2/driver/deliveries/available')
      .set(authHeader(tokenPour(livreurB)));

    expect(res.status, res.text).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.items).toHaveLength(0);
  });
});

describe('POST /api/v2/driver/deliveries/:id/accept', () => {
  it('5 livreurs en parallele : un seul gagnant, 4 x 409', async () => {
    const zoneTest = await zone();
    const agency = await agenceAvecZone(zoneTest.id);

    // Creer 5 livreurs dans la meme agence.
    const livreurs = [];
    for (let i = 0; i < 5; i++) {
      livreurs.push(await livreurAvecAgence(agency.id));
    }

    const buyer = await createUser({ role: 'BUYER' });
    const supplierUser = await createUser({ role: 'SUPPLIER' });
    const supplierProfile = await prisma.supplierProfile.create({
      data: { userId: supplierUser.id, farmName: 'Ferme Test' },
    });
    const product = await produit();
    const lot = await prisma.stockLot.create({
      data: {
        lotCode: identifiant('LOT'),
        supplierId: supplierProfile.id,
        productId: product.id,
        zoneId: zoneTest.id,
        agreedUnitPrice: '1000.00',
        quantityInitial: new Decimal(10),
        quantityAvailable: new Decimal(10),
        storageType: 'SUPPLIER_SITE',
        pickupAddress: '12 route de la ferme',
        pickupLatitude: 12.34,
        pickupLongitude: -5.67,
        status: 'AVAILABLE',
      },
    });
    const listing = await prisma.listing.create({
      data: {
        reference: identifiant('ANN'),
        title: 'Annonce Test',
        unitPrice: '1000.00',
        productId: product.id,
        zoneId: zoneTest.id,
        statusId: (await prisma.listingStatus.findFirst({ where: { code: 'ACTIVE' } })).id,
        publishedAt: new Date(),
      },
    });

    const { livraison } = await creerCommandeAvecLivraison({
      agencyId: agency.id,
      buyerId: buyer.id,
      lotId: lot.id,
      listingId: listing.id,
    });

    // 5 acceptations en parallele.
    const results = await Promise.all(
      livreurs.map(({ user }) =>
        api()
          .post(`/api/v2/driver/deliveries/${livraison.id}/accept`)
          .set(authHeader(tokenPour(user)))
      )
    );

    // Un seul gagnant.
    const gagnants = results.filter((r) => r.status === 200);
    const perdants = results.filter((r) => r.status === 409);

    expect(gagnants).toHaveLength(1);
    expect(perdants).toHaveLength(4);
    perdants.forEach((r) => {
      expect(r.body.code).toBe('DELIVERY_ALREADY_TAKEN');
    });
  });

  it('seconde course refusee : 409 DELIVERY_ALREADY_ACTIVE', async () => {
    const zoneTest = await zone();
    const agency = await agenceAvecZone(zoneTest.id);
    const { user: livreur } = await livreurAvecAgence(agency.id);
    const buyer = await createUser({ role: 'BUYER' });
    const supplierUser = await createUser({ role: 'SUPPLIER' });
    const supplierProfile = await prisma.supplierProfile.create({
      data: { userId: supplierUser.id, farmName: 'Ferme Test' },
    });
    const product = await produit();
    const lot = await prisma.stockLot.create({
      data: {
        lotCode: identifiant('LOT'),
        supplierId: supplierProfile.id,
        productId: product.id,
        zoneId: zoneTest.id,
        agreedUnitPrice: '1000.00',
        quantityInitial: new Decimal(10),
        quantityAvailable: new Decimal(10),
        storageType: 'SUPPLIER_SITE',
        pickupAddress: '12 route de la ferme',
        pickupLatitude: 12.34,
        pickupLongitude: -5.67,
        status: 'AVAILABLE',
      },
    });
    const listing = await prisma.listing.create({
      data: {
        reference: identifiant('ANN'),
        title: 'Annonce Test',
        unitPrice: '1000.00',
        productId: product.id,
        zoneId: zoneTest.id,
        statusId: (await prisma.listingStatus.findFirst({ where: { code: 'ACTIVE' } })).id,
        publishedAt: new Date(),
      },
    });

    // Deux livraisons PENDING.
    const { livraison: livraison1 } = await creerCommandeAvecLivraison({
      agencyId: agency.id,
      buyerId: buyer.id,
      lotId: lot.id,
      listingId: listing.id,
    });
    const { livraison: livraison2 } = await creerCommandeAvecLivraison({
      agencyId: agency.id,
      buyerId: buyer.id,
      lotId: lot.id,
      listingId: listing.id,
    });

    // Premiere acceptation : succes.
    const res1 = await api()
      .post(`/api/v2/driver/deliveries/${livraison1.id}/accept`)
      .set(authHeader(tokenPour(livreur)));
    expect(res1.status, res1.text).toBe(200);

    // Seconde acceptation : refusee.
    const res2 = await api()
      .post(`/api/v2/driver/deliveries/${livraison2.id}/accept`)
      .set(authHeader(tokenPour(livreur)));
    expect(res2.status, res2.text).toBe(409);
    expect(res2.body.code).toBe('DELIVERY_ALREADY_ACTIVE');
  });
});

describe('PATCH /api/v2/driver/deliveries/:id/status', () => {
  it('FAILED sans motif : 400', async () => {
    const zoneTest = await zone();
    const agency = await agenceAvecZone(zoneTest.id);
    const { user: livreur } = await livreurAvecAgence(agency.id);
    const buyer = await createUser({ role: 'BUYER' });
    const supplierUser = await createUser({ role: 'SUPPLIER' });
    const supplierProfile = await prisma.supplierProfile.create({
      data: { userId: supplierUser.id, farmName: 'Ferme Test' },
    });
    const product = await produit();
    const lot = await prisma.stockLot.create({
      data: {
        lotCode: identifiant('LOT'),
        supplierId: supplierProfile.id,
        productId: product.id,
        zoneId: zoneTest.id,
        agreedUnitPrice: '1000.00',
        quantityInitial: new Decimal(10),
        quantityAvailable: new Decimal(10),
        storageType: 'SUPPLIER_SITE',
        pickupAddress: '12 route de la ferme',
        pickupLatitude: 12.34,
        pickupLongitude: -5.67,
        status: 'AVAILABLE',
      },
    });
    const listing = await prisma.listing.create({
      data: {
        reference: identifiant('ANN'),
        title: 'Annonce Test',
        unitPrice: '1000.00',
        productId: product.id,
        zoneId: zoneTest.id,
        statusId: (await prisma.listingStatus.findFirst({ where: { code: 'ACTIVE' } })).id,
        publishedAt: new Date(),
      },
    });

    const { livraison } = await creerCommandeAvecLivraison({
      agencyId: agency.id,
      buyerId: buyer.id,
      lotId: lot.id,
      listingId: listing.id,
    });

    // Le livreur accepte puis passe IN_TRANSIT.
    await api()
      .post(`/api/v2/driver/deliveries/${livraison.id}/accept`)
      .set(authHeader(tokenPour(livreur)));
    await api()
      .patch(`/api/v2/driver/deliveries/${livraison.id}/status`)
      .set(authHeader(tokenPour(livreur)))
      .send({ status: 'PICKED_UP' });
    await api()
      .patch(`/api/v2/driver/deliveries/${livraison.id}/status`)
      .set(authHeader(tokenPour(livreur)))
      .send({ status: 'IN_TRANSIT' });

    // FAILED sans motif -> 400.
    const res = await api()
      .patch(`/api/v2/driver/deliveries/${livraison.id}/status`)
      .set(authHeader(tokenPour(livreur)))
      .send({ status: 'FAILED' });

    expect(res.status, res.text).toBe(400);
  });
});

describe('Flux complet', () => {
  it('livraison complete -> commande COMPLETED, stock vendu, reversement READY', async () => {
    const zoneTest = await zone();
    const agency = await agenceAvecZone(zoneTest.id);
    const { user: livreur } = await livreurAvecAgence(agency.id);
    const buyer = await createUser({ role: 'BUYER' });
    const supplierUser = await createUser({ role: 'SUPPLIER' });
    const supplierProfile = await prisma.supplierProfile.create({
      data: { userId: supplierUser.id, farmName: 'Ferme Test' },
    });
    const product = await produit();
    const lot = await prisma.stockLot.create({
      data: {
        lotCode: identifiant('LOT'),
        supplierId: supplierProfile.id,
        productId: product.id,
        zoneId: zoneTest.id,
        agreedUnitPrice: '1000.00',
        quantityInitial: new Decimal(10),
        quantityAvailable: new Decimal(5),
        quantityReserved: new Decimal(5),
        storageType: 'SUPPLIER_SITE',
        pickupAddress: '12 route de la ferme',
        pickupLatitude: 12.34,
        pickupLongitude: -5.67,
        status: 'AVAILABLE',
      },
    });
    const listing = await prisma.listing.create({
      data: {
        reference: identifiant('ANN'),
        title: 'Annonce Test',
        unitPrice: '1000.00',
        productId: product.id,
        zoneId: zoneTest.id,
        statusId: (await prisma.listingStatus.findFirst({ where: { code: 'ACTIVE' } })).id,
        publishedAt: new Date(),
      },
    });

    const { order, livraison } = await creerCommandeAvecLivraison({
      agencyId: agency.id,
      buyerId: buyer.id,
      lotId: lot.id,
      listingId: listing.id,
    });

    // Le livreur accepte.
    const acceptRes = await api()
      .post(`/api/v2/driver/deliveries/${livraison.id}/accept`)
      .set(authHeader(tokenPour(livreur)));
    expect(acceptRes.status, acceptRes.text).toBe(200);
    expect(acceptRes.body.status).toBe('ACCEPTED');

    // Le livreur passe PICKED_UP -> commande OUT_FOR_DELIVERY.
    const pickupRes = await api()
      .patch(`/api/v2/driver/deliveries/${livraison.id}/status`)
      .set(authHeader(tokenPour(livreur)))
      .send({ status: 'PICKED_UP' });
    expect(pickupRes.status, pickupRes.text).toBe(200);
    expect(pickupRes.body.pickedUpAt).toBeTruthy();

    let orderEnBase = await prisma.order.findUnique({ where: { id: order.id } });
    expect(orderEnBase.status).toBe('OUT_FOR_DELIVERY');

    // IN_TRANSIT.
    const transitRes = await api()
      .patch(`/api/v2/driver/deliveries/${livraison.id}/status`)
      .set(authHeader(tokenPour(livreur)))
      .send({ status: 'IN_TRANSIT' });
    expect(transitRes.status, transitRes.text).toBe(200);

    // DELIVERED -> commande COMPLETED, stock vendu, reversement READY.
    const deliveredRes = await api()
      .patch(`/api/v2/driver/deliveries/${livraison.id}/status`)
      .set(authHeader(tokenPour(livreur)))
      .send({ status: 'DELIVERED' });
    expect(deliveredRes.status, deliveredRes.text).toBe(200);
    expect(deliveredRes.body.deliveredAt).toBeTruthy();

    // Verification base de donnees.
    orderEnBase = await prisma.order.findUnique({ where: { id: order.id } });
    expect(orderEnBase.status).toBe('COMPLETED');

    const lotEnBase = await prisma.stockLot.findUnique({ where: { id: lot.id } });
    expect(new Decimal(lotEnBase.quantitySold).toNumber()).toBe(5);

    // Reversements READY (commande COMPLETED et PAID).
    const payouts = await prisma.supplierPayout.findMany({ where: { orderId: order.id } });
    expect(payouts.length).toBeGreaterThan(0);
    payouts.forEach((p) => {
      expect(p.status).toBe('READY');
    });
  });
});
