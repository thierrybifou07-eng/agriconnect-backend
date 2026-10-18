import { describe, it, expect } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

const client = api();

function tokenFor(user, role) {
  return generateToken({ id: user.id, role });
}

// Buffers minimaux portant une signature de tête valide : l'API compare les
// octets de tête au type MIME déclaré (utils/fileSignature.js).
const FAKE_PDF = Buffer.from('%PDF-1.4 factice');
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

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
    expect(media.publicId).toMatch(/^ID_CARD\//);
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

describe('GET /api/v2/admin/verifications — filtres', () => {
  const adminToken = async () => {
    const admin = await createUser({ role: 'ADMIN' });
    return tokenFor(admin, 'ADMIN');
  };

  const liste = (jeton, query) =>
    client.get(`/api/v2/admin/verifications${query}`).set(authHeader(jeton));

  it('filtre par type de document', async () => {
    const token = tokenFor(await createUser({ role: 'BUYER' }), 'BUYER');
    await depotDocument(token, { type: 'ID_CARD' });
    await depotDocument(token, { type: 'FARM_PROOF', filename: 'ferme.pdf' });
    const jetonAdmin = await adminToken();

    const res = await liste(jetonAdmin, '?type=FARM_PROOF');

    expect(res.status, res.text).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({ type: 'FARM_PROOF', status: 'PENDING' });
  });

  it('filtre par rôle du compte déposant', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const supplier = await createUser({ role: 'SUPPLIER' });
    await depotDocument(tokenFor(buyer, 'BUYER'));
    await depotDocument(tokenFor(supplier, 'SUPPLIER'), { type: 'FARM_PROOF', filename: 'registre.pdf' });
    const jetonAdmin = await adminToken();

    const res = await liste(jetonAdmin, '?role=SUPPLIER');

    expect(res.status, res.text).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].user.role.code).toBe('SUPPLIER');
  });

  it('filtre par userId', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const autre = await createUser({ role: 'BUYER' });
    await depotDocument(tokenFor(buyer, 'BUYER'));
    await depotDocument(tokenFor(autre, 'BUYER'));
    const jetonAdmin = await adminToken();

    const res = await liste(jetonAdmin, `?userId=${buyer.id}`);

    expect(res.status, res.text).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].user.id).toBe(buyer.id);
  });

  it('cumule les filtres', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    await depotDocument(tokenFor(buyer, 'BUYER'));
    await depotDocument(tokenFor(buyer, 'BUYER'), { type: 'OTHER', filename: 'autre.pdf' });
    const jetonAdmin = await adminToken();

    const res = await liste(jetonAdmin, `?status=PENDING&type=OTHER&role=BUYER&userId=${buyer.id}`);

    expect(res.status, res.text).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({ type: 'OTHER' });
    expect(res.body.items[0].user.id).toBe(buyer.id);
  });

  it('refuse un filtre hors nomenclature (400)', async () => {
    const jetonAdmin = await adminToken();

    for (const query of ['?status=APPROVED', '?type=PASSEPORT', '?role=ADMIN', '?limit=0', '?limit=101', '?limit=abc', '?userId=0']) {
      const res = await liste(jetonAdmin, query);
      expect(res.status, `${query} devrait être refusé (recu ${res.text})`).toBe(400);
      expect(res.body.error).toBe('Données invalides');
    }
  });

  it('borne la pagination et reste exacte', async () => {
    const token = tokenFor(await createUser({ role: 'BUYER' }), 'BUYER');
    for (let i = 0; i < 3; i++) {
      await depotDocument(token, { filename: `doc${i}.pdf` });
    }
    const jetonAdmin = await adminToken();

    const res = await liste(jetonAdmin, '?status=PENDING&limit=2&page=2');

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(res.body.items).toHaveLength(1);
  });
});

