import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Le service lit UPLOADS_DIR au chargement : le dossier temporaire est donc
// posé AVANT l'import dynamique, et les modules sont réinitialisés pour que
// chaque charge reparte sur le bon environnement.
let tempDir;
let saveFile, deleteFile, resolvePrivateFile, publicIdFromUrl, deleteUnreferencedFiles;
let StorageKind, UPLOADS_ROOT, PUBLIC_KINDS;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'agriconnect-storage-'));
  vi.resetModules();
  vi.stubEnv('UPLOADS_DIR', tempDir);
  const storage = await import('../../src/services/storage.service.js');
  saveFile = storage.saveFile;
  deleteFile = storage.deleteFile;
  resolvePrivateFile = storage.resolvePrivateFile;
  publicIdFromUrl = storage.publicIdFromUrl;
  deleteUnreferencedFiles = storage.deleteUnreferencedFiles;
  StorageKind = storage.StorageKind;
  UPLOADS_ROOT = storage.UPLOADS_ROOT;
  PUBLIC_KINDS = storage.PUBLIC_KINDS;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true });
});

const FAKE_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

describe('UPLOADS_ROOT et constantes', () => {
  it('UPLOADS_ROOT pointe sur le dossier temporaire', () => {
    expect(UPLOADS_ROOT).toBe(tempDir);
  });

  it('PUBLIC_KINDS liste exactement les trois dossiers publics', () => {
    expect(PUBLIC_KINDS).toEqual(['AVATAR', 'LOT_PHOTO', 'LISTING_PHOTO']);
  });
});

