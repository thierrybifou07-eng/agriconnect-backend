import { describe, it, expect, beforeEach } from 'vitest';
import { Server } from 'socket.io';
import { io as clientIo } from 'socket.io-client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { resetDatabase } from '../helpers/db.js';
import { assertNoLeak } from '../helpers/assertNoLeak.js';
import app from '../../src/app.js';
import initChatSocket from '../../src/sockets/chat.socket.js';
import {
  MESSAGE_NEW,
  ERROR_MESSAGE,
  CONVERSATION_ASSIGNED,
  CONVERSATION_ESCALATED,
} from '../../src/services/message.service.js';
import {UserStatusCode} from "../../src/utils/enums/enums.helpers.js";

// Temps reel de la messagerie (plan v2, P3.2). Les memes regles que l API
// REST, mais sur socket : un client ne voit que ses conversations, une note
// interne ne sort jamais de l equipe, et le cycle de vie d une conversation
// est notifie a l equipe seulement.
//
// Le defaut est dans le protocole : ces tests montent un vrai serveur et de
// vrais clients, comme pour la suspension (socket-revocation.test.js).

const client = api();

// Aucun identifiant d agent ni d utilisateur tiers ne doit sortir vers le
// client, y compris en temps reel.
const CLES_INTERDITES = ['assignedAgentId', 'senderAgentId', 'senderUserId', 'customerId'];

