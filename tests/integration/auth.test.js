import { describe, it, expect } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api } from '../helpers/app.js';
import { registerViaApi } from '../helpers/factory.js';

const client = api();

describe('POST /api/auth/register', () => {
  it('cree un compte et renvoie les jetons', async () => {
    const { user, accessToken, refreshToken } = await registerViaApi(client, { role: 'FARMER' });

    // role est expose sous forme de libelle lisible ("Agriculteur") et non de
    // code technique : c'est ce que safeUserToApi renvoie aujourd hui.
    expect(user).toMatchObject({ firstname: 'Amina', lastname: 'Benali', role: 'Agriculteur' });
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();
  });

  it("n'expose jamais le hash du mot de passe", async () => {
    const { user } = await registerViaApi(client);
    expect(user.password).toBeUndefined();
    expect(JSON.stringify(user)).not.toContain('$2b$');
  });

  it('refuse un role hors liste blanche, meme envoye', async () => {
    for (const role of ['ADMIN', 'ROOT']) {
      const res = await client.post('/api/auth/register').send({
        firstname: 'Malin',
        lastname: 'Intention',
        phone: '+33611110000',
        email: `${role.toLowerCase()}@example.com`,
        password: 'MotDePasse1!',
        role,
      });
      expect(res.status, `role ${role} doit etre refuse`).toBe(400);
    }
    expect(await prisma.user.count()).toBe(0);
  });

  it('refuse un email deja utilise', async () => {
    await registerViaApi(client, { email: 'doublon@example.com' });
    const res = await client.post('/api/auth/register').send({
      firstname: 'Autre',
      lastname: 'Personne',
      phone: '+33622220000',
      email: 'doublon@example.com',
      password: 'MotDePasse1!',
      role: 'BUYER',
    });
    expect(res.status).toBe(409);
  });

  it('refuse un mot de passe trop faible', async () => {
    const res = await client.post('/api/auth/register').send({
      firstname: 'Faible',
      lastname: 'MotDePasse',
      phone: '+33633330000',
      email: 'faible@example.com',
      password: 'tropcourt',
      role: 'BUYER',
    });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => d.field === 'password')).toBe(true);
  });
});

