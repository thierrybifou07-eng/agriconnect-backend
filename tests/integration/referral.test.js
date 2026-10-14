import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

// --- Mock Cloudinary ---
// upload_stream : objet avec end() qui déclenche le callback, comme le vrai SDK.
// private_download_url : URL factice avec expires_at.
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

function tokenFor(userId, roleCode) {
  return generateToken({ id: userId, role: roleCode });
}

// Buffers minimaux : multer ne regarde que le mimetype déclaré, pas le contenu.
const FAKE_PDF = Buffer.from('%PDF-1.4 factice');

// Le setup global (tests/setup/hooks.js) vide la base avant chaque test ; ici on
// configure seulement les mocks Cloudinary.
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

// Restaure les récompenses de parrainage avant chaque test : le test "montant figé"
// les modifie, et l'ordre d'exécution des tests n'est pas déterministe.
beforeEach(async () => {
  await prisma.platformSetting.update({
    where: { id: 1 },
    data: { referralBuyerReward: 5000, referralSupplierReward: 10000 },
  });
});

// Dépose un document via l'API.
async function depotDocument(token) {
  return client
    .post('/api/v2/auth/me/documents')
    .set(authHeader(token))
    .attach('file', FAKE_PDF, { filename: 'doc.pdf', contentType: 'application/pdf' })
    .field('type', 'ID_CARD');
}

// Crée un compte ADMIN.
async function createAdmin() {
  const admin = await createUser({ role: 'ADMIN' });
  return admin;
}

// Fait approuver le profil d'un utilisateur par un admin (P1.6).
async function approuverProfil(adminToken, user) {
  // Recharge l'utilisateur avec son rôle (createUser ne l'inclut pas).
  const full = await prisma.user.findUnique({ where: { id: user.id }, include: { role: true } });
  const depot = await depotDocument(tokenFor(full.id, full.role.code));
  const docId = depot.body.id;

  const res = await client
    .patch(`/api/v2/admin/verifications/${docId}`)
    .set(authHeader(adminToken))
    .send({ decision: 'APPROVE' });

  expect(res.status, res.text).toBe(200);
  return docId;
}

// Crée un parrainage direct en base (sans passer par l'inscription).
async function creerReferral(referrerId, referredId, kind = 'BUYER') {
  return prisma.referral.create({
    data: { referrerId, referredId, kind, status: 'PENDING' },
  });
}

describe('Parrainage — onProfileVerified : ELIGIBLE quand les deux sont vérifiés', () => {
  it('filleul vérifié + parrain vérifié -> ELIGIBLE avec le bon montant (BUYER)', async () => {
    const referrer = await createUser({ role: 'BUYER' });
    const referred = await createUser({ role: 'BUYER' });
    await creerReferral(referrer.id, referred.id, 'BUYER');

    const admin = await createAdmin();

    // Le parrain est vérifié d'abord.
    await approuverProfil(tokenFor(admin.id, 'ADMIN'), referrer);

    // Le filleul est vérifié ensuite : le parrainage doit passer à ELIGIBLE.
    await approuverProfil(tokenFor(admin.id, 'ADMIN'), referred);

    const referral = await prisma.referral.findFirst({
      where: { referrerId: referrer.id, referredId: referred.id },
    });
    expect(referral.status).toBe('ELIGIBLE');
    expect(referral.rewardAmount).toBeTruthy();
    expect(Number(referral.rewardAmount)).toBe(5000); // referralBuyerReward par défaut
    expect(referral.eligibleAt).toBeTruthy();
  });

  it('filleul vérifié + parrain vérifié -> ELIGIBLE avec le bon montant (SUPPLIER)', async () => {
    const referrer = await createUser({ role: 'SUPPLIER' });
    const referred = await createUser({ role: 'SUPPLIER' });
    await creerReferral(referrer.id, referred.id, 'SUPPLIER');

    const admin = await createAdmin();

    // Le parrain est vérifié d'abord.
    await approuverProfil(tokenFor(admin.id, 'ADMIN'), referrer);

    // Le filleul est vérifié ensuite : le parrainage doit passer à ELIGIBLE.
    await approuverProfil(tokenFor(admin.id, 'ADMIN'), referred);

    const referral = await prisma.referral.findFirst({
      where: { referrerId: referrer.id, referredId: referred.id },
    });
    expect(referral.status).toBe('ELIGIBLE');
    expect(referral.rewardAmount).toBeTruthy();
    expect(Number(referral.rewardAmount)).toBe(10000); // referralSupplierReward par défaut
    expect(referral.eligibleAt).toBeTruthy();
  });

  it('parrain non vérifié -> reste PENDING puis passe ELIGIBLE quand il est vérifié', async () => {
    const referrer = await createUser({ role: 'BUYER' });
    const referred = await createUser({ role: 'BUYER' });
    await creerReferral(referrer.id, referred.id, 'BUYER');

    const admin = await createAdmin();

    // Le filleul est vérifié, mais le parrain ne l'est pas encore : PENDING.
    await approuverProfil(tokenFor(admin.id, 'ADMIN'), referred);

    let referral = await prisma.referral.findFirst({
      where: { referrerId: referrer.id, referredId: referred.id },
    });
    expect(referral.status).toBe('PENDING');
    expect(referral.rewardAmount).toBeNull();
    expect(referral.eligibleAt).toBeNull();

    // Le parrain est vérifié : le parrainage doit passer à ELIGIBLE.
    await approuverProfil(tokenFor(admin.id, 'ADMIN'), referrer);

    referral = await prisma.referral.findFirst({
      where: { referrerId: referrer.id, referredId: referred.id },
    });
    expect(referral.status).toBe('ELIGIBLE');
    expect(referral.rewardAmount).toBeTruthy();
    expect(Number(referral.rewardAmount)).toBe(5000);
    expect(referral.eligibleAt).toBeTruthy();
  });
});

