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
