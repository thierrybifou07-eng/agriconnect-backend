import { describe, it, expect } from 'vitest';
import { randomInt } from 'node:crypto';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

const client = api();

function tokenPour(user, role) {
  return generateToken({ id: user.id, role });
}

const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const DANS_7_JOURS = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

// --- Fixtures ---

async function fournisseur({ verifie = false } = {}) {
  const user = await createUser({ role: 'SUPPLIER' });
  if (verifie) {
    await prisma.user.update({
      where: { id: user.id },
      data: { profileVerificationStatus: 'VERIFIED' },
    });
  }
  await prisma.supplierProfile.create({
    data: { userId: user.id, farmName: 'Ferme du Test' },
  });
  return user;
}

async function createAgentUser({ capabilities = [], isActive = true } = {}) {
  const user = await createUser({ role: 'AGENT' });
  const agent = await prisma.agent.create({
    data: { kind: 'HUMAN', userId: user.id, displayName: 'Agent Test', isActive },
  });
  if (capabilities.length > 0) {
    const rows = await prisma.agentCapability.findMany({
      where: { code: { in: capabilities } },
      select: { id: true },
    });
    await prisma.agentCapabilityLink.createMany({
      data: rows.map((row) => ({ agentId: agent.id, capabilityId: row.id })),
    });
  }
  return { user, agent };
}

async function produit({ perissable = true } = {}) {
  const [category, unit] = await Promise.all([
    prisma.productCategory.findFirst(),
    prisma.unit.findFirst(),
  ]);
  return prisma.product.create({
    data: {
      categoryId: category.id,
      unitId: unit.id,
      name: `Produit test ${Date.now()}-${randomInt(1_000, 9_999)}`,
      isPerishable: perissable,
    },
  });
}

async function zone() {
  return prisma.zone.create({
    data: { name: `Zone test ${Date.now()}-${randomInt(1_000, 9_999)}` },
  });
}

function champsBase(product, z) {
  return {
    productId: product.id,
    zoneId: z.id,
    agreedUnitPrice: '1250.50',
    quantity: '1500',
    storageType: 'SUPPLIER_SITE',
    pickupAddress: '12 route de la ferme',
    pickupLatitude: '12.34',
    pickupLongitude: '-5.67',
    expiresAt: DANS_7_JOURS,
  };
}

async function declarerLot(token, champs, images = []) {
  let requete = client.post('/api/v2/supplier/lots').set(authHeader(token));
  for (const [cle, valeur] of Object.entries(champs)) {
    requete = requete.field(cle, String(valeur));
  }
  images.forEach((buffer, i) => {
    requete = requete.attach('images', buffer, {
      filename: `photo${i + 1}.jpg`,
      contentType: 'image/jpeg',
    });
  });
  return requete;
}

async function declarentLotSurSite(token, overrides = {}) {
  const prod = await produit();
  const z = await zone();
  const res = await declarerLot(token, { ...champsBase(prod, z), ...overrides });
  expect(res.status, res.text).toBe(201);
  return res;
}

// Crée un agent avec STOCK_VALIDATION et un fournisseur vérifié, puis déclare
// un lot : le cas nominal pour tester la validation.
async function setupAgentEtLot() {
  const { user: agentUser } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });
  const supplier = await fournisseur({ verifie: true });
  const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));
  return { agentUser, supplier, lot: lotRes.body };
}

