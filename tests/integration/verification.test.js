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

function tokenFor(user, role) {
  return generateToken({ id: user.id, role });
}

// Buffers minimaux : multer ne regarde que le mimetype déclaré, pas le contenu.
const FAKE_PDF = Buffer.from('%PDF-1.4 factice');
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

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

// Dépose un document via l'API.
async function depotDocument(
  token,
  { type = 'ID_CARD', contentType = 'application/pdf', filename = 'doc.pdf', buffer = FAKE_PDF } = {}
) {
  return client
    .post('/api/v2/auth/me/documents')
    .set(authHeader(token))
    .attach('file', buffer, { filename, contentType })
    .field('type', type);
}

// Crée un compte AGENT avec sa fiche et les capacités demandées.
async function agentAvecVerification(capabilities = ['USER_VERIFICATION']) {
  const user = await createUser({ role: 'AGENT' });
  const agent = await prisma.agent.create({
    data: { kind: 'HUMAN', userId: user.id, displayName: 'Agent Test' },
  });
  const rows = await prisma.agentCapability.findMany({
    where: { code: { in: capabilities } },
    select: { id: true },
  });
  await prisma.agentCapabilityLink.createMany({
    data: rows.map((row) => ({ agentId: agent.id, capabilityId: row.id })),
  });
  return user;
}

describe('POST /api/v2/auth/me/documents — dépôt de document', () => {
  it('un SUPPLIER dépose un document : PENDING, Media privé, profil PENDING', async () => {
    const supplier = await createUser({ role: 'SUPPLIER' });
    const token = tokenFor(supplier, 'SUPPLIER');

    const res = await depotDocument(token);

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ type: 'ID_CARD', status: 'PENDING' });
    expect(res.body.id).toBeGreaterThan(0);
    // Aucune URL dans la réponse : le fichier est privé.
    expect(res.body).not.toHaveProperty('url');

    // Media privé avec publicId, mimeType résolu (DOCUMENT pour un PDF).
    const media = await prisma.media.findFirst({
      where: { ownerVerificationDocumentId: res.body.id },
      include: { mimeType: true, mediaType: true },
    });
    expect(media).toBeTruthy();
    expect(media.isPrivate).toBe(true);
    expect(media.publicId).toBe('doc_test_123');
    expect(media.mimeType.code).toBe('application/pdf');
    expect(media.mediaType.code).toBe('DOCUMENT');

    // UNVERIFIED -> PENDING.
    const user = await prisma.user.findUnique({ where: { id: supplier.id } });
    expect(user.profileVerificationStatus).toBe('PENDING');
  });

  it('un BUYER dépose une image : mediaType IMAGE', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const token = tokenFor(buyer, 'BUYER');

    const res = await depotDocument(token, {
      type: 'FARM_PROOF',
      contentType: 'image/jpeg',
      filename: 'photo.jpg',
      buffer: FAKE_JPEG,
    });

    expect(res.status, res.text).toBe(201);
    const media = await prisma.media.findFirst({
      where: { ownerVerificationDocumentId: res.body.id },
      include: { mimeType: true, mediaType: true },
    });
    expect(media.mimeType.code).toBe('image/jpeg');
    expect(media.mediaType.code).toBe('IMAGE');
  });

  it('refuse un mime non supporté (400)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const token = tokenFor(buyer, 'BUYER');

    const res = await depotDocument(token, {
      type: 'OTHER',
      contentType: 'image/gif',
      filename: 'anim.gif',
      buffer: Buffer.from('GIF89a'),
    });

    expect(res.status, res.text).toBe(400);
    expect(res.body.error).toContain('Format de fichier');
  });

  it('refuse un type de document inconnu (400)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const token = tokenFor(buyer, 'BUYER');

    const res = await depotDocument(token, { type: 'PASSEPORT' });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un dépôt sans fichier (400)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const token = tokenFor(buyer, 'BUYER');

    const res = await client
      .post('/api/v2/auth/me/documents')
      .set(authHeader(token))
      .field('type', 'ID_CARD');

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un ADMIN (403)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const token = tokenFor(admin, 'ADMIN');

    const res = await depotDocument(token);

    expect(res.status, res.text).toBe(403);
  });

  it('un compte REJECTED qui redépose repasse en PENDING', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    await prisma.user.update({ where: { id: buyer.id }, data: { profileVerificationStatus: 'REJECTED' } });
    const token = tokenFor(buyer, 'BUYER');

    const res = await depotDocument(token);

    expect(res.status, res.text).toBe(201);
    const user = await prisma.user.findUnique({ where: { id: buyer.id } });
    expect(user.profileVerificationStatus).toBe('PENDING');
  });
});

