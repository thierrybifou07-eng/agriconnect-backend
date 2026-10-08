import { describe, it, expect, beforeEach, vi } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { registerViaApi } from '../helpers/factory.js';
import {
  issueVerificationToken,
  dispatchVerificationEmail,
  consumeVerificationToken,
} from '../../src/utils/emailVerification.js';
import { backendUrl, appUrl } from '../../src/utils/links.js';
import { renderTemplate } from '../../src/config/email/sendMail.js';

// User.emailVerified existait depuis la premiere migration sans jamais etre
// ecrite ni lue : le projet n'avait aucune verification. Ces tests verrouillent
// le flux complet, et surtout le fait qu'il ne bloque rien — un compte non
// verifie doit pouvoir utiliser l'API normalement.

const client = api();

// Le SMTP est neutralise dans la suite, donc l'email ne part jamais et la valeur
// claire du jeton n'existe que dans le message qui aurait ete envoye. La base ne
// contient que l'empreinte : sans cette interception, la suite ne pourrait pas
// verifier le flux, faute d'acces au jeton. On intercepte donc l'envoi plutot que
// de rendre la production testable — ce qui introduirait un point d'observation
// que rien n'utilise en fonctionnement reel.
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

const jetonsDe = async (userId) =>
  prisma.emailVerificationToken.findMany({ where: { userId }, orderBy: { id: 'asc' } });

const jetonValide = async (userId) =>
  (await jetonsDe(userId)).find((j) => j.usedAt === null && j.expiresAt > new Date());

/**
 * Jeton en clair, extrait du lien que le serveur vient de composer.
 *
 * On cherche le dernier message de verification et non le premier envoi : une
 * inscription produit aussi un email de bienvenue, et un changement d'adresse
 * invalide le lien precedent au profit du nouveau. Renoncer au dernier ferait
 * tester un jeton volontairement casse.
 */
const jetonEnvoye = () => {
  const envoi = envois.findLast((e) => e.template === 'verify-email');
  if (!envoi) throw new Error('aucun email de verification emis');
  return new URL(envoi.props.verificationUrl).searchParams.get('token');
};

const verifier = (token) => client.post('/api/v2/auth/verify-email').send({ token });

/** Inscription puis relecture : l'inscription emet un jeton de verification. */
async function inscrit() {
  const { payload, accessToken } = await registerViaApi(client);
  const user = await prisma.user.findUnique({ where: { email: payload.email } });
  return { user, payload, accessToken };
}

