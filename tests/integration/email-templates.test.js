import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../setup/env.js';

// La pile email contenait un projet entierement etranger : 17 gabarits
// "RentHub" (une plateforme de location) sans la moindre reference a
// AgriConnect. Un utilisateur qui s'inscrivait recevait un email intitule
// "Bienvenue sur RentHub", avec un code de verification 00000 alors que le
// projet n'a aucune fonction de verification, et un contact support@renthub.com.
//
// Ces tests verrouillent l'absence de residue, ce qu'aucune relecture ne
// garantit durablement.

const EMAILS_DIR = path.join(PROJECT_ROOT, 'views', 'emails');
const SRC = path.join(PROJECT_ROOT, 'src');

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (existsSync(full) && !statSync(full).isDirectory()) {
      return full.endsWith('.ejs') || full.endsWith('.css') ? [full] : [];
    }
    return listFiles(full);
  });
}

describe('Gabarits e-mail', () => {
  const fichiers = listFiles(EMAILS_DIR);

  it('contient au moins un gabarit', () => {
    // Garde-fou : un glob fautif ne doit pas faire passer le test suivant.
    expect(fichiers.length).toBeGreaterThan(0);
  });

  it('ne contient aucune mention de RentHub', () => {
    const coupables = fichiers.filter((f) => /renthub/i.test(readFileSync(f, 'utf8')));
    expect(
      coupables.map((f) => path.relative(PROJECT_ROOT, f)),
      'Gabarits contenant encore la marque RentHub'
    ).toEqual([]);
  });

  it('ne contient aucun code de verification factice', () => {
    const coupables = fichiers.filter((f) => /validatedCode|00000/.test(readFileSync(f, 'utf8')));
    expect(
      coupables.map((f) => path.relative(PROJECT_ROOT, f)),
      'Gabarits encore references au code de verification supprime'
    ).toEqual([]);
  });

  it('ne mentionne pas de projet stranger dans le code', () => {
    // Meme verification cote code : un commentaire ou une chaine "RentHub"
    // subspammerait a nouveau dans les logs ou les gabarits.
    const coupables = [];
    for (const f of listJsFiles(SRC)) {
      if (/renthub/i.test(readFileSync(f, 'utf8'))) {
        coupables.push(path.relative(PROJECT_ROOT, f));
      }
    }
    expect(coupables).toEqual([]);
  });
});

function listJsFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return full.endsWith('.js') ? [full] : [];
  });
}

describe('Rendu du gabarit de bienvenue', () => {
  // Le rendu se fait par le vrai moteur, avec le vrai CSS inline : c'est ce
  // que le destinataire recoit.
  async function render(props) {
    const { renderTemplate } = await import('../../src/config/email/sendMail.js');
    return renderTemplate('welcome', props);
  }

  it('remplace le prenom et le role', async () => {
    const html = await render({ username: 'Amina', roleLabel: 'Agricultrice' });

    expect(html).toContain('Amina');
    expect(html).toContain('Agricultrice');
    // Les balises EJS doivent avoir ete resolues, sinon le template est faux.
    expect(html).not.toContain('<%');
  });

  it('mentionne AgriConnect et rien d autre', async () => {
    const html = await render({ username: 'Amina' });

    expect(html).toContain('AgriConnect');
    expect(html).not.toMatch(/renthub/i);
  });

  it('reste valide quand le role est absent', async () => {
    // Un appelant qui oublie roleLabel ne doit pas produire un template casse
    // ni une erreur : le gabarit teste sa presence.
    const html = await render({ username: 'Zaid' });

    expect(html).toContain('Zaid');
    expect(html).not.toContain('undefined');
  });

  // Les clients email ignorent les feuilles de style externes : le CSS doit etre
  // inline. juice le fait en attributs style quand le gabarit ne contient pas de
  // bloc <style>, ce qui est la forme la plus compatible.
  it('inline le CSS partage', async () => {
    const html = await render({ username: 'Amina' });

    expect(html).toContain('style="');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<style');
  });

  // La palette doit etre celle d'AgriConnect (vert), pas celle du projet
  // etranger d'origine (bleu).
  it('utilise la palette verte AgriConnect', async () => {
    const html = await render({ username: 'Amina' });

    expect(html).toContain('#2e7d32');
    expect(html).not.toContain('#1a56db');
  });
});

