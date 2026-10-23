import { describe, expect, it } from 'vitest';
import { randomInt } from 'node:crypto';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

const client = api();
const tokenFor = (user, role) => generateToken({ id: user.id, role });
const uniqueCode = (prefix) => `${prefix}_${randomInt(100000, 999999)}`;

async function createProductFixtures() {
  const categoryOne = await prisma.productCategory.create({
    data: { code: uniqueCode('MOB_CAT'), label: 'Référentiel A' },
  });
  const categoryTwo = await prisma.productCategory.create({
    data: { code: uniqueCode('MOB_CAT'), label: 'Référentiel B' },
  });
  const unit = await prisma.unit.create({
    data: { code: uniqueCode('MOB_UNIT'), label: 'Unité mobile' },
  });
  const active = await prisma.product.create({
    data: { categoryId: categoryOne.id, unitId: unit.id, name: 'Produit actif' },
  });
  await prisma.product.create({
    data: {
      categoryId: categoryOne.id,
      unitId: unit.id,
      name: 'Produit désactivé',
      isActive: false,
    },
  });
  const otherCategoryProduct = await prisma.product.create({
    data: { categoryId: categoryTwo.id, unitId: unit.id, name: 'Produit autre catégorie' },
  });
  return { categoryOne, categoryTwo, active, otherCategoryProduct };
}

describe('GET /api/v2/reference/*', () => {
  it.each(['SUPPLIER', 'BUYER', 'AGENT', 'ADMIN', 'ROOT'])('autorise la lecture au rôle %s', async (role) => {
    const user = await createUser({ role });
    const token = tokenFor(user, role);

    const [categories, units, products, zones, hubs] = await Promise.all([
      client.get('/api/v2/reference/categories').set(authHeader(token)),
      client.get('/api/v2/reference/units').set(authHeader(token)),
      client.get('/api/v2/reference/products').set(authHeader(token)),
      client.get('/api/v2/reference/zones').set(authHeader(token)),
      client.get('/api/v2/reference/hubs').set(authHeader(token)),
    ]);

    for (const response of [categories, units, products, zones, hubs]) {
      expect(response.status, response.text).toBe(200);
      expect(response.body).toMatchObject({ page: 1, limit: 20 });
      expect(Array.isArray(response.body.items)).toBe(true);
    }
  });

  it('refuse un appel sans jeton', async () => {
    const res = await client.get('/api/v2/reference/zones');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_MISSING');
  });

  it('refuse le rôle DRIVER', async () => {
    const driver = await createUser({ role: 'DRIVER' });

    const res = await client.get('/api/v2/reference/zones')
      .set(authHeader(tokenFor(driver, 'DRIVER')));

    expect(res.status, res.text).toBe(403);
    expect(res.body.code).toBe('ROLE_FORBIDDEN');
  });

  it('exclut les produits inactifs et filtre par catégorie', async () => {
    const { categoryOne, otherCategoryProduct, active } = await createProductFixtures();
    const supplier = await createUser({ role: 'SUPPLIER' });

    const res = await client.get(`/api/v2/reference/products?categoryId=${categoryOne.id}`)
      .set(authHeader(tokenFor(supplier, 'SUPPLIER')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.items.map((product) => product.id)).toEqual([active.id]);
    expect(res.body.items.every((product) => product.category.id === categoryOne.id)).toBe(true);
    expect(res.body.items.some((product) => product.name === 'Produit désactivé')).toBe(false);
    expect(res.body.items).not.toContainEqual(expect.objectContaining({ id: otherCategoryProduct.id }));
  });

  it('applique la pagination et rejette un paramètre invalide', async () => {
    await createProductFixtures();
    const buyer = await createUser({ role: 'BUYER' });
    const token = tokenFor(buyer, 'BUYER');

    const page = await client.get('/api/v2/reference/products?page=1&limit=1')
      .set(authHeader(token));
    expect(page.status, page.text).toBe(200);
    expect(page.body).toMatchObject({ page: 1, limit: 1, total: 2 });
    expect(page.body.items).toHaveLength(1);

    const invalid = await client.get('/api/v2/reference/products?limit=101')
      .set(authHeader(token));
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('Données invalides');
  });
});