describe('Emission du jeton de verification', () => {
  it('cree un jeton a l inscription', async () => {
    const { user } = await inscrit();

    const jetons = await jetonsDe(user.id);
    expect(jetons).toHaveLength(1);
    expect(jetons[0].usedAt).toBeNull();
    expect(jetons[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  // Seule l'empreinte est stockee : une fuite de la base ne doit pas permettre de
  // verifier une adresse qui n'est pas celle du detenteur du compte.
  it('ne stocke que l empreinte du jeton', async () => {
    const { user } = await inscrit();

    const [jeton] = await jetonsDe(user.id);
    const envoye = jetonEnvoye();

    expect(jeton.token).toMatch(/^[a-f0-9]{64}$/);
    expect(jeton.token).not.toBe(envoye);
    expect(jeton.token).not.toContain(envoye);
  });

  it('donne environ 24 heures de validite', async () => {
    const { user } = await inscrit();

    const [jeton] = await jetonsDe(user.id);
    const heures = (jeton.expiresAt.getTime() - Date.now()) / (60 * 60 * 1000);

    expect(heures).toBeGreaterThan(23);
    expect(heures).toBeLessThan(25);
  });

  it('adresse l email au compte inscrit', async () => {
    const { user } = await inscrit();

    expect(envois.at(-1).to).toBe(user.email);
    expect(envois.at(-1).template).toBe('verify-email');
  });
});

describe('Verification de l adresse', () => {
  it('applique la verification', async () => {
    const { user } = await inscrit();

    const res = await verifier(jetonEnvoye());

    expect(res.status, res.text).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: user.id } })).emailVerified).toBe(true);
  });

  it('marque le jeton comme utilise', async () => {
    const { user } = await inscrit();
    const jeton = await jetonValide(user.id);

    await verifier(jetonEnvoye());

    const apres = await prisma.emailVerificationToken.findUnique({ where: { id: jeton.id } });
    expect(apres.usedAt).not.toBeNull();
  });

  // Un lien ne sert qu'une fois : c'est ce qui distingue un jeton d'un mot de
  // passe, et ce qui borne la fenetre pendant laquelle un lien vole fonctionne.
  it('refuse un jeton deja utilise', async () => {
    const { user } = await inscrit();
    const jeton = jetonEnvoye();
    await verifier(jeton);

    const res = await verifier(jeton);

    expect(res.status).toBe(400);
    expect(res.text).toContain('deja servi');
  });

  it('refuse un jeton inconnu', async () => {
    const res = await verifier('a'.repeat(80));

    expect(res.status).toBe(400);
    expect(res.text).toContain('invalide');
  });

  it('refuse un jeton expire', async () => {
    const { user } = await inscrit();
    const jeton = await jetonValide(user.id);
    await prisma.emailVerificationToken.update({
      where: { id: jeton.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await verifier(jetonEnvoye());

    expect(res.status).toBe(400);
    expect(res.text).toContain('expire');
  });

  it('ne laisse pas un jeton expire verifier l adresse', async () => {
    const { user } = await inscrit();
    const jeton = await jetonValide(user.id);
    await prisma.emailVerificationToken.update({
      where: { id: jeton.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await verifier(jetonEnvoye());

    expect((await prisma.user.findUnique({ where: { id: user.id } })).emailVerified).toBe(false);
  });

  it('refuse un jeton mal forme avant d interroger la base', async () => {
    for (const jeton of ['court', '', 'z'.repeat(80)]) {
      const res = await verifier(jeton);
      expect(res.status, `token "${jeton}"`).toBe(400);
    }
  });

  it('donne le meme verdict par la fonction et par la route', async () => {
    const { user } = await inscrit();
    const jeton = jetonEnvoye();

    // La fonction et la route doivent s’accorder : un appelant de l’une ne doit pas
    // obtenir un comportement que l’autre ne partage pas.
    expect(await consumeVerificationToken(jeton)).toEqual({ ok: true });
    expect((await prisma.user.findUnique({ where: { id: user.id } })).emailVerified).toBe(true);
  });
});

describe('Le GET affiche et ne consomme pas', () => {
  // Le risque est concret : plusieurs clients de messagerie et la plupart des
  // antivirus prechargent les liens. Un GET qui consomme le jeton verifierait
  // l'adresse sans que son proprietaire l'ait vue.
  it('laisse le jeton utilisable apres un GET', async () => {
    const { user } = await inscrit();
    const jeton = jetonEnvoye();

    const page = await client.get(`/api/v2/auth/verify-email?token=${jeton}`);
    expect(page.status).toBe(200);

    const res = await verifier(jeton);
    expect(res.status, res.text).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: user.id } })).emailVerified).toBe(true);
  });

  it('sert une page HTML avec un formulaire de confirmation', async () => {
    const { user } = await inscrit();
    const jeton = jetonEnvoye();

    const res = await client.get(`/api/v2/auth/verify-email?token=${jeton}`);

    expect(res.type).toContain('text/html');
    expect(res.text).toContain('Confirmer mon adresse');
    // Sans le jeton dans le formulaire, l'utilisateur ne peut rien confirmer.
    expect(res.text).toContain(jeton);
    expect(res.text).not.toContain('<%');
  });

  it('affiche une page lisible quand le lien ne vaut plus rien', async () => {
    const res = await client.get('/api/v2/auth/verify-email?token=pas-un-jeton');

    // La page s'affiche malgre tout : un lien casse doit expliquer pourquoi, pas
    // renvoyer du JSON a un navigateur.
    expect(res.status).toBe(200);
    expect(res.type).toContain('text/html');
    expect(res.text).toContain('Confirmer');
  });
});

