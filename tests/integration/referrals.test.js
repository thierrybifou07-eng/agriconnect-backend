import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

const Decimal = Prisma.Decimal;

// --- Mock Cloudinary ---
// Le module npm 'cloudinary' est mocké (et non config/cloudinary.js) : les deux
// importent { v2 } de 'cloudinary', donc un seul mock couvre les deux.
const { uploadStream, privateDownloadUrl } = vi.hoisted(() => ({
  uploadStream: vi.fn(),
  privateDownloadUrl: vi.fn(),
}));

vi.mock('cloudinary', () => ({
  v2: {
    config: vi.fn(),
    uploader: { upload_stream: uploadStream },
    utils: { private_download_url: privateDownloadUrl },
  },
}));

const client = api();

function tokenFor(user) {
  return generateToken({ id: user.id, role: user.role?.code ?? 'BUYER' });
}

// Buffers minimaux : multer ne regarde que le mimetype déclaré, pas le contenu.
const FAKE_PDF = Buffer.from('%PDF-1.4 factice');

beforeEach(() => {
  uploadStream.mockImplementation((options, callback) => ({
    end: () => {
      setImmediate(() =>
        callback(null, {
          public_id: 'doc_test_123',
          secure_url: 'https://res.cloudinary.com/test/doc_test_123',
        })
      );
    },
  }));
  privateDownloadUrl.mockImplementation(
    (publicId, format, options) =>
      `https://api.cloudinary.com/v1_1/test/image/download?public_id=${publicId}&format=${format}&expires_at=${options.expires_at}&signature=mocksig`
  );
});

// Depose un document et l'approuve via l'API admin : le profil passe VERIFIED.
// Passe par la vraie route pour que onProfileVerified soit appele dans la
// transaction de validation (P1.6).
async function verifierProfil(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const admin = await createUser({ role: 'ADMIN' });
  const depot = await client
    .post('/api/v2/auth/me/documents')
    .set(authHeader(tokenFor(user)))
    .attach('file', FAKE_PDF, { filename: 'doc.pdf', contentType: 'application/pdf' })
    .field('type', 'ID_CARD');
  expect(depot.status, depot.text).toBe(201);

  const res = await client
    .patch(`/api/v2/admin/verifications/${depot.body.id}`)
    .set(authHeader(tokenFor(admin)))
    .send({ decision: 'APPROVE' });
  expect(res.status, res.text).toBe(200);
}

// Cree un parrain avec son referralCode et un filleul parraine.
async function creerParrainage({ parrainRole = 'BUYER', filleulRole = 'BUYER', parrainVerifie = false } = {}) {
  const parrain = await createUser({ role: parrainRole });
  const code = `CODE-${parrain.id}-${Date.now()}`;
  await prisma.user.update({ where: { id: parrain.id }, data: { referralCode: code } });

  const filleul = await createUser({ role: filleulRole });
  const referral = await prisma.referral.create({
    data: {
      referrerId: parrain.id,
      referredId: filleul.id,
      kind: filleulRole,
      status: 'PENDING',
    },
  });

  if (parrainVerifie) {
    await prisma.user.update({
      where: { id: parrain.id },
      data: { profileVerificationStatus: 'VERIFIED', profileVerifiedAt: new Date() },
    });
  }

  return { parrain, filleul, referral, code };
}

