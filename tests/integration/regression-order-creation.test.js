import { describe, it, expect } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createListing, createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { toNumber } from '../../src/utils/money.js';

// ---------------------------------------------------------------------------
// Ces tests reproduisent le defaut B2 : order.validator.js exige que listingId
// soit un UUID, alors que Listing.id est un entier auto-incremente. Toute
// creation de commande est donc rejetee en 400 et le flux metier central est
// inaccessible.
//
// Ils doivent etre ROUGES. Ils passeront au vert en phase 2.
// ---------------------------------------------------------------------------

const client = api();

async function buyerToken() {
  const buyer = await createUser({ role: 'BUYER' });
  return { buyer, token: generateToken({ id: buyer.id, role: 'BUYER' }) };
}

describe('B2 - POST /api/v2/orders doit accepter un listingId entier', () => {
  it('cree une commande en retrait', async () => {
    const { buyer, token } = await buyerToken();
    const farmer = await createUser({ role: 'FARMER' });
    const listing = await createListing({ farmer, quantity: 100, price: 250 });

    const res = await client
      .post('/api/v2/orders')
      .set(authHeader(token))
      .send({ listingId: listing.id, quantity: 10, deliveryMode: 'PICKUP' });

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ buyerId: buyer.id, farmerId: farmer.id, quantity: 10 });
  });

  it('resiste a un listingId envoye en chaine', async () => {
    const { token } = await buyerToken();
    const listing = await createListing();

    const res = await client
      .post('/api/v2/orders')
      .set(authHeader(token))
      .send({ listingId: String(listing.id), quantity: 5, deliveryMode: 'PICKUP' });

    // Un client mobile peut serialiser l id en chaine : le backend doit
    // l accepter plutot que de rejeter silencieusement la commande.
    expect(res.status, res.text).toBe(201);
  });

  it('reserve la quantite commandee sur le stock', async () => {
    const { token } = await buyerToken();
    const listing = await createListing({ quantity: 100 });

    await client
      .post('/api/v2/orders')
      .set(authHeader(token))
      .send({ listingId: listing.id, quantity: 30, deliveryMode: 'PICKUP' });

    const apres = await prisma.listing.findUnique({ where: { id: listing.id } });
    // quantity est une colonne DECIMAL : Prisma renvoie un objet Decimal, que
    // l'API convertit en nombre au moment de la reponse HTTP. Ici on lit la
    // base directement, il faut donc convertir explicitement.
    expect(toNumber(apres.quantity)).toBe(70);
  });

  it('calcule le total au prix unitaire de l annonce', async () => {
    const { token } = await buyerToken();
    const listing = await createListing({ price: 250, quantity: 100 });

    const res = await client
      .post('/api/v2/orders')
      .set(authHeader(token))
      .send({ listingId: listing.id, quantity: 4, deliveryMode: 'PICKUP' });

    expect(res.body.totalPrice).toBe(1000);
    expect(res.body.unitPrice).toBe(250);
  });
});

describe('B2 - les garde-fous de creation de commande', () => {
  it('refuse de commander sa propre annonce', async () => {
    const farmer = await createUser({ role: 'FARMER' });
    const listing = await createListing({ farmer });
    const token = generateToken({ id: farmer.id, role: 'FARMER' });

    const res = await client
      .post('/api/v2/orders')
      .set(authHeader(token))
      .send({ listingId: listing.id, quantity: 1, deliveryMode: 'PICKUP' });

    // Un agriculteur n est pas acheteur : le route le refuse deja.
    expect([400, 403]).toContain(res.status);
  });

  it('refuse une quantite superieure au stock', async () => {
    const { token } = await buyerToken();
    const listing = await createListing({ quantity: 10 });

    const res = await client
      .post('/api/v2/orders')
      .set(authHeader(token))
      .send({ listingId: listing.id, quantity: 999, deliveryMode: 'PICKUP' });

    expect(res.status, res.text).toBe(400);
    expect(res.body.error).toMatch(/stock/i);
  });

  it('refuse une livraison sans coordonnees', async () => {
    const { token } = await buyerToken();
    const listing = await createListing();

    const res = await client
      .post('/api/v2/orders')
      .set(authHeader(token))
      .send({ listingId: listing.id, quantity: 1, deliveryMode: 'DELIVERY' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deliveryLatitude/);
  });

  it('refuse un mode de livraison inconnu', async () => {
    const { token } = await buyerToken();
    const listing = await createListing();

    const res = await client
      .post('/api/v2/orders')
      .set(authHeader(token))
      .send({ listingId: listing.id, quantity: 1, deliveryMode: 'TORTUE' });

    // Une valeur de reference inconnue est une faute de saisie du client : elle
    // doit produire un 400 detaille, pas une erreur serveur.
    expect(res.status, res.text).toBe(400);
    expect(res.body.error).toBe('Données invalides');
    expect(res.body.details[0]).toMatchObject({ field: 'deliveryMode' });
  });

  it('refuse un listingId non numerique', async () => {
    const { token } = await buyerToken();

    const res = await client
      .post('/api/v2/orders')
      .set(authHeader(token))
      .send({ listingId: 'pas-un-id', quantity: 1, deliveryMode: 'PICKUP' });

    expect(res.status, res.text).toBe(400);
    expect(res.body.details[0].field).toBe('listingId');
  });

  it('refuse un listingId negatif ou decimal', async () => {
    const { token } = await buyerToken();

    for (const listingId of [-1, 0, 2.5]) {
      const res = await client
        .post('/api/v2/orders')
        .set(authHeader(token))
        .send({ listingId, quantity: 1, deliveryMode: 'PICKUP' });

      expect(res.status, `listingId ${listingId}`).toBe(400);
    }
  });

  it('repond 404 si l annonce n existe pas', async () => {
    const { token } = await buyerToken();

    const res = await client
      .post('/api/v2/orders')
      .set(authHeader(token))
      .send({ listingId: 999999, quantity: 1, deliveryMode: 'PICKUP' });

    // 404 et non 500 : l absence de ressource est une situation normale.
    expect(res.status, res.text).toBe(404);
  });

  it('refuse un acheteur non authentifie', async () => {
    const listing = await createListing();

    const res = await client
      .post('/api/v2/orders')
      .send({ listingId: listing.id, quantity: 1, deliveryMode: 'PICKUP' });

    expect(res.status).toBe(401);
  });
});
