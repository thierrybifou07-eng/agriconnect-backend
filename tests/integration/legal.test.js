import { describe, it, expect, beforeEach } from 'vitest';
import { randomInt } from 'node:crypto';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { seedLegalDocuments } from '../../prisma/seed-data/legal.js';

const client = api();

// Les tables LegalDocument* ne sont pas dans BUSINESS_TABLES : elles
// persistent entre deux exécutions du fichier. On repart du seed à chaque
// test pour garantir l'isolation.
beforeEach(async () => {
  await prisma.legalDocumentVersion.deleteMany({});
  await seedLegalDocuments();
});

function tokenFor(user, role) {
  return generateToken({ id: user.id, role });
}

async function admin() {
  const user = await createUser({ role: 'ADMIN' });
  return { user, token: tokenFor(user, 'ADMIN') };
}

async function buyer() {
  const user = await createUser({ role: 'BUYER' });
  return { user, token: tokenFor(user, 'BUYER') };
}

describe('GET /api/v2/legal', () => {
  it('renvoie la liste des documents sans jeton', async () => {
    const res = await client.get('/api/v2/legal');

    expect(res.status, res.text).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(3);

    const cgu = res.body.find((d) => d.code === 'CGU');
    expect(cgu).toMatchObject({
      code: 'CGU',
      label: "Conditions générales d'utilisation",
      version: '1.0',
    });
    expect(cgu.publishedAt).toBeTruthy();
  });
});

describe('GET /api/v2/legal/:code', () => {
  it('renvoie le contenu en français par défaut', async () => {
    const res = await client.get('/api/v2/legal/CGU');

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      code: 'CGU',
      version: '1.0',
      locale: 'fr',
      title: "Conditions générales d'utilisation",
    });
    expect(res.body.content).toContain('[TEXTE PROVISOIRE');
    expect(res.body.publishedAt).toBeTruthy();
  });

  it('renvoie le contenu en anglais avec ?lang=en', async () => {
    const res = await client.get('/api/v2/legal/CGU?lang=en');

    expect(res.status, res.text).toBe(200);
    expect(res.body.locale).toBe('en');
    expect(res.body.title).toBe('Terms of Use');
  });

  it('renvoie le contenu en anglais via Accept-Language', async () => {
    const res = await client.get('/api/v2/legal/CGU').set('Accept-Language', 'en-US,en;q=0.9');

    expect(res.status, res.text).toBe(200);
    expect(res.body.locale).toBe('en');
  });

  it('repli sur fr quand la traduction en est absente', async () => {
    // Crée un document avec uniquement une traduction fr
    const doc = await prisma.legalDocument.create({
      data: {
        code: 'TEST_FALLBACK',
        label: 'Document de test',
        versions: {
          create: {
            version: '1.0',
            status: 'PUBLISHED',
            publishedAt: new Date(),
            translations: {
              create: { locale: 'fr', title: 'Titre FR', content: 'Contenu FR' },
            },
          },
        },
      },
    });

    const res = await client.get('/api/v2/legal/TEST_FALLBACK?lang=en');

    expect(res.status, res.text).toBe(200);
    expect(res.body.locale).toBe('fr');
    expect(res.body.title).toBe('Titre FR');

    // Nettoyage
    await prisma.legalDocumentVersion.deleteMany({ where: { documentId: doc.id } });
    await prisma.legalDocument.delete({ where: { id: doc.id } });
  });

  it('renvoie 404 pour un code inconnu', async () => {
    const res = await client.get('/api/v2/legal/UNKNOWN_CODE');

    expect(res.status, res.text).toBe(404);
    expect(res.body.error).toContain('introuvable');
  });

  it('renvoie 404 pour un document sans version publiée', async () => {
    const doc = await prisma.legalDocument.create({
      data: {
        code: 'TEST_NO_PUBLISHED',
        label: 'Document sans version publiée',
      },
    });

    const res = await client.get('/api/v2/legal/TEST_NO_PUBLISHED');

    expect(res.status, res.text).toBe(404);

    await prisma.legalDocument.delete({ where: { id: doc.id } });
  });
});