describe('Parrainage — eligibilite', () => {
  it('filleul verifie + parrain verifie -> ELIGIBLE avec le bon montant (BUYER)', async () => {
    const { parrain, filleul, referral } = await creerParrainage({ parrainVerifie: true });

    await verifierProfil(filleul.id);

    const maj = await prisma.referral.findUnique({ where: { id: referral.id } });
    expect(maj.status).toBe('ELIGIBLE');
    expect(maj.rewardAmount).toEqual(new Decimal(5000));
    expect(maj.eligibleAt).toBeTruthy();
  });

  it('filleul verifie + parrain verifie -> ELIGIBLE avec le bon montant (SUPPLIER)', async () => {
    const { parrain, filleul, referral } = await creerParrainage({ parrainRole: 'SUPPLIER', filleulRole: 'SUPPLIER', parrainVerifie: true });

    await verifierProfil(filleul.id);

    const maj = await prisma.referral.findUnique({ where: { id: referral.id } });
    expect(maj.status).toBe('ELIGIBLE');
    expect(maj.rewardAmount).toEqual(new Decimal(10000));
  });

  it('parrain non verifie -> reste PENDING puis passe ELIGIBLE quand il est verifie', async () => {
    const { parrain, filleul, referral } = await creerParrainage({ parrainVerifie: false });

    // Filleul verifie en premier : parrain pas encore verifie -> PENDING.
    await verifierProfil(filleul.id);
    let maj = await prisma.referral.findUnique({ where: { id: referral.id } });
    expect(maj.status).toBe('PENDING');
    expect(maj.rewardAmount).toBeNull();

    // Parrain verifie ensuite : le referral passe ELIGIBLE.
    await verifierProfil(parrain.id);
    maj = await prisma.referral.findUnique({ where: { id: referral.id } });
    expect(maj.status).toBe('ELIGIBLE');
    expect(maj.rewardAmount).toEqual(new Decimal(5000));
    expect(maj.eligibleAt).toBeTruthy();
  });

  it('montant fige meme si PlatformSetting change ensuite', async () => {
    const { parrain, filleul, referral } = await creerParrainage({ parrainVerifie: true });

    await verifierProfil(filleul.id);
    const avant = await prisma.referral.findUnique({ where: { id: referral.id } });
    expect(avant.rewardAmount).toEqual(new Decimal(5000));

    // Changement de la configuration : le montant deja fige ne bouge pas.
    await prisma.platformSetting.update({
      where: { id: 1 },
      data: { referralBuyerReward: 9999 },
    });

    const apres = await prisma.referral.findUnique({ where: { id: referral.id } });
    expect(apres.rewardAmount).toEqual(new Decimal(5000));

    // Restaure la configuration pour ne pas contaminer les autres tests.
    await prisma.platformSetting.update({
      where: { id: 1 },
      data: { referralBuyerReward: 5000 },
    });
  });
});

describe('GET /api/v2/auth/me/referral — vue parrain', () => {
  it('renvoie le code, les totaux et la liste avec le prenom seul', async () => {
    const { parrain, filleul, code } = await creerParrainage();
    await prisma.user.update({
      where: { id: parrain.id },
      data: { profileVerificationStatus: 'VERIFIED', profileVerifiedAt: new Date() },
    });
    await verifierProfil(filleul.id);

    const res = await client.get('/api/v2/auth/me/referral').set(authHeader(tokenFor(parrain)));

    expect(res.status, res.text).toBe(200);
    expect(res.body.code).toBe(code);
    expect(res.body.totals).toEqual({ pending: 0, eligible: 1, paid: 0 });
    expect(res.body.referrals).toHaveLength(1);
    expect(res.body.referrals[0]).toMatchObject({
      status: 'ELIGIBLE',
      kind: 'BUYER',
      rewardAmount: 5000,
      referredFirstname: filleul.firstname,
    });
    // Aucune donnee personnelle supplementaire (pas de nom, pas d email).
    expect(res.body.referrals[0]).not.toHaveProperty('lastname');
    expect(res.body.referrals[0]).not.toHaveProperty('email');
  });

  it('un utilisateur sans parrainage renvoie des totaux a zero', async () => {
    const user = await createUser({ role: 'BUYER' });
    const res = await client.get('/api/v2/auth/me/referral').set(authHeader(tokenFor(user)));

    expect(res.status, res.text).toBe(200);
    expect(res.body.totals).toEqual({ pending: 0, eligible: 0, paid: 0 });
    expect(res.body.referrals).toHaveLength(0);
  });
});

describe('GET /api/v2/admin/referrals — liste admin', () => {
  it('un ADMIN liste tous les parrainages avec pagination', async () => {
    const { parrain, filleul } = await creerParrainage();
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .get('/api/v2/admin/referrals')
      .set(authHeader(tokenFor(admin)));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ page: 1, limit: 20 });
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.items[0]).toHaveProperty('referrer');
    expect(res.body.items[0]).toHaveProperty('referred');
  });

  it('filtre par statut', async () => {
    const { parrain, filleul } = await creerParrainage();
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .get('/api/v2/admin/referrals?status=PENDING')
      .set(authHeader(tokenFor(admin)));

    expect(res.status, res.text).toBe(200);
    expect(res.body.items.every((r) => r.status === 'PENDING')).toBe(true);
  });

  it('refuse un AGENT (403)', async () => {
    const agent = await createUser({ role: 'AGENT' });
    const res = await client
      .get('/api/v2/admin/referrals')
      .set(authHeader(tokenFor(agent)));
    expect(res.status, res.text).toBe(403);
  });

  it('refuse un agent IA (403) — bloqué par requireMinLevel(50)', async () => {
    const user = await createUser({ role: 'AGENT' });
    await prisma.agent.create({
      data: { kind: 'AI', userId: user.id, displayName: 'IA Test' },
    });
    const res = await client
      .get('/api/v2/admin/referrals')
      .set(authHeader(tokenFor(user)));
    expect(res.status, res.text).toBe(403);
  });
});

