import { describe, it, expect } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createListing, createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { toNumber } from '../../src/utils/money.js';

// Les regles .external() des validateurs verifient en base qu'une valeur de
// reference existe (categorie, statut, mode de livraison). Elles etaient
// signalees par un `throw new Error(...)`, qui sortait de validateAsync sans
// etre une erreur Joi : le middleware ne la reconnaitrait pas et renvoyait
// 500. Une simple faute de frappe du client suffisait donc a faire tomber le
// service en erreur serveur.
//
// Ces tests verrouillent le comportement correct : un 400 detaille, avec le
// champ et la valeur fautifs dans le message.

const client = api();

async function farmerToken() {
  const farmer = await createUser({ role: 'FARMER' });
  return { farmer, token: generateToken({ id: farmer.id, role: 'FARMER' }) };
}

function validListing(overrides = {}) {
  return {
    title: 'Blé tendre',
    category: 'CEREALES',
    price: 250,
    quantity: 100,
    unit: 'kg',
    location: 'Rabat',
    ...overrides,
  };
}

describe('Valeurs de reference invalides - creation d annonce', () => {
  it('rejette une categorie inconnue en 400', async () => {
    const { token } = await farmerToken();

    const res = await client
      .post('/api/listings')
      .set(authHeader(token))
      .send(validListing({ category: 'ROBOTES' }));

    expect(res.status, res.text).toBe(400);
    expect(res.body.error).toBe('Données invalides');
    expect(res.body.details[0].field).toBe('category');
  });

  it('accepte une categorie valide', async () => {
    const { token } = await farmerToken();

    const res = await client
      .post('/api/listings')
      .set(authHeader(token))
      .send(validListing());

    // Ce test reste rouge tant que B1 n'est pas corrige : le controleur selectionne
    // User.fullName, qui n existe pas dans le schema, et repond 500 apres avoir
    // valide la charge utile. C'est le comportement attendu a ce stade.
    expect(res.status, res.text).toBe(201);
  });
});

describe('Valeurs de reference invalides - mise a jour d annonce', () => {
  it('rejette un statut inconnu en 400', async () => {
    const { farmer, token } = await farmerToken();
    const listing = await createListing({ farmer });

    const res = await client
      .patch(`/api/listings/${listing.id}`)
      .set(authHeader(token))
      .send({ status: 'EN_VENTE' });

    expect(res.status, res.text).toBe(400);
    expect(res.body.details[0].field).toBe('status');
  });

  it('rejette une categorie inconnue en 400', async () => {
    const { farmer, token } = await farmerToken();
    const listing = await createListing({ farmer });

    const res = await client
      .patch(`/api/listings/${listing.id}`)
      .set(authHeader(token))
      .send({ category: 'CACHOTS' });

    expect(res.status, res.text).toBe(400);
    expect(res.body.details[0].field).toBe('category');
  });

  // La validation doit se produire avant toute ecriture : un rejet ne doit pas
  // avoir modifie l annonce. On relit la base directement, et non via
  // GET /api/listings, qui repond 500 tant que B1 n'est pas corrige.
  it('ne modifie rien quand la validation echoue', async () => {
    const { farmer, token } = await farmerToken();
    const listing = await createListing({ farmer, price: 250 });

    await client
      .patch(`/api/listings/${listing.id}`)
      .set(authHeader(token))
      .send({ price: 999, category: 'ROBOTES' });

    const apres = await prisma.listing.findUnique({ where: { id: listing.id } });
    // price est une colonne DECIMAL : cf. le commentaire du meme test dans
    // regression-order-creation.test.js.
    expect(toNumber(apres.price)).toBe(250);
  });
});