import prisma from '../config/prisma.js';

// Cache mémoire simple pour les tables de référence (rôles, statuts, catégories...).
// Ces valeurs changent très rarement : un cache en mémoire de process évite une
// requête DB à chaque écriture qui doit résoudre un "code" en id.
const cache = new Map();

export async function getLookupId(model, code) {
  const key = `${model}:${code}`;
  if (cache.has(key)) return cache.get(key);

  const row = await prisma[model].findUnique({ where: { code } });
  if (!row) {
    throw Object.assign(new Error(`Valeur de référence introuvable : ${model}.${code}`), { statusCode: 500 });
  }

  cache.set(key, row.id);
  return row.id;
}

export function clearLookupCache() {
  cache.clear();
}
