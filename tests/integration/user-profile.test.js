import { describe, it, expect } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser, registerViaApi } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

// B1 ne se limitait pas aux `select` : createAdmin et updateMe tentaient
// d'ecrire une colonne `fullName` inexistante. Ces tests le verifient a
// l'execution, la ou un controle statique des cles de select ne voit rien.

const client = api();

async function rootToken() {
  const root = await createUser({ role: 'ROOT' });
  return { root, token: generateToken({ id: root.id, role: 'ROOT' }) };
}

async function buyerToken() {
  const buyer = await createUser({ role: 'BUYER' });
  return { buyer, token: generateToken({ id: buyer.id, role: 'BUYER' }) };
}

describe('POST /api/v2/admin/users - creation d un administrateur', () => {
  it('cree le compte avec prenom et nom', async () => {
    const { token } = await rootToken();

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Youssef',
      lastname: 'El Amrani',
      phone: '+33612345678',
      email: 'youssef@example.com',
      password: 'MotDePasse1!',
    });

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ firstname: 'Youssef', lastname: 'El Amrani' });

    const enBase = await prisma.user.findUnique({ where: { email: 'youssef@example.com' } });
    expect(enBase).toBeTruthy();
  });

  it('n expose jamais le hash du mot de passe', async () => {
    const { token } = await rootToken();

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Yasmine',
      lastname: 'Tazi',
      phone: '+33612345679',
      email: 'yasmine@example.com',
      password: 'MotDePasse1!',
    });

    expect(res.status, res.text).toBe(201);
    expect(res.body.password).toBeUndefined();
  });

  it('refuse un prenom ou un nom manquant', async () => {
    const { token } = await rootToken();

    for (const payload of [
      { lastname: 'Tazi', phone: '+33612345680', password: 'MotDePasse1!' },
      { firstname: 'Yasmine', phone: '+33612345681', password: 'MotDePasse1!' },
    ]) {
      const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send(payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
    }
  });

  // La creation d'un administrateur est la privilege le plus eleve de l'API :
  // un roles moins eleve ne doit pas y acceder.
  it('refuse un roles non ROOT', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const token = generateToken({ id: admin.id, role: 'ADMIN' });

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Pirate',
      lastname: 'Intrus',
      phone: '+33612345682',
      password: 'MotDePasse1!',
    });

    expect(res.status).toBe(403);
  });
});

describe('Forme unique de la reponse utilisateur', () => {
  // GET /api/v2/users/me renvoyait role et userStatus en lignes de base entieres
  // (id, level, isActive, createdAt) alors que register et login renvoyaient un
  // libelle. Deux formes pour le meme champ, dont une qui exposait des colonnes
  // internes. Tout passe maintenant par utils/userApi.js.
  it('expose role et userStatus en { code, label }, et rien de plus', async () => {
    const { buyer, token } = await buyerToken();

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body.role).toEqual({ code: 'BUYER', label: 'Acheteur' });
    expect(res.body.userStatus).toEqual({ code: 'ACTIVE', label: 'Actif' });
    // Les colonnes internes de Role et UserStatus ne doivent plus sortir.
    expect(res.body.role).not.toHaveProperty('level');
    expect(res.body.role).not.toHaveProperty('isActive');
    expect(res.body.role).not.toHaveProperty('createdAt');
    expect(res.body.userStatus).not.toHaveProperty('createdAt');
  });

  // "Qui suis-je" n'a pas besoin de coordonnees : le client connait sa propre
  // position, et les renvoyer ajoute une donnee sensible sans usage. Elles
  // restent ecrites par la route availability.
  it('ne renvoie pas les coordonnees', async () => {
    const { buyer, token } = await buyerToken();
    await prisma.user.update({
      where: { id: buyer.id },
      data: { latitude: 34.02, longitude: -6.84 },
    });

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(res.body.latitude).toBeUndefined();
    expect(res.body.longitude).toBeUndefined();
  });

  it('expose la verification d adresse', async () => {
    const { buyer, token } = await buyerToken();
    await prisma.user.update({ where: { id: buyer.id }, data: { emailVerified: true } });

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(res.body.emailVerified).toBe(true);
  });

  // La forme doit etre la meme partout : c'est register et login qui
  // s'alignent sur /me qui change, pas l'inverse.
  it('est la meme forme sur register, login et me', async () => {
    const { accessToken, user: inscrit, payload } = await registerViaApi(client, { role: 'DRIVER' });
    const me = await client.get('/api/v2/auth/me').set(authHeader(accessToken));
    const login = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: payload.password });

    expect(login.status, login.text).toBe(200);

    const cles = (u) => Object.keys(u).sort().join(',');
    // /me porte en plus "media", qui n'a pas sa place dans une inscription.
    expect(cles(me.body).replace(',media', '')).toBe(cles(inscrit));
    expect(cles(login.body.user)).toBe(cles(inscrit));
    expect(inscrit.role).toEqual({ code: 'DRIVER', label: 'Livreur' });
  });

  it('conserve la liste des medias sur me', async () => {
    const { token } = await buyerToken();

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(Array.isArray(res.body.media)).toBe(true);
  });
});

