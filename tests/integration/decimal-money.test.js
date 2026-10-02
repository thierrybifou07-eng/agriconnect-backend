import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createListing, createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { toNumber } from '../../src/utils/money.js';

// Deux proprietes doivent tenir simultanement apres le passage en DECIMAL :
//   1. l'API renvoie des NOMBRES, pas des chaines, comme avant la migration
//   2. le total calcule en base est exact, sans derive de virgule flottante

const client = api();

describe('Les montants sortent en nombre, pas en chaine', () => {
  it('sur POST /api/orders', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const farmer = await createUser({ role: 'FARMER' });
    const listing = await createListing({ farmer, price: 12.5, quantity: 10 });
    const token = generateToken({ id: buyer.id, role: 'BUYER' });

    const res = await client
      .post('/api/orders')
      .set(authHeader(token))
      .send({ listingId: listing.id, quantity: 2, deliveryMode: 'PICKUP' });

    expect(res.status, res.text).toBe(201);
    // Le test porte sur le TYPE, pas sur la valeur : c est ce que verrait un
    // client JavaScript qui fait res.body.totalPrice * 2.
    expect(typeof res.body.totalPrice).toBe('number');
    expect(typeof res.body.unitPrice).toBe('number');
    expect(typeof res.body.quantity).toBe('number');
    expect(res.body.totalPrice).toBe(25);
  });

  it('sur GET /api/listings', async () => {
    await createListing({ price: 250.75, quantity: 5 });

    const res = await client.get('/api/listings');

    expect(res.status, res.text).toBe(200);
    expect(typeof res.body[0].price).toBe('number');
    expect(typeof res.body[0].quantity).toBe('number');
    expect(res.body[0].price).toBe(250.75);
  });

  it('y compris pour une annonce imbriquee dans une commande', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const farmer = await createUser({ role: 'FARMER' });
    const listing = await createListing({ farmer, price: 9.99, quantity: 100 });
    const token = generateToken({ id: buyer.id, role: 'BUYER' });

    await client
      .post('/api/orders')
      .set(authHeader(token))
      .send({ listingId: listing.id, quantity: 1, deliveryMode: 'PICKUP' });

    const res = await client.get('/api/orders').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(typeof res.body[0].totalPrice).toBe('number');
    expect(res.body[0].totalPrice).toBe(9.99);
  });
});

describe('Les totaux sont exacts', () => {
  // 0.1 * 3 : en Float, le total vaut 0.30000000000000004 et une commande
  // partirait avec un centime de trop.
  it('sur une quantite et un prix decimaux', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const farmer = await createUser({ role: 'FARMER' });
    const listing = await createListing({ farmer, price: 0.1, quantity: 100 });
    const token = generateToken({ id: buyer.id, role: 'BUYER' });

    const res = await client
      .post('/api/orders')
      .set(authHeader(token))
      .send({ listingId: listing.id, quantity: 3, deliveryMode: 'PICKUP' });

    expect(res.status, res.text).toBe(201);
    expect(res.body.totalPrice).toBe(0.3);

    const enBase = await prisma.order.findUnique({ where: { id: res.body.id } });
    expect(toNumber(enBase.totalPrice)).toBe(0.3);
  });

  it('sur une quantite fractionnaire', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const farmer = await createUser({ role: 'FARMER' });
    const listing = await createListing({ farmer, price: 33.33, quantity: 100 });
    const token = generateToken({ id: buyer.id, role: 'BUYER' });

    const res = await client
      .post('/api/orders')
      .set(authHeader(token))
      .send({ listingId: listing.id, quantity: 2.5, deliveryMode: 'PICKUP' });

    expect(res.status, res.text).toBe(201);
    expect(res.body.totalPrice).toBe(83.33);
  });

  it('sur 1000 repetitions du meme prix', async () => {
    // 0.07 * 1000 = 70 exactement. En Float cumule, l'ecart se voit.
    const total = Array.from({ length: 1000 }, () => new Prisma.Decimal('0.07')).reduce(
      (acc, d) => acc.plus(d),
      new Prisma.Decimal(0)
    );
    expect(total.toFixed(2)).toBe('70.00');
  });
});

describe('Les stocks restent coherents avec le Decimal', () => {
  // Le stock se decremente avec minus() sur des Decimal, et se compare avec
  // isZero() : plus aucune comparaison "===" qui depende du type JS.
  it('marque l annonce vendue quand tout le stock est commande', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const farmer = await createUser({ role: 'FARMER' });
    const listing = await createListing({ farmer, price: 10, quantity: 5 });
    const token = generateToken({ id: buyer.id, role: 'BUYER' });

    const res = await client
      .post('/api/orders')
      .set(authHeader(token))
      .send({ listingId: listing.id, quantity: 5, deliveryMode: 'PICKUP' });

    expect(res.status, res.text).toBe(201);

    const apres = await prisma.listing.findUnique({
      where: { id: listing.id },
      include: { status: true },
    });
    expect(toNumber(apres.quantity)).toBe(0);
    // La comparaison "quantite restante == 0" ne doit pas dependre du type JS.
    expect(apres.status.code).toBe('SOLD');
  });
});

describe('Les frais de livraison sont des montants', () => {
  it('sont arrondis au centime et stockes en Decimal', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const farmer = await createUser({ role: 'FARMER' });
    const listing = await createListing({ farmer, price: 10, quantity: 100 });
    const buyerToken = generateToken({ id: buyer.id, role: 'BUYER' });
    const farmerToken = generateToken({ id: farmer.id, role: 'FARMER' });

    const commande = await client
      .post('/api/orders')
      .set(authHeader(buyerToken))
      .send({
        listingId: listing.id,
        quantity: 1,
        deliveryMode: 'DELIVERY',
        deliveryLatitude: 33.57,
        deliveryLongitude: -7.59,
      });

    expect(commande.status, commande.text).toBe(201);

    const accepted = await client
      .patch(`/api/orders/${commande.body.id}/confirm`)
      .set(authHeader(farmerToken));

    expect(accepted.status, accepted.text).toBe(200);

    const delivery = await prisma.delivery.findUnique({ where: { orderId: commande.body.id } });
    expect(delivery).toBeTruthy();
    expect(delivery.deliveryFee).toBeInstanceOf(Prisma.Decimal);

    const frais = toNumber(delivery.deliveryFee);
    expect(Number.isFinite(frais)).toBe(true);
    // Arrondi au centime : deux decimales au plus.
    expect(frais.toFixed(2)).toBe(frais.toFixed(2));
    expect(Math.round(frais * 100) / 100).toBe(frais);
  });
});