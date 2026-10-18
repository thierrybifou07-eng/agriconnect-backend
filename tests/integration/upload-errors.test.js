import { describe, it, expect } from 'vitest';
import { api, authHeader } from '../helpers/app.js';
import { createUser, createVerifiedUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

const client = api();

function tokenPour(user, role) {
  return generateToken({ id: user.id, role });
}

// Buffers minimaux : multer ne regarde que le mimetype déclaré, pas le contenu.
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const FAKE_PDF = Buffer.from('%PDF-1.4 factice');
// Un fichier dont la taille dépasse la limite de 8 Mo du middleware document.
const GROS_PDF = Buffer.alloc(8 * 1024 * 1024 + 1);

// Dépose un document via l'API.
function depotDocument(
  token,
  { type = 'ID_CARD', contentType = 'application/pdf', filename = 'doc.pdf', buffer = FAKE_PDF } = {}
) {
  return client
    .post('/api/v2/auth/me/documents')
    .set(authHeader(token))
    .attach('file', buffer, { filename, contentType })
    .field('type', type);
}

describe('POST /api/v2/auth/me/documents — erreurs multipart', () => {
  it('un document valide (champ file) : 201', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const res = await depotDocument(tokenPour(buyer, 'BUYER'));

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ type: 'ID_CARD', status: 'PENDING' });
  });

  it('un champ fichier inattendu (document au lieu de file) : 400 UNEXPECTED_FILE_FIELD', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const res = await client
      .post('/api/v2/auth/me/documents')
      .set(authHeader(tokenPour(buyer, 'BUYER')))
      .attach('document', FAKE_PDF, { filename: 'doc.pdf', contentType: 'application/pdf' })
      .field('type', 'ID_CARD');

    expect(res.status, res.text).toBe(400);
    expect(res.body.code).toBe('UNEXPECTED_FILE_FIELD');
    expect(res.body.expectedField).toBe('file');
    expect(res.body.error).toContain('document');
    expect(res.body.error).toContain('file');
  });

  it('deux fichiers sous le champ file : 400 UNEXPECTED_FILE_FIELD', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const res = await client
      .post('/api/v2/auth/me/documents')
      .set(authHeader(tokenPour(buyer, 'BUYER')))
      .attach('file', FAKE_PDF, { filename: 'doc1.pdf', contentType: 'application/pdf' })
      .attach('file', FAKE_PDF, { filename: 'doc2.pdf', contentType: 'application/pdf' })
      .field('type', 'ID_CARD');

    expect(res.status, res.text).toBe(400);
    expect(res.body.code).toBe('UNEXPECTED_FILE_FIELD');
    expect(res.body.expectedField).toBe('file');
  });

  it('un format non supporté (GIF) : 400 UNSUPPORTED_MEDIA_TYPE', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const res = await depotDocument(tokenPour(buyer, 'BUYER'), {
      type: 'OTHER',
      contentType: 'image/gif',
      filename: 'anim.gif',
      buffer: Buffer.from('GIF89a'),
    });

    expect(res.status, res.text).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(res.body.error).toContain('Format de fichier');
  });

  it('un fichier de plus de 8 Mo : 413 FILE_TOO_LARGE', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const res = await depotDocument(tokenPour(buyer, 'BUYER'), {
      filename: 'gros.pdf',
      buffer: GROS_PDF,
    });

    expect(res.status, res.text).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
    expect(res.body.error).toContain('8 Mo');
  });

  it('aucun fichier : 400 FILE_REQUIRED', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const res = await client
      .post('/api/v2/auth/me/documents')
      .set(authHeader(tokenPour(buyer, 'BUYER')))
      .field('type', 'ID_CARD');

    expect(res.status, res.text).toBe(400);
    expect(res.body.code).toBe('FILE_REQUIRED');
  });
});

describe('POST /api/v2/auth/me/avatar — erreurs multipart', () => {
  it('un avatar envoyé sous le champ file : 400 UNEXPECTED_FILE_FIELD', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const res = await client
      .post('/api/v2/auth/me/avatar')
      .set(authHeader(tokenPour(buyer, 'BUYER')))
      .attach('file', FAKE_JPEG, { filename: 'avatar.jpg', contentType: 'image/jpeg' });

    expect(res.status, res.text).toBe(400);
    expect(res.body.code).toBe('UNEXPECTED_FILE_FIELD');
    expect(res.body.expectedField).toBe('avatar');
    expect(res.body.error).toContain('avatar');
  });
});

describe('POST /api/v2/supplier/lots — erreurs multipart', () => {
  it('un lot avec 6 images : 400 UNEXPECTED_FILE_FIELD (maximum 5)', async () => {
    // Profil vérifié : sinon requireVerifiedProfile répond 403 avant multer et
    // le test ne porterait plus sur la limite de fichiers.
    const fournisseur = await createVerifiedUser({ role: 'SUPPLIER' });

    let requete = client.post('/api/v2/supplier/lots').set(authHeader(tokenPour(fournisseur, 'SUPPLIER')));
    for (let i = 0; i < 6; i += 1) {
      requete = requete.attach('images', FAKE_JPEG, {
        filename: `photo${i + 1}.jpg`,
        contentType: 'image/jpeg',
      });
    }
    const res = await requete;

    // Le sixième fichier arrête multer avant toute validation du corps : la
    // réponse ne dépend donc pas des champs texte de la déclaration.
    expect(res.status, res.text).toBe(400);
    expect(res.body.code).toBe('UNEXPECTED_FILE_FIELD');
    expect(res.body.expectedField).toBe('images');
    expect(res.body.error).toContain('5');
  });
});
