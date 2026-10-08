import { describe, it, expect, beforeEach, vi } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api } from '../helpers/app.js';
import { registerViaApi } from '../helpers/factory.js';
import { hashToken } from '../../src/utils/refreshToken.js';

// Le reset coupe tous les acces et ne rend aucun jeton nouveau : c'est le point
// central. Un changement de mot de passe qui laisse les sessions ouvertes laisse
// un voleur connecte avec l'ancien mot de passe, ce qui est le scenario d'abus
// le plus courant.

const client = api();

const { envois } = vi.hoisted(() => ({ envois: [] }));

vi.mock('../../src/config/email/sendMail.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    sendTemplateEmail: async (to, subject, template, props) => {
      envois.push({ to, subject, template, props });
      return true;
    },
  };
});

beforeEach(() => {
  envois.length = 0;
});

const emailsDe = (template) => envois.filter((e) => e.template === template);

const jetonsDe = async (userId) =>
  prisma.passwordResetToken.findMany({ where: { userId }, orderBy: { id: 'asc' } });

const jetonEnvoye = () => {
  const envoi = emailsDe('forgot-password').at(-1);
  if (!envoi) throw new Error('aucun email de reinitialisation emis');
  return new URL(envoi.props.resetUrl).searchParams.get('token');
};

const demander = (email) => client.post('/api/v2/auth/forgot-password').send({ email });
const appliquer = (token, password = 'NouveauMdp1!') =>
  client.post('/api/v2/auth/reset-password').send({ token, password });

/** Compte inscrit, avec un lien de reinitialisation en cours. */
async function avecLien(email = 'reset@example.com', motDePasse = 'AncienMdp1!') {
  const { payload } = await registerViaApi(client, { email, password: motDePasse });
  const user = await prisma.user.findUnique({ where: { email: payload.email } });
  await demander(payload.email);
  return { user, payload, token: jetonEnvoye() };
}

