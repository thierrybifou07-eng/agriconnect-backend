import { describe, it, expect } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createListing, createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { getLookupId } from '../../src/utils/lookupCache.js';

// B5 : Express donne toujours req.params sous forme de chaine, alors que toutes
// les cles primaires du schema sont des Int. Les 22 lectures
// `where: { id: req.params.id }` du projet repondaient donc 500
// "Argument `id`: Invalid value provided. Expected Int, provided String".
//
// Concretement, tout ce qui passe par une URL paramtree etait mort : detail d une
// annonce, mise a jour, suppression, detail d une commande, confirmation,
// annulation, messages d une conversation, acceptation et suivi d une
// livraison, suspension et reactivation d un compte.
//
// Ces tests couvrent la famille de routes entiere, pour que le cas ne puisse
// pas revenir par un seul forgot.

const client = api();

async function tokens() {
  const buyer = await createUser({ role: 'BUYER' });
  const farmer = await createUser({ role: 'FARMER' });
  const driver = await createUser({ role: 'DRIVER' });
  const admin = await createUser({ role: 'ADMIN' });
  return {
    buyer,
    farmer,
    driver,
    admin,
    buyerToken: generateToken({ id: buyer.id, role: 'BUYER' }),
    farmerToken: generateToken({ id: farmer.id, role: 'FARMER' }),
    driverToken: generateToken({ id: driver.id, role: 'DRIVER' }),
    adminToken: generateToken({ id: admin.id, role: 'ADMIN' }),
  };
}

// Cree une commande en Direct, prete a etre confirmee.
async function createPickupOrder(farmer) {
  const buyer = await createUser({ role: 'BUYER' });
  const listing = await createListing({ farmer, price: 100, quantity: 50 });
  const token = generateToken({ id: buyer.id, role: 'BUYER' });

  const res = await client
    .post('/api/orders')
    .set(authHeader(token))
    .send({ listingId: listing.id, quantity: 5, deliveryMode: 'PICKUP' });

  expect(res.status, res.text).toBe(201);
  return { order: res.body, listing, buyer, buyerToken: token };
}

describe('GET /api/listings/:id', () => {
  it('renvoie l annonce', async () => {
    await createListing({ title: 'Orge fourragère' });

    const listing = await prisma.listing.findFirst();
    const res = await client.get(`/api/listings/${listing.id}`);

    expect(res.status, res.text).toBe(200);
    expect(res.body.id).toBe(listing.id);
    expect(res.body.title).toBe('Orge fourragère');
  });

  it('repond 404 sur un identifiant inexistant', async () => {
    const res = await client.get('/api/listings/999999');
    expect(res.status, res.text).toBe(404);
  });
});

describe('PATCH et DELETE /api/listings/:id', () => {
  it('met a jour une annonce', async () => {
    const { farmer, farmerToken } = await tokens();
    const listing = await createListing({ farmer, price: 100 });

    const res = await client
      .patch(`/api/listings/${listing.id}`)
      .set(authHeader(farmerToken))
      .send({ price: 175, description: 'Nouvelle description' });

    expect(res.status, res.text).toBe(200);

    const apres = await prisma.listing.findUnique({ where: { id: listing.id } });
    expect(Number(apres.price)).toBe(175);
  });

  it('refuse la modification par un tiers', async () => {
    const { farmer } = await tokens();
    const autre = await createUser({ role: 'FARMER' });
    const listing = await createListing({ farmer });

    const res = await client
      .patch(`/api/listings/${listing.id}`)
      .set(authHeader(generateToken({ id: autre.id, role: 'FARMER' })))
      .send({ price: 1 });

    expect(res.status).toBe(403);
  });

  it('supprime une annonce', async () => {
    const { farmer, farmerToken } = await tokens();
    const listing = await createListing({ farmer });

    const res = await client.delete(`/api/listings/${listing.id}`).set(authHeader(farmerToken));

    // 204 No Content : la suppression n'a rien a renvoyer.
    expect(res.status, res.text).toBe(204);
    expect(await prisma.listing.findUnique({ where: { id: listing.id } })).toBeNull();
  });
});

