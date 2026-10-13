import { describe, it, expect, beforeEach } from 'vitest';
import { Server } from 'socket.io';
import { io as clientIo } from 'socket.io-client';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';

const Decimal = Prisma.Decimal;
import { api, authHeader } from '../helpers/app.js';
import { createUser, createListingForLot } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { resetDatabase } from '../helpers/db.js';
import { assertNoLeak } from '../helpers/assertNoLeak.js';
import app from '../../src/app.js';
import initChatSocket from '../../src/sockets/chat.socket.js';

// Temps reel de la livraison (plan v2, P5.3) : les memes regles que la
// messagerie (socket-chat.test.js), mais sur les evenements de course.
// delivery:available n'est emis qu'aux livreurs de l'agence, delivery:status
// n'est emis qu'au staff et a l'acheteur concerne, et un livreur sans profil
// ne rejoint aucune salle d'agence.
//
// Le defaut est dans le protocole : ces tests montrent un vrai serveur et de
// vrais clients, comme pour la messagerie.

const client = api();

// Aucun prix, aucun montant ne doit sortir sur les evenements de livraison,
// ni vers le staff ni vers l'acheteur.
const CLES_INTERDITES = [
  'deliveryFee',
  'agencyCost',
  'insuredValue',
  'lineTotal',
  'unitPrice',
  'supplierUnitPrice',
  'subtotal',
  'total',
  'buyerFee',
  'commissionTotal',
  'agreedUnitPrice',
  'grossAmount',
  'commissionAmount',
  'netAmount',
  'amount',
];