describe('POST /api/v2/staff/lots/:id/validate — validation', () => {
  it('un agent avec STOCK_VALIDATION valide un lot : 200, AVAILABLE, mouvement RECEIVED, audit', async () => {
    const { agentUser, lot } = await setupAgentEtLot();

    const res = await client
      .post(`/api/v2/staff/lots/${lot.id}/validate`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('AVAILABLE');
    expect(res.body.validatedAt).toBeTruthy();
    expect(res.body.supplier.profileVerificationStatus).toBe('VERIFIED');

    // Le mouvement RECEIVED a été créé.
    const mouvements = await prisma.stockMovement.findMany({
      where: { lotId: lot.id },
    });
    expect(mouvements).toHaveLength(1);
    expect(mouvements[0].type).toBe('RECEIVED');
    expect(mouvements[0].quantityDelta.toNumber()).toBe(1500);

    // L'audit LOT_VALIDATED a été écrit.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'LOT_VALIDATED', entityType: 'StockLot', entityId: lot.id },
    });
    expect(audit).toBeTruthy();
    expect(audit.actorUserId).toBe(agentUser.id);
  });

  it('refuse si le fournisseur n\'est pas vérifié : 409 NOT_VERIFIED', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });
    // Le lot est déclaré par un fournisseur vérifié (la déclaration l'exige,
    // requireVerifiedProfile), puis le profil est retiré : c'est la validation
    // staff que ce test vérifie.
    const supplier = await fournisseur({ verifie: true });
    const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));
    await prisma.user.update({
      where: { id: supplier.id },
      data: { profileVerificationStatus: 'UNVERIFIED' },
    });

    const res = await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/validate`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('NOT_VERIFIED');

    // Le lot n'a pas changé de statut.
    const enBase = await prisma.stockLot.findUnique({ where: { id: lotRes.body.id } });
    expect(enBase.status).toBe('PENDING_VALIDATION');
  });

  it('refuse si le lot n\'est plus en PENDING_VALIDATION : 409 INVALID_STATE_TRANSITION', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    // Premier passage : valide le lot.
    await client
      .post(`/api/v2/staff/lots/${lot.id}/validate`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    // Deuxième passage : le lot est déjà AVAILABLE.
    const res = await client
      .post(`/api/v2/staff/lots/${lot.id}/validate`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('un AGENT sans STOCK_VALIDATION reçoit 403', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: [] });
    const supplier = await fournisseur({ verifie: true });
    const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));

    const res = await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/validate`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(403);
  });

  it('un BUYER reçoit 403', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const supplier = await fournisseur({ verifie: true });
    const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));

    const res = await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/validate`)
      .set(authHeader(tokenPour(buyer, 'BUYER')));

    expect(res.status, res.text).toBe(403);
  });

  it('répond 404 pour un lot inconnu', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });

    const res = await client
      .post('/api/v2/staff/lots/999999/validate')
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(404);
  });
});

describe('POST /api/v2/staff/lots/:id/reject — rejet', () => {
  it('un agent rejette un lot avec raison : 200, REJECTED, audit', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });
    const supplier = await fournisseur({ verifie: true });
    const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));

    const res = await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/reject`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')))
      .send({ reason: 'Qualité insuffisante' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('REJECTED');
    expect(res.body.rejectionReason).toBe('Qualité insuffisante');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'LOT_REJECTED', entityType: 'StockLot', entityId: lotRes.body.id },
    });
    expect(audit).toBeTruthy();
  });

  it('refuse un rejet sans raison (400)', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });
    const supplier = await fournisseur({ verifie: true });
    const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));

    const res = await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/reject`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')))
      .send({});

    expect(res.status, res.text).toBe(400);
  });

  it('refuse de rejeter un lot déjà validé : 409 INVALID_STATE_TRANSITION', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    await client
      .post(`/api/v2/staff/lots/${lot.id}/validate`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    const res = await client
      .post(`/api/v2/staff/lots/${lot.id}/reject`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')))
      .send({ reason: 'Trop tard' });

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('POST /api/v2/staff/lots/:id/return — retour', () => {
  it('un agent retourne un lot AVAILABLE : 200, RETURNED, audit', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });
    const supplier = await fournisseur({ verifie: true });
    const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));
    // Valider d'abord pour passer en AVAILABLE.
    await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/validate`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    const res = await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/return`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')))
      .send({ reason: 'Produit abîmé' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('RETURNED');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'LOT_RETURNED', entityType: 'StockLot', entityId: lotRes.body.id },
    });
    expect(audit).toBeTruthy();
  });

  it('refuse de retourner un lot PENDING_VALIDATION : 409 INVALID_STATE_TRANSITION', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });
    const supplier = await fournisseur({ verifie: true });
    const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));

    const res = await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/return`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')))
      .send({ reason: 'Pas encore validé' });

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('POST /api/v2/supplier/lots/:id/withdraw — retrait fournisseur', () => {
  it('un fournisseur retire un lot AVAILABLE sans réservation : 200, WITHDRAWN', async () => {
    const supplier = await fournisseur({ verifie: true });
    const token = tokenPour(supplier, 'SUPPLIER');
    const lotRes = await declarentLotSurSite(token);
    // Valider d'abord pour passer en AVAILABLE.
    const { user: agentUser } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });
    await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/validate`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    const res = await client
      .post(`/api/v2/supplier/lots/${lotRes.body.id}/withdraw`)
      .set(authHeader(token))
      .send({ reason: 'Plus besoin' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('WITHDRAWN');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'LOT_WITHDRAWN', entityType: 'StockLot', entityId: lotRes.body.id },
    });
    expect(audit).toBeTruthy();
  });

  it('refuse le retrait d\'un lot avec réservation : 409 INVALID_STATE_TRANSITION', async () => {
    const supplier = await fournisseur({ verifie: true });
    const token = tokenPour(supplier, 'SUPPLIER');
    const lotRes = await declarentLotSurSite(token);
    const { user: agentUser } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });
    await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/validate`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    // Simuler une réservation (transition P2.3, écrite directement en base ici).
    await prisma.stockLot.update({
      where: { id: lotRes.body.id },
      data: { quantityReserved: 500, quantityAvailable: 1000 },
    });

    const res = await client
      .post(`/api/v2/supplier/lots/${lotRes.body.id}/withdraw`)
      .set(authHeader(token))
      .send({ reason: 'Retrait impossible' });

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('POST /api/v2/staff/lots/:id/quality-checks — contrôle qualité', () => {
  it('un agent note un lot : 201, grade mis à jour, audit', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });
    const supplier = await fournisseur({ verifie: true });
    const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));

    const res = await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/quality-checks`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')))
      .send({ grade: 'A', notes: 'Excellent calibre' });

    expect(res.status, res.text).toBe(201);
    expect(res.body.qualityGrade).toBe('A');

    const checks = await prisma.lotQualityCheck.findMany({
      where: { lotId: lotRes.body.id },
    });
    expect(checks).toHaveLength(1);
    expect(checks[0].grade).toBe('A');
    expect(checks[0].notes).toBe('Excellent calibre');
    expect(checks[0].inspectedByUserId).toBe(agentUser.id);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'LOT_QUALITY_CHECKED', entityType: 'StockLot', entityId: lotRes.body.id },
    });
    expect(audit).toBeTruthy();
  });

  it('refuse une note invalide (400)', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });
    const supplier = await fournisseur({ verifie: true });
    const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));

    const res = await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/quality-checks`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')))
      .send({ grade: 'D' });

    expect(res.status, res.text).toBe(400);
  });

  it('met à jour la note du lot quand une seconde inspection est faite', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });
    const supplier = await fournisseur({ verifie: true });
    const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));
    const token = tokenPour(agentUser, 'AGENT');

    await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/quality-checks`)
      .set(authHeader(token))
      .send({ grade: 'A' });

    const res = await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/quality-checks`)
      .set(authHeader(token))
      .send({ grade: 'C', notes: 'Petite dégradation' });

    expect(res.status, res.text).toBe(201);
    expect(res.body.qualityGrade).toBe('C');

    const checks = await prisma.lotQualityCheck.findMany({
      where: { lotId: lotRes.body.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(checks).toHaveLength(2);
    expect(checks[0].grade).toBe('A');
    expect(checks[1].grade).toBe('C');
  });

  it('refuse de noter un lot RETURNED : 409 INVALID_STATE_TRANSITION', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });
    const supplier = await fournisseur({ verifie: true });
    const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));
    const token = tokenPour(agentUser, 'AGENT');
    // Valider puis retourner.
    await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/validate`)
      .set(authHeader(token));
    await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/return`)
      .set(authHeader(token))
      .send({ reason: 'Retour fournisseur' });

    const res = await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/quality-checks`)
      .set(authHeader(token))
      .send({ grade: 'B' });

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('un AGENT sans STOCK_VALIDATION reçoit 403', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: [] });
    const supplier = await fournisseur({ verifie: true });
    const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));

    const res = await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/quality-checks`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')))
      .send({ grade: 'A' });

    expect(res.status, res.text).toBe(403);
  });
});