describe('Transport SMTP', () => {
  const envSauvegarde = { ...process.env };

  afterEach(() => {
    vi.resetModules();
    process.env = { ...envSauvegarde };
  });

  it('est inactif sans SMTP_HOST', async () => {
    delete process.env.SMTP_HOST;
    vi.resetModules();

    const { isMailConfigured } = await import('../../src/config/email/transport.js');
    expect(isMailConfigured()).toBe(false);
  });

  it("se configure depuis les variables d'environnement", async () => {
    process.env.SMTP_HOST = 'smtp.exemple.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_SECURE = 'true';
    process.env.SMTP_USER = 'postmaster';
    process.env.SMTP_PASSWORD = 'secret';
    vi.resetModules();

    const mod = await import('../../src/config/email/transport.js');
    expect(mod.isMailConfigured()).toBe(true);

    // Le transport doit porter exactement les valeurs fournies, sans hote ni
    // port codees en dur, et sans verification TLS desactivee.
    const options = mod.default.options;
    expect(options.host).toBe('smtp.exemple.com');
    expect(options.port).toBe(465);
    expect(options.secure).toBe(true);
    expect(options.auth).toEqual({ user: 'postmaster', pass: 'secret' });
    expect(options.tls?.rejectUnauthorized).not.toBe(false);
  });

  // Un SMTP injoignable ne doit pas faire echouer une inscription : c'est la
  // raison d'etre du non-bloquant.
  it('renvoie false sans lever quand la messagerie est indisponible', async () => {
    delete process.env.SMTP_HOST;
    vi.resetModules();

    const { sendTemplateEmail } = await import('../../src/config/email/sendMail.js');
    const resultat = await sendTemplateEmail('a@b.com', 'Objet', 'welcome', { username: 'Amina' });

    expect(resultat).toBe(false);
  });

  it('renvoie false au lieu de lever si le gabarit est absent', async () => {
    process.env.SMTP_HOST = 'smtp.injoignable.example';
    vi.resetModules();

    const { sendTemplateEmail } = await import('../../src/config/email/sendMail.js');
    const resultat = await sendTemplateEmail(
      'a@b.com',
      'Objet',
      'gabarit-qui-nexiste-pas',
      {}
    );

    expect(resultat).toBe(false);
  });

  it('ignore un destinataire vide', async () => {
    const { sendTemplateEmail } = await import('../../src/config/email/sendMail.js');
    expect(await sendTemplateEmail(null, 'Objet', 'welcome', {})).toBe(false);
  });
});

describe('Configuration SMTP declaree', () => {
  const envExample = readFileSync(path.join(PROJECT_ROOT, '.env.example'), 'utf8');

  // Les exemples commentes comptent : c'est precisement dans ces lignes que
  // se glisse la confusion qui a bloque l'envoi des emails.
  const valeurs = (nom) =>
    envExample
      .split(/\r?\n/)
      .filter((l) => new RegExp(`^\\s*#?\\s*${nom}\\s*=`).test(l))
      .map((l) => l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);

  // SMTP_HOST est un nom d'hote. Une URL d'interface web y est acceptee sans
  // erreur par la bibliotheque, qui tente alors de parler SMTP a un serveur
  // HTTP : l'envoi echoue sans bruit et sans message d'erreur explicite.
  it('donne un nom d hote pour SMTP_HOST, pas une URL', () => {
    const coupables = valeurs('SMTP_HOST').filter((v) => v.includes('://'));
    expect(coupables, 'SMTP_HOST renseigne avec une URL au lieu d un nom d hote').toEqual([]);
  });

  // Un SMTP refuse une adresse nue ; l'expedition echoue alors sur la plupart
  // des fournisseurs.
  it('exige une adresse d expedition complete dans les exemples', () => {
    for (const valeur of valeurs('EMAIL_SENDER')) {
      expect(valeur, `EMAIL_SENDER sans forme "Nom <adresse>" : ${valeur}`).toMatch(/<[^>]+@[^>]+>/);
    }
  });

  it('documente le port SMTP du piege a mail local', () => {
    expect(valeurs('SMTP_PORT')).toContain('1025');
  });

  // Les liens de reinitialisation et de verification sont construits a partir
  // de cette variable : sans elle, aucun lien ne peut partir.
  it('documente APP_URL, necessaire aux liens envoyes par email', () => {
    expect(valeurs('APP_URL').length).toBeGreaterThan(0);
  });
});

describe('Une seule pile email', () => {
  it('supprime l ancienne pile', () => {
    const disparus = [
      'src/utils/sendMail.js',
      'src/config/mailer.js',
      'src/utils/renderEmail.js',
      'src/emails/templates/welcome.ejs',
    ].filter((f) => existsSync(path.join(PROJECT_ROOT, f)));

    expect(disparus, 'Fichiers de l ancienne pile encore presents').toEqual([]);
  });

  it('ne laisse qu un seul module d envoi de mail', () => {
    const emissions = [];
    for (const f of listJsFiles(SRC)) {
      const code = readFileSync(f, 'utf8');
      if (/from\s+'[^']*sendMail\.js'/.test(code)) emissions.push(path.relative(PROJECT_ROOT, f));
    }
    expect(emissions.every((f) => f.startsWith('src/config/email/'))).toBe(true);
  });
});