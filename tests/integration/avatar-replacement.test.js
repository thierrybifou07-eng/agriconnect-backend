import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import prisma from '../../src/config/prisma.js';
import { UPLOADS_ROOT, saveFile, deleteFile, StorageKind } from '../../src/services/storage.service.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

// Remplacer un avatar ne suffit pas à supprimer l'ancien : la ligne Media part
// dans la transaction, mais le fichier, lui, doit disparaître du disque sans
// jamais casser la nouvelle image. Ces tests vérifient les DEUX moitiés.

const client = api();

// Buffers minimaux : multer ne regarde que le mimetype déclaré, pas le contenu.
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const FAKE_PDF = Buffer.from('%PDF-1.4 factice');

// Les tests d'intégration écrivent dans le vrai dossier uploads/ (UPLOADS_DIR
// n'est pas posé en test). Ces deux collecteurs permettent de tout effacer après
// chaque cas, pour ne pas laisser d'orphelins derrière la suite.
const publicIdsACleaner = new Set();
const idsUtilisateurs = [];

// Un avatar est nommé {horodatage}_{userId}_{rand}{ext}
// (voir buildFileName dans storage.service.js) : le suffixe identifie de façon
// fiable les fichiers d'un utilisateur, quel que soit le nombre d'avatars
// laissés par les autres suites.
async function fichiersAvatarDe(userId) {
  const noms = await readdir(join(UPLOADS_ROOT, 'AVATAR')).catch(() => []);
  return noms.filter((nom) => nom.includes(`_${userId}_`));
}

async function utilisateur() {
  const user = await createUser({ role: 'BUYER' });
  idsUtilisateurs.push(user.id);
  return { user, token: generateToken({ id: user.id, role: 'BUYER' }) };
}

function depotAvatar(token, { filename = 'avatar.jpg' } = {}) {
  return client
    .post('/api/v2/auth/me/avatar')
    .set(authHeader(token))
    .attach('avatar', FAKE_JPEG, { filename, contentType: 'image/jpeg' });
}

async function depotDocument(token) {
  return client
    .post('/api/v2/auth/me/documents')
    .set(authHeader(token))
    .attach('file', FAKE_PDF, { filename: 'doc.pdf', contentType: 'application/pdf' })
    .field('type', 'ID_CARD');
}

const mediasDuUser = (userId) => prisma.media.findMany({ where: { ownerUserId: userId } });

const existe = (publicId) => readFile(join(UPLOADS_ROOT, publicId)).then(() => true, () => false);

afterEach(async () => {
  vi.restoreAllMocks();
  for (const publicId of publicIdsACleaner) {
    await deleteFile(publicId);
  }
  publicIdsACleaner.clear();
  for (const userId of idsUtilisateurs.splice(0)) {
    for (const nom of await fichiersAvatarDe(userId)) {
      await deleteFile(`AVATAR/${nom}`);
    }
  }
});

