import transporter from '../config/mailer.js';
import { renderEmail } from './renderEmail.js';

const isMailerConfigured = Boolean(process.env.SMTP_HOST);

// Envoi non-bloquant par design : à appeler avec .catch() côté appelant plutôt
// qu'await'é dans le chemin critique d'une requête (un échec d'email ne doit
// jamais faire échouer une inscription ou une création de compte).
export async function sendMail({ to, subject, template, data }) {
  if (!to) return null;

  if (!isMailerConfigured) {
    console.warn(`[mailer] SMTP non configuré - email "${subject}" à ${to} non envoyé (dev/local)`);
    return null;
  }

  const html = await renderEmail(template, data);

  return transporter.sendMail({
    from: process.env.MAIL_FROM || 'AgriConnect <no-reply@agriconnect.local>',
    to,
    subject,
    html,
  });
}