describe('La verification ne bloque rien', () => {
  it('laisse un compte non verifie appeler l API', async () => {
    const { user, accessToken } = await inscrit();
    expect(user.emailVerified).toBe(false);

    const me = await client.get('/api/v2/auth/me').set(authHeader(accessToken));
    expect(me.status, me.text).toBe(200);
    expect(me.body.emailVerified).toBe(false);
  });

  it('ne rend pas le compte verifie bloquant non plus', async () => {
    const { user, accessToken } = await inscrit();
    await verifier(jetonEnvoye());

    const me = await client.get('/api/v2/auth/me').set(authHeader(accessToken));
    expect(me.status).toBe(200);
  });
});

describe('Changement d adresse', () => {
  it('repart de zero et invalide le jeton en cours', async () => {
    const { user, accessToken } = await inscrit();
    const ancien = jetonEnvoye();
    await verifier(ancien);
    expect((await prisma.user.findUnique({ where: { id: user.id } })).emailVerified).toBe(true);

    const res = await client
      .patch('/api/v2/auth/me')
      .set(authHeader(accessToken))
      .send({ email: 'nouvelle@example.com' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.emailVerified).toBe(false);

    // Le lien de l'ancienne adresse ne vaut plus rien.
    expect((await verifier(ancien)).status).toBe(400);
  });

  // C'est le point de securite du flux : sans cette remise a zero, changer
  // d'adresse suffirait a heriter d'un verified=true sur une adresse tierce.
  it('ne herite pas du verified de l adresse precedente', async () => {
    const { user, accessToken } = await inscrit();
    await verifier(jetonEnvoye());

    await client
      .patch('/api/v2/auth/me')
      .set(authHeader(accessToken))
      .send({ email: 'adresse-tierce@example.com' });

    const enBase = await prisma.user.findUnique({ where: { id: user.id } });
    expect(enBase.email).toBe('adresse-tierce@example.com');
    expect(enBase.emailVerified).toBe(false);
  });

  it('envoie un lien a la nouvelle adresse', async () => {
    const { user, accessToken } = await inscrit();

    await client
      .patch('/api/v2/auth/me')
      .set(authHeader(accessToken))
      .send({ email: 'nouvelle@example.com' });

    const dernier = envois.at(-1);
    expect(dernier.to).toBe('nouvelle@example.com');

    // Et seul ce nouveau lien fonctionne.
    expect((await verifier(jetonEnvoye())).status).toBe(200);
  });

  it('ne remet pas a zero quand l adresse ne change pas', async () => {
    const { user, accessToken } = await inscrit();
    await verifier(jetonEnvoye());

    const res = await client.patch('/api/v2/auth/me').set(authHeader(accessToken)).send({ lastname: 'Benali' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.emailVerified).toBe(true);
  });

  // Renvoyer la meme adresse n'est pas en changer : le drapeau ne doit pas
  // sauter pour une simple reponse de formulaire.
  it('ne remet pas a zero quand la meme adresse est renvoyee', async () => {
    const { user, accessToken, payload } = await inscrit();
    await verifier(jetonEnvoye());

    const res = await client
      .patch('/api/v2/auth/me')
      .set(authHeader(accessToken))
      .send({ email: payload.email });

    expect(res.body.emailVerified).toBe(true);
  });
});

describe('Renvoi du lien', () => {
  it('exige une authentification', async () => {
    expect((await client.post('/api/v2/auth/resend-verification')).status).toBe(401);
  });

  it('repond 202 sans rien reveler sur l etat du SMTP', async () => {
    const { accessToken } = await inscrit();

    const res = await client.post('/api/v2/auth/resend-verification').set(authHeader(accessToken));

    // Un 202 sans detail : rapporter si le mail est parti transformerait la
    // reponse en sonde de l'etat du serveur de messagerie.
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      message: 'Si cette adresse est valide, un email vient de lui etre envoye.',
    });
  });

  it('delivre un nouveau jeton et invalide le precedent', async () => {
    const { user, accessToken } = await inscrit();
    const premierId = (await jetonValide(user.id)).id;

    await client.post('/api/v2/auth/resend-verification').set(authHeader(accessToken));

    const restants = await jetonsDe(user.id);
    expect(restants.find((j) => j.id === premierId).usedAt).not.toBeNull();
    expect(restants.filter((j) => j.usedAt === null)).toHaveLength(1);
  });

  // Renvoyer un lien ne doit pas annuler une verification deja faite.
  it('laisse un compte deja verifie verifie', async () => {
    const { user, accessToken } = await inscrit();
    await verifier(jetonEnvoye());

    await client.post('/api/v2/auth/resend-verification').set(authHeader(accessToken));

    expect((await prisma.user.findUnique({ where: { id: user.id } })).emailVerified).toBe(true);
  });
});

