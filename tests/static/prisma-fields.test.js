import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { PROJECT_ROOT } from '../setup/env.js';

// Garde-fou statique contre le defaut B1.
//
// Les controleurs selectionnaient `fullName` sur le modele User, colonne qui
// n'existe pas. Prisma leve alors une PrismaClientValidationError et l'API
// repond 500 : c'est une erreur d'execution, invisible a la lecture, et elle a
// rendu cinq endpoints inutilisables.
//
// Plutot que de recopier la liste des colonnes autorisees (qui deriveraien
// elle-meme du schema), on interroge le DMMF genere par Prisma, c'est-a-dire
// la vraie definition du modele. Toute cle de `select` ou `include` inconnue
// du schema est donc signalee, sans liste a maintenir a la main.

// L'analyse porte sur src/controllers/ : c'est la que vivent les requetes
// Prisma. D'autres fichiers utilisent aussi la forme `cle: true` pour des
// reglages qui nont rien a voir avec la base (standardHeaders du limiteur de
// debit, par exemple), et les distinguer demanderait un vrai parseur JS.
const SRC = path.join(PROJECT_ROOT, 'src', 'controllers');

function listJsFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? listJsFiles(full) : full.endsWith('.js') ? [full] : [];
  });
}

// Toutes les cles `... : true` des select/include Prisma. On tolere les
// commentaires de fin de ligne et on ne retient que des noms de champs.
const SELECT_KEY = /^\s*([A-Za-z_]\w*)\s*:\s*true\s*,?\s*(\/\/.*)?$/;

function collectSelectKeys(file) {
  const code = readFileSync(file, 'utf8');
  const found = new Map();
  const lines = code.split(/\r?\n/);

  lines.forEach((line, i) => {
    const match = SELECT_KEY.exec(line);
    if (!match) return;
    const key = match[1];
    found.set(key, `${path.relative(PROJECT_ROOT, file)}:${i + 1}`);
  });

  return found;
}

describe('Champs Prisma utilises dans les controleurs', () => {
  const known = new Set();
  for (const model of Prisma.dmmf.datamodel.models) {
    for (const field of model.fields) known.add(field.name);
  }

  const used = new Map();
  for (const file of listJsFiles(SRC)) {
    for (const [key, where] of collectSelectKeys(file)) {
      if (!used.has(key)) used.set(key, where);
    }
  }

  it('le DMMF expose bien les modeles du projet', () => {
    // Garde-fou : si l'acces au DMMF cassait, le test suivant ne testerait
    // plus rien et passerait a vide.
    expect(known.size).toBeGreaterThan(50);
  });

  it('ne selectionne que des champs declares dans le schema', () => {
    const unknown = [...used.entries()]
      .filter(([key]) => !known.has(key))
      .map(([key, where]) => `${key} (${where})`);

    expect(
      unknown,
      `Champs selectionnes mais absents du schema Prisma :\n  ${unknown.join('\n  ')}`
    ).toEqual([]);
  });

  // Controle cible, pour que la regression soit explicite dans l'historique
  // plutot que de disparaitre dans le test general ci-dessus.
  it('ne mentionne plus fullName dans les select Prisma', () => {
    expect(used.has('fullName')).toBe(false);
  });
});