describe('Routes /api/orders/:id', () => {
  it('GET renvoie la commande', async () => {
    const { farmer } = await tokens();
    // Le jeton doit etre celui de l acheteur de la commande : les controleurs
    // verifient que l appelant est bien l acheteur ou le vendeur.
    const { order, buyerToken } = await createPickupOrder(farmer);

    const res = await client.get(`/api/orders/${order.id}`).set(authHeader(buyerToken));

    expect(res.status, res.text).toBe(200);
    expect(res.body.id).toBe(order.id);
  });

  it('PATCH /:id/confirm passe la commande en preparation', async () => {
    const { farmer, farmerToken } = await tokens();
    const { order } = await createPickupOrder(farmer);

    const res = await client.patch(`/api/orders/${order.id}/confirm`).set(authHeader(farmerToken));

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('READY_FOR_PICKUP');
  });

  it('PATCH /:id/cancel annule et restitue le stock', async () => {
    const { farmer } = await tokens();
    const { order, listing, buyerToken } = await createPickupOrder(farmer);

    const res = await client
      .patch(`/api/orders/${order.id}/cancel`)
      .set(authHeader(buyerToken));

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('CANCELLED');

    // Le stock doit revenir a la valeur exacte d'origine.
    const apres = await prisma.listing.findUnique({ where: { id: listing.id } });
    expect(Number(apres.quantity)).toBe(50);
  });

  it('PATCH /:id/complete cloture la commande', async () => {
    const { farmer, farmerToken } = await tokens();
    const { order, buyerToken } = await createPickupOrder(farmer);

    await client.patch(`/api/orders/${order.id}/confirm`).set(authHeader(farmerToken));

    const res = await client.patch(`/api/orders/${order.id}/complete`).set(authHeader(buyerToken));

    expect(res.status, res.text).toBe(200);
    // Une commande en retrait cloturee passe a DELIVERED, pas COMPLETED : les
    // deux statuts ne distinguent pas le mode, seul le mode de livraison
    // distingue "livre par un livreur" de "recupere par l acheteur".
    expect(res.body.status).toBe('DELIVERED');
  });

  // Le controle du mode et du statut : une commande en attente ne peut pas etre
  // cloturee directement.
  it('PATCH /:id/complete refuse une commande pas encore confirmee', async () => {
    const { farmer } = await tokens();
    const { order, buyerToken } = await createPickupOrder(farmer);

    const res = await client
      .patch(`/api/orders/${order.id}/complete`)
      .set(authHeader(buyerToken));

    expect(res.status, res.text).toBe(400);
  });

  it('refuse la confirmation par quelqu un d autre que le vendeur', async () => {
    const { farmer } = await tokens();
    const { order, buyerToken } = await createPickupOrder(farmer);

    const res = await client.patch(`/api/orders/${order.id}/confirm`).set(authHeader(buyerToken));

    expect(res.status).toBe(403);
  });
});

describe('Routes /api/conversations/:id/messages', () => {
  it('liste et ajoute des messages', async () => {
    const { farmer, buyer, buyerToken } = await tokens();
    const listing = await createListing({ farmer });

    const conversation = await client
      .post('/api/conversations')
      .set(authHeader(buyerToken))
      .send({ listingId: listing.id });

    expect(conversation.status, conversation.text).toBe(201);
    const id = conversation.body.id;

    const ajout = await client
      .post(`/api/conversations/${id}/messages`)
      .set(authHeader(buyerToken))
      .send({ content: 'Bonjour, la commande est-elle toujours disponible ?' });

    expect(ajout.status, ajout.text).toBe(201);

    const liste = await client.get(`/api/conversations/${id}/messages`).set(authHeader(buyerToken));
    expect(liste.status, liste.text).toBe(200);
    expect(liste.body.length).toBeGreaterThan(0);

    // Un tiers qui n'est ni acheteur ni vendeur ne voit rien.
    const intrus = await createUser({ role: 'BUYER' });
    const refuse = await client
      .get(`/api/conversations/${id}/messages`)
      .set(authHeader(generateToken({ id: intrus.id, role: 'BUYER' })));
    expect(refuse.status).toBe(403);
    expect(buyer.id).not.toBe(farmer.id);
  });
});

describe('Routes /api/deliveries/:id', () => {
  async function createDelivery() {
    const { farmer, buyerToken, farmerToken, driver, driverToken } = await tokens();
    const listing = await createListing({ farmer, price: 100, quantity: 50 });
    const commande = await client
      .post('/api/orders')
      .set(authHeader(buyerToken))
      .send({
        listingId: listing.id,
        quantity: 1,
        deliveryMode: 'DELIVERY',
        deliveryLatitude: 33.57,
        deliveryLongitude: -7.59,
      });
    expect(commande.status, commande.text).toBe(201);

    await client.patch(`/api/orders/${commande.body.id}/confirm`).set(authHeader(farmerToken));

    const delivery = await prisma.delivery.findUnique({ where: { orderId: commande.body.id } });
    expect(delivery).toBeTruthy();
    return { delivery, driver, driverToken };
  }

  it('POST /:id/accept attribue la livraison au livreur', async () => {
    const { delivery, driver, driverToken } = await createDelivery();

    const res = await client.post(`/api/deliveries/${delivery.id}/accept`).set(authHeader(driverToken));

    expect(res.status, res.text).toBe(200);

    const apres = await prisma.delivery.findUnique({ where: { id: delivery.id } });
    expect(apres.driverId).toBe(driver.id);
    expect(apres.status).toBe('ASSIGNED');
  });

  it('PATCH /:id/status fait avancer la livraison', async () => {
    const { delivery, driverToken } = await createDelivery();
    await client.post(`/api/deliveries/${delivery.id}/accept`).set(authHeader(driverToken));

    const res = await client
      .patch(`/api/deliveries/${delivery.id}/status`)
      .set(authHeader(driverToken))
      .send({ status: 'PICKED_UP' });

    expect(res.status, res.text).toBe(200);

    const apres = await prisma.delivery.findUnique({ where: { id: delivery.id } });
    expect(apres.status).toBe('PICKED_UP');
  });
});

