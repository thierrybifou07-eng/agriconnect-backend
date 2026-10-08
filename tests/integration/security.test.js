import { describe, it, expect } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createListing, createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

const client = api();

function tokenFor(user, role) {
  return generateToken({ id: user.id, role });
}

async function buyer() {
  const user = await createUser({ role: 'BUYER' });
  return { user, token: tokenFor(user, 'BUYER') };
}

async function farmer() {
  const user = await createUser({ role: 'FARMER' });
  return { user, token: tokenFor(user, 'FARMER') };
}

describe('Le hash de mot de passe ne sort jamais', () => {
  // protect() chargeait l'utilisateur complet, hash compris. Aucun controleur
  // ne renvoyait aujourd'hui req.user tel quel, mais la protection reposait
  // sur la discipline de chacun : un res.json(req.user) suffisait a faire fuiter
  // le hash. Le middleware ne selectionne plus la colonne.
  it('GET /api/v2/auth/me ne renvoie pas le hash', async () => {
    const { token } = await buyer();

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body.password).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('$2b$');
  });

  it('PATCH /api/v2/auth/me ne renvoie pas le hash', async () => {
    const { token } = await buyer();

    const res = await client.patch('/api/v2/auth/me').set(authHeader(token)).send({ location: 'Rabat' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.password).toBeUndefined();
  });

  it('req.user ne contient pas le hash', async () => {
    const { user } = await buyer();

    const { protect } = await import('../../src/middlewares/auth.middleware.js');
    const req = { headers: { authorization: `Bearer ${tokenFor(user, 'BUYER')}` } };
    let captured;
    req.user = undefined;
    // On rejoue le middleware pour inspecter ce qu il met sur req.
    await new Promise((resolve) => {
      protect(req, { status: () => ({ json: resolve }) }, () => {
        captured = req.user;
        resolve();
      });
    });

    expect(captured).toBeTruthy();
    expect(captured.password).toBeUndefined();
    // Les champs utiles restent presents, sinon le middleware casserait tout.
    expect(captured.id).toBe(user.id);
    expect(captured.role.code).toBe('BUYER');
  });
});

describe('Suppression d une annonce', () => {
  it('supprime une annonce sans commande ni conversation', async () => {
    const { user: proprietaire, token } = await farmer();
    const listing = await createListing({ farmer: proprietaire });

    const res = await client.delete(`/api/v2/listings/${listing.id}`).set(authHeader(token));

    expect(res.status, res.text).toBe(204);
    expect(await prisma.listing.findUnique({ where: { id: listing.id } })).toBeNull();
  });

  // La suppression partait sur delete() et levait une violation de cle
  // etrangere, donc 500 : une annonce vendue ne pouvait pas etre retiree.
  it('refuse de supprimer une annonce qui a des commandes, avec 409', async () => {
    const { user: proprietaire, token } = await farmer();
    const { token: acheteur } = await buyer();
    const listing = await createListing({ farmer: proprietaire, quantity: 50 });

    const commande = await client
      .post('/api/v2/orders')
      .set(authHeader(acheteur))
      .send({ listingId: listing.id, quantity: 2, deliveryMode: 'PICKUP' });

    expect(commande.status, commande.text).toBe(201);

    const res = await client.delete(`/api/v2/listings/${listing.id}`).set(authHeader(token));

    // 409 Conflict : la demande est valide mais incompatible avec l etat
    // actuel. Un 500 dirait au client que le serveur est casse.
    expect(res.status, res.text).toBe(409);
    expect(res.body.error).toMatch(/désactiv/i);
    expect(res.body.ordersCount).toBe(1);

    // L annonce ET son historique doivent survivre.
    expect(await prisma.listing.findUnique({ where: { id: listing.id } })).toBeTruthy();
    expect(await prisma.order.findUnique({ where: { id: commande.body.id } })).toBeTruthy();
  });

  it('emporte avec elle les conversations et les photos', async () => {
    const { user: proprietaire, token } = await farmer();
    const { token: acheteur } = await buyer();
    const listing = await createListing({ farmer: proprietaire });

    await client.post('/api/v2/conversations').set(authHeader(acheteur)).send({ listingId: listing.id });
    await prisma.media.create({
      data: {
        url: 'https://exemple.test/photo.jpg',
        ownerListingId: listing.id,
        mediaTypeId: await lookupId('mediaType', 'IMAGE'),
        mimeTypeId: await lookupId('mimeType', 'image/jpeg'),
      },
    });

    const res = await client.delete(`/api/v2/listings/${listing.id}`).set(authHeader(token));

    expect(res.status, res.text).toBe(204);
    expect(await prisma.conversation.count({ where: { listingId: listing.id } })).toBe(0);
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.media.count({ where: { ownerListingId: listing.id } })).toBe(0);
  });

  it('laisse la photo d un profil utilisateur intacte', async () => {
    const { user: proprietaire, token } = await farmer();
    const { user: autre } = await buyer();
    const listing = await createListing({ farmer: proprietaire });

    // Un media d avatar appartient a l utilisateur, pas a l annonce : la
    // suppression de l annonce ne doit pas y toucher.
    await prisma.media.create({
      data: {
        url: 'https://exemple.test/avatar.jpg',
        ownerUserId: autre.id,
        mediaTypeId: await lookupId('mediaType', 'IMAGE'),
        mimeTypeId: await lookupId('mimeType', 'image/jpeg'),
      },
    });

    await client.delete(`/api/v2/listings/${listing.id}`).set(authHeader(token));

    expect(await prisma.media.count({ where: { ownerUserId: autre.id } })).toBe(1);
  });

  it('refuse toujours la suppression par un tiers', async () => {
    const { user: proprietaire } = await farmer();
    const { token: intrus } = await farmer();
    const listing = await createListing({ farmer: proprietaire });

    const res = await client.delete(`/api/v2/listings/${listing.id}`).set(authHeader(intrus));

    expect(res.status).toBe(403);
    expect(await prisma.listing.findUnique({ where: { id: listing.id } })).toBeTruthy();
  });
});

async function lookupId(model, code) {
  const row = await prisma[model].findUnique({ where: { code } });
  if (!row) throw new Error(`Table de reference non peuplee : ${model}.${code}`);
  return row.id;
}