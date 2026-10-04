// Construction des liens.
//
// Un seul endroit decisionne ou pointe un lien. L'adresse du client Flutter
// n'etant pas encore fixee, tout passe par APP_URL : le jour ou elle est connue,
// une seule variable change et aucun lien n'a besoin d'etre reconstruit ailleurs.

// Le backend sert lui-meme les pages derriere les liens d'email (formulaire de
// reinitialisation, confirmation de verification). Raison : beaucoup de clients
// de messagerie et d'antivirus prechargent les liens, et un GET qui consomme un
// jeton peut l'invalider avant que la page ne s'affiche. Une page qui
// n consomme rien evite le piege, et elle fonctionne dans n'importe quel
// navigateur comme le client mobile. APP_URL reste necessaire pour la
// redirection apres action.

const DEFAULT_APP_URL = 'http://localhost:3000';

/** Base du client, sans barre oblique finale, pour ne pas doubler les separateurs. */
export function appBase() {
  return (process.env.APP_URL || DEFAULT_APP_URL).replace(/\/+$/, '');
}

/** Route du client : appUrl('/reinitialiser-mdp') */
export function appUrl(pathname = '/') {
  const base = appBase();
  return pathname.startsWith('/') ? `${base}${pathname}` : `${base}/${pathname}`;
}

/**
 * Route du backend : backendUrl('/api/auth/reset-password')
 *
 * Base derivee de APP_URL quand elle a le meme hote, sinon de l'hote courant.
 * Ainsi le lien reste correct en developpement comme derriere un reverse proxy,
 * sans introduire une seconde variable a renseigner.
 */
export function backendUrl(pathname, query = {}) {
  const base = sameOriginBase() ?? appBase();
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, base);

  for (const [cle, valeur] of Object.entries(query)) {
    if (valeur !== undefined && valeur !== null) url.searchParams.set(cle, String(valeur));
  }
  return url.toString();
}

/**
 * Base de l'API elle-meme, si elle est discernible d'APP_URL.
 *
 * En production les deux sont derriere le meme domaine avec APP_URL en prefixe
 * de chemin ; lire le port d'APP_URL permet alors de reconstruire l'origine de
 * l'API sans configuration supplementaire.
 */
function sameOriginBase() {
  const port = process.env.PORT;
  if (!port) return null;

  const app = new URL(appBase());
  if (!app.port) return null;

  return `${app.protocol}//${app.hostname}:${port}`;
}