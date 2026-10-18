import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { FILE_TOKEN_AUDIENCE, FILE_TOKEN_PURPOSE } from '../../src/utils/fileToken.js';

// Accès aux documents de vérification : lien à durée courte, lié au membre du
// staff qui l'a obtenu, et journalisé.

const client = api();

const tokenPour = (user, role) => generateToken({ id: user.id, role });

// Fichiers minimaux : seule la signature de tête compte.
const PDF = Buffer.from('%PDF-1.4 factice');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEXTE = Buffer.from('Ceci est un fichier texte, pas une image.');

// SECRET_FILE_TOKEN n'est pas défini en test : le repli hors production s'
// applique. On lit donc la même règle que le module pour fabriquer un jeton.
const secretFichier = () => process.env.SECRET_FILE_TOKEN ?? process.env.JWT_SECRET;

async function depotDocument(token, options = {}) {
  const {
    type = 'ID_CARD',
    contentType = 'application/pdf',
    filename = 'doc.pdf',
    buffer = PDF,
  } = options;
  return client
    .post('/api/v2/auth/me/documents')
    .set(authHeader(token))
    .attach('file', buffer, { filename, contentType })
    .field('type', type);
}

// Dépôt + récupération du lien signé par le staff.
async function lienSigne(documentId, staffToken) {
  const res = await client.get(`/api/v2/admin/verifications/${documentId}`).set(authHeader(staffToken));
  expect(res.status, res.text).toBe(200);
  return res.body.media.url;
}

describe('GET /api/v2/admin/verifications/:id — jeton de fichier', () => {
  it('le jeton ne contient aucun chemin disque, seulement un identifiant de Media', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenPour(buyer, 'BUYER'));
    const admin = await createUser({ role: 'ADMIN' });

    const url = await lienSigne(depot.body.id, tokenPour(admin, 'ADMIN'));
    const charge = jwt.verify(url.split('/').pop(), secretFichier());

    expect(charge.mediaId).toBeGreaterThan(0);
    expect(charge.sub).toBe(String(admin.id));
    expect(charge.purpose).toBe(FILE_TOKEN_PURPOSE);
    expect(charge.aud).toBe(FILE_TOKEN_AUDIENCE);
    // Aucun segment de chemin dans la charge utile.
    for (const valeur of Object.values(charge)) {
      expect(typeof valeur === 'string' ? valeur : JSON.stringify(valeur)).not.toContain('/');
    }
    expect(charge.filePath).toBeUndefined();
  });

  it('trace la consultation dans le journal d’audit', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenPour(buyer, 'BUYER'));
    const admin = await createUser({ role: 'ADMIN' });

    await lienSigne(depot.body.id, tokenPour(admin, 'ADMIN'));

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'VerificationDocument', entityId: depot.body.id },
    });
    expect(audit).toBeTruthy();
    expect(audit.action).toBe('PROFILE_DOCUMENT_VIEWED');
    expect(audit.actorUserId).toBe(admin.id);
    expect(audit.metadata.userId).toBe(buyer.id);
  });
});

describe('GET /api/v2/admin/files/:token — accès au fichier privé', () => {
  it('sert le document au membre du staff qui a reçu le lien', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenPour(buyer, 'BUYER'));
    const admin = await createUser({ role: 'ADMIN' });
    const token = tokenPour(admin, 'ADMIN');

    const fileRes = await client.get(await lienSigne(depot.body.id, token)).set(authHeader(token));

    expect(fileRes.status).toBe(200);
  });

  it('refuse le lien d’un autre membre du staff (403)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenPour(buyer, 'BUYER'));
    const admin = await createUser({ role: 'ADMIN' });
    const autreAdmin = await createUser({ role: 'ADMIN' });

    const url = await lienSigne(depot.body.id, tokenPour(admin, 'ADMIN'));
    const fileRes = await client.get(url).set(authHeader(tokenPour(autreAdmin, 'ADMIN')));

    expect(fileRes.status).toBe(403);
  });

  it('refuse un jeton expiré (401)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenPour(buyer, 'BUYER'));
    const media = await prisma.media.findFirst({ where: { ownerVerificationDocumentId: depot.body.id } });
    const admin = await createUser({ role: 'ADMIN' });

    const expire = jwt.sign(
      { purpose: FILE_TOKEN_PURPOSE, mediaId: media.id, sub: String(admin.id) },
      secretFichier(),
      { audience: FILE_TOKEN_AUDIENCE, expiresIn: '-1s' }
    );
    const fileRes = await client
      .get(`/api/v2/admin/files/${expire}`)
      .set(authHeader(tokenPour(admin, 'ADMIN')));

    expect(fileRes.status).toBe(401);
  });

  it('refuse un jeton d’accès normal utilisé comme jeton de fichier (401)', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const fileRes = await client
      .get(`/api/v2/admin/files/${tokenPour(admin, 'ADMIN')}`)
      .set(authHeader(tokenPour(admin, 'ADMIN')));

    expect(fileRes.status).toBe(401);
  });

  it('refuse un Media qui n’est pas privé (404)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    // Un avatar public : le jeton est valide et appartient au bon compte, le
    // Media n'est simplement pas privé.
    const mediaTypeId = (await prisma.mediaType.findUnique({ where: { code: 'IMAGE' } })).id;
    const mimeTypeId = (await prisma.mimeType.findUnique({ where: { code: 'image/png' } })).id;
    const media = await prisma.media.create({
      data: {
        ownerUserId: admin.id,
        mediaTypeId,
        mimeTypeId,
        url: '/uploads/AVATAR/test.png',
        publicId: 'AVATAR/test.png',
        isPrivate: false,
      },
    });

    const tokenFichier = jwt.sign(
      { purpose: FILE_TOKEN_PURPOSE, mediaId: media.id, sub: String(admin.id) },
      secretFichier(),
      { audience: FILE_TOKEN_AUDIENCE, expiresIn: '10m' }
    );
    const fileRes = await client
      .get(`/api/v2/admin/files/${tokenFichier}`)
      .set(authHeader(tokenPour(admin, 'ADMIN')));

    expect(fileRes.status).toBe(404);
  });

  it('répond no-store, nosniff et un nom de fichier neutre', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const depot = await depotDocument(tokenPour(buyer, 'BUYER'));
    const admin = await createUser({ role: 'ADMIN' });
    const token = tokenPour(admin, 'ADMIN');

    const fileRes = await client.get(await lienSigne(depot.body.id, token)).set(authHeader(token));

    expect(fileRes.status).toBe(200);
    expect(fileRes.headers['cache-control']).toContain('private');
    expect(fileRes.headers['cache-control']).toContain('no-store');
    expect(fileRes.headers['x-content-type-options']).toBe('nosniff');
    // Le nom d'origine du document déposé ('doc.pdf') ne doit pas fuiter.
    expect(fileRes.headers['content-disposition']).toBe('inline; filename="document.pdf"');
  });
});