describe('Routes /api/admin/*/:id', () => {
  it('PATCH /users/:id/suspend suspend un compte', async () => {
    const { adminToken } = await tokens();
    const cible = await createUser({ role: 'BUYER' });

    const res = await client
      .patch(`/api/admin/users/${cible.id}/suspend`)
      .set(authHeader(adminToken));

    expect(res.status, res.text).toBe(200);

    const apres = await prisma.user.findUnique({
      where: { id: cible.id },
      include: { userStatus: true },
    });
    expect(apres.userStatus.code).toBe('SUSPENDED');
  });

  it('PATCH /users/:id/reactivate reactive un compte', async () => {
    const { adminToken } = await tokens();
    const cible = await createUser({ role: 'BUYER' });
    const suspendu = await getLookupId('userStatus', 'SUSPENDED');
    await prisma.user.update({ where: { id: cible.id }, data: { userStatusId: suspendu } });

    const res = await client
      .patch(`/api/admin/users/${cible.id}/reactivate`)
      .set(authHeader(adminToken));

    expect(res.status, res.text).toBe(200);

    const apres = await prisma.user.findUnique({
      where: { id: cible.id },
      include: { userStatus: true },
    });
    expect(apres.userStatus.code).toBe('ACTIVE');
  });

  it('PATCH /listings/:id/deactivate desactive une annonce', async () => {
    const { adminToken } = await tokens();
    const { farmer } = await tokens();
    const listing = await createListing({ farmer });

    const res = await client
      .patch(`/api/admin/listings/${listing.id}/deactivate`)
      .set(authHeader(adminToken));

    expect(res.status, res.text).toBe(200);

    const apres = await prisma.listing.findUnique({
      where: { id: listing.id },
      include: { status: true },
    });
    expect(apres.status.code).toBe('INACTIVE');
  });
});

describe('Identifiants mal formes', () => {
  // Une saisie erronee doit repondre 400, pas 500 : le cas remontait jusqu'a
  // Prisma qui levait une erreur de validation cote serveur.
  //
  // Les routes protegees sont appelees avec un jetent valide : protect s'execute
  // avant l'extraction du parametre, ce qui est l'ordre voulu (un appelant
  // anonyme recoit 401 sans apprendre quoi que ce soit sur l'identifiant).
  it('repond 400 sur un identifiant non numerique', async () => {
    const { buyerToken, driverToken } = await tokens();

    const cas = [
      { methode: 'get', chemin: '/api/listings/abc', token: null },
      { methode: 'get', chemin: '/api/orders/abc', token: buyerToken },
      { methode: 'get', chemin: '/api/conversations/abc/messages', token: buyerToken },
      // Route PATCH : un GET ne matche pas et reviendrait 404, ce qui ne
      // testerait pas du tout la conversion.
      { methode: 'patch', chemin: '/api/deliveries/abc/status', token: driverToken },
    ];

    for (const { methode, chemin, token } of cas) {
      let requete = client[methode](chemin);
      if (token) requete = requete.set(authHeader(token));

      const res = await requete;
      expect(res.status, `${chemin} -> ${res.status}`).toBe(400);
      expect(res.body.error).toBe('Identifiant invalide');
    }
  });

  it('repond 400 sur un identifiant negatif', async () => {
    const res = await client.get('/api/listings/-1');
    expect(res.status).toBe(400);
  });

  // Un identifiant valide mais inexistant doit rester un 404 : la conversion
  // ne doit pas confondre "mal forme" et "absent".
  it('distingue identifiant mal forme et identifiant absent', async () => {
    const res = await client.get('/api/listings/999999');
    expect(res.status).toBe(404);
    expect(res.body.error).not.toBe('Identifiant invalide');
  });
});