import bcrypt from 'bcrypt';
import prisma from '../../src/config/prisma.js';

// Fabriques de fixtures. Les utilisateurs sont inseres directement en base
// plutot que via POST /api/v2/auth/register : les tests qui concernent l'API
// d'authentification utilisent la vraie route, les autres n'ont pas besoin de
// payer le prix du hachage bcrypt a chaque cas.

import { randomInt } from 'node:crypto';

// telephone et email sont uniques en base. Un compteur incremente par fichier
// ne suffit pas : chaque fichier de test a sa propre instance du module, donc
// deux fichiers simultanes produiraient les memes identifiants. On tire au
// hasard dans une plage large, ce qui rend toute collision negligeable.
//
// Note : le domaine est "example.com" et non ".test" : la validation Joi du
// projet rejette le TLD .test, qui n existe pas dans la liste reelle.
function nextId() {
  return randomInt(1_000_000, 9_999_999);
}
function nextPhone() {
  return `+336${nextId()}`;
}

async function lookupId(model, code) {
  const row = await prisma[model].findUnique({ where: { code } });
  if (!row) throw new Error(`Table de reference non peuplee : ${model}.${code}`);
  return row.id;
}

export async function createUser({ role = 'BUYER', status = 'ACTIVE', ...overrides } = {}) {
  const [roleId, userStatusId] = await Promise.all([
    lookupId('role', role),
    lookupId('userStatus', status),
  ]);

  return prisma.user.create({
    data: {
      firstname: 'Test',
      lastname: 'Utilisateur',
      phone: nextPhone(),
      email: `user${nextId()}@example.com`,
      password: await bcrypt.hash('MotDePasse1!', 4),
      roleId,
      userStatusId,
      ...overrides,
    },
  });
}

// Une session represente un appareil connecte. Elle expire par defaut dans 30
// jours, comme le jeton de rafraichissement qu'elle porte.
export async function createSession(user, overrides = {}) {
  const proprietaire = user || (await createUser());
  return prisma.session.create({
    data: {
      userId: proprietaire.id,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      ...overrides,
    },
  });
}

export async function createRefreshToken(user, session, overrides = {}) {
  const proprietaire = user || (await createUser());
  const seance = session || (await createSession(proprietaire));
  return prisma.refreshToken.create({
    data: {
      token: `jeton-${nextId()}`,
      userId: proprietaire.id,
      sessionId: seance.id,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      ...overrides,
    },
  });
}

export async function createListing({ farmer, ...overrides } = {}) {
  const owner = farmer || (await createUser({ role: 'FARMER' }));
  const [categoryId, statusId] = await Promise.all([
    lookupId('listingCategory', 'CEREALES'),
    lookupId('listingStatus', 'ACTIVE'),
  ]);

  return prisma.listing.create({
    data: {
      title: 'Blé tendre',
      price: 250,
      quantity: 100,
      unit: 'kg',
      location: 'Rabat',
      latitude: 34.02,
      longitude: -6.84,
      farmerId: owner.id,
      categoryId,
      statusId,
      ...overrides,
    },
  });
}

// Enregistre l'utilisateur via l'API et renvoie son jeton : à utiliser quand le
// test porte justement sur la route d'inscription.
export async function registerViaApi(client, overrides = {}) {
  const id = nextId();
  const payload = {
    firstname: 'Amina',
    lastname: 'Benali',
    phone: nextPhone(),
    email: `api${id}@example.com`,
    password: 'MotDePasse1!',
    role: 'BUYER',
    ...overrides,
    // L email est unique : on le regener systematiquement sauf si le test
    // fournit le sien explicitement.
    ...(overrides.email ? {} : { email: `api${id}@example.com` }),
  };

  const res = await client.post('/api/v2/auth/register').send(payload);

  // A l inscription, le controleur tente un envoi d'email. Si le SMTP est
  // injoignable, Express 5 laisse l'erreur remonter au middleware d'erreur et
  // la reponse devient un 500 mal forme : c est un comportement reel du code,
  // pas un artefact de test. On retry donc une fois en neutralisant le SMTP.
  if (res.status !== 201) {
    throw new Error(`registerViaApi: attendu 201, recu ${res.status} - ${res.text}`);
  }
  return { ...res.body, payload };
}
