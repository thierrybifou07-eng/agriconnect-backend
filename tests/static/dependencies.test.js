import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { PROJECT_ROOT } from '../setup/env.js';

const SRC = path.join(PROJECT_ROOT, 'src');

function listJsFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? listJsFiles(full) : full.endsWith('.js') ? [full] : [];
  });
}

// Regle le plus large possible : tout ce qui ressemble a un paquet externe,
// c'est-a-dire un specifiant qui ne commence ni par "." ni par "/" et qui n'est
// pas un builtin Node. Sans ce filtre, "path" ou "url" seraient analyses comme
// des dependances a installer.
const BUILTIN = new Set(builtinModules);
function isExternal(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  if (specifier.startsWith('node:')) return false;
  if (BUILTIN.has(specifier)) return false;
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  return !BUILTIN.has(name);
}

function collectImports() {
  const found = new Map();
  for (const file of listJsFiles(SRC)) {
    const code = readFileSync(file, 'utf8');
    const specifiers = [
      ...code.matchAll(/(?:^|\s)(?:import|export)[^'"`]*?from\s*['"]([^'"]+)['"]/g),
      ...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);

    for (const specifier of specifiers) {
      if (!isExternal(specifier)) continue;
      const name = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      if (!found.has(name)) found.set(name, path.relative(PROJECT_ROOT, file));
    }
  }
  return found;
}

describe('Classification des dependances', () => {
  const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const imported = collectImports();

  it('trouve des imports externes dans src/', () => {
    // Garde-fou : si le collecteur ne marche plus, ce test passerait a vide
    // et le suivant ne testerait plus rien.
    expect(imported.size).toBeGreaterThan(5);
  });

  // B3 : ESM resout tout le graphe d'imports au chargement. Un paquet importe
  // par du code de production mais declare en devDependency fait echouer le
  // demarrage d'un deploiement "npm ci --omit=dev".
  it('declare en dependencies tout paquet utilise par le code de production', () => {
    const misclassified = [...imported.entries()]
      .filter(([name]) => !pkg.dependencies[name])
      .map(([name, file]) => `${name} (importe par ${file})`);

    expect(
      misclassified,
      `Paquets importes par src/ mais absents de "dependencies" :\n  ${misclassified.join('\n  ')}`
    ).toEqual([]);
  });

  // "dotenv" n'apparait dans aucun import nommé : il est chargé par son effet de
  // bord (import 'dotenv/config'). Ce genre de paquet est legitime à avoir sans
  // usage direct, on l'ignore donc de ce controle.
  it('ne laisse pas de dependance declaree et jamais importee', () => {
    const sideEffectOnly = new Set(['dotenv']);
    const orphans = Object.keys(pkg.dependencies)
      .filter((name) => !imported.has(name))
      .filter((name) => !sideEffectOnly.has(name));

    expect(orphans, `Dependances declarees mais jamais importees : ${orphans.join(', ')}`).toEqual([]);
  });
});