describe('POST /api/auth/login', () => {
  it('accepte les identifiants valides', async () => {
    const { payload } = await registerViaApi(client, { email: 'login@example.com' });

    const res = await client
      .post('/api/auth/login')
      .send({ email: payload.email, password: payload.password });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('renvoie le meme message pour email inconnu et mot de passe faux', async () => {
    const { payload } = await registerViaApi(client, { email: 'connu@example.com' });

    const inconnu = await client.post('/api/auth/login').send({ email: 'inconnu@example.com', password: 'x' });
    const faux = await client
      .post('/api/auth/login')
      .send({ email: payload.email, password: 'MauvaisMotDePasse1!' });

    // Distinguer les deux cas permettrait d enumerer les comptes existants.
    expect(inconnu.status).toBe(401);
    expect(faux.status).toBe(401);
    expect(inconnu.body.error).toBe(faux.body.error);
  });

  it('bloque la connexion d un compte suspendu', async () => {
    const { payload } = await registerViaApi(client, { email: 'suspendu@example.com' });
    const user = await prisma.user.findUnique({ where: { email: payload.email } });
    const suspendu = await prisma.userStatus.findUnique({ where: { code: 'SUSPENDED' } });
    await prisma.user.update({ where: { id: user.id }, data: { userStatusId: suspendu.id } });

    const res = await client
      .post('/api/auth/login')
      .send({ email: payload.email, password: payload.password });

    expect(res.status).toBe(403);
  });
});

describe('Rotation du refresh token', () => {
  it('delivre un nouvel access token', async () => {
    const { refreshToken } = await registerViaApi(client);

    const res = await client.post('/api/auth/refresh').send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  // Le logout revoque le jeton : le rejouer ne doit plus rien donner.
  it('ne reutilise pas un jeton revoque', async () => {
    const { refreshToken } = await registerViaApi(client);
    await client.post('/api/auth/logout').send({ refreshToken });

    const res = await client.post('/api/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });

  it('ne stocke que l empreinte du jeton', async () => {
    const { refreshToken } = await registerViaApi(client);
    const stored = await prisma.refreshToken.findMany();

    expect(stored).toHaveLength(1);
    expect(stored[0].token).not.toBe(refreshToken);
  });

  it('refuse un jeton expire', async () => {
    const { refreshToken } = await registerViaApi(client);
    await prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await client.post('/api/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });
});

// Avant cette phase, une deconnexion ne revocait que l'un des jetons du compte :
// les connexions concurrentes restaient valides, et rien ne pouvait dire de quel
// appareil venait une connexion. Une session est ce qui rend la deconnexion
// ciblee exprimable.
describe('Sessions', () => {
  const sessionsDe = (userId) => prisma.session.findMany({ where: { userId } });

  it('ouvre une session a l inscription', async () => {
    const { user } = await registerViaApi(client);

    const sessions = await sessionsDe(user.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].revokedAt).toBeNull();
    expect(sessions[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('ouvre une session a chaque connexion, sans reutiliser la precedente', async () => {
    const { payload } = await registerViaApi(client);
    const user = await prisma.user.findUnique({ where: { email: payload.email } });

    const apresInscription = (await sessionsDe(user.id)).length;

    await client.post('/api/auth/login').send({ email: payload.email, password: payload.password });
    await client.post('/api/auth/login').send({ email: payload.email, password: payload.password });

    // L'inscription ouvre deja une session ; deux connexions de plus en ouvrent
    // deux autres. Deux appareils, deux sessions : c'est tout l'objet du modele,
    // puisqu'avant une reconnexion ne pouvait que se superposer a la precedente.
    const sessions = await sessionsDe(user.id);
    expect(apresInscription).toBe(1);
    expect(sessions).toHaveLength(3);
    expect(sessions.every((s) => s.revokedAt === null)).toBe(true);
  });

  it('rattache le jeton de rafraichissement a sa session', async () => {
    const { user, refreshToken } = await registerViaApi(client);

    const jeton = await prisma.refreshToken.findFirst({ where: { userId: user.id } });
    const session = await prisma.session.findFirst({ where: { id: jeton.sessionId } });

    expect(session.userId).toBe(user.id);
    expect(jeton.token).not.toBe(refreshToken);
  });

  it('enregistre l appareil quand la requete le renseigne', async () => {
    const { payload } = await registerViaApi(client, { email: 'appareil@example.com' });
    const user = await prisma.user.findUnique({ where: { email: payload.email } });

    await client
      .post('/api/auth/login')
      .set('User-Agent', 'AgriConnect-Jest/1.0')
      .send({ email: payload.email, password: payload.password });

    // Agent et IP sont facultatifs, mais quand la requete les porte ils doivent
    // etre conserves : sans eux, "deconnecte cet appareil" n'a aucun sens.
    const derniere = (await sessionsDe(user.id)).sort((a, b) => b.id - a.id)[0];
    expect(derniere.userAgent).toBe('AgriConnect-Jest/1.0');
    expect(derniere.ip).toBeTruthy();
  });

  // Supertest n'envoie pas de User-Agent : la session doit quand meme etre creee,
  // faute de quoi un client qui masque son agent ne pourrait plus se connecter.
  it('ouvre une session meme sans agent ni IP', async () => {
    const { user } = await registerViaApi(client, { email: 'sans-agent@example.com' });

    const sessions = await sessionsDe(user.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].userAgent).toBeNull();
  });

  it('ferme la session au logout, pas seulement le jeton', async () => {
    const { user, refreshToken } = await registerViaApi(client);

    const res = await client.post('/api/auth/logout').send({ refreshToken });
    expect(res.status).toBe(204);

    const sessions = await sessionsDe(user.id);
    expect(sessions[0].revokedAt).not.toBeNull();
    expect(await prisma.refreshToken.count({ where: { revoked: false } })).toBe(0);
  });

  // Fermer une session deja fermee doit rester sans effet : un client qui
  // rejoue sa deconnexion, ou qui n'a pas recu la reponse, ne doit pas obtenir
  // une erreur.
  it('rend le logout idempotent', async () => {
    const { refreshToken } = await registerViaApi(client);

    expect((await client.post('/api/auth/logout').send({ refreshToken })).status).toBe(204);
    expect((await client.post('/api/auth/logout').send({ refreshToken })).status).toBe(204);
  });

  it('ne coupe que la session de l appareil qui se deconnecte', async () => {
    const { payload } = await registerViaApi(client);
    const user = await prisma.user.findUnique({ where: { email: payload.email } });

    const telephone = await client
      .post('/api/auth/login')
      .send({ email: payload.email, password: payload.password });
    const ordinateur = await client
      .post('/api/auth/login')
      .send({ email: payload.email, password: payload.password });

    await client.post('/api/auth/logout').send({ refreshToken: telephone.body.refreshToken });

    // L'appareil qui s'est deconnecte ne peut plus rafraichir ; l'autre si.
    const coupe = await client.post('/api/auth/refresh').send({ refreshToken: telephone.body.refreshToken });
    const intact = await client.post('/api/auth/refresh').send({ refreshToken: ordinateur.body.refreshToken });

    expect(coupe.status).toBe(401);
    expect(intact.status).toBe(200);

    const actives = (await sessionsDe(user.id)).filter((s) => s.revokedAt === null);
    // Trois sessions au total : inscription, telephone, ordinateur. Une seule
    // est fermee, celle de l'appareil qui s'est deconnecte.
    expect(actives).toHaveLength(2);
  });

  // Un jeton peut rester valide alors que sa session a ete close : c'est
  // exactement le cas que la verification de session doit attraper.
  it('refuse le refresh quand la session a ete close', async () => {
    const { user, refreshToken } = await registerViaApi(client);

    await prisma.session.updateMany({ where: { userId: user.id }, data: { revokedAt: new Date() } });

    const res = await client.post('/api/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });
});
