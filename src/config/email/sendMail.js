import ejs from 'ejs';
import juice from 'juice';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import transport, { isMailConfigured } from './transport.js';

// Les gabarits sont resolus depuis la racine du projet, et non depuis le
// repertoire courant : le code etait resolu via resolve('views/emails/...'),
// ce qui rendait le demarrage dependant du dossier depuis lequel node etait
// lance (un `npm start` depuis la racine marchait, un lancement par un script
// de deploiement pas).
// src/config/email/ -> trois niveaux pour atteindre la racine du projet.
const VIEWS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../views/emails'
);

const SHARED_CSS = path.join(VIEWS_DIR, '_shared', 'style.css');

/**
 * Rend un gabarit en HTML, CSS inline.
 * Exporte car c'est une capacite a part entiere : elle permet de verifier le
 * rendu sans passer par SMTP.
 *
 * @returns {Promise<string|null>} null si le gabarit n'existe pas.
 */
export async function renderTemplate(template, props = {}) {
  const basePath = path.join(VIEWS_DIR, template);
  const templatePath = path.join(basePath, 'email.ejs');

  if (!existsSync(templatePath)) {
    console.error(`[mail] gabarit introuvable : ${templatePath}`);
    return null;
  }

  // Le CSS partage est inline par juice, car les clients email ignorent les
  // <link rel="stylesheet">.
  const cssFiles = existsSync(SHARED_CSS) ? [SHARED_CSS] : [];
  const localCss = path.join(basePath, 'email.css');
  if (existsSync(localCss)) cssFiles.push(localCss);

  const html = await ejs.renderFile(templatePath, props);

  if (cssFiles.length === 0) return html;

  const combinedCss = (await Promise.all(cssFiles.map((f) => readFile(f, 'utf8')))).join('\n');
  return juice.inlineContent(html, combinedCss);
}

// L'expedition par defaut. EMAIL_SENDER doit etre une adresse complete
// ("AgriConnect <no-reply@...>") : SMTP rejette une adresse nue sur la plupart
// des fournisseurs.
const sender = process.env.EMAIL_SENDER || 'AgriConnect <no-reply@agriconnect.local>';

// Neutralisation explicite pour les tests : aucun envoi reel ne doit partir
// depuis une base de test, et aucune connexion SMTP ne doit etre tentee.
const isDisabled = () => process.env.SMTP_DISABLED === '1';

/**
 * Rend un gabarit puis l'envoie.
 *
 * Ne leve jamais pour un echec de messagerie : un email non envoye ne doit pas
 * faire echouer une inscription ni une creation de compte. L'appelant peut
 * toutefois await() pour savoir si l'envoi a reussi.
 *
 * @returns {Promise<boolean>} true si le message a bien ete remis au transport.
 */
export async function sendTemplateEmail(to, subject, template, props = {}) {
  if (!to) return false;

  if (isDisabled()) {
    console.log(`[mail] envoi ignore (SMTP_DISABLED) : "${subject}" a ${to}`);
    return false;
  }

  if (!isMailConfigured()) {
    console.warn(`[mail] SMTP non configure - "${subject}" a ${to} non envoye (dev/local)`);
    return false;
  }

  try {
    const html = await renderTemplate(template, props);
    if (html === null) return false;

    await transport.sendMail({ from: sender, to, subject, html });
    return true;
  } catch (error) {
    console.error(`[mail] envoi en echec pour "${subject}" a ${to} :`, error.message);
    return false;
  }
}