describe('Parrainage — paiement unique', () => {
  it('paiement unique (double paiement 409)', async () => {
    const referrer = await createUser({ role: 'BUYER' });
    const referred = await createUser({ role: 'BUYER' });
    await creerReferral(referrer.id, referred.id, 'BUYER');

    const admin = await createAdmin();

    // Vérifie les deux pour que le parrainage passe à ELIGIBLE.
    await approuverProfil(tokenFor(admin.id, 'ADMIN'), referrer);
    await approuverProfil(tokenFor(admin.id, 'ADMIN'), referred);

    const referral = await prisma.referral.findFirst({
      where: { referrerId: referrer.id, referredId: referred.id },
    });
    expect(referral.status).toBe('ELIGIBLE');

    // Premier paiement : OK.
    const res1 = await client
      .patch(`/api/v2/admin/referrals/${referral.id}/pay`)
      .set(authHeader(tokenFor(admin.id, 'ADMIN')))
      .send({ reference: 'PAY-001' });
    expect(res1.status, res1.text).toBe(200);
    expect(res1.body.status).toBe('PAID');

    // Second paiement : 409.
    const res2 = await client
      .patch(`/api/v2/admin/referrals/${referral.id}/pay`)
      .set(authHeader(tokenFor(admin.id, 'ADMIN')))
      .send({ reference: 'PAY-002' });
    expect(res2.status, res2.text).toBe(409);
  });
});

