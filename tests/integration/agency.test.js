import { describe, it, expect } from 'vitest';
import { randomInt } from 'node:crypto';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { findActiveAgencyForZone } from '../../src/services/agency.service.js';

const client = api();

// Le jeton ne porte que l'identifiant : protect recharge l'utilisateur (et son
// rôle) en base à chaque requête, comme dans les autres suites.
function tokenFor(user, role) {
  return generateToken({ id: user.id, role });
}

// Zone posée directement en base : Zone est une table métier, vidée entre
// deux tests, donc un nom fixe suffit.
async function seedZone(overrides = {}) {
  return prisma.zone.create({
    data: { name: 'Zone Test', ...overrides },
  });
}

// Agence posée directement en base : les tests de routes portent sur les
// contrôleurs, pas sur la création des agences dont ils dépendent.
async function seedAgency(overrides = {}) {
  return prisma.transportAgency.create({
    data: {
      name: `Agence ${randomInt(100000, 999999)}`,
      phone: '+33600000000',
      ...overrides,
    },
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

describe('Agences — contrôle d\'accès', () => {
  it('refuse un AGENT sans rôle admin (403 — requireMinLevel(50))', async () => {
    const agent = await createUser({ role: 'AGENT' });

    const res = await client.get('/api/v2/admin/agencies').set(authHeader(tokenFor(agent, 'AGENT')));

    expect(res.status, res.text).toBe(403);
  });

  it('refuse un appel sans jeton (401)', async () => {
    const res = await client.get('/api/v2/admin/agencies');

    expect(res.status, res.text).toBe(401);
  });
});

describe('Agences — CRUD', () => {
  it('crée une agence (201) et écrit un AuditLog', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .post('/api/v2/admin/agencies')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({
        name: 'Agence du Nord',
        contactName: 'Awa Diallo',
        phone: '+22966000000',
        email: 'nord@agence.com',
        insuranceProvider: 'NSIA Assurances',
        insurancePolicyNumber: 'POL-12345',
        insuranceExpiresAt: '2027-01-01T00:00:00.000Z',
      });

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Agence du Nord',
      contactName: 'Awa Diallo',
      phone: '+22966000000',
      insuranceProvider: 'NSIA Assurances',
      insurancePolicyNumber: 'POL-12345',
      isActive: true,
    });

    const audit = await auditFor('AGENCY_CREATED', 'TransportAgency', res.body.id);
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(admin.id);
    expect(audit.metadata).toMatchObject({ name: 'Agence du Nord' });
  });

  it('refuse un nom en double (409)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    await seedAgency({ name: 'Agence Unique' });

    const res = await client
      .post('/api/v2/admin/agencies')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ name: 'Agence Unique', phone: '+22966000001' });

    expect(res.status, res.text).toBe(409);
    expect(res.body.error).toContain('existe déjà');
  });

  it('refuse un nom manquant (400)', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .post('/api/v2/admin/agencies')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ phone: '+22966000001' });

    expect(res.status, res.text).toBe(400);
  });

  it('modifie une agence et écrit un AuditLog de modification', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agency = await seedAgency({ name: 'Agence Avant' });

    const res = await client
      .patch(`/api/v2/admin/agencies/${agency.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ contactName: 'Nouveau Contact', insuranceExpiresAt: '2028-06-01T00:00:00.000Z' });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ id: agency.id, contactName: 'Nouveau Contact' });

    const audit = await auditFor('AGENCY_UPDATED', 'TransportAgency', agency.id);
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(admin.id);
    expect(audit.metadata.changes).toMatchObject({ contactName: 'Nouveau Contact' });
  });

  it('désactive une agence via PATCH (isActive=false)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agency = await seedAgency();

    const res = await client
      .patch(`/api/v2/admin/agencies/${agency.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ isActive: false });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ id: agency.id, isActive: false });

    const inBase = await prisma.transportAgency.findUnique({ where: { id: agency.id } });
    expect(inBase.isActive).toBe(false);
  });

  it('refuse une agence inexistante (404)', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch('/api/v2/admin/agencies/999999')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ name: 'Nom' });

    expect(res.status, res.text).toBe(404);
    expect(res.body.error).toContain('introuvable');
  });

  it('liste paginée avec filtre ?active=true|false', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agency = await seedAgency();
    await client
      .patch(`/api/v2/admin/agencies/${agency.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ isActive: false });

    const toutes = await client.get('/api/v2/admin/agencies?limit=2').set(authHeader(tokenFor(admin, 'ADMIN')));
    expect(toutes.status, toutes.text).toBe(200);
    expect(toutes.body).toMatchObject({ page: 1, limit: 2 });
    expect(toutes.body.total).toBeGreaterThanOrEqual(1);
    expect(toutes.body.items.length).toBeLessThanOrEqual(2);

    const inactives = await client.get('/api/v2/admin/agencies?active=false').set(authHeader(tokenFor(admin, 'ADMIN')));
    expect(inactives.body.items.some((a) => a.id === agency.id)).toBe(true);
    expect(inactives.body.items.every((a) => a.isActive === false)).toBe(true);

    const actives = await client.get('/api/v2/admin/agencies?active=true').set(authHeader(tokenFor(admin, 'ADMIN')));
    expect(actives.body.items.some((a) => a.id === agency.id)).toBe(false);
  });
});

describe('Agences — couverture des zones et tarifs', () => {
  it('crée une couverture de zone (201) avec tarifs, puis la met à jour (200)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agency = await seedAgency();
    const zone = await seedZone();

    const created = await client
      .put(`/api/v2/admin/agencies/${agency.id}/zones/${zone.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ baseFee: 500, perKmFee: 100 });

    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ agencyId: agency.id, zoneId: zone.id, isActive: true });
    // Les tarifs sont des Decimal en base : ils arrivent convertis en nombres
    // par le middleware decimal-json.
    expect(Number(created.body.baseFee)).toBe(500);
    expect(Number(created.body.perKmFee)).toBe(100);

    const auditCreate = await auditFor('AGENCY_ZONE_CREATED', 'AgencyZone', zone.id);
    expect(auditCreate).not.toBeNull();
    expect(auditCreate.actorUserId).toBe(admin.id);

    const updated = await client
      .put(`/api/v2/admin/agencies/${agency.id}/zones/${zone.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ baseFee: 750, perKmFee: 120, isActive: false });

    expect(updated.status, updated.text).toBe(200);
    expect(updated.body).toMatchObject({ agencyId: agency.id, zoneId: zone.id, isActive: false });
    expect(Number(updated.body.baseFee)).toBe(750);

    const auditUpdate = await auditFor('AGENCY_ZONE_UPDATED', 'AgencyZone', zone.id);
    expect(auditUpdate).not.toBeNull();
    expect(auditUpdate.metadata).toMatchObject({ agencyId: agency.id, zoneId: zone.id });
  });

  it('refuse un tarif négatif (400)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agency = await seedAgency();
    const zone = await seedZone();

    const res = await client
      .put(`/api/v2/admin/agencies/${agency.id}/zones/${zone.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ baseFee: -10, perKmFee: 100 });

    expect(res.status, res.text).toBe(400);
    expectDetails(res, 'négatif');

    // Aucune ligne écrite : le 400 arrive avant le contrôleur.
    const inBase = await prisma.agencyZone.findUnique({
      where: { agencyId_zoneId: { agencyId: agency.id, zoneId: zone.id } },
    });
    expect(inBase).toBeNull();
  });

  it('refuse une zone inexistante (400)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agency = await seedAgency();

    const res = await client
      .put(`/api/v2/admin/agencies/${agency.id}/zones/999999`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ baseFee: 500, perKmFee: 100 });

    expect(res.status, res.text).toBe(400);
    expect(res.body.error).toContain('Zone');
  });

  it('refuse un identifiant de zone non numérique (400)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agency = await seedAgency();

    const res = await client
      .put(`/api/v2/admin/agencies/${agency.id}/zones/abc`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ baseFee: 500, perKmFee: 100 });

    expect(res.status, res.text).toBe(400);
  });

  it('supprime une couverture de zone et écrit un AuditLog', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agency = await seedAgency();
    const zone = await seedZone();
    await prisma.agencyZone.create({
      data: { agencyId: agency.id, zoneId: zone.id, baseFee: 500, perKmFee: 100 },
    });

    const res = await client
      .delete(`/api/v2/admin/agencies/${agency.id}/zones/${zone.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ agencyId: agency.id, zoneId: zone.id });

    const inBase = await prisma.agencyZone.findUnique({
      where: { agencyId_zoneId: { agencyId: agency.id, zoneId: zone.id } },
    });
    expect(inBase).toBeNull();

    const audit = await auditFor('AGENCY_ZONE_REMOVED', 'AgencyZone', zone.id);
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(admin.id);
  });

  it('refuse une couverture inexistante (404)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agency = await seedAgency();
    const zone = await seedZone();

    const res = await client
      .delete(`/api/v2/admin/agencies/${agency.id}/zones/${zone.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(404);
    expect(res.body.error).toContain('introuvable');
  });
});

