import { describe, it, expect } from 'vitest';
import { randomInt } from 'node:crypto';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

const client = api();

// Le jeton ne porte que l'identifiant : protect recharge l'utilisateur (et son
// rôle) en base à chaque requête, comme dans les autres suites.
function tokenFor(user, role) {
  return generateToken({ id: user.id, role });
}

// ProductCategory et Unit ne sont pas vidées entre deux tests (ce sont des
// référentiels, voir tests/helpers/db.js) : chaque test emporte ses propres
// codes, sinon le deuxième créant le même code échouerait sur l'index unique.
function uniqueCode(prefix) {
  return `${prefix}_${randomInt(100000, 999999)}`;
}

// Catégorie et unité posées directement en base : les tests de produits
// portent sur les routes, pas sur la création des référentiels dont ils
// dépendent.
async function seedCategory(overrides = {}) {
  return prisma.productCategory.create({
    data: { code: uniqueCode('CAT'), label: 'Catégorie Test', ...overrides },
  });
}

async function seedUnit(overrides = {}) {
  return prisma.unit.create({
    data: { code: uniqueCode('UNIT'), label: 'Unité Test', ...overrides },
  });
}

// Zone posée directement en base : Zone est une table métier, vidée entre
// deux tests, donc un nom fixe suffit.
async function seedZone(overrides = {}) {
  return prisma.zone.create({
    data: { name: 'Zone Test', ...overrides },
  });
}

async function auditFor(action, entityType, entityId) {
  return prisma.auditLog.findFirst({ where: { action, entityType, entityId } });
}

// Le middleware de validation renvoie le message métier dans details, error
// valant toujours 'Données invalides'.
function expectDetails(res, fragment) {
  expect(res.body.details?.some((d) => d.message.includes(fragment)), res.text).toBe(true);
}

describe('Référentiels — contrôle d\'accès', () => {
  it('refuse un AGENT sans rôle admin (403 — requireMinLevel(50))', async () => {
    const agent = await createUser({ role: 'AGENT' });

    const res = await client.get('/api/v2/admin/categories').set(authHeader(tokenFor(agent, 'AGENT')));

    expect(res.status, res.text).toBe(403);
  });

  it('refuse un AGENT sur les écritures également (403)', async () => {
    const agent = await createUser({ role: 'AGENT' });

    const res = await client
      .post('/api/v2/admin/categories')
      .set(authHeader(tokenFor(agent, 'AGENT')))
      .send({ code: uniqueCode('CAT'), label: 'Tentative' });

    expect(res.status, res.text).toBe(403);
    // Aucune ligne écrite : le 403 arrive avant le contrôleur.
    const count = await prisma.productCategory.count({ where: { label: 'Tentative' } });
    expect(count).toBe(0);
  });

  it('refuse un appel sans jeton (401)', async () => {
    const res = await client.get('/api/v2/admin/categories');

    expect(res.status, res.text).toBe(401);
  });
});

