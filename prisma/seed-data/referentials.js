// Référentiels du catalogue seedés par prisma/seed.js (upsert par code,
// idempotent). Ils vivent ici plutôt que dans seed.js pour que
// tests/helpers/db.js puisse les lire : le nettoyage entre tests supprime
// les lignes de ProductCategory et Unit dont le code n'est pas seedé, sinon
// les lignes créées par les tests s'accumuleraient d'un test à l'autre.
export const PRODUCT_CATEGORIES = [
  { code: 'CEREALES', label: 'Céréales' },
  { code: 'LEGUMES', label: 'Légumes' },
  { code: 'FRUITS', label: 'Fruits' },
  { code: 'TUBERCULES', label: 'Tubercules' },
  { code: 'ELEVAGE', label: 'Élevage' },
  { code: 'AUTRE', label: 'Autre' },
];

export const UNITS = [
  { code: 'KG', label: 'Kilogramme' },
  { code: 'TON', label: 'Tonne' },
  { code: 'BAG', label: 'Sac' },
  { code: 'CRATE', label: 'Caisse' },
  { code: 'PIECE', label: 'Pièce' },
  { code: 'LITER', label: 'Litre' },
  { code: 'BUNCH', label: 'Botte' },
];