describe('Deplacement des routes profil hors de /api/v2/users', () => {
  // /api/v2/users est reserve aux endpoints d'administration a venir. Les quatre
  // routes y sont parties, et il n'y a pas de compatibilite : aucun client
  // n'existe encore, donc un point de deplacement explicite dans l'historique
  // vaut mieux qu'un shim qui aurait deux sources de verite.
  const anciennesRoutes = [
    ['get', '/api/v2/users/me'],
    ['patch', '/api/v2/users/me'],
    ['post', '/api/v2/users/me/avatar'],
    ['patch', '/api/v2/users/me/availability'],
  ];

  it.each(anciennesRoutes)('%s %s ne repond plus', async (methode, chemin) => {
    const { token } = await buyerToken();

    const res = await client[methode](chemin).set(authHeader(token)).send({});

    expect(res.status, `${methode.toUpperCase()} ${chemin} devrait etre gone`).toBe(404);
  });

  it('laisse le prefixe /api/v2/users entierement libre', async () => {
    const { token } = await buyerToken();

    // Aucune route sous /api/v2/users : ce prefixe est disponible pour la
    // future interface d'administration.
    for (const chemin of ['/api/v2/users', '/api/v2/users/1', '/api/v2/users/me']) {
      const res = await client.get(chemin).set(authHeader(token));
      expect(res.status, `GET ${chemin} devrait etre 404`).toBe(404);
    }
  });

  // Sansauthentification comprise : une route supprimee repond 404, pas 401.
  it('repond 404 sans jeton, et non 401', async () => {
    const res = await client.get('/api/v2/users/me');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/v2/auth/me - mise a jour du profil', () => {
  it('met a jour le prenom et le nom', async () => {
    const { buyer, token } = await buyerToken();

    const res = await client
      .patch('/api/v2/auth/me')
      .set(authHeader(token))
      .send({ firstname: 'Amina', lastname: 'Benali' });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ firstname: 'Amina', lastname: 'Benali' });
  });

  // Les deux moities sont traitees separement : mettre a jour l'une ne doit
  // jamais effacer l'autre.
  it('ne modifie que le champ envoye', async () => {
    const { buyer, token } = await buyerToken();
    await prisma.user.update({ where: { id: buyer.id }, data: { firstname: 'Fatima', lastname: 'Zahra' } });

    await client.patch('/api/v2/auth/me').set(authHeader(token)).send({ lastname: 'Alaoui' });

    const enBase = await prisma.user.findUnique({ where: { id: buyer.id } });
    expect(enBase.firstname).toBe('Fatima');
    expect(enBase.lastname).toBe('Alaoui');
  });

  it('met a jour la localisation et l email', async () => {
    const { buyer, token } = await buyerToken();

    const res = await client
      .patch('/api/v2/auth/me')
      .set(authHeader(token))
      .send({ location: 'Salé', email: 'nouveau@example.com' });

    expect(res.status, res.text).toBe(200);
    const enBase = await prisma.user.findUnique({ where: { id: buyer.id } });
    expect(enBase.location).toBe('Salé');
    expect(enBase.email).toBe('nouveau@example.com');
  });

  // Un corps vide ne doit rien changer, et surtout pas tout effacer.
  it('accepte une mise a jour vide sans rien modifier', async () => {
    const { buyer, token } = await buyerToken();
    const avant = await prisma.user.findUnique({ where: { id: buyer.id } });

    const res = await client.patch('/api/v2/auth/me').set(authHeader(token)).send({});

    expect(res.status, res.text).toBe(200);
    const apres = await prisma.user.findUnique({ where: { id: buyer.id } });
    expect(apres.firstname).toBe(avant.firstname);
    expect(apres.lastname).toBe(avant.lastname);
  });

  it('refuse une mise a jour sans authentification', async () => {
    const res = await client.patch('/api/v2/auth/me').send({ firstname: 'Intrus' });
    expect(res.status).toBe(401);
  });
});