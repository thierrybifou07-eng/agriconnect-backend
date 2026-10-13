import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../setup/env.js';
import { BUSINESS_TABLES, REFERENCE_TABLES } from '../helpers/db.js';

// Garde-fou statique sur les listes de nettoyage de tests/helpers/db.js.
//
// Une table du schéma oubliée des deux listes n'est jamais vidée : ses lignes
// survivent d'un test à l'autre et contaminent les suivants (doublons sur les
// index uniques, listes paginées gonflées). Une table listée mais absente du
// schéma fait échouer un DELETE sur une table inexistante. Les deux fautes sont
// silencieuses à la lecture : seul ce test les nomme.
const SCHEMA = path.join(PROJECT_ROOT, 'prisma', 'schema.prisma');

// Les modèles du schéma : lignes `model Nom {`. Les enums (`enum Nom {`)
// ne matchent pas et ne sont pas des tables.
function schemaModels() {
  const code = readFileSync(SCHEMA, 'utf8');
  return [...code.matchAll(/^model\s+([A-Za-z_]\w*)\s*\{/gm)].map((m) => m[1]);
}

describe('Tables du schéma vs listes de nettoyage', () => {
  const models = schemaModels();
  const business = new Set(BUSINESS_TABLES);
  const reference = new Set(REFERENCE_TABLES);

  it('trouve bien les modèles du schéma', () => {
    // Garde-fou : si le parsing du schéma loupait, les deux tests ci-dessous
    // passeraient à vide sur une liste vide.
    expect(models.length).toBeGreaterThan(40);
  });

  it('attribue chaque modèle à exactement une des deux listes', () => {
    // business.has(m) === reference.has(m) est vrai dans les deux cas
    // fautifs : le modèle figure dans les deux listes, ou dans aucune.
    const fautifs = models.filter((m) => business.has(m) === reference.has(m));

    expect(fautifs, `Modèles dans zéro ou deux listes : ${fautifs.join(', ')}`).toEqual([]);
  });

  it('n invente aucune table absente du schéma', () => {
    const inconnues = [...BUSINESS_TABLES, ...REFERENCE_TABLES].filter((t) => !models.includes(t));

    expect(inconnues, `Tables listées mais absentes du schéma : ${inconnues.join(', ')}`).toEqual([]);
  });
});
