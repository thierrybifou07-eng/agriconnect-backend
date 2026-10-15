import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../setup/env.js';

// Le test compare deux listes :
//  1. les routes reellement montees, extraites de src/routes (index.js donne
//     le prefixe de chaque routeur, chaque fichier donne router.METHOD('path'))
//  2. les chemins de docs/openapi.yaml
// Les deux ensembles doivent etre identiques : une route codee sans entree
// OpenAPI (ou l'inverse) casse le test.

const ROUTES_DIR = path.join(PROJECT_ROOT, 'src', 'routes');
const OPENAPI_FILE = path.join(PROJECT_ROOT, 'docs', 'openapi.yaml');

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

// Extrait les montages de src/routes/index.js : router.use('/prefix', xRoutes)
// en liant la variable a son import (import xRoutes from './x.routes.js').
function extractMounts() {
  const code = readFileSync(path.join(ROUTES_DIR, 'index.js'), 'utf8');
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
// pour que la comparaison avec openapi.yaml (ecrit sans barre) tienne.
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

// Parseur volontairement naif : dans docs/openapi.yaml, les chemins sont
// indentes de 2 espaces sous `paths:` et les methodes de 4 espaces sous le
// chemin. Toute autre ligne (components, descriptions) ne matche pas.
function openapiRoutes() {
  const text = readFileSync(OPENAPI_FILE, 'utf8');
  const found = [];
  let currentPath = null;
  for (const line of text.split('\n')) {
    const pathMatch = /^  (\/[^\s:]+):$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    const methodMatch = /^    (get|post|put|patch|delete):$/.exec(line);
    if (methodMatch && currentPath) {
      found.push(`${methodMatch[1]} ${currentPath}`);
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

  it('trouve des chemins dans docs/openapi.yaml', () => {
    expect(openapiRoutes().length).toBeGreaterThan(50);
  });

  it('chaque route de src/routes figure dans openapi.yaml', () => {
    const documented = openapiRoutes();
    const missing = codeRoutes().filter((r) => !documented.includes(r));
    expect(missing).toEqual([]);
  });

  it('chaque chemin de openapi.yaml correspond a une route reelle', () => {
    const mounted = codeRoutes();
    const extra = openapiRoutes().filter((r) => !mounted.includes(r));
    expect(extra).toEqual([]);
  });
});