describe('GET /api/v2/auth/me/documents — liste sans URL', () => {
  it('liste les documents du connecté, sans aucune URL', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const token = tokenFor(buyer, 'BUYER');
    await depotDocument(token);
    await depotDocument(token, { type: 'OTHER', filename: 'doc2.pdf' });

    const res = await client.get('/api/v2/auth/me/documents').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toHaveLength(2);
    for (const doc of res.body) {
      // Exactement les 5 champs attendus, rien d'autre (surtout pas d'URL).
      expect(Object.keys(doc).sort()).toEqual(['createdAt', 'id', 'note', 'status', 'type']);
      expect(doc).not.toHaveProperty('url');
      expect(doc).not.toHaveProperty('media');
    }
  });

  it('ne liste pas les documents des autres', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const autre = await createUser({ role: 'BUYER' });
    await depotDocument(tokenFor(buyer, 'BUYER'));

    const res = await client.get('/api/v2/auth/me/documents').set(authHeader(tokenFor(autre, 'BUYER')));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

describe('GET /api/v2/admin/verifications — liste paginée', () => {
  it('un ADMIN liste les documents PENDING', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    await depotDocument(tokenFor(buyer, 'BUYER'));
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .get('/api/v2/admin/verifications?status=PENDING')
      .set(authHeader(tokenFor(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ page: 1, limit: 20, total: 1 });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ type: 'ID_CARD', status: 'PENDING' });
    expect(res.body.items[0]).not.toHaveProperty('url');
  });

  it('un AGENT avec USER_VERIFICATION liste aussi', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    await depotDocument(tokenFor(buyer, 'BUYER'));
    const agent = await agentAvecVerification();

    const res = await client
      .get('/api/v2/admin/verifications')
      .set(authHeader(tokenFor(agent, 'AGENT')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it('refuse un AGENT sans USER_VERIFICATION (403)', async () => {
    const agent = await createUser({ role: 'AGENT' });
    // Pas de fiche agent : requireCapability refuse.

    const res = await client
      .get('/api/v2/admin/verifications')
      .set(authHeader(tokenFor(agent, 'AGENT')));

    expect(res.status, res.text).toBe(403);
  });

  it('refuse un BUYER (403)', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const res = await client
      .get('/api/v2/admin/verifications')
      .set(authHeader(tokenFor(buyer, 'BUYER')));

    expect(res.status, res.text).toBe(403);
  });
});

describe('GET /api/v2/admin/verifications/:id — détail + URL signée', () => {
  it('un ADMIN voit l URL signée, un BUYER non', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenFor(buyer, 'BUYER'));
    const docId = depot.body.id;
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .get(`/api/v2/admin/verifications/${docId}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.media).toBeTruthy();
    expect(res.body.media.url).toContain('public_id=doc_test_123');
    expect(res.body.media.url).toContain('expires_at=');
    // private_download_url appelé avec le bon public_id, le bon format et
    // une expiration de 10 minutes.
    expect(privateDownloadUrl).toHaveBeenCalledWith(
      'doc_test_123',
      'pdf',
      expect.objectContaining({ type: 'authenticated', expires_at: expect.any(Number) })
    );

    // Un BUYER ne peut pas voir le détail.
    const resBuyer = await client
      .get(`/api/v2/admin/verifications/${docId}`)
      .set(authHeader(tokenFor(buyer, 'BUYER')));
    expect(resBuyer.status, resBuyer.text).toBe(403);
  });

  it('répond 404 pour un document inconnu', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .get('/api/v2/admin/verifications/999999')
      .set(authHeader(tokenFor(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(404);
  });
});

describe('PATCH /api/v2/admin/verifications/:id — décision', () => {
  it('APPROVE : document VERIFIED, utilisateur VERIFIED (profileVerifiedAt, profileVerifiedById)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenFor(buyer, 'BUYER'));
    const docId = depot.body.id;
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch(`/api/v2/admin/verifications/${docId}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ decision: 'APPROVE' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('VERIFIED');

    const user = await prisma.user.findUnique({ where: { id: buyer.id } });
    expect(user.profileVerificationStatus).toBe('VERIFIED');
    expect(user.profileVerifiedAt).toBeTruthy();
    expect(user.profileVerifiedById).toBe(admin.id);

    // Audit écrit dans la même transaction.
    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'VerificationDocument', entityId: docId },
    });
    expect(audit).toBeTruthy();
    expect(audit.action).toBe('PROFILE_DOCUMENT_APPROVED');
  });

  it('REJECT sans document VERIFIED : utilisateur REJECTED', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenFor(buyer, 'BUYER'));
    const docId = depot.body.id;
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch(`/api/v2/admin/verifications/${docId}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ decision: 'REJECT', note: 'Document illisible' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('REJECTED');
    expect(res.body.note).toBe('Document illisible');

    const user = await prisma.user.findUnique({ where: { id: buyer.id } });
    expect(user.profileVerificationStatus).toBe('REJECTED');
  });

  it('exige une note pour REJECT (400)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenFor(buyer, 'BUYER'));
    const docId = depot.body.id;
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch(`/api/v2/admin/verifications/${docId}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ decision: 'REJECT' });

    expect(res.status, res.text).toBe(400);
  });

  it('APPROVE avec un autre PENDING : utilisateur reste en attente', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot1 = await depotDocument(tokenFor(buyer, 'BUYER'));
    await depotDocument(tokenFor(buyer, 'BUYER'), { type: 'OTHER', filename: 'doc2.pdf' });
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch(`/api/v2/admin/verifications/${depot1.body.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ decision: 'APPROVE' });

    expect(res.status, res.text).toBe(200);
    const user = await prisma.user.findUnique({ where: { id: buyer.id } });
    // Un autre document PENDING : le profil ne passe pas à VERIFIED.
    expect(user.profileVerificationStatus).toBe('PENDING');
  });

  it('refuse une décision invalide (400)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenFor(buyer, 'BUYER'));
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch(`/api/v2/admin/verifications/${depot.body.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ decision: 'MAYBE' });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un second examen (409)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenFor(buyer, 'BUYER'));
    const docId = depot.body.id;
    const admin = await createUser({ role: 'ADMIN' });

    await client
      .patch(`/api/v2/admin/verifications/${docId}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ decision: 'APPROVE' });

    const res = await client
      .patch(`/api/v2/admin/verifications/${docId}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ decision: 'REJECT', note: 'Trop tard' });

    expect(res.status, res.text).toBe(409);
  });
});

describe('Avatar et documents de vérification', () => {
  it('changer d avatar ne supprime pas les documents de vérification', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const token = tokenFor(buyer, 'BUYER');
    const depot = await depotDocument(token);
    const docId = depot.body.id;

    // Change d'avatar.
    const avatar = await client
      .post('/api/v2/auth/me/avatar')
      .set(authHeader(token))
      .attach('avatar', FAKE_JPEG, { filename: 'avatar.jpg', contentType: 'image/jpeg' });
    expect(avatar.status, avatar.text).toBe(201);

    // Le document existe toujours, avec sa ligne Media.
    const doc = await prisma.verificationDocument.findUnique({ where: { id: docId } });
    expect(doc).toBeTruthy();
    const media = await prisma.media.findMany({ where: { ownerVerificationDocumentId: docId } });
    expect(media).toHaveLength(1);
    expect(media[0].isPrivate).toBe(true);
  });
});