describe('GET /api/v2/staff/lots/:id/quality-checks — historique', () => {
  it('renvoie l\'historique des contrôles d\'un lot', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });
    const supplier = await fournisseur({ verifie: true });
    const lotRes = await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));
    const token = tokenPour(agentUser, 'AGENT');

    await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/quality-checks`)
      .set(authHeader(token))
      .send({ grade: 'A' });
    await client
      .post(`/api/v2/staff/lots/${lotRes.body.id}/quality-checks`)
      .set(authHeader(token))
      .send({ grade: 'B' });

    const res = await client
      .get(`/api/v2/staff/lots/${lotRes.body.id}/quality-checks`)
      .set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].grade).toBe('B'); // Plus récent d'abord
    expect(res.body[1].grade).toBe('A');
  });
});

describe('GET /api/v2/staff/lots — liste staff', () => {
  it('un agent liste les lots avec filtres', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });
    const supplier = await fournisseur({ verifie: true });
    await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));
    await declarentLotSurSite(tokenPour(supplier, 'SUPPLIER'));

    const res = await client
      .get('/api/v2/staff/lots')
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ page: 1, limit: 20, total: 2 });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].supplier).toBeTruthy();
    expect(res.body.items[0].supplier.farmName).toBe('Ferme du Test');
  });

  it('un AGENT sans STOCK_VALIDATION reçoit 403', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: [] });

    const res = await client
      .get('/api/v2/staff/lots')
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(403);
  });
});

describe('GET /api/v2/staff/stock-movements — journal', () => {
  it('un agent consulte le mouvement RECEIVED après validation', async () => {
    const { agentUser, lot } = await setupAgentEtLot();
    await client
      .post(`/api/v2/staff/lots/${lot.id}/validate`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    const res = await client
      .get(`/api/v2/staff/stock-movements?lotId=${lot.id}`)
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].type).toBe('RECEIVED');
    expect(res.body.items[0].lotId).toBe(lot.id);
  });

  it('un AGENT sans STOCK_VALIDATION reçouvrent 403', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: [] });

    const res = await client
      .get('/api/v2/staff/stock-movements')
      .set(authHeader(tokenPour(agentUser, 'AGENT')));

    expect(res.status, res.text).toBe(403);
  });
});