describe('GET /api/v2/auth/reset-password', () => {
  it('affiche un formulaire pour un lien valide', async () => {
    const { token } = await avecLien();

    const res = await client.get(`/api/v2/auth/reset-password?token=${token}`);

    expect(res.status, res.text).toBe(200);
    expect(res.type).toContain('text/html');
    expect(res.text).toContain('name="password"');
    expect(res.text).toContain('Nouveau mot de passe');
  });

  // Le piege : un client de messagerie ou un antivirus peut precharger le lien.
  // Un GET qui consomme le jeton changerait le mot de passe avant que
  // l'utilisateur ne voie quoi que ce soit, et le formulaire affiche ensuite
  // serait rejete.
  it('ne consomme pas le jeton', async () => {
    const { token } = await avecLien();

    const page = await client.get(`/api/v2/auth/reset-password?token=${token}`);
    expect(page.status).toBe(200);

    // Le lien reste valable : c'est le formulaire qui l'applique.
    const res = await appliquer(token);
    expect(res.status, res.text).toBe(200);
  });

  it('n affiche pas le formulaire pour un jeton inconnu', async () => {
    const res = await client.get(`/api/v2/auth/reset-password?token=${'a'.repeat(80)}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('invalide');
    expect(res.text).not.toContain('name="password"');
  });

  it('n affiche pas le formulaire pour un jeton expire', async () => {
    const { user, token } = await avecLien();
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await client.get(`/api/v2/auth/reset-password?token=${token}`);

    expect(res.text).toContain('expire');
    expect(res.text).not.toContain('name="password"');
  });

  it('affiche quand meme une page lisible sans jeton', async () => {
    const res = await client.get('/api/v2/auth/reset-password');

    // Un lien casse ou tronque doit expliquer pourquoi, pas renvoyer du JSON.
    expect(res.status).toBe(200);
    expect(res.type).toContain('text/html');
    expect(res.text).toContain('invalide');
  });
});

describe('POST /api/v2/auth/reset-password', () => {
  it('applique le nouveau mot de passe', async () => {
    const { user, payload, token } = await avecLien();

    const res = await appliquer(token);

    expect(res.status, res.text).toBe(200);
    const connexion = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: 'NouveauMdp1!' });
    expect(connexion.status, connexion.text).toBe(200);

    // Et l'ancien ne fonctionne plus.
    const ancien = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: payload.password });
    expect(ancien.status).toBe(401);
  });

  it('consomme le jeton', async () => {
    const { user, token } = await avecLien();

    await appliquer(token);

    const [jeton] = await jetonsDe(user.id);
    expect(jeton.usedAt).not.toBeNull();
  });

  // Usage unique : c'est ce qui borne la fenetre pendant laquelle un lien vole
  // fonctionne, et ce qui distingue un jeton d'un mot de passe.
  it('refuse un jeton deja utilise', async () => {
    const { token } = await avecLien();
    await appliquer(token);

    const res = await appliquer(token, 'EncoreMdp1!');

    expect(res.status).toBe(400);
  });

  it('refuse un jeton inconnu', async () => {
    await avecLien();

    const res = await appliquer('b'.repeat(80));

    expect(res.status).toBe(400);
  });

  it('refuse un jeton expire', async () => {
    const { user, token } = await avecLien();
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await appliquer(token);

    expect(res.status).toBe(400);
    expect((await prisma.user.findUnique({ where: { id: user.id } })).password).toBeTruthy();
  });

  it('refuse un mot de passe trop faible', async () => {
    const { user, payload, token } = await avecLien();

    const res = await appliquer(token, 'court');

    expect(res.status).toBe(400);
    // Le mot de passe doit rester le meme : un refus de validation ne consomme
    // pas le lien, l'utilisateur peut corriger et reessayer.
    const connexion = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: payload.password });
    expect(connexion.status).toBe(200);
  });

  it('ne consomme pas le jeton quand le mot de passe est refuse', async () => {
    const { token } = await avecLien();

    await appliquer(token, 'court');

    // Le lien reste utilisable : refuser une saisie faible ne doit pas obliger a
    // redemander un email.
    const res = await appliquer(token);
    expect(res.status, res.text).toBe(200);
  });

  it('refuse un jeton mal forme', async () => {
    for (const token of ['court', '', 'z'.repeat(80)]) {
      expect((await appliquer(token)).status, `token "${token}"`).toBe(400);
    }
  });
});

describe('Le reset coupe tous les acces', () => {
  // Le coeur du choix : changer de mot de passe sans fermer les sessions
  // laisserait un voleur tranquillement connecte avec l'ancien mot de passe.
  it('ferme toutes les sessions du compte', async () => {
    const { user, payload } = await inscritAvecSessions();
    const { resetToken } = await connecterPlusieursAppareils(payload);

    const res = await appliquer(resetToken);

    expect(res.status, res.text).toBe(200);
    const sessions = await prisma.session.findMany({ where: { userId: user.id } });
    expect(sessions.length).toBeGreaterThan(1);
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revoked: false } })).toBe(0);
  });

  it('empeche chaque appareil de rafraichir', async () => {
    const { payload } = await inscritAvecSessions();
    const { refreshTokens, resetToken } = await connecterPlusieursAppareils(payload);

    await appliquer(resetToken);

    for (const jeton of refreshTokens) {
      const res = await client.post('/api/v2/auth/refresh').send({ refreshToken: jeton });
      expect(res.status, 'chaque appareil doit etre coupe').toBe(401);
    }
  });

  // Le reset ne doit pas depasser le compte concerne : une session d'un autre
  // utilisateur qui aurait le malheur de partager un jeton ne doit pas tomber.
  it('laisse les sessions d un autre compte intactes', async () => {
    const { user: premier, payload } = await inscritAvecSessions();
    const { refreshTokens, resetToken } = await connecterPlusieursAppareils(payload);

    const autre = await registerViaApi(client);
    await client
      .post('/api/v2/auth/login')
      .send({ email: autre.payload.email, password: autre.payload.password });

    await appliquer(resetToken);

    // Le compte reinitialise ne peut plus rafraichir...
    for (const jeton of refreshTokens) {
      expect((await client.post('/api/v2/auth/refresh').send({ refreshToken: jeton })).status).toBe(401);
    }

    // ... et l autre, qui n'a rien demande, continue de fonctionner.
    const sessionsAutre = await prisma.session.count({
      where: { revokedAt: null, user: { email: autre.payload.email } },
    });
    expect(sessionsAutre).toBeGreaterThan(0);
    expect(premier.id).not.toBe(0);
  });

  it('permet de se reconnecter avec le nouveau mot de passe', async () => {
    const { payload } = await inscritAvecSessions();
    const { resetToken } = await connecterPlusieursAppareils(payload);

    await appliquer(resetToken);

    const res = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: 'NouveauMdp1!' });
    expect(res.status, res.text).toBe(200);
  });
});


describe('Alerte de securite', () => {
  // Sans elle, la victime n'a aucun moyen d'apprendre qu'elle a ete contrainte de
  // changer de mot de passe — et c'est le signal qui declenche sa reaction sur
  // ses autres comptes.
  it('previens le proprietaire apres le changement', async () => {
    const { user } = await avecLien();

    await appliquer(jetonEnvoye());

    const alertes = emailsDe('password-changed');
    expect(alertes).toHaveLength(1);
    expect(alertes[0].to).toBe(user.email);
    expect(alertes[0].props.changedAt).toBeTruthy();
  });

  it('demande de reinitialiser si l alerte n a pas ete demandee', async () => {
    await avecLien();
    await appliquer(jetonEnvoye());

    const { renderTemplate } = await import('../../src/config/email/sendMail.js');
    const html = await renderTemplate('password-changed', emailsDe('password-changed')[0].props);

    // Une alerte qui ne dit pas quoi faire en cas de doute est inutile.
    expect(html).toContain('acc&egrave;s');
    expect(html).toContain('autres comptes');
  });

  it('n envoie pas d alerte quand le changement echoue', async () => {
    await avecLien();

    await appliquer(jetonEnvoye(), 'court');

    expect(emailsDe('password-changed')).toHaveLength(0);
  });
});

/** Inscrit un compte dont on connaisse le mot de passe. */
async function inscritAvecSessions() {
  const { payload, accessToken } = await registerViaApi(client, {
    email: `sessions-${Date.now()}@example.com`,
    password: 'AncienMdp1!',
  });
  const user = await prisma.user.findUnique({ where: { email: payload.email } });
  return { user, payload, accessToken };
}

/**
 * Ouvre plusieurs sessions, puis demande un lien de reinitialisation.
 *
 * Les jetons de rafraichissement sont recus en clair dans les reponses de
 * connexion : c'est la seule occasion de les voir, puisque la base n'en stocke
 * que l'empreinte. Les valeurs sont donc conservees ici.
 */
async function connecterPlusieursAppareils(payload) {
  const refreshTokens = [];
  for (let i = 0; i < 2; i += 1) {
    const res = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: payload.password });
    refreshTokens.push(res.body.refreshToken);
  }

  await demander(payload.email);

  return { refreshTokens, resetToken: jetonEnvoye() };
}