describe('Catégories', () => {
  it('crée une catégorie (201) et écrit un AuditLog', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .post('/api/v2/admin/categories')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ code: uniqueCode('CAT'), label: 'Céréales' });

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ label: 'Céréales', isActive: true });
    expect(typeof res.body.code).toBe('string');
    expect(res.body).not.toHaveProperty('password');

    const audit = await auditFor('CATEGORY_CREATED', 'ProductCategory', res.body.id);
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(admin.id);
    expect(audit.metadata).toMatchObject({ label: 'Céréales' });
  });

  it('refuse un code en double (409)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const code = uniqueCode('CAT');
    await seedCategory({ code, label: ' Première' });

    const res = await client
      .post('/api/v2/admin/categories')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ code, label: 'Seconde' });

    expect(res.status, res.text).toBe(409);
    expect(res.body.error).toContain('existe déjà');
  });

  it('refuse un code en minuscules (400 — collision MySQL insensible à la casse)', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .post('/api/v2/admin/categories')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ code: 'cereales', label: 'Céréales' });

    expect(res.status, res.text).toBe(400);
  });

  it('désactive une catégorie via PATCH (isActive=false)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const category = await seedCategory();

    const res = await client
      .patch(`/api/v2/admin/categories/${category.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ isActive: false });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ id: category.id, isActive: false });

    const inBase = await prisma.productCategory.findUnique({ where: { id: category.id } });
    expect(inBase.isActive).toBe(false);
  });

  it('modifie le libellé et écrit un AuditLog de modification', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const category = await seedCategory({ label: 'Ancien libellé' });

    const res = await client
      .patch(`/api/v2/admin/categories/${category.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ label: 'Nouveau libellé' });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ id: category.id, label: 'Nouveau libellé' });

    const audit = await auditFor('CATEGORY_UPDATED', 'ProductCategory', category.id);
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(admin.id);
    expect(audit.metadata.changes).toMatchObject({ label: 'Nouveau libellé' });
  });

  it('refuse une catégorie inexistante (404)', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch('/api/v2/admin/categories/999999')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ label: 'Nom' });

    expect(res.status, res.text).toBe(404);
    expect(res.body.error).toContain('introuvable');
  });

  it('liste paginée avec filtre ?active=true|false', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const code = uniqueCode('CAT');
    await client.post('/api/v2/admin/categories').set(authHeader(tokenFor(admin, 'ADMIN'))).send({ code, label: 'Active' });
    const desactivee = await client
      .post('/api/v2/admin/categories')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ code: uniqueCode('CAT'), label: 'Désactivée' });
    await client
      .patch(`/api/v2/admin/categories/${desactivee.body.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ isActive: false });

    const toutes = await client.get('/api/v2/admin/categories?limit=2').set(authHeader(tokenFor(admin, 'ADMIN')));
    expect(toutes.status, toutes.text).toBe(200);
    expect(toutes.body).toMatchObject({ page: 1, limit: 2 });
    expect(toutes.body.total).toBeGreaterThanOrEqual(2);
    expect(toutes.body.items).toHaveLength(2);

    const actives = await client.get('/api/v2/admin/categories?active=true').set(authHeader(tokenFor(admin, 'ADMIN')));
    expect(actives.status, actives.text).toBe(200);
    expect(actives.body.items.some((c) => c.id === desactivee.body.id)).toBe(false);
    expect(actives.body.items.every((c) => c.isActive === true)).toBe(true);

    const inactives = await client.get('/api/v2/admin/categories?active=false').set(authHeader(tokenFor(admin, 'ADMIN')));
    expect(inactives.status, inactives.text).toBe(200);
    expect(inactives.body.items.some((c) => c.id === desactivee.body.id)).toBe(true);
    expect(inactives.body.items.every((c) => c.isActive === false)).toBe(true);
  });

  it('refuse un filtre ?active= hors énumération (400)', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client.get('/api/v2/admin/categories?active=maybe').set(authHeader(tokenFor(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(400);
  });
});

describe('Unités', () => {
  it('crée une unité (201) et écrit un AuditLog', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .post('/api/v2/admin/units')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ code: uniqueCode('UNIT'), label: 'Kilogramme' });

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ label: 'Kilogramme' });
    expect(typeof res.body.code).toBe('string');
    // Unit n'a pas de colonne isActive (schéma cible) : le champ n'existe
    // ni en base, ni dans la réponse.
    expect(res.body).not.toHaveProperty('isActive');

    const audit = await auditFor('UNIT_CREATED', 'Unit', res.body.id);
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(admin.id);
  });

  it('refuse un code en double (409)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const code = uniqueCode('UNIT');
    await seedUnit({ code, label: 'Première' });

    const res = await client
      .post('/api/v2/admin/units')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ code, label: 'Seconde' });

    expect(res.status, res.text).toBe(409);
    expect(res.body.error).toContain('existe déjà');
  });

  it('modifie le libellé et écrit un AuditLog de modification', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const unit = await seedUnit({ label: 'Ancien libellé' });

    const res = await client
      .patch(`/api/v2/admin/units/${unit.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ label: 'Nouveau libellé' });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ id: unit.id, label: 'Nouveau libellé' });

    const audit = await auditFor('UNIT_UPDATED', 'Unit', unit.id);
    expect(audit).not.toBeNull();
    expect(audit.metadata.changes).toMatchObject({ label: 'Nouveau libellé' });
  });

  it('ignore le filtre ?active= (pas de colonne isActive sur Unit)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    await seedUnit();

    // Le filtre ne s'applique pas : la réponse reste une liste paginée 200,
    // sans erreur — la colonne n'existe tout simplement pas.
    const res = await client.get('/api/v2/admin/units?active=false').set(authHeader(tokenFor(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ page: 1, limit: 20 });
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('refuse une unité inexistante (404)', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch('/api/v2/admin/units/999999')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ label: 'Nom' });

    expect(res.status, res.text).toBe(404);
    expect(res.body.error).toContain('introuvable');
  });
});

