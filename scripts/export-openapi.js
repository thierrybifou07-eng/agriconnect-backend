import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import openapiDocument from '../openapi/openapi.config.js';

// Écrit docs/openapi.yaml à partir du document assemblé par
// openapi/openapi.config.js (les fragments du dossier openapi/, fusionnés par
// openapi-merge).
//
// Ce YAML est un EXPORT : il ne s'édite pas à la main. Toute modification doit
// passer par le document généré, puis par `npm run docs:openapi`. Sans cela, le
// fichier dérive de la spec en silence ; le test unitaire
// tests/unit/openapi-routes.test.js compare les deux et le signale.
//
//   node scripts/export-openapi.js          (ou : npm run docs:openapi)
//
// Utilisé aussi comme bibliothèque par le test : celui-ci compare le YAML parsé
// au document généré et n'écrit rien.

// lineWidth 0 : aucune coupure de ligne dans les scalaires (les descriptions
// longues restent sur une ligne, comme dans le document lisible).
// indentSeq false : les séquences restent au niveau de leur clé.
// singleQuote : apostrophes simples dès qu'un échappement est nécessaire.
export const YAML_OPTIONS = { lineWidth: 0, indentSeq: false, singleQuote: true };

const RACINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OPENAPI_YAML_PATH = path.join(RACINE, 'docs', 'openapi.yaml');

/**
 * Sérialise le document OpenAPI généré.
 * @returns {string} le contenu YAML
 */
export function renderOpenapiYaml() {
  return YAML.stringify(openapiDocument, YAML_OPTIONS);
}

/**
 * Écrit docs/openapi.yaml.
 * @param {string} [cible] chemin de destination (surchargé par les tests)
 * @returns {string} le contenu écrit
 */
export function exportOpenapiYaml(cible = OPENAPI_YAML_PATH) {
  const contenu = renderOpenapiYaml();
  writeFileSync(cible, contenu, 'utf8');
  return contenu;
}

// Exécution directe : node scripts/export-openapi.js
const estExecutionDirecte =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (estExecutionDirecte) {
  exportOpenapiYaml();
  console.log(`docs/openapi.yaml régénéré depuis openapi/openapi.config.js.`);
}
