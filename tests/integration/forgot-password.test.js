import { describe, it, expect, beforeEach, vi } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { registerViaApi } from '../helpers/factory.js';

// L'exigence dominante de cet endpoint est negative : la reponse ne doit rien
// reveler sur l'existence d'un compte. Distinguer les deux cas permettrait
// d'enumerer les adresses enregistrees, et "compte inconnu" invite l'utilisateur
// a essayer une autre adresse.
//
// Le SMTP etant neutralise dans la suite, l'envoi est intercepté pour observer
// le lien que le serveur aurait transmis.

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

const jetonsDe = async (userId) =>
  prisma.passwordResetToken.findMany({ where: { userId }, orderBy: { id: 'asc' } });

// Une inscription produit elle aussi des emails (bienvenue, verification). On
// ne compte donc que ceux du gabarit etudie : sinon les assertions verraient
// l'email de bienvenue et conclueraient a tort que forgot-password en a envoye
// un.
const emailsReset = () => envois.filter((e) => e.template === 'forgot-password');

const jetonEnvoye = () => {
  const envoi = envois.findLast((e) => e.template === 'forgot-password');
  if (!envoi) throw new Error('aucun email de reinitialisation emis');
  return new URL(envoi.props.resetUrl).searchParams.get('token');
};

async function inscrit(email = 'oubli@example.com') {
  const { payload } = await registerViaApi(client, { email });
  const user = await prisma.user.findUnique({ where: { email: payload.email } });
  return { user, payload };
}

describe('POST /api/auth/forgot-password', () => {
  it('repond 200 pour un compte existant', async () => {
    const { payload } = await inscrit();

    const res = await client.post('/api/auth/forgot-password').send({ email: payload.email });

    expect(res.status, res.text).toBe(200);
    expect(res.body.message).toBeTruthy();
  });

  it('envoie un email a la bonne adresse', async () => {
    const { payload, user } = await inscrit();

    await client.post('/api/auth/forgot-password').send({ email: payload.email });

    expect(emailsReset()).toHaveLength(1);
    expect(emailsReset()[0].to).toBe(user.email);
  });

  it('emet un jeton pour un compte existant', async () => {
    const { user, payload } = await inscrit();

    await client.post('/api/auth/forgot-password').send({ email: payload.email });

    const jetons = await jetonsDe(user.id);
    expect(jetons).toHaveLength(1);
    expect(jetons[0].usedAt).toBeNull();
  });

  it('ne stocke que l empreinte du jeton', async () => {
    const { user, payload } = await inscrit();
    await client.post('/api/auth/forgot-password').send({ email: payload.email });

    const [jeton] = await jetonsDe(user.id);

    expect(jeton.token).toMatch(/^[a-f0-9]{64}$/);
    expect(jeton.token).not.toBe(jetonEnvoye());
  });

  it('donne 15 minutes de validite', async () => {
    const { user, payload } = await inscrit();
    await client.post('/api/auth/forgot-password').send({ email: payload.email });

    const [jeton] = await jetonsDe(user.id);
    const minutes = (jeton.expiresAt.getTime() - Date.now()) / (60 * 1000);

    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThan(16);
  });
});