/** Monte un serveur Socket.io, le monte sur un port libre, puis le descend. */
async function avecServeur(action) {
  const io = new Server(0, { cors: { origin: '*' } });
  initChatSocket(io);

  // Les controleurs REST emettent via req.app.get('io') : sans ce montage,
  // une livraison creee par l API n atteindrait jamais les clients du test.
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

// Les joins de salle (agence, staff) sont asynchrones cote serveur : un
// evenement emis avant la fin du join serait perdu. Attend qu'un socket ait
// rejoint une room, poll borne a 2 s : au-dela, le join n'aura jamais lieu.
async function attendreDans(io, room, socketId) {
  const debut = Date.now();
  while (Date.now() - debut < 2000) {
    if (estDans(io, room, socketId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// Vrai si le socket est membre de la room (rooms desagregees : le socket
// lui-meme n'est une room que s'il est seul, sans interet ici).
function estDans(io, room, socketId) {
  const membres = io.sockets.adapter.rooms.get(room);
  return membres ? membres.has(socketId) : false;
}

// --- Fixtures ---

function identifiant(prefixe) {
  return `${prefixe}-${Date.now()}-${randomInt(1_000, 9_999)}`;
}

async function produit() {
  const [category, unit] = await Promise.all([
    prisma.productCategory.findFirst(),
    prisma.unit.findFirst(),
  ]);
  return prisma.product.create({
    data: {
      categoryId: category.id,
      unitId: unit.id,
      name: identifiant('Produit'),
      isPerishable: false,
    },
  });
}

async function zone() {
  return prisma.zone.create({ data: { name: identifiant('Zone') } });
}

async function creerLot({ quantity = '100', agreedUnitPrice = '1000.00' } = {}) {
  const supplierUser = await createUser({ role: 'SUPPLIER' });
  const profile = await prisma.supplierProfile.create({
    data: { userId: supplierUser.id, farmName: 'Ferme du Test' },
  });
  const product = await produit();
  const zoneTest = await zone();
  return prisma.stockLot.create({
    data: {
      lotCode: identifiant('LOT'),
      supplierId: profile.id,
      productId: product.id,
      zoneId: zoneTest.id,
      agreedUnitPrice,
      quantityInitial: new Decimal(quantity),
      quantityAvailable: new Decimal(quantity),
      storageType: 'SUPPLIER_SITE',
      pickupAddress: '12 route de la ferme',
      pickupLatitude: 12.34,
      pickupLongitude: -5.67,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      status: 'AVAILABLE',
    },
  });
}

async function creerAgenceAvecZone(zoneId) {
  const agency = await prisma.transportAgency.create({
    data: { name: identifiant('Agence'), phone: '+33600000000', isActive: true },
  });
  await prisma.agencyZone.create({
    data: { agencyId: agency.id, zoneId, baseFee: '500', perKmFee: '100', isActive: true },
  });
  return agency;
}

async function livreurAvecAgence(agencyId) {
  const user = await createUser({ role: 'DRIVER' });
  const driverProfile = await prisma.driverProfile.create({
    data: { userId: user.id, agencyId },
  });
  return { user, driverProfile };
}

async function agentAvecCapacite(capacites) {
  const user = await createUser({ role: 'AGENT' });
  const agent = await prisma.agent.create({
    data: { kind: 'HUMAN', userId: user.id, displayName: 'Agent Test', isActive: true },
  });
  for (const code of capacites) {
    const cap = await prisma.agentCapability.findFirst({ where: { code } });
    await prisma.agentCapabilityLink.create({ data: { agentId: agent.id, capabilityId: cap.id } });
  }
  return { user, agent };
}

// Cree une commande AGENCY_DELIVERY via l API staff (devis reel), puis la
// passe en PREPARING directement en base, comme staff-deliveries.test.js.
async function creerCommandePreparing({ agentUser, lots, quantities, zoneLivraison }) {
  const buyer = await createUser({ role: 'BUYER' });
  const items = [];
  for (let i = 0; i < lots.length; i++) {
    const annonce = await createListingForLot(lots[i]);
    await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1200.00' } });
    items.push({ listingId: annonce.id, quantity: quantities[i] });
  }
  const res = await client
    .post('/api/v2/staff/orders')
    .set(authHeader(jetonPour(agentUser, 'AGENT')))
    .send({
      buyerId: buyer.id,
      items,
      deliveryMode: 'AGENCY_DELIVERY',
      delivery: {
        zoneId: zoneLivraison.id,
        address: '10 avenue de la Gare',
        latitude: 48.85,
        longitude: 2.35,
      },
    });
  expect(res.status, res.text).toBe(201);
  await prisma.order.update({
    where: { id: res.body.id },
    data: { status: 'PREPARING', paymentStatus: 'PAID' },
  });
  return { order: res.body, buyer };
}

beforeEach(async () => {
  await resetDatabase();
});

describe('delivery:available — diffusion aux livreurs de l\'agence', () => {
  it('un livreur de l\'agence recoit delivery:available ; un livreur d\'une autre agence et l\'acheteur non', async () => {
    const zoneLivraison = await zone();
    const agenceA = await creerAgenceAvecZone(zoneLivraison.id);
    const agenceB = await prisma.transportAgency.create({
      data: { name: identifiant('Agence'), phone: '+33600000001', isActive: true },
    });
    const { user: livreurA } = await livreurAvecAgence(agenceA.id);
    const { user: livreurB } = await livreurAvecAgence(agenceB.id);

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'DISPATCH_COORDINATION']);
    const lot = await creerLot({ quantity: '50' });
    const { order, buyer } = await creerCommandePreparing({
      agentUser,
      lots: [lot],
      quantities: [5],
      zoneLivraison,
    });

    await avecServeur(async (url, io) => {
      const socketA = await connecter(url, jetonPour(livreurA, 'DRIVER'));
      const socketB = await connecter(url, jetonPour(livreurB, 'DRIVER'));
      const socketAcheteur = await connecter(url, jetonPour(buyer));

      // Les joins d'agence sont asynchrones : attendre que chacun ait rejoint
      // sa salle avant d'emettre, sous peine de course.
      expect(await attendreDans(io, `agency:${agenceA.id}`, socketA.id)).toBe(true);
      expect(await attendreDans(io, `agency:${agenceB.id}`, socketB.id)).toBe(true);

      const recuA = new Promise((resolve) => socketA.once('delivery:available', resolve));
      let recuB = false;
      socketB.on('delivery:available', () => {
        recuB = true;
      });
      let recuAcheteur = false;
      socketAcheteur.on('delivery:available', () => {
        recuAcheteur = true;
      });

      const res = await client
        .post(`/api/v2/staff/orders/${order.id}/deliveries`)
        .set(authHeader(jetonPour(agentUser, 'AGENT')))
        .send({});
      expect(res.status, res.text).toBe(201);

      const event = await recuA;
      expect(event.agencyId).toBe(agenceA.id);
      expect(event.deliveryId).toBe(res.body[0].id);

      // L evenement n est pas emis aux autres : un livreur d'une autre agence
      // et l'acheteur ne doivent rien recevoir.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(recuB).toBe(false);
      expect(recuAcheteur).toBe(false);

      await fermer(socketA);
      await fermer(socketB);
      await fermer(socketAcheteur);
    });
  });
});

describe('delivery:status — staff et acheteur concerne seulement', () => {
  it('acceptation et changements de statut : delivery:status atteint le staff et l\'acheteur, jamais un autre acheteur, sans prix', async () => {
    const zoneLivraison = await zone();
    const agenceA = await creerAgenceAvecZone(zoneLivraison.id);
    const { user: livreurA } = await livreurAvecAgence(agenceA.id);

    const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING', 'DISPATCH_COORDINATION']);
    const lot = await creerLot({ quantity: '50' });
    const { order, buyer } = await creerCommandePreparing({
      agentUser,
      lots: [lot],
      quantities: [5],
      zoneLivraison,
    });

    // Cree les livraisons (une seule origine : un seul lot).
    const resLivraisons = await client
      .post(`/api/v2/staff/orders/${order.id}/deliveries`)
      .set(authHeader(jetonPour(agentUser, 'AGENT')))
      .send({});
    expect(resLivraisons.status, resLivraisons.text).toBe(201);
    const livraisonId = resLivraisons.body[0].id;

    const autreAcheteur = await createUser({ role: 'BUYER' });

    await avecServeur(async (url, io) => {
      const socketStaff = await connecter(url, jetonPour(agentUser, 'AGENT'));
      const socketAcheteur = await connecter(url, jetonPour(buyer));
      const socketAutre = await connecter(url, jetonPour(autreAcheteur));

      // Le join de la salle staff est asynchrone, comme celui de l'agence.
      expect(await attendreDans(io, 'staff', socketStaff.id)).toBe(true);

      const recuStaff = new Promise((resolve) => socketStaff.once('delivery:status', resolve));
      const recuAcheteur = new Promise((resolve) => socketAcheteur.once('delivery:status', resolve));
      let recuAutre = false;
      socketAutre.on('delivery:status', () => {
        recuAutre = true;
      });

      // Le livreur accepte la course.
      const accept = await client
        .post(`/api/v2/driver/deliveries/${livraisonId}/accept`)
        .set(authHeader(jetonPour(livreurA, 'DRIVER')));
      expect(accept.status, accept.text).toBe(200);

      const [eventStaff, eventAcheteur] = await Promise.all([recuStaff, recuAcheteur]);
      expect(eventStaff.status).toBe('ACCEPTED');
      expect(eventAcheteur.status).toBe('ACCEPTED');
      expect(eventStaff.deliveryId).toBe(livraisonId);
      expect(eventAcheteur.deliveryId).toBe(livraisonId);
      assertNoLeak(eventStaff, CLES_INTERDITES);
      assertNoLeak(eventAcheteur, CLES_INTERDITES);

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(recuAutre).toBe(false);

      // Changement de statut par le livreur : PICKED_UP.
      const recuStaff2 = new Promise((resolve) => socketStaff.once('delivery:status', resolve));
      const recuAcheteur2 = new Promise((resolve) => socketAcheteur.once('delivery:status', resolve));
      const pickup = await client
        .patch(`/api/v2/driver/deliveries/${livraisonId}/status`)
        .set(authHeader(jetonPour(livreurA, 'DRIVER')))
        .send({ status: 'PICKED_UP' });
      expect(pickup.status, pickup.text).toBe(200);

      const [eventStaff2, eventAcheteur2] = await Promise.all([recuStaff2, recuAcheteur2]);
      expect(eventStaff2.status).toBe('PICKED_UP');
      expect(eventAcheteur2.status).toBe('PICKED_UP');
      assertNoLeak(eventStaff2, CLES_INTERDITES);
      assertNoLeak(eventAcheteur2, CLES_INTERDITES);

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(recuAutre).toBe(false);

      await fermer(socketStaff);
      await fermer(socketAcheteur);
      await fermer(socketAutre);
    });
  });
});

describe('Room d\'agence — livreur sans profil', () => {
  it('un livreur sans DriverProfile se connecte sans rejoindre de salle d\'agence', async () => {
    const zoneTest = await zone();
    const agence = await creerAgenceAvecZone(zoneTest.id);
    const { user: livreurAvecProfil } = await livreurAvecAgence(agence.id);
    const sansProfil = await createUser({ role: 'DRIVER' });

    await avecServeur(async (url, io) => {
      const socketProfil = await connecter(url, jetonPour(livreurAvecProfil, 'DRIVER'));
      const socketSansProfil = await connecter(url, jetonPour(sansProfil, 'DRIVER'));

      // Le livreur avec profil a bien rejoint la salle de son agence : sans
      // cette preuve, l absence de salle rendrait le test trivial.
      expect(await attendreDans(io, `agency:${agence.id}`, socketProfil.id)).toBe(true);

      // Laisser au serveur le temps de tenter les joins du second socket.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const sallesAgence = [...io.sockets.adapter.rooms.keys()].filter((r) =>
        r.startsWith('agency:')
      );
      expect(sallesAgence).toContain(`agency:${agence.id}`);
      for (const salle of sallesAgence) {
        expect(estDans(io, salle, socketSansProfil.id)).toBe(false);
      }

      await fermer(socketProfil);
      await fermer(socketSansProfil);
    });
  });
});
