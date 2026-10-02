import nodemailer from 'nodemailer';

// Transport SMTP entierement configure par l'environnement.
//
// Le code precedemment en place pointait en dur sur 127.0.0.1:1025 avec
// rejectUnauthorized: false, c'est-a-dire un serveur de developpement et une
// verification TLS desactivee. Aucun deploiement ne pouvait donc configurer son
// propre SMTP, et en production tout le trafic partait en clair vers la
// machine locale.
//
// Sans SMTP_HOST, aucun transport n'est cree : l'envoi devient un no-op journalise
// plutot qu'une erreur. C'est ce qui permet a une inscription de aboutir meme
// quand la messagerie est indisponible.

const host = process.env.SMTP_HOST;
const port = Number.parseInt(process.env.SMTP_PORT || '587', 10);
const secure = process.env.SMTP_SECURE === 'true';

const transport = host
  ? nodemailer.createTransport({
      host,
      port,
      secure,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    })
  : null;

export function isMailConfigured() {
  return transport !== null;
}

export default transport;