describe('saveFile', () => {
  it('renvoie { url, publicId, isPrivate, size } pour un avatar', async () => {
    const result = await saveFile(FAKE_BUFFER, {
      kind: StorageKind.AVATAR,
      userId: 42,
      mimetype: 'image/jpeg',
    });

    expect(result.isPrivate).toBe(false);
    expect(result.size).toBe(FAKE_BUFFER.length);
    expect(result.publicId).toMatch(/^AVATAR\//);
    expect(result.url).toBe(`/uploads/${result.publicId}`);

    // Le fichier est bien écrit sur disque, dans le bon sous-dossier.
    const fileName = result.publicId.slice('AVATAR/'.length);
    const surDisque = await readFile(join(tempDir, 'AVATAR', fileName));
    expect(surDisque.equals(FAKE_BUFFER)).toBe(true);
  });

  it('déduit l\'extension du mimetype', async () => {
    const cas = [
      ['image/jpeg', '.jpg'],
      ['image/png', '.png'],
      ['image/webp', '.webp'],
      ['application/pdf', '.pdf'],
      ['application/octet-stream', '.bin'],
    ];
    for (const [mimetext, ext] of cas) {
      const { publicId } = await saveFile(FAKE_BUFFER, { kind: StorageKind.LOT_PHOTO, mimetype: mimetext });
      expect(publicId.endsWith(ext)).toBe(true);
    }
  });

  it('nomme le fichier avec date UTC, userId et rand8', async () => {
    const { publicId } = await saveFile(FAKE_BUFFER, {
      kind: StorageKind.LISTING_PHOTO,
      userId: 7,
      mimetype: 'image/png',
    });
    // {YYYYMMDD}T{HHMMSS}_{userId}_{rand8}.png
    expect(publicId).toMatch(/^LISTING_PHOTO\/\d{8}T\d{6}_7_[A-Za-z0-9_-]{8}\.png$/);
  });

  it('route un document de vérification vers son sous-dossier (isPrivate)', async () => {
    for (const documentType of ['ID_CARD', 'BUSINESS_REGISTRATION', 'FARM_PROOF', 'OTHER']) {
      const result = await saveFile(FAKE_BUFFER, {
        kind: StorageKind.VERIFICATION_DOCUMENT,
        userId: 1,
        mimetype: 'application/pdf',
        documentType,
      });
      expect(result.isPrivate).toBe(true);
      expect(result.publicId.startsWith(`${documentType}/`)).toBe(true);
    }
  });

  it('lève une erreur si documentType est absent pour VERIFICATION_DOCUMENT', async () => {
    await expect(
      saveFile(FAKE_BUFFER, { kind: StorageKind.VERIFICATION_DOCUMENT, mimetype: 'application/pdf' })
    ).rejects.toThrow(/Type de document invalide/);
  });

  it('lève une erreur si documentType est invalide pour VERIFICATION_DOCUMENT', async () => {
    await expect(
      saveFile(FAKE_BUFFER, {
        kind: StorageKind.VERIFICATION_DOCUMENT,
        mimetype: 'application/pdf',
        documentType: 'PASSEPORT',
      })
    ).rejects.toThrow(/Type de document invalide/);
  });

  it('lève une erreur pour un kind inconnu', async () => {
    await expect(saveFile(FAKE_BUFFER, { kind: 'INCONNU' })).rejects.toThrow(/Type de stockage invalide/);
  });
});

describe('deleteFile', () => {
  it('supprime un fichier existant', async () => {
    const { publicId } = await saveFile(FAKE_BUFFER, { kind: StorageKind.AVATAR, mimetype: 'image/jpeg' });
    await deleteFile(publicId);
    await expect(readFile(join(tempDir, publicId))).rejects.toThrow();
  });

  it('est idempotent : supprimer deux fois ne lève pas', async () => {
    const { publicId } = await saveFile(FAKE_BUFFER, { kind: StorageKind.AVATAR, mimetype: 'image/jpeg' });
    await deleteFile(publicId);
    await expect(deleteFile(publicId)).resolves.toBeUndefined();
  });

  it('lève pour une première suppression d\'un fichier absent', async () => {
    await expect(deleteFile('AVATAR/inexistant.jpg')).resolves.toBeUndefined();
  });

  it('refuse une tentative de traversée de répertoire', async () => {
    await expect(deleteFile('../../etc/passwd')).rejects.toThrow(/invalide/);
    await expect(deleteFile('AVATAR/../../etc/passwd')).rejects.toThrow(/invalide/);
  });

  it('refuse un chemin absolu', async () => {
    await expect(deleteFile('/etc/passwd')).rejects.toThrow(/invalide/);
  });
});

describe('resolvePrivateFile', () => {
  it('renvoie le chemin absolu d\'un fichier privé', () => {
    const abs = resolvePrivateFile('ID_CARD/20261018T142300_42_aB3xKpQm.pdf');
    expect(abs).toBe(join(tempDir, 'ID_CARD', '20261018T142300_42_aB3xKpQm.pdf'));
  });

  it('refuse un publicId dans un dossier public', () => {
    expect(() => resolvePrivateFile('AVATAR/x.jpg')).toThrow(/pas un fichier privé/);
    expect(() => resolvePrivateFile('LOT_PHOTO/x.jpg')).toThrow(/pas un fichier privé/);
    expect(() => resolvePrivateFile('LISTING_PHOTO/x.jpg')).toThrow(/pas un fichier privé/);
  });

  it('refuse un publicId qui sort de la racine', () => {
    expect(() => resolvePrivateFile('../../etc/passwd')).toThrow(/invalide/);
  });
});

describe('publicIdFromUrl', () => {
  it('extrait le publicId d\'une URL de dossier public', () => {
    expect(publicIdFromUrl('/uploads/AVATAR/x.jpg')).toBe('AVATAR/x.jpg');
    expect(publicIdFromUrl('/uploads/LOT_PHOTO/20261018T142300_42_aB3xKpQm.png')).toBe(
      'LOT_PHOTO/20261018T142300_42_aB3xKpQm.png'
    );
    expect(publicIdFromUrl('/uploads/LISTING_PHOTO/x.webp')).toBe('LISTING_PHOTO/x.webp');
  });

  it('renvoie null pour un dossier privé ou inconnu', () => {
    expect(publicIdFromUrl('/uploads/ID_CARD/x.pdf')).toBeNull();
    expect(publicIdFromUrl('/uploads/OTHER/x.pdf')).toBeNull();
    expect(publicIdFromUrl('/uploads/INCONNU/x.jpg')).toBeNull();
  });

  it('renvoie null pour toute autre URL', () => {
    expect(publicIdFromUrl('https://example.com/x.jpg')).toBeNull();
    expect(publicIdFromUrl('/api/v2/admin/files/abc')).toBeNull();
    expect(publicIdFromUrl('/uploads/')).toBeNull();
    expect(publicIdFromUrl(null)).toBeNull();
  });
});

describe('deleteUnreferencedFiles', () => {
  it('supprime le fichier quand plus aucune ligne Media ne le référence', async () => {
    const { publicId } = await saveFile(FAKE_BUFFER, { kind: StorageKind.AVATAR, mimetype: 'image/jpeg' });
    const prisma = { media: { count: vi.fn().mockResolvedValue(0) } };

    await deleteUnreferencedFiles(prisma, [publicId]);

    expect(prisma.media.count).toHaveBeenCalledWith({ where: { publicId } });
    await expect(readFile(join(tempDir, publicId))).rejects.toThrow();
  });

  it('conserve le fichier tant qu\'une ligne Media le référence', async () => {
    const { publicId } = await saveFile(FAKE_BUFFER, { kind: StorageKind.AVATAR, mimetype: 'image/jpeg' });
    const prisma = { media: { count: vi.fn().mockResolvedValue(1) } };

    await deleteUnreferencedFiles(prisma, [publicId]);

    const surDisque = await readFile(join(tempDir, publicId));
    expect(surDisque.equals(FAKE_BUFFER)).toBe(true);
  });

  it('traite chaque publicId indépendamment (copie lot → annonce)', async () => {
    const a = await saveFile(FAKE_BUFFER, { kind: StorageKind.AVATAR, mimetype: 'image/jpeg' });
    const b = await saveFile(FAKE_BUFFER, { kind: StorageKind.AVATAR, mimetype: 'image/jpeg' });
    // Deux lignes référencent le même fichier : conservé. L'autre est orphelin.
    const prisma = {
      media: {
        count: vi.fn().mockImplementation(({ where }) => (where.publicId === a.publicId ? 1 : 0)),
      },
    };

    await deleteUnreferencedFiles(prisma, [a.publicId, b.publicId]);

    await expect(readFile(join(tempDir, a.publicId))).resolves.toBeTruthy();
    await expect(readFile(join(tempDir, b.publicId))).rejects.toThrow();
  });
});
