// Parcourt un corps de réponse JSON de façon récursive et échoue si une
// clé interdite est trouvée. Utilisé par tous les modules acheteur pour
// garantir qu'aucune donnée interne (lot, fournisseur, prix convenu,
// adresse de retrait, identité) ne fuite dans les réponses publiques.
export function assertNoLeak(body, forbiddenKeys) {
  const forbidden = new Set(forbiddenKeys);

  function walk(value, path = '') {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, val] of Object.entries(value)) {
        if (forbidden.has(key)) {
          const location = path ? `${path}.${key}` : key;
          throw new Error(`Fuite de données : clé interdite "${location}" trouvée dans la réponse`);
        }
        walk(val, path ? `${path}.${key}` : key);
      }
    }
  }

  walk(body);
}
