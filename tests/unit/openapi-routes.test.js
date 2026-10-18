import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../setup/env.js';
import openapiDocument from '../../openapi/openapi.config.js';

// Le test compare deux listes :
//  1. les routes reellement montees, extraites de src/routes (router.js donne
//     le prefixe de chaque routeur, chaque fichier donne router.METHOD('path'))
//  2. les chemins du document OpenAPI genere (openapi/openapi.config.js,
//     assemble depuis les fragments par domaine)
// Les deux ensembles doivent etre identiques : une route codee sans entree
// dans la spec (ou l'inverse) casse le test.

const ROUTES_DIR = path.join(PROJECT_ROOT, 'src', 'routes');

// Extrait les routes d'un routeur Express : router.METHOD('chemin', ...).
// router.param() n'est pas une route et ne matche pas le motif.
function extractRouterRoutes(code) {
  const found = [];
  const re = /\brouter\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    found.push(`${m[1]} ${m[2]}`);
  }
  return found;
}

// Extrait les montages de src/routes/router.js : router.use('/prefix', xRoutes)
// en liant la variable a son import (import xRoutes from './x.routes.js').
function extractMounts() {
  const code = readFileSync(path.join(ROUTES_DIR, 'router.js'), 'utf8');
  const imports = {};
  const importRe = /import\s+(\w+)Routes\s+from\s+'\.\/(.+)\.routes\.js'/g;
  let m;
  while ((m = importRe.exec(code)) !== null) {
    imports[m[1]] = m[2];
  }
  const mounts = [];
  const useRe = /router\.use\('([^']+)',\s*(\w+)Routes\)/g;
  while ((m = useRe.exec(code)) !== null) {
    mounts.push({ prefix: m[1], routerFile: imports[m[2]] });
  }
  return mounts;
}

// Prefixe + chemin de route -> chemin d'API. Le chemin racine d'un routeur
// ('/' sur /conversations) donne un chemin avec barre finale : on la retire
// pour que la comparaison avec les chemins de la spec (ecrits sans barre) tienne.
// Les paramètres :id d'Express sont ecrits {id} dans OpenAPI.
function normalizePath(prefix, routePath) {
  const joined = (prefix + routePath).replace(/\/+/g, '/');
  const trimmed = joined.length > 1 ? joined.replace(/\/$/, '') : joined;
  return trimmed.replace(/:([a-zA-Z]+)/g, '{$1}');
}

function codeRoutes() {
  const routes = [];
  for (const { prefix, routerFile } of extractMounts()) {
    const code = readFileSync(path.join(ROUTES_DIR, `${routerFile}.routes.js`), 'utf8');
    for (const r of extractRouterRoutes(code)) {
      const [method, routePath] = r.split(' ');
      routes.push(`${method} ${normalizePath(prefix, routePath)}`);
    }
  }
  return routes.sort();
}

function documentRoutes() {
  const found = [];
  for (const [pathItem, item] of Object.entries(openapiDocument.paths)) {
    for (const method of Object.keys(item)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        found.push(`${method} ${pathItem}`);
      }
    }
  }
  return found.sort();
}

// docs/openapi.yaml est l'export statique du document genere (utile aux editeurs
// qui rendent le YAML). Il n'est pas regenere par les tests : on lit donc ses
// chemins a la main (chemin a 2 espaces, methode a 4 espaces) pour verifier
// qu'ils correspondent bien au document genere.
function yamlRoutes() {
  const code = readFileSync(path.join(PROJECT_ROOT, 'docs', 'openapi.yaml'), 'utf8');
  const found = [];
  let current = null;
  for (const line of code.split(/\r?\n/)) {
    const pathMatch = line.match(/^ {2}(\/[^:]*):$/);
    if (pathMatch) {
      current = pathMatch[1];
      continue;
    }
    const methodMatch = line.match(/^ {4}(get|post|put|patch|delete):$/);
    if (methodMatch && current) {
      found.push(`${methodMatch[1]} ${current}`);
    }
  }
  return found.sort();
}

describe('Couverture OpenAPI', () => {
  it('trouve des routes dans src/routes', () => {
    // Garde-fou : si le collecteur ne marche plus, ce test passerait a vide
    // et les comparaisons ci-dessous ne verifieraient plus rien.
    expect(codeRoutes().length).toBeGreaterThan(50);
  });

  it('genere un document OpenAPI non vide', () => {
    expect(documentRoutes().length).toBeGreaterThan(50);
    expect(openapiDocument.openapi).toBe('3.0.0');
  });

  it('chaque route de src/routes figure dans le document OpenAPI', () => {
    const documented = documentRoutes();
    const missing = codeRoutes().filter((r) => !documented.includes(r));
    expect(missing).toEqual([]);
  });

  it('chaque chemin du document OpenAPI correspond a une route reelle', () => {
    const mounted = codeRoutes();
    const extra = documentRoutes().filter((r) => !mounted.includes(r));
    expect(extra).toEqual([]);
  });

  it('docs/openapi.yaml correspond au document genere', () => {
    expect(yamlRoutes()).toEqual(documentRoutes());
  });

  it('le document genere ne contient aucun residu de schema Joi', () => {
    // Un schéma Joi passé tel quel (au lieu d'etre converti par
    // openapi.helpers.js) laisse apparaitre les champs internes de Joi dans le
    // document. Ce test echoue si un fragment oublie la conversion.
    const json = JSON.stringify(openapiDocument);
    for (const marker of ['$_root', '$_terms', '$_temp', '_flags', '_rules']) {
      expect(json).not.toContain(marker);
    }
  });
});