describe('Produits', () => {
  it('crée un produit (201) et écrit un AuditLog', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const category = await seedCategory();
    const unit = await seedUnit();

    const res = await client
      .post('/api/v2/admin/products')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({
        categoryId: category.id,
        unitId: unit.id,
        name: 'Maïs grain',
        description: 'Maïs jaune',
        isPerishable: true,
      });

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({
      categoryId: category.id,
      unitId: unit.id,
      name: 'Maïs grain',
      description: 'Maïs jaune',
      isPerishable: true,
      isActive: true,
    });

    const audit = await auditFor('PRODUCT_CREATED', 'Product', res.body.id);
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(admin.id);
  });

  it('refuse un couple (categoryId, name) en double (409)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const category = await seedCategory();
    const unit = await seedUnit();
    await prisma.product.create({ data: { categoryId: category.id, unitId: unit.id, name: 'Riz' } });

    const res = await client
      .post('/api/v2/admin/products')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ categoryId: category.id, unitId: unit.id, name: 'Riz' });

    expect(res.status, res.text).toBe(409);
    expect(res.body.error).toContain('existe déjà');
  });

  it('accepte le même nom dans une autre catégorie (201)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const categoryA = await seedCategory();
    const categoryB = await seedCategory();
    const unit = await seedUnit();
    await prisma.product.create({ data: { categoryId: categoryA.id, unitId: unit.id, name: 'Riz' } });

    const res = await client
      .post('/api/v2/admin/products')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ categoryId: categoryB.id, unitId: unit.id, name: 'Riz' });

    expect(res.status, res.text).toBe(201);
  });

  it('refuse une catégorie inexistante (400)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const unit = await seedUnit();

    const res = await client
      .post('/api/v2/admin/products')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ categoryId: 999999, unitId: unit.id, name: 'Produit' });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse une catégorie inactive (400)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const category = await seedCategory({ isActive: false });
    const unit = await seedUnit();

    const res = await client
      .post('/api/v2/admin/products')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ categoryId: category.id, unitId: unit.id, name: 'Produit' });

    expect(res.status, res.text).toBe(400);
    expectDetails(res, 'inactive');
  });

  it('refuse une unité inexistante (400)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const category = await seedCategory();

    const res = await client
      .post('/api/v2/admin/products')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ categoryId: category.id, unitId: 999999, name: 'Produit' });

    expect(res.status, res.text).toBe(400);
  });

  it('modifie et désactive un produit, et écrit un AuditLog', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const category = await seedCategory();
    const unit = await seedUnit();
    const product = await prisma.product.create({
      data: { categoryId: category.id, unitId: unit.id, name: 'Arachide' },
    });

    const res = await client
      .patch(`/api/v2/admin/products/${product.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ isPerishable: false, isActive: false });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ id: product.id, isPerishable: false, isActive: false });

    const audit = await auditFor('PRODUCT_UPDATED', 'Product', product.id);
    expect(audit).not.toBeNull();
    expect(audit.metadata.changes).toMatchObject({ isPerishable: false, isActive: false });
  });

  it('refuse de renommer vers un couple déjà pris (409)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const category = await seedCategory();
    const unit = await seedUnit();
    await prisma.product.create({ data: { categoryId: category.id, unitId: unit.id, name: 'Mil' } });
    const autre = await prisma.product.create({
      data: { categoryId: category.id, unitId: unit.id, name: 'Sorgho' },
    });

    const res = await client
      .patch(`/api/v2/admin/products/${autre.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ name: 'Mil' });

    expect(res.status, res.text).toBe(409);
  });

  it('refuse une catégorie inexistante en modification (400)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const category = await seedCategory();
    const unit = await seedUnit();
    const product = await prisma.product.create({
      data: { categoryId: category.id, unitId: unit.id, name: 'Sésame' },
    });

    const res = await client
      .patch(`/api/v2/admin/products/${product.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ categoryId: 999999 });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un produit inexistant (404)', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch('/api/v2/admin/products/999999')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ name: 'Nom' });

    expect(res.status, res.text).toBe(404);
    expect(res.body.error).toContain('introuvable');
  });

  it('filtre la liste par ?active=true|false', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const category = await seedCategory();
    const unit = await seedUnit();
    const product = await prisma.product.create({
      data: { categoryId: category.id, unitId: unit.id, name: 'Gombo' },
    });
    await client
      .patch(`/api/v2/admin/products/${product.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ isActive: false });

    const inactifs = await client.get('/api/v2/admin/products?active=false').set(authHeader(tokenFor(admin, 'ADMIN')));
    expect(inactifs.status, inactifs.text).toBe(200);
    expect(inactifs.body.items.some((p) => p.id === product.id)).toBe(true);

    const actifs = await client.get('/api/v2/admin/products?active=true').set(authHeader(tokenFor(admin, 'ADMIN')));
    expect(actifs.status, actifs.text).toBe(200);
    expect(actifs.body.items.some((p) => p.id === product.id)).toBe(false);
  });
});

