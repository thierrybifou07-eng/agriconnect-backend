import { describe, it, expect } from 'vitest';
import { Server } from 'socket.io';
import { io as clientIo } from 'socket.io-client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import initChatSocket from '../../src/sockets/chat.socket.js';
import { emitSessionRevoked, userRoom, SESSION_REVOKED } from '../../src/sockets/revocation.js';

// Le blocage d'un compte se faisait en trois points sur quatre : protect, login et
// refresh. Le quatrieme etait le websocket. Ces tests montent un vrai serveur et
// de vrais clients parce que le defaut est dans le protocole : aucun appel HTTP
// ne verrait passer une connexion qui reste ouverte apres une suspension.

const client = api();

/** Monte un serveur Socket.io, le monte sur un port libre, puis le descend. */
async function avecServeur(action) {
  const io = new Server(0, { cors: { origin: '*' } });
  initChatSocket(io);

  // L'attente se fait sur le serveur HTTP sous-jacent, pas sur l'instance
  // Socket.io : celle-ci ne relaie pas 'listening', et l'attente ne se resout
  // donc jamais. La garde sur `listening` couvre le cas ou le port est deja
  // ouvert au moment de l'abonnement.
  await new Promise((resolve) => {
    if (io.httpServer.listening) return resolve();
    io.httpServer.once('listening', resolve);
  });

  const url = `http://127.0.0.1:${io.httpServer.address().port}`;

  try {
    return await action(url, io);
  } finally {
    // io.close() est asynchrone sans garantie de rappel : on borne l'attente
    // plutot que de risquer de bloquer toute la suite sur un test.
    await Promise.race([
      new Promise((resolve) => io.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
}

/** Connexion cliente : resolue a la connexion, rejetee sinon. */
function connecter(url, token) {
  return new Promise((resolve, reject) => {
    const socket = clientIo(url, { auth: { token }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

// La fermeture se resout sur l'evenement 'disconnect' et non sur le rappel de
// socket.close(), que cette version de socket.io-client n'appelle pas toujours.
// L'evenement, lui, survient toujours : c'est la seule resolution fiable.
const fermer = (socket) =>
  new Promise((resolve) => {
    if (!socket || !socket.connected) return resolve();
    socket.once('disconnect', () => resolve());
    socket.close();
  });

/** Promise resolue quand le socket se deconnecte, rejetee s'il ne le fait pas. */
const deconnexion = (socket, delaiMs = 3000) =>
  new Promise((resolve, reject) => {
    const minuteur = setTimeout(
      () => reject(new Error('le socket ne s est pas deconnecte')),
      delaiMs
    );
    socket.once('disconnect', () => {
      clearTimeout(minuteur);
      resolve();
    });
  });

const jetonPour = (user, statut = 'ACTIVE') =>
  generateToken({ id: user.id, role: 'BUYER', userStatus: statut });

const rootToken = async () => {
  const root = await createUser({ role: 'ROOT' });
  return { root, token: generateToken({ id: root.id, role: 'ROOT' }) };
};

const statutDe = async (userId) =>
  (await prisma.user.findUnique({ where: { id: userId }, include: { userStatus: true } }))
    .userStatus.code;

describe('Connexion au socket', () => {
  it('accepte un compte actif', async () => {
    const user = await createUser();

    await avecServeur(async (url) => {
      const socket = await connecter(url, jetonPour(user));
      expect(socket.connected).toBe(true);
      await fermer(socket);
    });
  });

  // C'est le defaut verrouille ici : le jeton annonce ACTIVE alors que la base
  // dit SUSPENDED. Seul un controle en base peut l'attraper, et il manquait.
  it('refuse un compte suspendu, la ou le jeton ne le dit pas', async () => {
    const user = await createUser({ status: 'SUSPENDED' });

    await avecServeur(async (url) => {
      await expect(connecter(url, jetonPour(user, 'ACTIVE'))).rejects.toThrow(/suspend/i);
    });
  });

  it('refuse un compte inexistant', async () => {
    await avecServeur(async (url) => {
      const jeton = generateToken({ id: 999999, role: 'BUYER', userStatus: 'ACTIVE' });
      await expect(connecter(url, jeton)).rejects.toThrow(/introuvable/i);
    });
  });

  it('refuse un jeton invalide', async () => {
    await avecServeur(async (url) => {
      await expect(connecter(url, 'pas-un-jeton')).rejects.toThrow(/invalide/i);
    });
  });

  it('refuse une connexion sans jeton', async () => {
    await avecServeur(async (url) => {
      await expect(connecter(url, undefined)).rejects.toThrow(/requise/i);
    });
  });
});

describe('Suspension : les sessions tombent', () => {
  // Suspendre sans couper les sessions laissait un acces reel : les jetons
  // restaient valides et le compte pouvait se reconnecter par refresh.
  it('ferme les sessions du compte suspendu', async () => {
    const { token } = await rootToken();
    const user = await createUser();

    await client.post('/api/auth/login').send({ email: user.email, password: 'MotDePasse1!' });
    expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(1);

    await client.patch(`/api/admin/users/${user.id}/suspend`).set(authHeader(token));

    expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revoked: false } })).toBe(0);
  });

  it('empeche le compte suspendu de se reconnecter par refresh', async () => {
    const { token } = await rootToken();
    const user = await createUser();

    const login = await client.post('/api/auth/login').send({
      email: user.email,
      password: 'MotDePasse1!',
    });
    expect(login.status).toBe(200);

    await client.patch(`/api/admin/users/${user.id}/suspend`).set(authHeader(token));

    const res = await client
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });
    expect(res.status).toBe(401);
  });

  it('laisse les sessions d un autre compte intactes', async () => {
    const { token } = await rootToken();
    const sanctionne = await createUser();
    const temoin = await createUser();

    for (const user of [sanctionne, temoin]) {
      await client.post('/api/auth/login').send({ email: user.email, password: 'MotDePasse1!' });
    }

    await client.patch(`/api/admin/users/${sanctionne.id}/suspend`).set(authHeader(token));

    expect(await prisma.session.count({ where: { userId: temoin.id, revokedAt: null } })).toBe(1);
  });

  // Sans instance Socket.io, le signalement ne doit pas faire echouer la
  // suspension : c'est ce qui permet de tester le controleur sans serveur.
  it('suspend quand meme quand aucun serveur Socket.io n est monte', async () => {
    const { token } = await rootToken();
    const user = await createUser();

    const res = await client.patch(`/api/admin/users/${user.id}/suspend`).set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(await statutDe(user.id)).toBe('SUSPENDED');
    expect(emitSessionRevoked(null, user.id)).toBe(false);
  });
});

describe('Suspension : les websockets tombent', () => {
  it('deconnecte un socket ouvert au moment de la suspension', async () => {
    const { token } = await rootToken();
    const user = await createUser();

    await avecServeur(async (url, io) => {
      const socket = await connecter(url, jetonPour(user));
      const coupe = deconnexion(socket);

      // Le serveur emet dans la room de l'utilisateur ; le socket doit se
      // fermer seul, sans que le client ait a le demander.
      expect(emitSessionRevoked(io, user.id, 'account_suspended')).toBe(true);

      await coupe;
      expect(socket.connected).toBe(false);
      await fermer(socket);
    });
  });

  it('deconnecte toutes les connexions d un utilisateur, pas une seule', async () => {
    const user = await createUser();

    await avecServeur(async (url, io) => {
      const telephone = await connecter(url, jetonPour(user));
      const ordinateur = await connecter(url, jetonPour(user));

      const coupes = Promise.all([deconnexion(telephone), deconnexion(ordinateur)]);
      emitSessionRevoked(io, user.id, 'account_suspended');
      await coupes;

      await fermer(telephone);
      await fermer(ordinateur);
    });
  });

  it('ne deconnecte pas les sockets d un autre utilisateur', async () => {
    const cible = await createUser();
    const temoin = await createUser();

    await avecServeur(async (url, io) => {
      const socketCible = await connecter(url, jetonPour(cible));
      const socketTemoin = await connecter(url, jetonPour(temoin));

      // Le temoin doit NE PAS recevoir l'evenement : c'est cela qui prouve que
      // la room vise le bon utilisateur. On note donc sa reception plutot que
      // de l'attendre — attendre une promesse qui ne doit pas resoudre
      // reviendrait a tester l'inverse de ce qu'on veut.
      let recuParTemoin = false;
      socketTemoin.on(SESSION_REVOKED, () => {
        recuParTemoin = true;
      });

      const coupeCible = deconnexion(socketCible);
      emitSessionRevoked(io, cible.id, 'account_suspended');

      await coupeCible;
      // Laisse le temps a un eventuel evenement erroné d'arriver.
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(recuParTemoin).toBe(false);
      expect(socketTemoin.connected).toBe(true);

      await fermer(socketTemoin);
      await fermer(socketCible);
    });
  });

  it('porte la raison de la coupure, pour que le client sache quoi afficher', async () => {
    const user = await createUser();

    await avecServeur(async (url, io) => {
      const socket = await connecter(url, jetonPour(user));
      const evenement = new Promise((resolve) => socket.once(SESSION_REVOKED, resolve));

      emitSessionRevoked(io, user.id, 'account_suspended');

      // Distinguer "ton compte est suspendu" de "cette session a ete fermee" est
      // ce qui permet a l'application d'afficher la bonne chose.
      expect(await evenement).toEqual({ reason: 'account_suspended' });
      await fermer(socket);
    });
  });
});

describe('Room par utilisateur', () => {
  it('nomme la room de facon stable et non ambigue', () => {
    // La room se construit a partir de l'identifiant : deux utilisateurs
    // differents ne doivent jamais tomber dans la meme room.
    expect(userRoom(12)).toBe('user:12');
    expect(userRoom(12)).not.toBe(userRoom(121));
    expect(userRoom(12)).not.toBe(userRoom('12abc'));
  });
});