describe('POST /api/v2/admin/legal/:code/versions', () => {
  it('crée une version DRAFT avec traductions fr et en', async () => {
    const { token } = await admin();

    const res = await client
      .post('/api/v2/admin/legal/CGU/versions')
      .set(authHeader(token))
      .send({
        version: '2.0',
        translations: [
          { locale: 'fr', title: 'CGU v2', content: 'Contenu v2 FR' },
          { locale: 'en', title: 'CGU v2 EN', content: 'Content v2 EN' },
        ],
      });

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({
      version: '2.0',
      status: 'DRAFT',
    });
    expect(res.body.translations).toHaveLength(2);
  });

  it('refuse sans traduction fr (400)', async () => {
    const { token } = await admin();

    const res = await client
      .post('/api/v2/admin/legal/CGU/versions')
      .set(authHeader(token))
      .send({
        version: '2.1',
        translations: [{ locale: 'en', title: 'EN only', content: 'English only' }],
      });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un code inconnu (404)', async () => {
    const { token } = await admin();

    const res = await client
      .post('/api/v2/admin/legal/UNKNOWN/versions')
      .set(authHeader(token))
      .send({
        version: '1.0',
        translations: [{ locale: 'fr', title: 'Titre', content: 'Contenu' }],
      });

    expect(res.status, res.text).toBe(404);
  });

  it('refuse une version déjà existante (409)', async () => {
    const { token } = await admin();

    const res = await client
      .post('/api/v2/admin/legal/CGU/versions')
      .set(authHeader(token))
      .send({
        version: '1.0',
        translations: [{ locale: 'fr', title: 'Titre', content: 'Contenu' }],
      });

    expect(res.status, res.text).toBe(409);
  });

  it('refuse un BUYER (403)', async () => {
    const { token } = await buyer();

    const res = await client
      .post('/api/v2/admin/legal/CGU/versions')
      .set(authHeader(token))
      .send({
        version: '3.0',
        translations: [{ locale: 'fr', title: 'Titre', content: 'Contenu' }],
      });

    expect(res.status, res.text).toBe(403);
  });
});

describe('PATCH /api/v2/admin/legal/versions/:id/publish', () => {
  it('publie la version et archive la précédente', async () => {
    const { token } = await admin();

    // Crée une nouvelle version DRAFT (numéro unique pour éviter le 409)
    const versionNum = `2.${randomInt(0, 1000)}`;
    const createRes = await client
      .post('/api/v2/admin/legal/CGU/versions')
      .set(authHeader(token))
      .send({
        version: versionNum,
        translations: [{ locale: 'fr', title: 'CGU v2', content: 'Contenu v2' }],
      });
    expect(createRes.status).toBe(201);

    // La publie
    const publishRes = await client
      .patch(`/api/v2/admin/legal/versions/${createRes.body.id}/publish`)
      .set(authHeader(token));

    expect(publishRes.status, publishRes.text).toBe(200);
    expect(publishRes.body).toMatchObject({
      id: createRes.body.id,
      status: 'PUBLISHED',
    });
    expect(publishRes.body.publishedAt).toBeTruthy();

    // Vérifie que l'ancienne version 1.0 est archivée
    const oldVersion = await prisma.legalDocumentVersion.findFirst({
      where: { document: { code: 'CGU' }, version: '1.0' },
    });
    expect(oldVersion.status).toBe('ARCHIVED');
  });

  it('refuse de publier une version déjà publiée (409)', async () => {
    const { token } = await admin();

    // Récupère la version 1.0 (maintenant ARCHivée) — crée une nouvelle DRAFT
    const createRes = await client
      .post('/api/v2/admin/legal/BUYER_TERMS/versions')
      .set(authHeader(token))
      .send({
        version: '2.0',
        translations: [{ locale: 'fr', title: 'BT v2', content: 'Contenu' }],
      });

    // Première publication
    await client
      .patch(`/api/v2/admin/legal/versions/${createRes.body.id}/publish`)
      .set(authHeader(token));

    // Seconde tentative → 409
    const res = await client
      .patch(`/api/v2/admin/legal/versions/${createRes.body.id}/publish`)
      .set(authHeader(token));

    expect(res.status, res.text).toBe(409);
  });

  it('refuse un BUYER (403)', async () => {
    const { token } = await buyer();

    const res = await client
      .patch('/api/v2/admin/legal/versions/1/publish')
      .set(authHeader(token));

    expect(res.status, res.text).toBe(403);
  });
});

describe('Seed idempotent', () => {
  it('ne crée pas de doublon à deux appels consécutifs', async () => {
    await seedLegalDocuments();
    await seedLegalDocuments();

    const count = await prisma.legalDocumentVersion.count({
      where: { version: '1.0' },
    });
    expect(count).toBe(3); // 3 documents × 1 version PUBLISHED

    // Vérifie qu'il n'y a toujours qu'une version PUBLISHED par document
    const documents = await prisma.legalDocument.findMany({
      include: { versions: { where: { status: 'PUBLISHED' } } },
    });
    for (const doc of documents) {
      expect(doc.versions).toHaveLength(1);
    }
  });
});