describe('Cooldown', () => {
  // Sans fenetre, "renvoie" permet d'inonder une boite et de faire rejeter les
  // envois legitimes par le serveur de messagerie.
  it('refuse un second envoi dans la fenetre', async () => {
    const { user } = await inscrit();
    const avant = (await jetonsDe(user.id)).length;

    const jeton = await issueVerificationToken(user);

    expect(jeton).toBeNull();
    expect((await jetonsDe(user.id)).length).toBe(avant);
  });

  it('accepte un envoi une fois la fenetre passee', async () => {
    const { user } = await inscrit();
    await prisma.emailVerificationToken.updateMany({
      where: { userId: user.id },
      data: { createdAt: new Date(Date.now() - 6 * 60 * 1000) },
    });

    const jeton = await issueVerificationToken(user);

    expect(jeton).toBeTruthy();
    expect((await jetonsDe(user.id)).length).toBe(2);
  });

  it('cede a une demande explicite', async () => {
    const { user } = await inscrit();

    const jeton = await issueVerificationToken(user, { force: true });

    expect(jeton).toBeTruthy();
    expect((await jetonsDe(user.id)).length).toBe(2);
  });

  it('ne repete pas le meme jeton deux fois', async () => {
    const { user } = await inscrit();

    const premier = await issueVerificationToken(user, { force: true });
    const second = await issueVerificationToken(user, { force: true });

    expect(premier).not.toBe(second);
  });
});

describe('Construction des liens', () => {
  it('pointe vers le backend, seul a pouvoir servir la page', () => {
    const url = new URL(backendUrl('/api/v2/auth/verify-email', { token: 'jeton' }));

    expect(url.pathname).toBe('/api/v2/auth/verify-email');
    expect(url.searchParams.get('token')).toBe('jeton');
    expect(url.port).toBe('4000');
  });

  it('bascule sur APP_URL des que le client a une adresse', () => {
    const precedent = process.env.APP_URL;
    try {
      process.env.APP_URL = 'https://agriconnect.ma/';
      // Barre oblique finale toleree : sans cela, tous les liens auraient un
      // double separateur.
      expect(appUrl('/reinitialiser-mdp')).toBe('https://agriconnect.ma/reinitialiser-mdp');
    } finally {
      process.env.APP_URL = precedent;
    }
  });

  it('reprend le lien dans le gabarit d email', async () => {
    const lien = backendUrl('/api/v2/auth/verify-email', { token: 'jeton-de-test' });

    const html = await renderTemplate('verify-email', {
      heading: 'Confirmez votre adresse',
      username: 'Amina',
      verificationUrl: lien,
    });

    expect(html).toContain('Amina');
    expect(html).toContain(lien);
    // Le lien doit etre un vrai bouton : une URL sans <a href> n'est pas
    // cliquable dans la plupart des clients de messagerie.
    expect(html).toMatch(/<a href="[^"]*verify-email[^"]*"/);
    expect(html).not.toContain('<%');
  });
});
