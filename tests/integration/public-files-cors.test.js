import { describe, it, expect, afterEach } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { deleteFile, publicIdFromUrl } from '../../src/services/storage.service.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

// helmet pose Cross-Origin-Resource-Policy: same-origin sur TOUTES les réponses.
// C'est la bonne valeur pour une API, mais une image servie par /uploads et
// affichée dans une page d'une autre origine se voit refuser par le navigateur :
// l'avatar et les photos de lots apparaissent cassés dans le front web.
//
// app.js rouvre donc la lecture sur /uploads seul. Ces deux moitiés sont
// verrouillées ensemble : un en-tête cross-origin sur toute l'API vaudrait fuite
// inter-origines, et un oubli sur /uploads vaudrait images cassées.

const client = api();

const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const FAKE_PDF = Buffer.from('%PDF-1.4 factice');

// Les tests d'intégration écrivent dans le vrai dossier uploads/ : on efface
// ce qu'on a déposé, comme le fait avatar-replacement.test.js.
const publicIdsACleaner = new Set();

afterEach(async () => {
  for (const publicId of publicIdsACleaner) {
    await deleteFile(publicId);
  }
  publicIdsACleaner.clear();
});

async function utilisateur() {
  const user = await createUser({ role: 'BUYER' });
  return { user, token: generateToken({ id: user.id, role: 'BUYER' }) };
}

async function deposeAvatar(token) {
  const res = await client
    .post('/api/v2/auth/me/avatar')
    .set(authHeader(token))
    .attach('avatar', FAKE_JPEG, { filename: 'avatar.jpg', contentType: 'image/jpeg' });
  expect(res.status, res.text).toBe(201);
  // La reponse est un DTO d'affichage (URL, position, principale) : le publicId
  // se relit dans l'URL, comme le fait le reste du projet.
  publicIdsACleaner.add(publicIdFromUrl(res.body.url));
  return res.body;
}

async function deposeDocument(token) {
  const res = await client
    .post('/api/v2/auth/me/documents')
    .set(authHeader(token))
    .attach('file', FAKE_PDF, { filename: 'doc.pdf', contentType: 'application/pdf' })
    .field('type', 'ID_CARD');
  expect(res.status, res.text).toBe(201);
  // Aucune URL dans la reponse, par construction : seul le staff obtient un lien
  // signe. Le chemin du disque se lit donc en base.
  const media = await prisma.media.findFirst({
    where: { ownerVerificationDocumentId: res.body.id },
  });
  publicIdsACleaner.add(media.publicId);
  return media;
}

describe('En-têtes des fichiers servis sous /uploads', () => {
  it('autorise la lecture cross-origin d un fichier public', async () => {
    const { token } = await utilisateur();
    const avatar = await deposeAvatar(token);

    const res = await client.get(avatar.url);

    expect(res.status).toBe(200);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  // La correction est ciblée : helmet n'a pas été relâché, seul /uploads l'est.
  it('laisse la protection par defaut de helmet partout ailleurs', async () => {
    const res = await client.get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });
});

describe('Les fichiers privés restent hors de /uploads', () => {
  // Ouvrir la lecture cross-origin ne doit pas ouvrir la lecture tout court :
  // un document de vérification est un papier d'identité. Son accès passe par
  // GET /api/v2/admin/files/:token, jamais par son chemin sur le disque.
  it('ne sert pas un document de verification sous /uploads', async () => {
    const { token } = await utilisateur();
    const media = await deposeDocument(token);

    // Le nom reel du fichier, connu de l'API : c'est bien lui qu'on demande.
    const res = await client.get(`/uploads/${media.publicId}`);

    expect(res.status).toBe(404);
  });

  it('ne sert rien du tout dans un dossier prive', async () => {
    const { token } = await utilisateur();
    const media = await deposeDocument(token);

    // Le nom reel du fichier, demande directement dans le dossier prive.
    const [, nom] = media.publicId.split('/');
    const res = await client.get(`/uploads/ID_CARD/${nom}`);

    expect(res.status).toBe(404);
  });
});
