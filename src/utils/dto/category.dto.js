// DTO d'une catégorie de produit : le triplet d'affichage uniquement.
// La catégorie est un référentiel public — isActive et les dates n'ont
// pas à sortir de l'API.
export function categoryToApi(category) {
  return {
    id: category.id,
    code: category.code,
    label: category.label,
  };
}