/** Monte un serveur Socket.io, le monte sur un port libre, puis le descend. */
async function avecServeur(action) {
  const io = new Server(0, { cors: { origin: '*' } });
  initChatSocket(io);

  // Les controleurs REST emettent via req.app.get('io') : sans ce montage,
  // un message envoye par l API n atteindrait jamais les clients du test.
  // L instance est retiree dans finally, pour ne pas contaminer les autres
  // fichiers de test qui partagent la meme application Express.
  app.set('io', io);

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
    app.set('io', undefined);
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

const jetonPour = (user, role = 'BUYER') =>
  generateToken({ id: user.id, role, userStatus: 'ACTIVE' });

// Emmet join_conversation et attend l accuse serveur. Le traitement cote
// serveur est asynchrone (lectures en base) : seule la promesse garantit que
// la room est rejointe, ce qui evite toute course avec l emission suivante
// (leave, send_message, message REST). En cas de refus, l evenement
// error_message reste le diagnostic affiche au client.
const rejoindre = (socket, conversationId) =>
  new Promise((resolve, reject) => {
    socket.emit('join_conversation', conversationId, (ack) => {
      if (ack && ack.ok) return resolve();
      reject(new Error('join refuse par le serveur'));
    });
  });

// Creer un agent HUMAN avec ses capacites, comme conversations.test.js.
async function createAgentUser({ capabilities = [] } = {}) {
  const user = await createUser({ role: 'AGENT' });
  const agent = await prisma.agent.create({
    data: { kind: 'HUMAN', userId: user.id, displayName: 'Agent Test', isActive: true },
  });
  if (capabilities.length > 0) {
    const rows = await prisma.agentCapability.findMany({
      where: { code: { in: capabilities } },
      select: { id: true },
    });
    await prisma.agentCapabilityLink.createMany({
      data: rows.map((row) => ({ agentId: agent.id, capabilityId: row.id })),
    });
  }
  return { user, agent };
}

// Une conversation d acheteur ouverte via l API, comme le ferait l appli.
async function conversationAcheteur() {
  const buyer = await createUser({ role: 'BUYER' });
  const res = await client
    .post('/api/v2/conversations')
    .set(authHeader(jetonPour(buyer)))
    .send({ content: 'Question acheteur' });
  return { buyer, conversation: res.body };
}

beforeEach(async () => {
  await resetDatabase();
});

describe('message:new — diffusion vers la conversation', () => {
  it('le client et l agent rejoignent la conversation et recoivent message:new', async () => {
    const { buyer, conversation } = await conversationAcheteur();
    const { user: agentUser } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    await avecServeur(async (url) => {
      const socketClient = await connecter(url, jetonPour(buyer));
      await rejoindre(socketClient, conversation.id);
      const socketAgent = await connecter(url, jetonPour(agentUser, 'AGENT'));
      await rejoindre(socketAgent, conversation.id);

      const recuClient = new Promise((resolve) => socketClient.once(MESSAGE_NEW, resolve));
      const recuAgent = new Promise((resolve) => socketAgent.once(MESSAGE_NEW, resolve));

      socketClient.emit('send_message', { conversationId: conversation.id, content: 'Bonjour l equipe' });

      const [c, a] = await Promise.all([recuClient, recuAgent]);
      expect(c.content).toBe('Bonjour l equipe');
      expect(c.senderLabel).toBe('Vous');
      expect(a.content).toBe('Bonjour l equipe');

      // Le DTO client est le seul qui passe sur la salle de conversation :
      // l agent le recoit aussi, donc aucune identite ne peut y figurer.
      assertNoLeak(c, CLES_INTERDITES);

      // L ecriture a bien eu lieu, au nom du client.
      const enBase = await prisma.message.findFirst({
        where: { conversationId: conversation.id, senderType: 'CUSTOMER' },
        orderBy: { createdAt: 'desc' },
      });
      expect(enBase.content).toBe('Bonjour l equipe');
      expect(enBase.senderUserId).toBe(buyer.id);

      await fermer(socketClient);
      await fermer(socketAgent);
    });
  });

  it('un message public de l equipe (REST) parvient au client dans la salle', async () => {
    const { buyer, conversation } = await conversationAcheteur();
    const { user: agentUser } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    await avecServeur(async (url) => {
      const socketClient = await connecter(url, jetonPour(buyer));
      await rejoindre(socketClient, conversation.id);

      const recu = new Promise((resolve) => socketClient.once(MESSAGE_NEW, resolve));

      const reponse = await client
        .post(`/api/v2/staff/conversations/${conversation.id}/messages`)
        .set(authHeader(jetonPour(agentUser, 'AGENT')))
        .send({ content: 'Reponse de l equipe' });
      expect(reponse.status, reponse.text).toBe(201);

      const message = await recu;
      expect(message.content).toBe('Reponse de l equipe');
      expect(message.senderLabel).toBe('Équipe AgriConnect');
      assertNoLeak(message, CLES_INTERDITES);

      await fermer(socketClient);
    });
  });
});

describe('Notes internes — salle staff seulement', () => {
  it('le client ne recoit PAS une note interne ; l equipe si', async () => {
    const { buyer, conversation } = await conversationAcheteur();
    const { user: agentUser, agent } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    await avecServeur(async (url) => {
      const socketClient = await connecter(url, jetonPour(buyer));
      await rejoindre(socketClient, conversation.id);
      // L agent rejoint la salle staff automatiquement a sa connexion.
      const socketAgent = await connecter(url, jetonPour(agentUser, 'AGENT'));

      // On note la reception plutot que d'attendre l'inverse : attendre une
      // promesse qui ne doit pas resoudre reviendrait a tester autre chose.
      let recuClient = false;
      socketClient.on(MESSAGE_NEW, () => {
        recuClient = true;
      });
      const noteRecue = new Promise((resolve) => socketAgent.once(MESSAGE_NEW, resolve));

      const reponse = await client
        .post(`/api/v2/staff/conversations/${conversation.id}/messages`)
        .set(authHeader(jetonPour(agentUser, 'AGENT')))
        .send({ content: 'Note interne : verifier le stock', isInternal: true });
      expect(reponse.status, reponse.text).toBe(201);

      // L equipe recoit la note avec son identite complete (DTO staff).
      const note = await noteRecue;
      expect(note.content).toBe('Note interne : verifier le stock');
      expect(note.isInternal).toBe(true);
      expect(note.senderType).toBe('AGENT');
      expect(note.senderAgentId).toBe(agent.id);

      // Le client est dans conversation:{id} mais pas dans staff : la note
      // ne doit pas lui parvenir.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(recuClient).toBe(false);

      await fermer(socketClient);
      await fermer(socketAgent);
    });
  });
});

describe('Controle d acces sur join_conversation et send_message', () => {
  it('join_conversation d une conversation d autrui : refuse, et le socket ne recoit rien', async () => {
    const { buyer, conversation } = await conversationAcheteur();
    const autre = await createUser({ role: 'BUYER' });

    await avecServeur(async (url) => {
      const socketAutre = await connecter(url, jetonPour(autre));

      const refus = new Promise((resolve) => socketAutre.once(ERROR_MESSAGE, resolve));
      socketAutre.emit('join_conversation', conversation.id);
      expect(await refus).toEqual({ error: 'Accès refusé' });

      // La preuve qu il n a pas rejoint : les messages de la conversation ne
      // lui parviennent pas.
      let recu = false;
      socketAutre.on(MESSAGE_NEW, () => {
        recu = true;
      });
      await client
        .post(`/api/v2/conversations/${conversation.id}/messages`)
        .set(authHeader(jetonPour(buyer)))
        .send({ content: 'Message prive' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(recu).toBe(false);

      await fermer(socketAutre);
    });
  });

  it('send_message dans une conversation d autrui : refuse, rien n est ecrit', async () => {
    const { conversation } = await conversationAcheteur();
    const autre = await createUser({ role: 'BUYER' });

    await avecServeur(async (url) => {
      const socketAutre = await connecter(url, jetonPour(autre));

      const refus = new Promise((resolve) => socketAutre.once(ERROR_MESSAGE, resolve));
      socketAutre.emit('send_message', {
        conversationId: conversation.id,
        content: 'Je reponds a sa place',
      });
      expect(await refus).toEqual({ error: 'Accès refusé' });

      // Seul le premier message (creation de la conversation) existe.
      expect(await prisma.message.count({ where: { conversationId: conversation.id } })).toBe(1);

      await fermer(socketAutre);
    });
  });

  it('un agent sans la capacite du type ne peut pas rejoindre la conversation', async () => {
    const { conversation } = await conversationAcheteur();
    // Agent fournisseur uniquement : la conversation est BUYER_SUPPORT.
    const { user: agentUser } = await createAgentUser({ capabilities: ['SUPPLIER_SUPPORT'] });

    await avecServeur(async (url) => {
      const socketAgent = await connecter(url, jetonPour(agentUser, 'AGENT'));

      const refus = new Promise((resolve) => socketAgent.once(ERROR_MESSAGE, resolve));
      socketAgent.emit('join_conversation', conversation.id);
      expect(await refus).toEqual({ error: 'Accès refusé' });

      await fermer(socketAgent);
    });
  });

  it('send_message sans content : refuse, rien n est ecrit', async () => {
    const { buyer, conversation } = await conversationAcheteur();

    await avecServeur(async (url) => {
      const socketClient = await connecter(url, jetonPour(buyer));

      const refus = new Promise((resolve) => socketClient.once(ERROR_MESSAGE, resolve));
      socketClient.emit('send_message', { conversationId: conversation.id, content: '   ' });
      expect(await refus).toEqual({ error: 'content est requis' });

      expect(await prisma.message.count({ where: { conversationId: conversation.id } })).toBe(1);

      await fermer(socketClient);
    });
  });

  it('compte suspendu : connexion refusee (comportement conserve)', async () => {
    const user = await createUser({ status: UserStatusCode.SUSPENDED });

    await avecServeur(async (url) => {
      await expect(connecter(url, jetonPour(user))).rejects.toThrow(/suspend/i);
    });
  });
});

describe('Cycle de vie — notifications staff', () => {
  it('assign et escalate sont notifies a la salle staff, pas au client', async () => {
    const { buyer, conversation } = await conversationAcheteur();
    const { user: agentUser, agent } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    await avecServeur(async (url) => {
      // L agent rejoint la salle staff des sa connexion.
      const socketAgent = await connecter(url, jetonPour(agentUser, 'AGENT'));
      const socketClient = await connecter(url, jetonPour(buyer));

      // Le client ne doit jamais voir le cycle de vie de la conversation.
      let recuClient = false;
      socketClient.on(CONVERSATION_ESCALATED, () => {
        recuClient = true;
      });

      const assignRecu = new Promise((resolve) => socketAgent.once(CONVERSATION_ASSIGNED, resolve));
      const resAssign = await client
        .post(`/api/v2/staff/conversations/${conversation.id}/assign`)
        .set(authHeader(jetonPour(agentUser, 'AGENT')))
        .send({});
      expect(resAssign.status, resAssign.text).toBe(200);

      const assign = await assignRecu;
      expect(assign.assignedAgentId).toBe(agent.id);

      const escalateRecu = new Promise((resolve) => socketAgent.once(CONVERSATION_ESCALATED, resolve));
      const resEscalate = await client
        .post(`/api/v2/staff/conversations/${conversation.id}/escalate`)
        .set(authHeader(jetonPour(agentUser, 'AGENT')))
        .send({ reason: 'Litige sur le prix' });
      expect(resEscalate.status, resEscalate.text).toBe(200);

      const escalate = await escalateRecu;
      expect(escalate.escalatedAt).toBeTruthy();
      expect(escalate.escalationReason).toBe('Litige sur le prix');
      // L escalade desassigne : la conversation repart dans la file commune.
      expect(escalate.assignedAgentId).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(recuClient).toBe(false);

      await fermer(socketAgent);
      await fermer(socketClient);
    });
  });
});

describe('leave_conversation', () => {
  it('un client qui quitte la salle ne recoit plus les messages', async () => {
    const { buyer, conversation } = await conversationAcheteur();
    const { user: agentUser } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    await avecServeur(async (url) => {
      const socketClient = await connecter(url, jetonPour(buyer));
      await rejoindre(socketClient, conversation.id);
      const socketAgent = await connecter(url, jetonPour(agentUser, 'AGENT'));
      await rejoindre(socketAgent, conversation.id);

      // Le client quitte la salle de conversation.
      socketClient.emit('leave_conversation', conversation.id);

      const recuAgent = new Promise((resolve) => socketAgent.once(MESSAGE_NEW, resolve));
      let recuClient = false;
      socketClient.on(MESSAGE_NEW, () => {
        recuClient = true;
      });

      socketAgent.emit('send_message', {
        conversationId: conversation.id,
        content: 'Message apres le depart du client',
      });

      const message = await recuAgent;
      expect(message.content).toBe('Message apres le depart du client');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(recuClient).toBe(false);

      await fermer(socketClient);
      await fermer(socketAgent);
    });
  });
});