describe('PATCH /api/v2/admin/referrals/:id/pay — paiement', () => {
  it('paiement unique : ELIGIBLE -> PAID avec reference', async () => {
    const { parrain, filleul, referral } = await creerParrainage({ parrainVerifie: true });
    await verifierProfil(filleul.id);
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch(`/api/v2/admin/referrals/${referral.id}/pay`)
      .set(authHeader(tokenFor(admin)))
      .send({ reference: 'VIR-001' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('PAID');
    expect(res.body.paidAt).toBeTruthy();
    expect(res.body.reference).toBe('VIR-001');

    // Audit ecrit dans la meme transaction.
    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'Referral', entityId: referral.id, action: 'REFERRAL_PAID' },
    });
    expect(audit).toBeTruthy();
  });

  it('double paiement refuse (409)', async () => {
    const { parrain, filleul, referral } = await creerParrainage({ parrainVerifie: true });
    await verifierProfil(filleul.id);
    const admin = await createUser({ role: 'ADMIN' });

    await client
      .patch(`/api/v2/admin/referrals/${referral.id}/pay`)
      .set(authHeader(tokenFor(admin)))
      .send({ reference: 'VIR-001' });

    const res = await client
      .patch(`/api/v2/admin/referrals/${referral.id}/pay`)
      .set(authHeader(tokenFor(admin)))
      .send({ reference: 'VIR-002' });

    expect(res.status, res.text).toBe(409);
  });

  it('paiement d un PENDING refuse (409)', async () => {
    const { parrain, filleul, referral } = await creerParrainage({ parrainVerifie: false });
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch(`/api/v2/admin/referrals/${referral.id}/pay`)
      .set(authHeader(tokenFor(admin)))
      .send({ reference: 'VIR-001' });

    expect(res.status, res.text).toBe(409);
  });

  it('exige une reference (400)', async () => {
    const { parrain, filleul, referral } = await creerParrainage({ parrainVerifie: true });
    await verifierProfil(filleul.id);
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch(`/api/v2/admin/referrals/${referral.id}/pay`)
      .set(authHeader(tokenFor(admin)))
      .send({});

    expect(res.status, res.text).toBe(400);
  });
});

describe('PATCH /api/v2/admin/referrals/:id/reject — rejet motive', () => {
  it('rejet d un PENDING avec motif', async () => {
    const { parrain, filleul, referral } = await creerParrainage();
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch(`/api/v2/admin/referrals/${referral.id}/reject`)
      .set(authHeader(tokenFor(admin)))
      .send({ reason: 'Compte suspect' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('REJECTED');
    expect(res.body.rejectionReason).toBe('Compte suspect');

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'Referral', entityId: referral.id, action: 'REFERRAL_REJECTED' },
    });
    expect(audit).toBeTruthy();
  });

  it('rejet d un ELIGIBLE avec motif', async () => {
    const { parrain, filleul, referral } = await creerParrainage({ parrainVerifie: true });
    await verifierProfil(filleul.id);
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch(`/api/v2/admin/referrals/${referral.id}/reject`)
      .set(authHeader(tokenFor(admin)))
      .send({ reason: 'Fraude detectee' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('REJECTED');
  });

  it('rejet d un PAID refuse (409)', async () => {
    const { parrain, filleul, referral } = await creerParrainage({ parrainVerifie: true });
    await verifierProfil(filleul.id);
    const admin = await createUser({ role: 'ADMIN' });

    const payRes = await client
      .patch(`/api/v2/admin/referrals/${referral.id}/pay`)
      .set(authHeader(tokenFor(admin)))
      .send({ reference: 'VIR-001' });

    expect(payRes.status, payRes.text).toBe(200);

    const res = await client
      .patch(`/api/v2/admin/referrals/${referral.id}/reject`)
      .set(authHeader(tokenFor(admin)))
      .send({ reason: 'Trop tard' });

    expect(res.status, res.text).toBe(409);
  });

  it('exige un motif (400)', async () => {
    const { parrain, filleul, referral } = await creerParrainage();
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch(`/api/v2/admin/referrals/${referral.id}/reject`)
      .set(authHeader(tokenFor(admin)))
      .send({});

    expect(res.status, res.text).toBe(400);
  });
});
