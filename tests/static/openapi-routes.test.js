import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const routesDirectory = join(root, 'src', 'routes');
const routerSource = readFileSync(join(routesDirectory, 'router.js'), 'utf8');

function mountedRouteFiles() {
  const imports = new Map();
  for (const [, variable, file] of routerSource.matchAll(
    /import\s+(\w+)\s+from\s+['"]\.\/([^'"]+\.routes\.js)['"]/g,
  )) {
    imports.set(variable, file);
  }

  const mounts = new Map();
  for (const [, prefix, variable] of routerSource.matchAll(
    /router\s*\.\s*use\s*\(\s*['"]([^'"]*)['"]\s*,\s*(\w+)\s*\)/g,
  )) {
    const file = imports.get(variable);
    if (file) mounts.set(file, prefix);
  }
  return mounts;
}

function normalizePath(path) {
  const withParams = path.replace(/:([^/]+)/g, '{$1}');
  return `/${withParams.split('/').filter(Boolean).join('/')}`;
}

function actualRoutes() {
  const routes = new Set();
  const mounts = mountedRouteFiles();

  for (const [file, prefix] of mounts) {
    const source = readFileSync(join(routesDirectory, file), 'utf8');
    for (const [, method, path] of source.matchAll(
      /router\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"]([^'"]*)['"]/gi,
    )) {
      routes.add(`${method.toLowerCase()} ${normalizePath(`${prefix}/${path}`)}`);
    }
  }
  return routes;
}

function documentedRoutes() {
  const spec = parse(readFileSync(join(root, 'docs', 'openapi.yaml'), 'utf8'));
  const routes = new Set();
  for (const [path, operations] of Object.entries(spec.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      if (operations[method]) routes.add(`${method} ${path}`);
    }
  }
  return routes;
}

describe('Contrat routes ↔ OpenAPI', () => {
  it('documente chaque route montée et ne documente aucune route absente', () => {
    const actual = actualRoutes();
    const documented = documentedRoutes();
    const missingFromSpec = [...actual].filter((route) => !documented.has(route)).sort();
    const missingFromCode = [...documented].filter((route) => !actual.has(route)).sort();

    expect({ missingFromSpec, missingFromCode }).toEqual({
      missingFromSpec: [],
      missingFromCode: [],
    });
  });
});