describe('GET /api/v2/admin/verifications — ordre FIFO sur la file', () => {
  it('sort la demande la plus ancienne en premier (status=PENDING)', async () => {
    const token = tokenFor(await createUser({ role: 'BUYER' }), 'BUYER');
    const anciens = [];
    for (let i = 0; i < 3; i++) {
      const res = await depotDocument(token, { filename: `doc${i}.pdf` });
      anciens.push(res.body.id);
    }
    // Dates explicites et distinctes : le tri repose sur createdAt, pas sur
    // l'ordre d'insertion supposé.
    const base = new Date('2026-01-01T10:00:00Z').getTime();
    for (let i = 0; i < anciens.length; i++) {
      await prisma.verificationDocument.update({
        where: { id: anciens[i] },
        data: { createdAt: new Date(base + i * 60_000) },
      });
    }
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .get('/api/v2/admin/verifications?status=PENDING')
      .set(authHeader(tokenFor(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.items.map((d) => d.id)).toEqual(anciens);
  });

  it('trie du plus récent au plus ancien hors file d attente (status=VERIFIED)', async () => {
    const token = tokenFor(await createUser({ role: 'BUYER' }), 'BUYER');
    const docs = [];
    for (let i = 0; i < 2; i++) {
      const res = await depotDocument(token, { filename: `doc${i}.pdf` });
      docs.push(res.body.id);
    }
    const admin = await createUser({ role: 'ADMIN' });
    for (let i = 0; i < docs.length; i++) {
      await prisma.verificationDocument.update({
        where: { id: docs[i] },
        data: { status: 'VERIFIED', createdAt: new Date(new Date('2026-01-01T10:00:00Z').getTime() + i * 60_000) },
      });
    }

    const res = await client
      .get('/api/v2/admin/verifications?status=VERIFIED')
      .set(authHeader(tokenFor(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.items.map((d) => d.id)).toEqual([...docs].reverse());
  });
});

describe('GET /api/v2/admin/verifications — contenu de la liste', () => {
  it('expose le statut du profil et les caractéristiques du fichier, jamais une URL', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenFor(buyer, 'BUYER'));
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .get('/api/v2/admin/verifications?status=PENDING')
      .set(authHeader(tokenFor(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(200);
    const item = res.body.items[0];
    expect(item.id).toBe(depot.body.id);
    // Le relecteur voit où en est le COMPTE, pas seulement le document.
    expect(item.user.profileVerificationStatus).toBe('PENDING');
    // Assez pour juger de la pièce (format, poids), pas pour la lire.
    expect(item.media).toMatchObject({ mimeType: 'application/pdf' });
    expect(item.media.fileSize).toBeGreaterThan(0);

    // Aucune URL ni publicId, à aucun niveau de la réponse.
    expect(JSON.stringify(res.body)).not.toContain('/uploads/');
    const cles = [];
    (function parcourir(valeur) {
      if (Array.isArray(valeur)) valeur.forEach(parcourir);
      else if (valeur && typeof valeur === 'object') {
        for (const [cle, sous] of Object.entries(valeur)) {
          cles.push(cle);
          parcourir(sous);
        }
      }
    })(res.body);
    expect(cles).not.toContain('url');
    expect(cles).not.toContain('publicId');
  });

  it('renvoie media null pour un document sans pièce jointe', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    await prisma.verificationDocument.create({ data: { userId: buyer.id, type: 'OTHER' } });
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .get('/api/v2/admin/verifications?status=PENDING')
      .set(authHeader(tokenFor(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(200);
    expect(res.body.items[0].media).toBeNull();
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
    expect(res.body.media.url).toMatch(/^\/api\/v2\/admin\/files\//);

    // Vérifie que le token d'accès permet de récupérer le document privé streamé
    const fileRes = await client
      .get(res.body.media.url)
      .set(authHeader(tokenFor(admin, 'ADMIN')));
    expect(fileRes.status).toBe(200);

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
    expect(res.body.error).toBe('Ce document a déjà été examiné');
  });

  it('répond 404 sur un document inconnu', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch('/api/v2/admin/verifications/999999')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ decision: 'APPROVE' });

    expect(res.status, res.text).toBe(404);
  });

  // La course : deux relecteurs cliquent en même temps sur le même dossier.
  // Lire le statut puis écrire sans condition laissait les deux passer ; une
  // seule écriture conditionnelle peut aboutir.
  it('deux décisions simultanées : un 200 et un 409', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenFor(buyer, 'BUYER'));
    const docId = depot.body.id;
    const premier = await createUser({ role: 'ADMIN' });
    const second = await createUser({ role: 'ADMIN' });

    const [a, b] = await Promise.all([
      client
        .patch(`/api/v2/admin/verifications/${docId}`)
        .set(authHeader(tokenFor(premier, 'ADMIN')))
        .send({ decision: 'APPROVE' }),
      client
        .patch(`/api/v2/admin/verifications/${docId}`)
        .set(authHeader(tokenFor(second, 'ADMIN')))
        .send({ decision: 'REJECT', note: 'Pièce non conforme' }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const perdant = a.status === 409 ? a : b;
    expect(perdant.body.error).toBe('Ce document a déjà été examiné');

    // Une seule décision écrite en base, et un seul audit : le perdant n'a rien
    // laissé derrière lui.
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'VerificationDocument', entityId: docId },
    });
    expect(audits).toHaveLength(1);

    const doc = await prisma.verificationDocument.findUnique({ where: { id: docId } });
    const gagnant = a.status === 200 ? premier : second;
    expect(doc.reviewedById).toBe(gagnant.id);
    expect(doc.status === 'VERIFIED').toBe(a.status === 200);
  });

  it('un AGENT sans USER_VERIFICATION ne décide pas (403)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenFor(buyer, 'BUYER'));
    const agent = await createUser({ role: 'AGENT' }); // aucune fiche agent

    const res = await client
      .patch(`/api/v2/admin/verifications/${depot.body.id}`)
      .set(authHeader(tokenFor(agent, 'AGENT')))
      .send({ decision: 'APPROVE' });

    expect(res.status, res.text).toBe(403);
    const doc = await prisma.verificationDocument.findUnique({ where: { id: depot.body.id } });
    expect(doc.status).toBe('PENDING');
  });

  it('un AGENT avec USER_VERIFICATION décide (200)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenFor(buyer, 'BUYER'));
    const agent = await agentAvecVerification();

    const res = await client
      .patch(`/api/v2/admin/verifications/${depot.body.id}`)
      .set(authHeader(tokenFor(agent, 'AGENT')))
      .send({ decision: 'APPROVE' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('VERIFIED');
  });

  // Le message de décision part après le commit et n'est pas attendu : le
  // SMTP est neutralisé en test (SMTP_DISABLED), la décision doit donc aboutir
  // exactement comme si aucun serveur de messagerie n'existait.
  it('la décision aboutit même sans messagerie (non bloquant)', async () => {
    expect(process.env.SMTP_DISABLED).toBe('1');

    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenFor(buyer, 'BUYER'));
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch(`/api/v2/admin/verifications/${depot.body.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ decision: 'REJECT', note: 'Document illisible' });

    expect(res.status, res.text).toBe(200);
    const user = await prisma.user.findUnique({ where: { id: buyer.id } });
    expect(user.profileVerificationStatus).toBe('REJECTED');
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
