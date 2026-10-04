// Forme unique de representation d'un utilisateur dans l'API.
//
// L'API exposait deux representations du meme objet : register et login
// renvoyaient des libelles ("Acheteur"), tandis que GET /api/users/me renvoyait
// des lignes de base entieres — role et userStatus avec id, level, isActive et
// createdAt. Un client devait donc traiter deux formes pour le meme champ, et la
// seconde exposait des colonnes internes qui ne servent a rien au client.
//
// La forme retenue est { code, label } : le libelle pour l'affichage, le code
// pour la logique. C'est deja la convention du projet pour listing.category et
// listing.status, et c'est ce que porte le jeton d'acces sous forme de code.
//
// Le hash du mot de passe n'est jamais selectionne en amont : ce serializer ne
// fait que redimensionner un objet deja charge, et ne peut donc pas le
// telephoner dans la reponse.

/** Reduit une entite de reference a { code, label }. */
const reference = (row) => (row ? { code: row.code, label: row.label } : null);

/**
 * @param {object} user  Utilisateur charge avec `role` et `userStatus`.
 * @param {object} [extra]  Champs a joindre, par exemple la liste des medias.
 */
export function userToApi(user, extra = {}) {
  return {
    id: user.id,
    firstname: user.firstname,
    lastname: user.lastname,
    email: user.email,
    phone: user.phone,
    location: user.location ?? null,
    role: reference(user.role),
    userStatus: reference(user.userStatus),
    vehicleType: user.vehicleType ?? null,
    isAvailable: user.isAvailable,
    emailVerified: user.emailVerified ?? false,
    // Les coordonnees ne font pas partie de "qui suis-je" : le client connait sa
    // propre position, et la renvoyer ajoute une donnee sensible sans usage.
    // Elles restent ecrites par PATCH /me/availability.
    createdAt: user.createdAt,
    ...extra,
  };
}