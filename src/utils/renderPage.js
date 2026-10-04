import ejs from 'ejs';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Rendu des pages HTML servies par l'API, derriere les liens d'email.
//
// Volontairement distinct de la pile email (config/email/) : un email part dans
// une boite mail ou il est rendu par le client, ces pages sont rendues par un
// navigateur. Les traiter ensemble les melangerait : le CSS est inline pour
// l'email, il ne l'est pas ici.
//
// Les pages sont minimales et autonomes. Elles doivent fonctionner dans
// n'importe quel navigateur, y compris depuis un lien colle dans une boite mail
// sur un poste qui n'a jamais vu l'application.

const VIEWS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../views/pages'
);

// Une seule feuille de style pour toutes les pages : elles partagent la meme
// charte, et un style par page divergerait a chaque ajout.
const CSS_PATH = path.join(VIEWS_DIR, 'page.css');

/**
 * Rend une page depuis views/pages/<nom>.ejs.
 *
 * @returns {Promise<string|null>} null si la page n'existe pas.
 */
export async function renderPage(name, props = {}) {
  const templatePath = path.join(VIEWS_DIR, `${name}.ejs`);
  if (!existsSync(templatePath)) {
    console.error(`[page] gabarit introuvable : ${templatePath}`);
    return null;
  }

  const html = await ejs.renderFile(templatePath, props);
  if (!existsSync(CSS_PATH)) return html;

  const css = await readFile(CSS_PATH, 'utf8');
  return html.replace('</head>', `<style>\n${css}\n</style>\n</head>`);
}