describe('POST /api/v2/auth/me/documents — plafond et contenu', () => {
  it('refuse un sixième document en attente (409 TOO_MANY_PENDING_DOCUMENTS)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const token = tokenPour(buyer, 'BUYER');

    for (let i = 0; i < 5; i++) {
      const res = await depotDocument(token, { filename: `doc${i + 1}.pdf` });
      expect(res.status, res.text).toBe(201);
    }

    const res = await depotDocument(token, { filename: 'doc6.pdf' });

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('TOO_MANY_PENDING_DOCUMENTS');
    expect(res.body.error).toMatch(/en attente/i);
    // Aucun document supplémentaire n'a été écrit.
    expect(await prisma.verificationDocument.count({ where: { userId: buyer.id } })).toBe(5);
  });

  it('accepte de nouveau un dépôt une fois un document examiné', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const token = tokenPour(buyer, 'BUYER');
    const admin = await createUser({ role: 'ADMIN' });

    const ids = [];
    for (let i = 0; i < 5; i++) {
      const res = await depotDocument(token, { filename: `doc${i + 1}.pdf` });
      ids.push(res.body.id);
    }
    expect((await depotDocument(token, { filename: 'doc6.pdf' })).status).toBe(409);

    // Un document sort de la file : la place libérée est immédiatement
    // disponible.
    await client
      .patch(`/api/v2/admin/verifications/${ids[0]}`)
      .set(authHeader(tokenPour(admin, 'ADMIN')))
      .send({ decision: 'APPROVE' });

    const res = await depotDocument(token, { filename: 'doc7.pdf' });
    expect(res.status, res.text).toBe(201);
  });

  it('refuse un .txt renommé en .png (400 FILE_CONTENT_MISMATCH)', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const token = tokenPour(buyer, 'BUYER');

    const res = await depotDocument(token, {
      type: 'OTHER',
      contentType: 'image/png',
      filename: 'piece.png',
      buffer: TEXTE,
    });

    expect(res.status, res.text).toBe(400);
    expect(res.body.code).toBe('FILE_CONTENT_MISMATCH');
    // Rien n'a été écrit, ni en base ni sur le disque.
    expect(await prisma.verificationDocument.count({ where: { userId: buyer.id } })).toBe(0);
  });

  it('accepte un PNG et un PDF dont la signature est conforme', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const token = tokenPour(buyer, 'BUYER');

    const image = await depotDocument(token, {
      type: 'FARM_PROOF',
      contentType: 'image/png',
      filename: 'preuve.png',
      buffer: PNG,
    });
    expect(image.status, image.text).toBe(201);

    const pdf = await depotDocument(token, { filename: 'carte.pdf', buffer: PDF });
    expect(pdf.status, pdf.text).toBe(201);
  });
});

describe('Contrôle du contenu sur les autres envois', () => {
  it('refuse un avatar dont le contenu ne correspond pas au type déclaré', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const res = await client
      .post('/api/v2/auth/me/avatar')
      .set(authHeader(tokenPour(buyer, 'BUYER')))
      .attach('avatar', TEXTE, { filename: 'avatar.png', contentType: 'image/png' });

    expect(res.status, res.text).toBe(400);
    expect(res.body.code).toBe('FILE_CONTENT_MISMATCH');
    expect(await prisma.media.count({ where: { ownerUserId: buyer.id } })).toBe(0);
  });
});