describe('Parrainage — rejet motivé', () => {
  it('rejet motivé (PENDING -> REJECTED)', async () => {
    const referrer = await createUser({ role: 'BUYER' });
    const referred = await createUser({ role: 'BUYER' });
    const referral = await creerReferral(referrer.id, referred.id, 'BUYER');

    const admin = await createAdmin();

    const res = await client
      .patch(`/api/v2/admin/referrals/${referral.id}/reject`)
      .set(authHeader(tokenFor(admin.id, 'ADMIN')))
      .send({ reason: 'Compte suspect' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('REJECTED');
    expect(res.body.rejectionReason).toBe('Compte suspect');
  });

  it('rejet motivé (ELIGIBLE -> REJECTED)', async () => {
    const referrer = await createUser({ role: 'BUYER' });
    const referred = await createUser({ role: 'BUYER' });
    await creerReferral(referrer.id, referred.id, 'BUYER');

    const admin = await createAdmin();

    // Vérifie les deux pour que le parrainage passe à ELIGIBLE.
    await approuverProfil(tokenFor(admin.id, 'ADMIN'), referrer);
    await approuverProfil(tokenFor(admin.id, 'ADMIN'), referred);

    const referral = await prisma.referral.findFirst({
      where: { referrerId: referrer.id, referredId: referred.id },
    });
    expect(referral.status).toBe('ELIGIBLE');

    const res = await client
      .patch(`/api/v2/admin/referrals/${referral.id}/reject`)
      .set(authHeader(tokenFor(admin.id, 'ADMIN')))
      .send({ reason: 'Fraude détectée' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('REJECTED');
    expect(res.body.rejectionReason).toBe('Fraude détectée');
  });

  it('rejet sans motif -> 400', async () => {
    const referrer = await createUser({ role: 'BUYER' });
    const referred = await createUser({ role: 'BUYER' });
    const referral = await creerReferral(referrer.id, referred.id, 'BUYER');

    const admin = await createAdmin();

    const res = await client
      .patch(`/api/v2/admin/referrals/${referral.id}/reject`)
      .set(authHeader(tokenFor(admin.id, 'ADMIN')))
      .send({});

    expect(res.status, res.text).toBe(400);
  });

  it('rejet d\'un parrainage PAID -> 409', async () => {
    const referrer = await createUser({ role: 'BUYER' });
    const referred = await createUser({ role: 'BUYER' });
    await creerReferral(referrer.id, referred.id, 'BUYER');

    const admin = await createAdmin();

    // Vérifie les deux pour que le parrainage passe à ELIGIBLE.
    await approuverProfil(tokenFor(admin.id, 'ADMIN'), referrer);
    await approuverProfil(tokenFor(admin.id, 'ADMIN'), referred);

    const referral = await prisma.referral.findFirst({
      where: { referrerId: referrer.id, referredId: referred.id },
    });

    // Paie d'abord.
    await client
      .patch(`/api/v2/admin/referrals/${referral.id}/pay`)
      .set(authHeader(tokenFor(admin.id, 'ADMIN')))
      .send({ reference: 'PAY-001' });

    // Rejet ensuite : 409.
    const res = await client
      .patch(`/api/v2/admin/referrals/${referral.id}/reject`)
      .set(authHeader(tokenFor(admin.id, 'ADMIN')))
      .send({ reason: 'Trop tard' });

    expect(res.status, res.text).toBe(409);
  });
});

describe('Parrainage — montant figé', () => {
  it('montant figé même si PlatformSetting change ensuite', async () => {
    const referrer = await createUser({ role: 'BUYER' });
    const referred = await createUser({ role: 'BUYER' });
    await creerReferral(referrer.id, referred.id, 'BUYER');

    const admin = await createAdmin();

    // Vérifie les deux pour que le parrainage passe à ELIGIBLE.
    await approuverProfil(tokenFor(admin.id, 'ADMIN'), referrer);
    await approuverProfil(tokenFor(admin.id, 'ADMIN'), referred);

    let referral = await prisma.referral.findFirst({
      where: { referrerId: referrer.id, referredId: referred.id },
    });
    expect(referral.status).toBe('ELIGIBLE');
    const montantInitial = Number(referral.rewardAmount);

    // Modifie les récompenses dans PlatformSetting.
    await prisma.platformSetting.update({
      where: { id: 1 },
      data: { referralBuyerReward: 99999 },
    });

    // Le montant du parrainage ne doit pas changer.
    referral = await prisma.referral.findFirst({
      where: { referrerId: referrer.id, referredId: referred.id },
    });
    expect(Number(referral.rewardAmount)).toBe(montantInitial);

    // Note : pas besoin de restaurer manuellement, le beforeEach du fichier
    // restaure les récompenses avant chaque test.
  });
});

describe('GET /api/v2/auth/me/referral — parrainage utilisateur', () => {
  it('renvoie le code, les totaux et la liste des filleuls', async () => {
    const referrer = await createUser({ role: 'BUYER', referralCode: 'REF12345' });
    const referred1 = await createUser({ role: 'BUYER' });
    const referred2 = await createUser({ role: 'BUYER' });

    await creerReferral(referrer.id, referred1.id, 'BUYER');
    await creerReferral(referrer.id, referred2.id, 'BUYER');

    const res = await client.get('/api/v2/auth/me/referral').set(authHeader(tokenFor(referrer.id, 'BUYER')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.code).toBeTruthy();
    expect(res.body.totals).toEqual({ pending: 2, eligible: 0, paid: 0 });
    expect(res.body.referrals).toHaveLength(2);

    // Le parrain ne voit que le prénom du filleul.
    const r0 = res.body.referrals[0];
    expect(r0).toHaveProperty('referredFirstname');
    expect(r0).not.toHaveProperty('referredLastname');
    expect(r0).not.toHaveProperty('referredEmail');
    expect(r0).not.toHaveProperty('referredId');
  });

  it('un utilisateur sans parrainage renvoie des totaux à zéro', async () => {
    const user = await createUser({ role: 'BUYER' });

    const res = await client.get('/api/v2/auth/me/referral').set(authHeader(tokenFor(user.id, 'BUYER')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.totals).toEqual({ pending: 0, eligible: 0, paid: 0 });
    expect(res.body.referrals).toHaveLength(0);
  });
});

describe('GET /api/v2/admin/referrals — liste admin', () => {
  it('liste tous les parrainages', async () => {
    const referrer = await createUser({ role: 'BUYER' });
    const referred = await createUser({ role: 'BUYER' });
    await creerReferral(referrer.id, referred.id, 'BUYER');

    const admin = await createAdmin();

    const res = await client.get('/api/v2/admin/referrals').set(authHeader(tokenFor(admin.id, 'ADMIN')));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toHaveProperty('referrer');
    expect(res.body[0]).toHaveProperty('referred');
    expect(res.body[0]).toHaveProperty('status');
  });

  it('filtre par statut', async () => {
    const referrer = await createUser({ role: 'BUYER' });
    const referred = await createUser({ role: 'BUYER' });
    await creerReferral(referrer.id, referred.id, 'BUYER');

    const admin = await createAdmin();

    const res = await client
      .get('/api/v2/admin/referrals?status=PENDING')
      .set(authHeader(tokenFor(admin.id, 'ADMIN')));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe('PENDING');
  });

  it('refuse un BUYER (403)', async () => {
    const user = await createUser({ role: 'BUYER' });

    const res = await client.get('/api/v2/admin/referrals').set(authHeader(tokenFor(user.id, 'BUYER')));

    expect(res.status, res.text).toBe(403);
  });
});