describe('Agences — livreurs', () => {
  it('liste les livreurs rattachés à l\'agence', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agency = await seedAgency();
    const driver = await createUser({ role: 'DRIVER' });
    await prisma.driverProfile.create({
      data: { userId: driver.id, agencyId: agency.id, vehicleType: 'MOTO', plateNumber: 'AB-123' },
    });

    const res = await client
      .get(`/api/v2/admin/agencies/${agency.id}/drivers`)
      .set(authHeader(tokenFor(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      agencyId: agency.id,
      vehicleType: 'MOTO',
      plateNumber: 'AB-123',
    });
    expect(res.body.items[0].user).toMatchObject({
      id: driver.id,
      firstname: driver.firstname,
      phone: driver.phone,
    });
  });

  it('retourne une liste vide pour une agence sans livreur', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agency = await seedAgency();

    const res = await client
      .get(`/api/v2/admin/agencies/${agency.id}/drivers`)
      .set(authHeader(tokenFor(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ items: [], total: 0 });
  });

  it('refuse une agence inexistante (404)', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client.get('/api/v2/admin/agencies/999999/drivers').set(authHeader(tokenFor(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(404);
  });
});

describe('Service — findActiveAgencyForZone', () => {
  it('renvoie l\'agence active couvrant la zone', async () => {
    const zone = await seedZone();
    const agency = await seedAgency();
    await prisma.agencyZone.create({
      data: { agencyId: agency.id, zoneId: zone.id, baseFee: 500, perKmFee: 100 },
    });

    const found = await findActiveAgencyForZone(zone.id);

    expect(found.id).toBe(agency.id);
    expect(found.isActive).toBe(true);
  });

  it('refuse une zone non couverte (409 ZONE_NOT_COVERED)', async () => {
    const zone = await seedZone();

    await expect(findActiveAgencyForZone(zone.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ZONE_NOT_COVERED',
      message: 'Zone non couverte',
    });
  });

  it('refuse quand la seule agence couvrant la zone est inactive (409 ZONE_NOT_COVERED)', async () => {
    const zone = await seedZone();
    const agency = await seedAgency({ isActive: false });
    await prisma.agencyZone.create({
      data: { agencyId: agency.id, zoneId: zone.id, baseFee: 500, perKmFee: 100 },
    });

    await expect(findActiveAgencyForZone(zone.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ZONE_NOT_COVERED',
    });
  });

  it('refuse quand la couverture de la zone est inactive (409 ZONE_NOT_COVERED)', async () => {
    const zone = await seedZone();
    const agency = await seedAgency();
    await prisma.agencyZone.create({
      data: { agencyId: agency.id, zoneId: zone.id, baseFee: 500, perKmFee: 100, isActive: false },
    });

    await expect(findActiveAgencyForZone(zone.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ZONE_NOT_COVERED',
    });
  });

  it('refuse une agence dont l\'assurance est expirée (409 AGENCY_INSURANCE_EXPIRED)', async () => {
    const zone = await seedZone();
    const agency = await seedAgency({
      insuranceExpiresAt: new Date(Date.now() - 24 * 3600 * 1000),
    });
    await prisma.agencyZone.create({
      data: { agencyId: agency.id, zoneId: zone.id, baseFee: 500, perKmFee: 100 },
    });

    await expect(findActiveAgencyForZone(zone.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'AGENCY_INSURANCE_EXPIRED',
      message: 'Assurance de l\'agence expirée',
    });
  });

  it('accepte une agence sans date d\'expiration d\'assurance', async () => {
    const zone = await seedZone();
    const agency = await seedAgency({ insuranceExpiresAt: null });
    await prisma.agencyZone.create({
      data: { agencyId: agency.id, zoneId: zone.id, baseFee: 500, perKmFee: 100 },
    });

    const found = await findActiveAgencyForZone(zone.id);

    expect(found.id).toBe(agency.id);
  });
});
