import { describe, it, expect } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createListing, createUser } from '../helpers/factory.js';

// ---------------------------------------------------------------------------
// These tests reproduisent le defaut B1 : les controleurs selectionnent un champ
// "fullName" sur le modele User, qui n'existe pas dans le schema. Prisma leve
// alors une PrismaClientValidationError et l'API repond 500.
//
// Ils doivent etre ROUGES. Ils passeront au vert en phase 3, quand les
// controleurs seront alignes sur firstname/lastname.
// ---------------------------------------------------------------------------

const client = api();

async function farmerToken() {
  const farmer = await createUser({ role: 'FARMER' });
  return { farmer, token: (await createTokenFor(farmer)).accessToken };
}

async function createTokenFor(user) {
  const bcrypt = (await import('bcrypt')).default;
  const { generateToken } = await import('../../src/utils/jwt.js');
  return { accessToken: generateToken({ id: user.id, role: (await roleCodeOf(user)).code }) };
}

async function roleCodeOf(user) {
  const row = await prisma.role.findUnique({ where: { id: user.roleId } });
  return row;
}

describe('B1 - GET /api/listings ne doit pas casser sur un select inexistant', () => {
  it('renvoie 200 sur le listing public', async () => {
    await createListing();

    const res = await client.get('/api/listings');

    expect(res.status, res.text).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('inclut le nom de l agriculteur dans la reponse', async () => {
    await createListing({ farmer: await createUser({ role: 'FARMER', firstname: 'Amina', lastname: 'Benali' }) });

    const res = await client.get('/api/listings');

    expect(res.status).toBe(200);
    const listing = res.body[0];
    // Le controleur expose aujourd hui un seul champ concatene attendu "fullName" ;
    // apres alignement sur le schema, les deux champs du modele doivent etre la.
    const nomExpose = listing.farmer.fullName ?? [listing.farmer.firstname, listing.farmer.lastname].join(' ');
    expect(nomExpose).toContain('Amina');
    expect(listing.farmer.password).toBeUndefined();
  });
});

describe('B1 - POST /api/listings ne doit pas casser apres creation', () => {
  it('cree une annonce et renvoie 201', async () => {
    const { farmer, token } = await farmerToken();
    const category = await prisma.listingCategory.findUnique({ where: { code: 'CEREALES' } });

    const res = await client
      .post('/api/listings')
      .set(authHeader(token))
      .send({
        title: 'Orge fourragere',
        category: category.code,
        price: 180,
        quantity: 40,
        unit: 'kg',
        location: 'Kenitra',
      });

    expect(res.status, res.text).toBe(201);
    expect(res.body.farmerId).toBe(farmer.id);
  });
});

describe('B1 - les autres lectures ne doivent pas casser', () => {
  it('GET /api/orders renvoie 200', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const token = (await createTokenFor(buyer)).accessToken;

    const res = await client.get('/api/orders').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /api/conversations renvoie 200', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const token = (await createTokenFor(buyer)).accessToken;

    const res = await client.get('/api/conversations').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /api/deliveries/available renvoie 200 pour un livreur', async () => {
    const driver = await createUser({ role: 'DRIVER' });
    const token = (await createTokenFor(driver)).accessToken;

    const res = await client.get('/api/deliveries/available').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
  });

  it('GET /api/admin/users renvoie 200 pour un administrateur', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const token = (await createTokenFor(admin)).accessToken;

    const res = await client.get('/api/admin/users').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
  });
});