describe('Le endpoint ne revele pas l existence d un compte', () => {
  // Comparaison stricte : statut, corps, et cles. Une difference de libelle
  // suffirait a un attaquant automatise pour enumerer les comptes.
  it('repond exactement pareil pour une adresse inconnue', async () => {
    const { payload } = await inscrit();

    const connu = await client.post('/api/auth/forgot-password').send({ email: payload.email });
    const inconnu = await client
      .post('/api/auth/forgot-password')
      .send({ email: 'personne@example.com' });

    expect(inconnu.status).toBe(connu.status);
    expect(inconnu.body).toEqual(connu.body);
    expect(Object.keys(inconnu.body).sort()).toEqual(Object.keys(connu.body).sort());
  });

  it('n envoie rien pour une adresse inconnue', async () => {
    await inscrit();

    await client.post('/api/auth/forgot-password').send({ email: 'personne@example.com' });

    expect(emailsReset()).toHaveLength(0);
  });

  it('ne cree aucun jeton pour une adresse inconnue', async () => {
    await inscrit();

    await client.post('/api/auth/forgot-password').send({ email: 'personne@example.com' });

    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  // Un temps de reponse differant suffit a enumerer : un attaquant mesure.
  // Ce test verifie que le chemin inconnu ne fait pas de travail inutile
  // notable — il ne peut pas garantir l'absence de toute fuite temporelle, mais
  // il interdit le cas evident ou la reponse est livree beaucoup plus tot.
  it('ne livre pas la reponse beaucoup plus tot quand aucun envoi n a lieu', async () => {
    const { payload } = await inscrit();

    const mesurer = async (email) => {
      const debut = process.hrtime.bigint();
      await client.post('/api/auth/forgot-password').send({ email });
      return Number(process.hrtime.bigint() - debut) / 1e6;
    };

    // Un echantillon dans chaque sens : l'ordre des appels ne doit pas
    // determiner la mesure.
    const inconnu1 = await mesurer('personne@example.com');
    const connu = await mesurer(payload.email);
    const inconnu2 = await mesurer('absent@example.com');

    // Marge large : on ne cherche pas a mesurer une fuite subtile, mais a
    // attraper le cas ou la reponse est servie sans aucun traitement.
    expect(Math.min(inconnu1, inconnu2)).toBeGreaterThan(connu * 0.25);
  });

  it('rejette un format d email invalide sans consulter la base', async () => {
    await inscrit();

    const res = await client.post('/api/auth/forgot-password').send({ email: 'pas-un-email' });

    expect(res.status).toBe(400);
    expect(emailsReset()).toHaveLength(0);
  });

  it('exige une adresse', async () => {
    const res = await client.post('/api/auth/forgot-password').send({});
    expect(res.status).toBe(400);
  });
});

describe('Un seul lien valide a la fois', () => {
  // Deux demandes successive ne doivent pas laisser deux liens actifs : un
  // ancien lien resterait valable alors que l'utilisateur en a demande un
  // nouveau.
  it('invalide le lien precedent', async () => {
    const { user, payload } = await inscrit();

    await client.post('/api/auth/forgot-password').send({ email: payload.email });
    const premierId = (await jetonsDe(user.id))[0].id;

    await client.post('/api/auth/forgot-password').send({ email: payload.email });

    const jetons = await jetonsDe(user.id);
    expect(jetons.find((j) => j.id === premierId).usedAt).not.toBeNull();
    expect(jetons.filter((j) => j.usedAt === null)).toHaveLength(1);
  });

  it('n affecte que le compte concerne', async () => {
    const { user, payload } = await inscrit('a@example.com');
    const { user: autre } = await inscrit('b@example.com');

    await client.post('/api/auth/forgot-password').send({ email: payload.email });

    expect(await jetonsDe(user.id)).toHaveLength(1);
    expect(await jetonsDe(autre.id)).toHaveLength(0);
  });
});

describe('Gabarit d email', () => {
  it('porte le lien vers la page de reinitialisation', async () => {
    const { payload } = await inscrit();

    await client.post('/api/auth/forgot-password').send({ email: payload.email });

    const props = emailsReset()[0].props;
    expect(props.resetUrl).toContain('/api/auth/reset-password');
    expect(props.ttlMinutes).toBe(15);
    expect(props.username).toBeTruthy();
  });

  it('annonce que la demande n a rien change si l utilisateur n est pas a l origine', async () => {
    const { payload } = await inscrit();

    await client.post('/api/auth/forgot-password').send({ email: payload.email });

    // Un email de reinitialisation sans cette phrase fait paniquer les
    // utilisateurs qui recoivent le leur.
    const { renderTemplate } = await import('../../src/config/email/sendMail.js');
    const html = await renderTemplate('forgot-password', emailsReset()[0].props);
    // Le gabarit encode les accents en entités HTML : la comparaison se fait sur
    // la forme rendue, pas sur le texte source du gabarit.
    expect(html).toContain('n\'&eacute;tiez pas vous');
    expect(html).toContain(emailsReset()[0].props.resetUrl);
    expect(html).not.toContain('<%');
  });
});