describe('POST /api/v2/auth/me/avatar — remplacement sur disque', () => {
  it('deux uploads successifs : une seule ligne Media et un seul fichier sur disque', async () => {
    const { user, token } = await utilisateur();

    const premier = await depotAvatar(token, { filename: 'premier.jpg' });
    expect(premier.status, premier.text).toBe(201);
    const [avantLigne] = await mediasDuUser(user.id);
    expect(avantLigne.publicId).toBeTruthy();
    expect(await existe(avantLigne.publicId)).toBe(true);

    const second = await depotAvatar(token, { filename: 'second.jpg' });
    expect(second.status, second.text).toBe(201);
    expect(second.body.url).not.toBe(premier.body.url);

    // L'ancienne ligne Media a disparu avec la création de la nouvelle.
    const apres = await mediasDuUser(user.id);
    expect(apres).toHaveLength(1);
    expect(apres[0].url).toBe(second.body.url);

    // Et surtout : l'ancien fichier a disparu, le nouveau est là.
    expect(await existe(avantLigne.publicId)).toBe(false);
    expect(await existe(apres[0].publicId)).toBe(true);
    expect(await fichiersAvatarDe(user.id)).toHaveLength(1);

    // Côté HTTP : le nouveau avatar est servi, l'ancien renvoie un 404.
    expect((await client.get(second.body.url)).status).toBe(200);
    expect((await client.get(premier.body.url)).status).toBe(404);
  });

  it('un ancien avatar enregistré sans publicId est déduit de son URL et supprimé', async () => {
    const { user, token } = await utilisateur();

    // Simule un média d'avant la colonne publicId : le fichier existe, la ligne
    // ne porte qu'une URL.
    const { url: ancienUrl, publicId: ancienPublicId } = await saveFile(FAKE_JPEG, {
      kind: StorageKind.AVATAR,
      userId: user.id,
      mimetype: 'image/jpeg',
    });
    const [mediaType, mimeType] = await Promise.all([
      prisma.mediaType.findUnique({ where: { code: 'IMAGE' } }),
      prisma.mimeType.findUnique({ where: { code: 'image/jpeg' } }),
    ]);
    const ancien = await prisma.media.create({
      data: {
        ownerUserId: user.id,
        mediaTypeId: mediaType.id,
        mimeTypeId: mimeType.id,
        url: ancienUrl,
        publicId: null,
        isPrimary: true,
      },
    });
    expect(ancien.publicId).toBeNull();
    expect(await existe(ancienPublicId)).toBe(true);

    const nouveau = await depotAvatar(token);
    expect(nouveau.status, nouveau.text).toBe(201);

    const apres = await mediasDuUser(user.id);
    expect(apres).toHaveLength(1);
    expect(apres[0].id).not.toBe(ancien.id);

    // Le fichier dérivé de l'URL a bien été supprimé du disque.
    expect(await existe(ancienPublicId)).toBe(false);
    expect((await client.get(ancienUrl)).status).toBe(404);
  });

  it('si la transaction échoue : le nouveau fichier est supprimé, l’ancien avatar reste en place', async () => {
    const { user, token } = await utilisateur();

    const premier = await depotAvatar(token, { filename: 'avant.jpg' });
    expect(premier.status, premier.text).toBe(201);
    const [avantLigne] = await mediasDuUser(user.id);

    // Le middleware d'erreur journalise l'exception : on la masque pour ne pas
    // noyer la sortie du test.
    const journal = vi.spyOn(console, 'error').mockImplementation(() => {});

    // La transaction échoue à la création. Le contrôleur ne reçoit qu'un tx qui
    // ne touche à rien : rien ne doit changer en base. Le remplacement est
    // restauré dans le finally — un spy Prisma survit à vi.restoreAllMocks et
    // casserait le reset de base des tests suivants.
    const transactionReelle = prisma.$transaction;
    prisma.$transaction = async (callback) =>
      callback({
        media: {
          deleteMany: vi.fn(),
          create: vi.fn().mockRejectedValue(new Error('Échec simulé de la transaction')),
        },
      });

    let res;
    try {
      res = await depotAvatar(token, { filename: 'pendant.jpg' });
    } finally {
      prisma.$transaction = transactionReelle;
      journal.mockRestore();
    }

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Échec simulé de la transaction');

    // L'ancien avatar est intact : ligne, fichier, service HTTP.
    const apres = await mediasDuUser(user.id);
    expect(apres).toHaveLength(1);
    expect(apres[0].id).toBe(avantLigne.id);
    expect(apres[0].publicId).toBe(avantLigne.publicId);
    expect(await existe(avantLigne.publicId)).toBe(true);
    expect((await client.get(premier.body.url)).status).toBe(200);

    // Et le fichier écrit avant l'échec n'est pas resté sur le disque : c'est le
    // seul fichier du dossier pour cet utilisateur.
    const fichiers = await fichiersAvatarDe(user.id);
    expect(fichiers).toHaveLength(1);
    expect(fichiers[0]).toBe(avantLigne.publicId.split('/')[1]);
  });

  it("changer d'avatar ne supprime ni la ligne ni le fichier d'un document de vérification", async () => {
    const { user, token } = await utilisateur();

    const depot = await depotDocument(token);
    expect(depot.status, depot.text).toBe(201);
    const [mediaDoc] = await prisma.media.findMany({
      where: { ownerVerificationDocumentId: depot.body.id },
    });
    publicIdsACleaner.add(mediaDoc.publicId);

    // Deux changements d'affilée : ni la ligne ni le fichier du document ne
    // doivent bouger. Son propriétaire est le VerificationDocument, pas
    // l'utilisateur — la requête d'upload ne le voit pas.
    expect((await depotAvatar(token, { filename: 'a.jpg' })).status).toBe(201);
    expect((await depotAvatar(token, { filename: 'b.jpg' })).status).toBe(201);

    expect(await prisma.verificationDocument.findUnique({ where: { id: depot.body.id } })).toBeTruthy();
    const mediasDoc = await prisma.media.findMany({
      where: { ownerVerificationDocumentId: depot.body.id },
    });
    expect(mediasDoc).toHaveLength(1);
    expect(mediasDoc[0].id).toBe(mediaDoc.id);
    expect(await existe(mediaDoc.publicId)).toBe(true);

    // Le contrôle : l'avatar, lui, a bien été remplacé et nettoyé.
    expect(await mediasDuUser(user.id)).toHaveLength(1);
    expect(await fichiersAvatarDe(user.id)).toHaveLength(1);
  });
});