describe('Zones', () => {
  it('crée une zone (201) et écrit un AuditLog', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .post('/api/v2/admin/zones')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ name: 'Zone Test', city: 'Cotonou', region: 'Littoral' });

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ name: 'Zone Test', city: 'Cotonou', region: 'Littoral', isActive: true });

    const audit = await auditFor('ZONE_CREATED', 'Zone', res.body.id);
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(admin.id);
  });

  it('refuse un nom en double (409)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    await seedZone();

    const res = await client
      .post('/api/v2/admin/zones')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ name: 'Zone Test' });

    expect(res.status, res.text).toBe(409);
    expect(res.body.error).toContain('existe déjà');
  });

  it('désactive une zone via PATCH', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const zone = await seedZone();

    const res = await client
      .patch(`/api/v2/admin/zones/${zone.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ isActive: false });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ id: zone.id, isActive: false });

    const inBase = await prisma.zone.findUnique({ where: { id: zone.id } });
    expect(inBase.isActive).toBe(false);
  });

  it('filtre la liste par ?active=true|false', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const zone = await seedZone();
    await client
      .patch(`/api/v2/admin/zones/${zone.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ isActive: false });

    const inactives = await client.get('/api/v2/admin/zones?active=false').set(authHeader(tokenFor(admin, 'ADMIN')));
    expect(inactives.body.items.some((z) => z.id === zone.id)).toBe(true);

    const actives = await client.get('/api/v2/admin/zones?active=true').set(authHeader(tokenFor(admin, 'ADMIN')));
    expect(actives.body.items.some((z) => z.id === zone.id)).toBe(false);
  });
});

describe('Points de dépôt (hubs)', () => {
  it('crée un hub (201) et écrit un AuditLog', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const zone = await seedZone();

    const res = await client
      .post('/api/v2/admin/hubs')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({
        name: 'Dépôt Centre',
        address: '12 rue des Marchés',
        city: 'Cotonou',
        latitude: 6.37,
        longitude: 2.43,
        zoneId: zone.id,
      });

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Dépôt Centre',
      address: '12 rue des Marchés',
      city: 'Cotonou',
      zoneId: zone.id,
      acceptsDropoff: true,
      acceptsPickup: true,
      isActive: true,
    });

    const audit = await auditFor('HUB_CREATED', 'Hub', res.body.id);
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(admin.id);
  });

  it('refuse une zone inexistante (400)', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .post('/api/v2/admin/hubs')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({
        name: 'Dépôt Centre',
        address: '12 rue des Marchés',
        latitude: 6.37,
        longitude: 2.43,
        zoneId: 999999,
      });

    expect(res.status, res.text).toBe(400);
    expectDetails(res, 'Zone');
  });

  it('désactive un hub via PATCH et écrit un AuditLog', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const zone = await seedZone();
    const hub = await prisma.hub.create({
      data: { name: 'Dépôt Nord', address: '1 rue du Port', latitude: 6.4, longitude: 2.5, zoneId: zone.id },
    });

    const res = await client
      .patch(`/api/v2/admin/hubs/${hub.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ isActive: false });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ id: hub.id, isActive: false });

    const audit = await auditFor('HUB_UPDATED', 'Hub', hub.id);
    expect(audit).not.toBeNull();
    expect(audit.metadata.changes).toMatchObject({ isActive: false });
  });

  it('refuse une zone inexistante en modification (400)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const zone = await seedZone();
    const hub = await prisma.hub.create({
      data: { name: 'Dépôt Sud', address: '2 rue du Port', latitude: 6.4, longitude: 2.5, zoneId: zone.id },
    });

    const res = await client
      .patch(`/api/v2/admin/hubs/${hub.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ zoneId: 999999 });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un hub inexistant (404)', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch('/api/v2/admin/hubs/999999')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ name: 'Nom' });

    expect(res.status, res.text).toBe(404);
    expect(res.body.error).toContain('introuvable');
  });

  it('liste les hubs avec filtre ?active=', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const zone = await seedZone();
    const hub = await prisma.hub.create({
      data: { name: 'Dépôt Ouest', address: '3 rue du Port', latitude: 6.4, longitude: 2.5, zoneId: zone.id },
    });
    await client
      .patch(`/api/v2/admin/hubs/${hub.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ isActive: false });

    const tous = await client.get('/api/v2/admin/hubs').set(authHeader(tokenFor(admin, 'ADMIN')));
    expect(tous.status, tous.text).toBe(200);
    expect(tous.body).toMatchObject({ page: 1, limit: 20 });
    expect(tous.body.items.some((h) => h.id === hub.id)).toBe(true);

    const actifs = await client.get('/api/v2/admin/hubs?active=true').set(authHeader(tokenFor(admin, 'ADMIN')));
    expect(actifs.body.items.some((h) => h.id === hub.id)).toBe(false);
  });
});
