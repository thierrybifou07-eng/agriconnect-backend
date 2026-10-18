import { describe, it, expect } from 'vitest';
import { assertFileSignature } from '../../src/utils/fileSignature.js';

// Fichiers minimaux : seuls les octets de tête sont contrôlés, le corps peut
// être arbitraire.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
// "RIFF" + quatre octets de taille + "WEBP".
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const PDF = Buffer.from('%PDF-1.7 factice');
const TEXTE = Buffer.from('Bonjour, ceci est un fichier texte.');

describe('assertFileSignature — fichiers conformes', () => {
  it('accepte un JPEG, un PNG, un WEBP et un PDF', () => {
    expect(() => assertFileSignature(JPEG, 'image/jpeg')).not.toThrow();
    expect(() => assertFileSignature(PNG, 'image/png')).not.toThrow();
    expect(() => assertFileSignature(WEBP, 'image/webp')).not.toThrow();
    expect(() => assertFileSignature(PDF, 'application/pdf')).not.toThrow();
  });
});

describe('assertFileSignature — écarts', () => {
  // Le contrôle qui compte : un fichier texte renommé en image passe le filtre
  // MIME du middleware (qui ne lit que l'en-tête Content-Type).
  it('refuse un texte déclaré JPEG, PNG, WEBP ou PDF (400 FILE_CONTENT_MISMATCH)', () => {
    for (const mimetype of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
      expect(() => assertFileSignature(TEXTE, mimetype)).toThrowError(
        expect.objectContaining({ statusCode: 400, code: 'FILE_CONTENT_MISMATCH' })
      );
    }
  });

  it('refuse un PDF déclaré comme une image, et l’inverse', () => {
    expect(() => assertFileSignature(PDF, 'image/png')).toThrow();
    expect(() => assertFileSignature(JPEG, 'application/pdf')).toThrow();
  });

  it('refuse un PNG tronqué : la signature fait huit octets', () => {
    const tronque = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(() => assertFileSignature(tronque, 'image/png')).toThrowError(
      expect.objectContaining({ code: 'FILE_CONTENT_MISMATCH' })
    );
  });

  it('refuse un WEBP dont le second marqueur n’est pas WEBP', () => {
    const riffWave = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
    expect(() => assertFileSignature(riffWave, 'image/webp')).toThrowError(
      expect.objectContaining({ code: 'FILE_CONTENT_MISMATCH' })
    );
  });

  it('refuse un type sans signature connue et un buffer absent', () => {
    expect(() => assertFileSignature(PDF, 'image/gif')).toThrowError(
      expect.objectContaining({ statusCode: 400, code: 'FILE_CONTENT_MISMATCH' })
    );
    expect(() => assertFileSignature(undefined, 'image/png')).toThrowError(
      expect.objectContaining({ code: 'FILE_CONTENT_MISMATCH' })
    );
  });

  it('porte un message en français', () => {
    expect(() => assertFileSignature(TEXTE, 'image/png')).toThrow(/ne correspond pas au type déclaré/);
  });
});