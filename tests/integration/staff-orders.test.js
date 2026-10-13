import { describe, it, expect } from 'vitest';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser, createListingForLot } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { orderToBuyerDto } from '../../src/utils/dto/order.dto.js';
import { assertNoLeak } from '../helpers/assertNoLeak.js';

const Decimal = Prisma.Decimal;

const DANS_7_JOURS = new Date(Date.now() + 7 * 24 * 3600 * 1000);

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

function tokenPour(user) {
  return generateToken({ id: user.id, role: { code: 'AGENT', level: 30 } });
}

function tokenAdminPour(user) {
  return generateToken({ id: user.id, role: { code: 'ADMIN', level: 50 } });
}

// --- Tests ---

describe('POST /api/v2/staff/orders', () => {
  it('crée un devis HUB_PICKUP avec totaux exacts', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const monLot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
    const annonce = await annoncePour(monLot);
    // Prix public = 1200 (différent du prix convenu)
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
      });

    expect(res.status, res.text).toBe(201);
    expect(res.body.orderNumber).toMatch(/^AC-\d{4}-\d{6}$/);
    expect(res.body.status).toBe('QUOTED');
    expect(res.body.deliveryMode).toBe('HUB_PICKUP');

    // Totaux exacts
    expect(res.body.subtotal).toBe(6000); // 5 x 1200
    expect(res.body.buyerFee).toBe(0);
    expect(res.body.deliveryFee).toBe(0);
    expect(res.body.total).toBe(6000);
    expect(res.body.commissionTotal).toBe(0); // taux 0 par défaut

    // Ligne
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].quantity).toBe(5);
    expect(res.body.items[0].unitPrice).toBe(1200);
    expect(res.body.items[0].lineTotal).toBe(6000);

    // reservedUntil dans le futur (~24h par défaut)
    const reservedUntil = new Date(res.body.reservedUntil);
    expect(reservedUntil.getTime()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);

    // Audit
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'ORDER_QUOTED', entityType: 'Order', entityId: res.body.id },
    });
    expect(audit).toBeTruthy();

    // Stock réservé
    const lotMisAJour = await prisma.stockLot.findUnique({ where: { id: monLot.id } });
    expect(Number(lotMisAJour.quantityAvailable)).toBe(5);
    expect(Number(lotMisAJour.quantityReserved)).toBe(5);
  });

  it('crée un devis AGENCY_DELIVERY avec frais de livraison', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const monLot = await creerLot({ quantity: '50', agreedUnitPrice: '800.00' });
    const annonce = await annoncePour(monLot);
    await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1000.00' } });

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

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

    const res = await api()
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

    expect(res.status, res.text).toBe(201);
    expect(res.body.deliveryMode).toBe('AGENCY_DELIVERY');

    // Ligne
    expect(res.body.items[0].lineTotal).toBe(10000); // 10 x 1000
    expect(res.body.subtotal).toBe(10000);

    // Frais de livraison > 0
    expect(res.body.deliveryFee).toBeGreaterThan(0);
    expect(res.body.total).toBe(res.body.subtotal + res.body.buyerFee + res.body.deliveryFee);

    // Origines exposées dans le DTO staff
    expect(res.body.origins).toHaveLength(1);
    expect(res.body.origins[0].type).toBe('SUPPLIER_SITE');
    expect(res.body.origins[0].distanceKm).toBeGreaterThan(0);
  });

  it('refuse une zone non couverte : 409 ZONE_NOT_COVERED', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const monLot = await creerLot({ quantity: '10' });
    const annonce = await annoncePour(monLot);

    const zoneNonCouverte = await zone();

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

    const res = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: buyer.id,
        items: [{ listingId: annonce.id, quantity: 2 }],
        deliveryMode: 'AGENCY_DELIVERY',
        delivery: {
          zoneId: zoneNonCouverte.id,
          address: 'Quelque part',
          latitude: 48.85,
          longitude: 2.35,
        },
      });

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('ZONE_NOT_COVERED');
    expect(res.body.error).toBe('Zone non couverte');
  });

  it('rollback complet si une ligne manque de stock', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const lotA = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
    const annonceA = await annoncePour(lotA);

    const lotB = await creerLot({ quantity: '3', agreedUnitPrice: '500.00' });
    const annonceB = await annoncePour(lotB);

    // Lire le stock avant
    const lotAAvant = await prisma.stockLot.findUnique({ where: { id: lotA.id } });

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);
    const hub = await creerHub();

    // 5 du lot A (OK) + 10 du lot B (KO : seulement 3 disponibles)
    const res = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: buyer.id,
        items: [
          { listingId: annonceA.id, quantity: 5 },
          { listingId: annonceB.id, quantity: 10 },
        ],
        deliveryMode: 'HUB_PICKUP',
        pickupHubId: hub.id,
      });

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');

    // Le stock du lot A est inchangé (rollback)
    const lotAApres = await prisma.stockLot.findUnique({ where: { id: lotA.id } });
    expect(Number(lotAApres.quantityAvailable)).toBe(Number(lotAAvant.quantityAvailable));
    expect(Number(lotAApres.quantityReserved)).toBe(Number(lotAAvant.quantityReserved));

    // Aucun Order créé
    const orders = await prisma.order.findMany({ where: { buyerId: buyer.id } });
    expect(orders).toHaveLength(0);
  });

  it('deux devis concurrents sur le même lot : pas de survente', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const monLot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
    const annonce = await annoncePour(monLot);

    const hub = await creerHub();

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

    // Deux requêtes concurrentes : chacune veut 8 unités (total 16 > 10)
    const [res1, res2] = await Promise.all([
      api()
        .post('/api/v2/staff/orders')
        .set(authHeader(tokenPour(agentUser)))
        .send({
          buyerId: buyer.id,
          items: [{ listingId: annonce.id, quantity: 8 }],
          deliveryMode: 'HUB_PICKUP',
          pickupHubId: hub.id,
        }),
      api()
        .post('/api/v2/staff/orders')
        .set(authHeader(tokenPour(agentUser)))
        .send({
          buyerId: buyer.id,
          items: [{ listingId: annonce.id, quantity: 8 }],
          deliveryMode: 'HUB_PICKUP',
          pickupHubId: hub.id,
        }),
    ]);

    // Une réussit, l'autre échoue
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 409]);

    // Stock final : 2 disponibles, 8 réservés
    const lotFinal = await prisma.stockLot.findUnique({ where: { id: monLot.id } });
    expect(Number(lotFinal.quantityAvailable)).toBe(2);
    expect(Number(lotFinal.quantityReserved)).toBe(8);
  });

  it('refuse un buyerId non-acheteur : 400 NOT_A_BUYER', async () => {
    const supplier = await createUser({ role: 'SUPPLIER' });
    const monLot = await creerLot({ quantity: '10' });
    const annonce = await annoncePour(monLot);

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

    const res = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: supplier.id,
        items: [{ listingId: annonce.id, quantity: 2 }],
        deliveryMode: 'HUB_PICKUP',
        pickupHubId: (await creerHub()).id,
      });

    expect(res.status, res.text).toBe(400);
    expect(res.body.code).toBe('NOT_A_BUYER');
  });

  it('refuse un acheteur suspendu : 403 BUYER_NOT_ACTIVE', async () => {
    const buyer = await createUser({ role: 'BUYER', status: 'SUSPENDED' });
    const monLot = await creerLot({ quantity: '10' });
    const annonce = await annoncePour(monLot);

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

    const res = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: buyer.id,
        items: [{ listingId: annonce.id, quantity: 2 }],
        deliveryMode: 'HUB_PICKUP',
        pickupHubId: (await creerHub()).id,
      });

    expect(res.status, res.text).toBe(403);
    expect(res.body.code).toBe('BUYER_NOT_ACTIVE');
  });

  it('refuse un hub sans acceptsPickup : 400 HUB_NO_PICKUP', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const monLot = await creerLot({ quantity: '10' });
    const annonce = await annoncePour(monLot);

    const hub = await creerHub({ acceptsPickup: false });

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

    const res = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: buyer.id,
        items: [{ listingId: annonce.id, quantity: 2 }],
        deliveryMode: 'HUB_PICKUP',
        pickupHubId: hub.id,
      });

    expect(res.status, res.text).toBe(400);
    expect(res.body.code).toBe('HUB_NO_PICKUP');
  });

  it('DTO acheteur sans fuite de données internes', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const monLot = await creerLot({ quantity: '10', agreedUnitPrice: '800.00' });
    const annonce = await annoncePour(monLot);
    await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1200.00' } });

    const hub = await creerHub();

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

    // Créer le devis
    const res = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: buyer.id,
        items: [{ listingId: annonce.id, quantity: 3 }],
        deliveryMode: 'HUB_PICKUP',
        pickupHubId: hub.id,
      });

    expect(res.status, res.text).toBe(201);

    // Recharger la commande complète pour tester le DTO acheteur
    const commande = await prisma.order.findUnique({
      where: { id: res.body.id },
      include: {
        items: { include: { listing: true } },
        buyer: { select: { id: true, firstname: true, lastname: true } },
        deliveryMode: true,
        pickupHub: true,
      },
    });

    // Le DTO acheteur ne doit AUCUNEMENT contenir de données internes
    const buyerDto = orderToBuyerDto(commande);
    assertNoLeak(buyerDto, [
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

    // Vérifier que le DTO acheteur contient bien les données attendues
    expect(buyerDto.id).toBe(res.body.id);
    expect(buyerDto.status).toBe('QUOTED');
    expect(buyerDto.deliveryMode).toBe('HUB_PICKUP');
    expect(buyerDto.reservedUntil).toBeTruthy();
    expect(buyerDto.items).toHaveLength(1);
    expect(buyerDto.items[0].listingReference).toBeTruthy();
    expect(buyerDto.items[0].listingTitle).toBeTruthy();
    expect(buyerDto.subtotal).toBe(3600); // 3 x 1200
    expect(buyerDto.total).toBe(3600);
  });

  it('un AGENT sans ORDER_PROCESSING est refusé : 403', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const monLot = await creerLot({ quantity: '10' });
    const annonce = await annoncePour(monLot);

    const { user: agentUser } = await agentAvecCapacite(['BUYER_SUPPORT']);

    const res = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: buyer.id,
        items: [{ listingId: annonce.id, quantity: 2 }],
        deliveryMode: 'HUB_PICKUP',
        pickupHubId: (await creerHub()).id,
      });

    expect(res.status, res.text).toBe(403);
  });

  it('un ADMIN peut émettre un devis sans capacité spécifique', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const monLot = await creerLot({ quantity: '10' });
    const annonce = await annoncePour(monLot);

    const admin = await createUser({ role: 'ADMIN' });
    const hub = await creerHub();

    const res = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenAdminPour(admin)))
      .send({
        buyerId: buyer.id,
        items: [{ listingId: annonce.id, quantity: 2 }],
        deliveryMode: 'HUB_PICKUP',
        pickupHubId: hub.id,
      });

    expect(res.status, res.text).toBe(201);
  });

  it('refuse un pickupHubId manquant pour HUB_PICKUP : 400', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const monLot = await creerLot({ quantity: '10' });
    const annonce = await annoncePour(monLot);

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

    const res = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: buyer.id,
        items: [{ listingId: annonce.id, quantity: 2 }],
        deliveryMode: 'HUB_PICKUP',
      });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un delivery manquant pour AGENCY_DELIVERY : 400', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const monLot = await creerLot({ quantity: '10' });
    const annonce = await annoncePour(monLot);

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

    const res = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: buyer.id,
        items: [{ listingId: annonce.id, quantity: 2 }],
        deliveryMode: 'AGENCY_DELIVERY',
      });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse une annonce inactive : 404 LISTING_NOT_FOUND', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const monLot = await creerLot({ quantity: '10' });
    const annonce = await annoncePour(monLot);
    // Mettre l'annonce en INACTIVE
    const statusInactif = await prisma.listingStatus.findFirst({ where: { code: 'INACTIVE' } });
    await prisma.listing.update({ where: { id: annonce.id }, data: { statusId: statusInactif.id } });

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

    const res = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: buyer.id,
        items: [{ listingId: annonce.id, quantity: 2 }],
        deliveryMode: 'HUB_PICKUP',
        pickupHubId: (await creerHub()).id,
      });

    expect(res.status, res.text).toBe(404);
    expect(res.body.code).toBe('LISTING_NOT_FOUND');
  });

  it('utilise le prix fourni dans la request plutôt que celui de l\'annonce', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    // Prix convenu sous le prix fourni du test (900) : la règle du prix
    // plancher (PRICE_BELOW_SUPPLIER) ne doit pas interférer ici.
    const monLot = await creerLot({ quantity: '10', agreedUnitPrice: '500.00' });
    const annonce = await annoncePour(monLot);
    await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1200.00' } });

    const hub = await creerHub();

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

    const res = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: buyer.id,
        items: [{ listingId: annonce.id, quantity: 2, unitPrice: 900 }],
        deliveryMode: 'HUB_PICKUP',
        pickupHubId: hub.id,
      });

    expect(res.status, res.text).toBe(201);
    // Le prix fourni (900) est utilisé, pas le prix de l'annonce (1200)
    expect(res.body.items[0].unitPrice).toBe(900);
    expect(res.body.items[0].lineTotal).toBe(1800); // 2 x 900
  });

  it('un prix inférieur au prix convenu est refusé : 409 PRICE_BELOW_SUPPLIER et stock inchangé', async () => {
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
        items: [{ listingId: annonce.id, quantity: 2, unitPrice: 900 }],
        deliveryMode: 'HUB_PICKUP',
        pickupHubId: hub.id,
      });

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('PRICE_BELOW_SUPPLIER');
    expect(res.body.error).toBe('Prix inférieur au prix convenu avec le promoteur');

    // Le 409 annule toute la transaction : stock, mouvement et commande.
    const lotApres = await prisma.stockLot.findUnique({ where: { id: monLot.id } });
    expect(Number(lotApres.quantityAvailable)).toBe(10);
    expect(Number(lotApres.quantityReserved)).toBe(0);
    const mouvements = await prisma.stockMovement.findMany({ where: { lotId: monLot.id } });
    expect(mouvements).toHaveLength(0);
    const orders = await prisma.order.findMany({ where: { buyerId: buyer.id } });
    expect(orders).toHaveLength(0);
  });

  it('un ADMIN peut forcer un prix sous le prix convenu : 201 et audit forced', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const monLot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
    const annonce = await annoncePour(monLot);
    await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1200.00' } });

    const hub = await creerHub();
    const admin = await createUser({ role: 'ADMIN' });

    const res = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenAdminPour(admin)))
      .send({
        buyerId: buyer.id,
        items: [{ listingId: annonce.id, quantity: 2, unitPrice: 900 }],
        deliveryMode: 'HUB_PICKUP',
        pickupHubId: hub.id,
        force: true,
      });

    expect(res.status, res.text).toBe(201);
    expect(res.body.items[0].unitPrice).toBe(900);

    // La dérogation est tracée dans l'audit, forced: true sur la ligne.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'ORDER_QUOTED', entityType: 'Order', entityId: res.body.id },
    });
    expect(audit).toBeTruthy();
    expect(audit.metadata).toMatchObject({
      priceOverrides: [{ listingId: annonce.id, listingPrice: 1200, appliedPrice: 900, forced: true }],
    });

    // La réservation a bien eu lieu malgré le prix forcé.
    const lotApres = await prisma.stockLot.findUnique({ where: { id: monLot.id } });
    expect(Number(lotApres.quantityReserved)).toBe(2);
  });

  it('un prix différent mais >= prix convenu : 201 avec metadata priceOverrides', async () => {
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
        items: [{ listingId: annonce.id, quantity: 2, unitPrice: 1100 }],
        deliveryMode: 'HUB_PICKUP',
        pickupHubId: hub.id,
      });

    expect(res.status, res.text).toBe(201);
    expect(res.body.items[0].unitPrice).toBe(1100);

    // L'écart avec le prix public est tracé, sans mention forced.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'ORDER_QUOTED', entityType: 'Order', entityId: res.body.id },
    });
    expect(audit).toBeTruthy();
    expect(audit.metadata).toMatchObject({
      priceOverrides: [{ listingId: annonce.id, listingPrice: 1200, appliedPrice: 1100 }],
    });
    expect(audit.metadata.priceOverrides[0]).not.toHaveProperty('forced');
  });

  it('le mouvement RESERVED est relié à sa ligne (orderItemId)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const monLot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
    const annonce = await annoncePour(monLot);

    const hub = await creerHub();
    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

    const res = await api()
      .post('/api/v2/staff/orders')
      .set(authHeader(tokenPour(agentUser)))
      .send({
        buyerId: buyer.id,
        items: [{ listingId: annonce.id, quantity: 3 }],
        deliveryMode: 'HUB_PICKUP',
        pickupHubId: hub.id,
      });

    expect(res.status, res.text).toBe(201);

    // Le mouvement de réservation porte l'identifiant de sa ligne de commande.
    const mouvement = await prisma.stockMovement.findFirst({
      where: { type: 'RESERVED', lotId: monLot.id },
    });
    expect(mouvement).toBeTruthy();
    expect(mouvement.orderItemId).toBe(res.body.items[0].id);
    expect(Number(mouvement.quantityDelta)).toBe(3);
  });
});
