import { describe, it, expect } from 'vitest';
import { findOrphans, AGE_MINIMAL_MS } from '../../scripts/cleanup-orphan-uploads.js';

// findOrphans est la partie du script de nettoyage qui se décide sans base ni
// disque : elle ne fait que comparer deux listes. Ces tests la prennent seule,
// avec un « maintenant » et une taille de fichier choisis à la main.

const NOW = new Date('2026-10-18T12:00:00.000Z');
const JOUR = 24 * 60 * 60 * 1000;

const fichier = (publicId, { ageJours = 2, size = 1024 } = {}) => ({
  publicId,
  size,
  mtimeMs: NOW.getTime() - ageJours * JOUR,
});

describe('findOrphans', () => {
  it('ne retient que les fichiers absents de la base', () => {
    const fichiers = [
      fichier('LOT_PHOTO/a.jpg'),
      fichier('LOT_PHOTO/b.jpg'),
      fichier('AVATAR/c.jpg'),
    ];
    const references = new Set(['LOT_PHOTO/a.jpg']);

    const orphelins = findOrphans(fichiers, references, NOW, 0);

    expect(orphelins.map((f) => f.publicId)).toEqual(['AVATAR/c.jpg', 'LOT_PHOTO/b.jpg']);
  });

  it('renvoie les objets d\'origine (publicId, size, mtimeMs)', () => {
    const seul = fichier('ID_CARD/doc.pdf', { size: 2048 });

    const orphelins = findOrphans([seul], new Set(), NOW, 0);

    expect(orphelins).toHaveLength(1);
    expect(orphelins[0]).toBe(seul);
    expect(orphelins[0].size).toBe(2048);
    expect(orphelins[0].mtimeMs).toBe(seul.mtimeMs);
  });

  it('accepte un tableau de référence comme un Set', () => {
    const fichiers = [fichier('AVATAR/a.jpg'), fichier('AVATAR/b.jpg')];

    expect(findOrphans(fichiers, ['AVATAR/a.jpg'], NOW, 0).map((f) => f.publicId)).toEqual([
      'AVATAR/b.jpg',
    ]);
    expect(findOrphans(fichiers, new Set(['AVATAR/a.jpg']), NOW, 0)).toHaveLength(1);
  });

  it('accepte un now numérique comme un Date', () => {
    const fichiers = [fichier('AVATAR/a.jpg', { ageJours: 2 })];

    expect(findOrphans(fichiers, new Set(), NOW.getTime(), 0)).toHaveLength(1);
  });

  it('ignore les fichiers de moins de minAgeMs (upload en cours)', () => {
    const fichiers = [
      fichier('AVATAR/recent.jpg', { ageJours: 0.01 }),
      fichier('AVATAR/encours.jpg', { ageJours: 0.5 }),
      fichier('AVATAR/ancien.jpg', { ageJours: 3 }),
    ];

    const orphelins = findOrphans(fichiers, new Set(), NOW, JOUR);

    expect(orphelins.map((f) => f.publicId)).toEqual(['AVATAR/ancien.jpg']);
  });

  it('conserve un fichier de 24 h piles : la borne est inclusive', () => {
    const fichiers = [fichier('AVATAR/limite.jpg', { ageJours: 1 })];

    expect(findOrphans(fichiers, new Set(), NOW, AGE_MINIMAL_MS)).toHaveLength(1);
    expect(AGE_MINIMAL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('ignore l\'âge pour un fichier encore référencé, même très ancien', () => {
    const fichiers = [fichier('LOT_PHOTO/ancien.jpg', { ageJours: 4000 })];

    expect(findOrphans(fichiers, new Set(['LOT_PHOTO/ancien.jpg']), NOW, AGE_MINIMAL_MS)).toEqual(
      []
    );
  });

  it('trie les orphelins par publicId', () => {
    const fichiers = [
      fichier('OTHER/c.pdf'),
      fichier('AVATAR/a.jpg'),
      fichier('LOT_PHOTO/b.jpg'),
    ];

    expect(findOrphans(fichiers, new Set(), NOW, 0).map((f) => f.publicId)).toEqual([
      'AVATAR/a.jpg',
      'LOT_PHOTO/b.jpg',
      'OTHER/c.pdf',
    ]);
  });

  it('ne modifie pas la liste reçue', () => {
    const fichiers = [fichier('AVATAR/b.jpg'), fichier('AVATAR/a.jpg')];

    findOrphans(fichiers, new Set(), NOW, 0);

    expect(fichiers.map((f) => f.publicId)).toEqual(['AVATAR/b.jpg', 'AVATAR/a.jpg']);
  });

  it('renvoie une liste vide quand tout est référencé ou qu\'il n\'y a rien', () => {
    expect(findOrphans([], new Set(), NOW, 0)).toEqual([]);
    expect(findOrphans([fichier('AVATAR/a.jpg')], new Set(['AVATAR/a.jpg']), NOW, 0)).toEqual([]);
  });
});