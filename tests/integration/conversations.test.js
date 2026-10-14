import { describe, it, expect, beforeEach } from 'vitest';
import { randomInt } from 'node:crypto';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser, createListingForLot } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { resetDatabase } from '../helpers/db.js';
import { assertNoLeak } from '../helpers/assertNoLeak.js';

// Messagerie client <-> équipe (P3.1) : une conversation relie toujours un
// client à l'équipe, jamais un acheteur à un fournisseur.

const client = api();

// Aucun identifiant d'agent ni d'utilisateur tiers ne doit sortir côté client.
const CLES_INTERDITES = ['assignedAgentId', 'senderAgentId', 'senderUserId', 'customerId'];

// Le jeton ne porte que l'identifiant : protect recharge l'utilisateur (et son
// rôle) depuis la base à chaque requête, la charge utile n'est pas une
// autorité.
function tokenPour(user) {
  return generateToken({ id: user.id });
}

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

async function produit() {
  const [category, unit] = await Promise.all([
    prisma.productCategory.findFirst(),
    prisma.unit.findFirst(),
  ]);
  return prisma.product.create({
    data: {
      categoryId: category.id,
      unitId: unit.id,
      name: `Produit test ${Date.now()}-${randomInt(1_000, 9_999)}`,
      isPerishable: true,
    },
  });
}

async function zone() {
  return prisma.zone.create({
    data: { name: `Zone test ${Date.now()}-${randomInt(1_000, 9_999)}` },
  });
}

async function fournisseur() {
  const user = await createUser({ role: 'SUPPLIER' });
  const profile = await prisma.supplierProfile.create({
    data: { userId: user.id, farmName: 'Ferme du Test' },
  });
  return { user, profile };
}

async function createLot(profile, overrides = {}) {
  const [p, z] = await Promise.all([produit(), zone()]);
  return prisma.stockLot.create({
    data: {
      lotCode: `LOT-TMP-${randomInt(1_000_000, 9_999_999)}`,
      supplierId: profile.id,
      productId: p.id,
      zoneId: z.id,
      agreedUnitPrice: '1250.50',
      quantityInitial: '1500',
      quantityAvailable: '1500',
      ...overrides,
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
});

describe('POST /api/v2/conversations — ouverture et premier message', () => {
  it('un acheteur ouvre une conversation sur une annonce ACTIVE avec son premier message', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const { profile } = await fournisseur();
    const lot = await createLot(profile);
    const annonce = await createListingForLot(lot);

    const res = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(buyer)))
      .send({ listingId: annonce.id, content: 'Bonjour, ce produit est-il encore disponible ?' });

    expect(res.status, res.text).toBe(201);
    expect(res.body.type).toBe('BUYER_SUPPORT');
    expect(res.body.listingId).toBe(annonce.id);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.lastMessageAt).toBeTruthy();

    // Le premier message a été créé dans la même transaction.
    const messages = await prisma.message.findMany({ where: { conversationId: res.body.id } });
    expect(messages).toHaveLength(1);
    expect(messages[0].senderType).toBe('CUSTOMER');
    expect(messages[0].senderUserId).toBe(buyer.id);
    expect(messages[0].content).toContain('encore disponible');

    // Aucune fuite d'identité dans la réponse.
    assertNoLeak(res.body, CLES_INTERDITES);
  });

  it('un acheteur ouvre une conversation sans annonce (conseil général)', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const res = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(buyer)))
      .send({ content: 'Comment passer une commande ?' });

    expect(res.status, res.text).toBe(201);
    expect(res.body.type).toBe('BUYER_SUPPORT');
    expect(res.body.listingId).toBeNull();
  });

  it('un fournisseur ouvre une conversation sur un de SES lots', async () => {
    const { user, profile } = await fournisseur();
    const lot = await createLot(profile);

    const res = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(user)))
      .send({ lotId: lot.id, content: 'Pouvez-vous valider mon lot ?' });

    expect(res.status, res.text).toBe(201);
    expect(res.body.type).toBe('SUPPLIER_SUPPORT');
    // lotId ne sort plus côté client : le fournisseur retrouve son lot via /supplier/lots.
    expect(res.body.lotId).toBeUndefined();
  });

  it('un fournisseur ouvre une conversation sans lot', async () => {
    const { user } = await fournisseur();

    const res = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(user)))
      .send({ content: 'Question sur mes reversements' });

    expect(res.status, res.text).toBe(201);
    expect(res.body.type).toBe('SUPPLIER_SUPPORT');
    expect(res.body.lotId).toBeUndefined();
  });

  it('un fournisseur ne peut pas ouvrir de conversation sur le lot d’un tiers : 404', async () => {
    const { user } = await fournisseur();
    const autre = await fournisseur();
    const lot = await createLot(autre.profile);

    const res = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(user)))
      .send({ lotId: lot.id, content: 'Ce lot m’appartient' });

    expect(res.status, res.text).toBe(404);
  });

  it('un fournisseur avec un lotId inexistant : 404', async () => {
    const { user } = await fournisseur();

    const res = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(user)))
      .send({ lotId: 999999, content: 'Question' });

    expect(res.status, res.text).toBe(404);
  });

  it('un acheteur avec un listingId inexistant ou inactif : 400', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const resInconnu = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(buyer)))
      .send({ listingId: 999999, content: 'Question' });
    expect(resInconnu.status, resInconnu.text).toBe(400);

    // Une annonce DRAFT n'est pas consultable : la conversation est refusée.
    const { profile } = await fournisseur();
    const lot = await createLot(profile);
    const statutBrouillon = await prisma.listingStatus.findUnique({ where: { code: 'DRAFT' } });
    const annonce = await prisma.listing.create({
      data: {
        reference: `ANN-TMP-${randomInt(1_000_000, 9_999_999)}`,
        title: 'Annonce brouillon',
        unitPrice: lot.agreedUnitPrice,
        productId: lot.productId,
        zoneId: lot.zoneId,
        statusId: statutBrouillon.id,
      },
    });

    const resBrouillon = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(buyer)))
      .send({ listingId: annonce.id, content: 'Question' });
    expect(resBrouillon.status, resBrouillon.text).toBe(400);
  });

  it('un acheteur ne peut pas fournir lotId, ni un fournisseur listingId : 400', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const { user: fournisseurUser, profile } = await fournisseur();
    const lot = await createLot(profile);

    const resAcheteur = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(buyer)))
      .send({ lotId: lot.id, content: 'Question' });
    expect(resAcheteur.status, resAcheteur.text).toBe(400);

    const { profile: profilAcheteur } = await fournisseur();
    const lotAcheteur = await createLot(profilAcheteur);
    const annonce = await createListingForLot(lotAcheteur);

    const resFournisseur = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(fournisseurUser)))
      .send({ listingId: annonce.id, content: 'Question' });
    expect(resFournisseur.status, resFournisseur.text).toBe(400);
  });

  it('un rôle non client (DRIVER) ne peut pas ouvrir de conversation : 400', async () => {
    const driver = await createUser({ role: 'DRIVER' });

    const res = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(driver)))
      .send({ content: 'Question' });

    expect(res.status, res.text).toBe(400);
  });

  it('content manquant ou vide : 400', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const res = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(buyer)))
      .send({ content: '   ' });
    expect(res.status, res.text).toBe(400);
  });
});

describe('GET /api/v2/conversations et messages — lecture côté client', () => {
  it('un client ne voit que ses conversations, les plus récentes d’abord', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const autre = await createUser({ role: 'BUYER' });

    const res1 = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(buyer)))
      .send({ content: 'Première question' });
    const res2 = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(buyer)))
      .send({ content: 'Deuxième question' });
    await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(autre)))
      .send({ content: 'Question d’un autre client' });

    const liste = await client
      .get('/api/v2/conversations')
      .set(authHeader(tokenPour(buyer)));

    expect(liste.status, liste.text).toBe(200);
    expect(liste.body.total).toBe(2);
    expect(liste.body.items.map((c) => c.id)).toEqual([res2.body.id, res1.body.id]);
    assertNoLeak(liste.body, CLES_INTERDITES);
  });

  it('le fil est chronologique et le client ne voit pas les notes internes', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const { user: agentUser, agent } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    const conv = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(buyer)))
      .send({ content: 'Ma première question' });
    await client
      .post(`/api/v2/conversations/${conv.body.id}/messages`)
      .set(authHeader(tokenPour(buyer)))
      .send({ content: 'Une précision' });
    // Note interne de l'équipe : jamais renvoyée au client.
    await client
      .post(`/api/v2/staff/conversations/${conv.body.id}/messages`)
      .set(authHeader(tokenPour(agentUser)))
      .send({ content: 'Note interne : vérifier le stock', isInternal: true });

    const fil = await client
      .get(`/api/v2/conversations/${conv.body.id}/messages`)
      .set(authHeader(tokenPour(buyer)));

    expect(fil.status, fil.text).toBe(200);
    expect(fil.body.total).toBe(2);
    expect(fil.body.items.map((m) => m.content)).toEqual(['Ma première question', 'Une précision']);
    expect(fil.body.items[0].senderLabel).toBe('Vous');
    assertNoLeak(fil.body, CLES_INTERDITES);

    // La note interne existe bien en base, côté staff seulement.
    const tous = await prisma.message.findMany({ where: { conversationId: conv.body.id } });
    expect(tous).toHaveLength(3);
    expect(tous.filter((m) => m.isInternal)).toHaveLength(1);
  });

  it('un message de l’équipe porte le label « Équipe AgriConnect »', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const { user: agentUser } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    const conv = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(buyer)))
      .send({ content: 'Ma question' });
    await client
      .post(`/api/v2/staff/conversations/${conv.body.id}/messages`)
      .set(authHeader(tokenPour(agentUser)))
      .send({ content: 'Notre réponse' });

    const fil = await client
      .get(`/api/v2/conversations/${conv.body.id}/messages`)
      .set(authHeader(tokenPour(buyer)));

    expect(fil.body.items[1].senderLabel).toBe('Équipe AgriConnect');
  });

  it('lire ou écrire dans la conversation d’un autre client : 404', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const autre = await createUser({ role: 'BUYER' });

    const conv = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(autre)))
      .send({ content: 'Question privée' });

    const lecture = await client
      .get(`/api/v2/conversations/${conv.body.id}/messages`)
      .set(authHeader(tokenPour(buyer)));
    expect(lecture.status, lecture.text).toBe(404);

    const ecriture = await client
      .post(`/api/v2/conversations/${conv.body.id}/messages`)
      .set(authHeader(tokenPour(buyer)))
      .send({ content: 'Je réponds à sa place' });
    expect(ecriture.status, ecriture.text).toBe(404);
  });

  it('chaque message met à jour lastMessageAt', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const conv = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(buyer)))
      .send({ content: 'Premier' });
    const avant = new Date(conv.body.lastMessageAt).getTime();

    const reponse = await client
      .post(`/api/v2/conversations/${conv.body.id}/messages`)
      .set(authHeader(tokenPour(buyer)))
      .send({ content: 'Deuxième' });

    expect(reponse.status, reponse.text).toBe(201);
    expect(reponse.body.senderLabel).toBe('Vous');
    const maj = await prisma.conversation.findUnique({ where: { id: conv.body.id } });
    expect(new Date(maj.lastMessageAt).getTime()).toBeGreaterThanOrEqual(avant);
  });
});

describe('Routes staff — assign, escalate, close, messages', () => {
  async function conversationAcheteur() {
    const buyer = await createUser({ role: 'BUYER' });
    const res = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(buyer)))
      .send({ content: 'Question acheteur' });
    return res.body;
  }

  it('un agent s’assigne une conversation de son type, puis répond', async () => {
    const conv = await conversationAcheteur();
    const { user: agentUser, agent } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    const assign = await client
      .post(`/api/v2/staff/conversations/${conv.id}/assign`)
      .set(authHeader(tokenPour(agentUser)))
      .send({});

    expect(assign.status, assign.text).toBe(200);
    expect(assign.body.assignedAgentId).toBe(agent.id);
    expect(assign.body.assignedAgent.displayName).toBe('Agent Test');
    expect(assign.body.customer.firstname).toBeTruthy();

    const reponse = await client
      .post(`/api/v2/staff/conversations/${conv.id}/messages`)
      .set(authHeader(tokenPour(agentUser)))
      .send({ content: 'Réponse de l’équipe' });

    expect(reponse.status, reponse.text).toBe(201);
    expect(reponse.body.senderType).toBe('AGENT');
    expect(reponse.body.senderAgentId).toBe(agent.id);
    expect(reponse.body.senderUserId).toBe(agentUser.id);
    expect(reponse.body.isInternal).toBe(false);
  });

  it('un agent ne peut pas désigner un autre agent : 403', async () => {
    const conv = await conversationAcheteur();
    const { user: agentUser } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });
    const { agent: autre } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    const res = await client
      .post(`/api/v2/staff/conversations/${conv.id}/assign`)
      .set(authHeader(tokenPour(agentUser)))
      .send({ agentId: autre.id });

    expect(res.status, res.text).toBe(403);
  });

  it('un ADMIN désigne un agentId ; sans agentId : 400, agent inconnu : 404', async () => {
    const conv = await conversationAcheteur();
    const admin = await createUser({ role: 'ADMIN' });
    const { agent } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    const sansAgent = await client
      .post(`/api/v2/staff/conversations/${conv.id}/assign`)
      .set(authHeader(tokenPour(admin)))
      .send({});
    expect(sansAgent.status, sansAgent.text).toBe(400);

    const inconnu = await client
      .post(`/api/v2/staff/conversations/${conv.id}/assign`)
      .set(authHeader(tokenPour(admin)))
      .send({ agentId: 999999 });
    expect(inconnu.status, inconnu.text).toBe(404);

    const ok = await client
      .post(`/api/v2/staff/conversations/${conv.id}/assign`)
      .set(authHeader(tokenPour(admin)))
      .send({ agentId: agent.id });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.assignedAgentId).toBe(agent.id);
  });

  it('escalate : escalatedAt, reason, et la conversation est désassignée', async () => {
    const conv = await conversationAcheteur();
    const { user: agentUser, agent } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    await client
      .post(`/api/v2/staff/conversations/${conv.id}/assign`)
      .set(authHeader(tokenPour(agentUser)))
      .send({});

    const res = await client
      .post(`/api/v2/staff/conversations/${conv.id}/escalate`)
      .set(authHeader(tokenPour(agentUser)))
      .send({ reason: 'Litige sur le prix' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.escalatedAt).toBeTruthy();
    expect(res.body.escalationReason).toBe('Litige sur le prix');
    expect(res.body.assignedAgentId).toBeNull();

    // Le filtre escalated=true la retrouve, unassigned aussi (désassignée).
    const filtre = await client
      .get('/api/v2/staff/conversations?escalated=true')
      .set(authHeader(tokenPour(agentUser)));
    expect(filtre.body.items.map((c) => c.id)).toContain(conv.id);

    const nonAssignees = await client
      .get('/api/v2/staff/conversations?unassigned=true')
      .set(authHeader(tokenPour(agentUser)));
    expect(nonAssignees.body.items.map((c) => c.id)).toContain(conv.id);
  });

  it('close : la conversation passe à CLOSED', async () => {
    const conv = await conversationAcheteur();
    const { user: agentUser } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    const res = await client
      .post(`/api/v2/staff/conversations/${conv.id}/close`)
      .set(authHeader(tokenPour(agentUser)));

    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('CLOSED');
  });

  it('un agent sans la capacité du bon type : 403 sur toutes les actions', async () => {
    const conv = await conversationAcheteur();
    const { user: agentAcheteur } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    // Une conversation fournisseur : hors de son périmètre.
    const { user: fournisseurUser, profile } = await fournisseur();
    const lot = await createLot(profile);
    const convFournisseur = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(fournisseurUser)))
      .send({ lotId: lot.id, content: 'Question fournisseur' });

    for (const appel of [
      () => client.post(`/api/v2/staff/conversations/${convFournisseur.body.id}/assign`).set(authHeader(tokenPour(agentAcheteur))).send({}),
      () => client.post(`/api/v2/staff/conversations/${convFournisseur.body.id}/escalate`).set(authHeader(tokenPour(agentAcheteur))).send({ reason: 'x' }),
      () => client.post(`/api/v2/staff/conversations/${convFournisseur.body.id}/close`).set(authHeader(tokenPour(agentAcheteur))),
      () => client.post(`/api/v2/staff/conversations/${convFournisseur.body.id}/messages`).set(authHeader(tokenPour(agentAcheteur))).send({ content: 'x' }),
    ]) {
      const res = await appel();
      expect(res.status, res.text).toBe(403);
    }

    // La conversation acheteur, elle, reste accessible.
    const ok = await client
      .post(`/api/v2/staff/conversations/${conv.id}/close`)
      .set(authHeader(tokenPour(agentAcheteur)));
    expect(ok.status, ok.text).toBe(200);
  });

  it('un agent sans aucune capacité support : 403 sur la liste', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: [] });

    const res = await client
      .get('/api/v2/staff/conversations')
      .set(authHeader(tokenPour(agentUser)));

    expect(res.status, res.text).toBe(403);
  });

  it('un agent ne voit que les conversations de son type ; un ADMIN les voit toutes', async () => {
    const convAcheteur = await conversationAcheteur();
    const { user: fournisseurUser, profile } = await fournisseur();
    const lot = await createLot(profile);
    const convFournisseur = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(fournisseurUser)))
      .send({ lotId: lot.id, content: 'Question fournisseur' });

    const { user: agentAcheteur } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });
    const listeAgent = await client
      .get('/api/v2/staff/conversations')
      .set(authHeader(tokenPour(agentAcheteur)));
    expect(listeAgent.body.items.map((c) => c.id)).toEqual([convAcheteur.id]);

    const admin = await createUser({ role: 'ADMIN' });
    const listeAdmin = await client
      .get('/api/v2/staff/conversations')
      .set(authHeader(tokenPour(admin)));
    expect(listeAdmin.body.items.map((c) => c.id).sort()).toEqual(
      [convAcheteur.id, convFournisseur.body.id].sort()
    );
  });

  it('le filtre mine=true ne retourne que les conversations de l’agent', async () => {
    const conv1 = await conversationAcheteur();
    const conv2 = await conversationAcheteur();
    const { user: agentUser, agent } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    await client
      .post(`/api/v2/staff/conversations/${conv1.id}/assign`)
      .set(authHeader(tokenPour(agentUser)))
      .send({});

    const res = await client
      .get('/api/v2/staff/conversations?mine=true')
      .set(authHeader(tokenPour(agentUser)));

    expect(res.body.items.map((c) => c.id)).toEqual([conv1.id]);
    expect(res.body.items[0].assignedAgentId).toBe(agent.id);
  });

  it('statut invalide : 400', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    const res = await client
      .get('/api/v2/staff/conversations?status=INCONNU')
      .set(authHeader(tokenPour(agentUser)));

    expect(res.status, res.text).toBe(400);
  });

  it('un message staff met à jour lastMessageAt', async () => {
    const conv = await conversationAcheteur();
    const { user: agentUser } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    const res = await client
      .post(`/api/v2/staff/conversations/${conv.id}/messages`)
      .set(authHeader(tokenPour(agentUser)))
      .send({ content: 'Réponse tardive' });

    expect(res.status, res.text).toBe(201);
    const maj = await prisma.conversation.findUnique({ where: { id: conv.id } });
    expect(new Date(maj.lastMessageAt).getTime()).toBeGreaterThan(new Date(conv.lastMessageAt).getTime());
  });
});

describe('Routes staff — détail et historique des messages', () => {
  // Conversation acheteur sur une annonce, avec son acheteur et son annonce.
  async function conversationAcheteur() {
    const buyer = await createUser({ role: 'BUYER' });
    const { profile } = await fournisseur();
    const lot = await createLot(profile);
    const annonce = await createListingForLot(lot);
    const res = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(buyer)))
      .send({ listingId: annonce.id, content: 'Question acheteur' });
    return { conv: res.body, buyer, annonce };
  }

  it('un agent lit le détail d\'une conversation de son type (client, annonce, agent, escalade)', async () => {
    const { conv, buyer, annonce } = await conversationAcheteur();
    const { user: agentUser, agent } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    // Prise en charge puis escalade : le détail doit refléter les deux.
    await client
      .post(`/api/v2/staff/conversations/${conv.id}/assign`)
      .set(authHeader(tokenPour(agentUser)))
      .send({});
    await client
      .post(`/api/v2/staff/conversations/${conv.id}/escalate`)
      .set(authHeader(tokenPour(agentUser)))
      .send({ reason: 'Litige sur le prix' });

    const res = await client
      .get(`/api/v2/staff/conversations/${conv.id}`)
      .set(authHeader(tokenPour(agentUser)));

    expect(res.status, res.text).toBe(200);
    expect(res.body.type).toBe('BUYER_SUPPORT');
    expect(res.body.status).toBe('OPEN');
    expect(res.body.customer).toMatchObject({
      id: buyer.id,
      firstname: buyer.firstname,
      lastname: buyer.lastname,
    });
    expect(res.body.listingId).toBe(annonce.id);
    // L'escalade désassigne : la conversation repart dans la file commune.
    expect(res.body.assignedAgent).toBeNull();
    expect(res.body.escalatedAt).toBeTruthy();
    expect(res.body.escalationReason).toBe('Litige sur le prix');
  });

  it('l\'historique staff contient TOUS les messages, notes internes comprises, en ordre chronologique et paginé', async () => {
    const { conv, buyer } = await conversationAcheteur();
    const { user: agentUser, agent } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    // Messages insérés directement en base avec des dates espacées : l'ordre
    // chronologique ne doit pas dépendre de la résolution de l'horloge.
    const base = Date.now() + 60_000;
    const messages = [
      { senderType: 'CUSTOMER', senderUserId: buyer.id, senderAgentId: null, content: 'Message 2', isInternal: false, decalage: 1000 },
      { senderType: 'AGENT', senderUserId: agentUser.id, senderAgentId: agent.id, content: 'Note interne', isInternal: true, decalage: 2000 },
      { senderType: 'AGENT', senderUserId: agentUser.id, senderAgentId: agent.id, content: 'Réponse agent', isInternal: false, decalage: 3000 },
    ];
    for (const m of messages) {
      await prisma.message.create({
        data: {
          conversationId: conv.id,
          senderType: m.senderType,
          senderUserId: m.senderUserId,
          senderAgentId: m.senderAgentId,
          content: m.content,
          isInternal: m.isInternal,
          createdAt: new Date(base + m.decalage),
        },
      });
    }
    // 4 messages en tout : le premier (question) + les trois ci-dessus.

    const page1 = await client
      .get(`/api/v2/staff/conversations/${conv.id}/messages?page=1&limit=2`)
      .set(authHeader(tokenPour(agentUser)));

    expect(page1.status, page1.text).toBe(200);
    expect(page1.body).toMatchObject({ page: 1, limit: 2, total: 4 });
    expect(page1.body.items).toHaveLength(2);
    // Ordre chronologique : le premier message de la conversation d'abord.
    expect(page1.body.items.map((m) => m.content)).toEqual(['Question acheteur', 'Message 2']);
    // Champs staff complets sur chaque message.
    expect(page1.body.items[0]).toMatchObject({
      senderType: 'CUSTOMER',
      senderUserId: buyer.id,
      senderAgentId: null,
      isInternal: false,
    });

    const page2 = await client
      .get(`/api/v2/staff/conversations/${conv.id}/messages?page=2&limit=2`)
      .set(authHeader(tokenPour(agentUser)));

    expect(page2.status, page2.text).toBe(200);
    expect(page2.body.items.map((m) => m.content)).toEqual(['Note interne', 'Réponse agent']);

    // La note interne est bien dans l'historique staff, avec son identité complète.
    const note = page2.body.items[0];
    expect(note.isInternal).toBe(true);
    expect(note.senderType).toBe('AGENT');
    expect(note.senderAgentId).toBe(agent.id);
    expect(note.senderUserId).toBe(agentUser.id);
  });

  it('un agent d\'un autre type : 403 sur le détail et l\'historique', async () => {
    const { conv } = await conversationAcheteur();
    const { user: agentAcheteur } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    // Une conversation fournisseur : hors du périmètre de l'agent acheteur.
    const { user: fournisseurUser, profile } = await fournisseur();
    const lot = await createLot(profile);
    const convFournisseur = await client
      .post('/api/v2/conversations')
      .set(authHeader(tokenPour(fournisseurUser)))
      .send({ lotId: lot.id, content: 'Question fournisseur' });

    const detail = await client
      .get(`/api/v2/staff/conversations/${convFournisseur.body.id}`)
      .set(authHeader(tokenPour(agentAcheteur)));
    expect(detail.status, detail.text).toBe(403);

    const historique = await client
      .get(`/api/v2/staff/conversations/${convFournisseur.body.id}/messages`)
      .set(authHeader(tokenPour(agentAcheteur)));
    expect(historique.status, historique.text).toBe(403);

    // La conversation acheteur, elle, reste accessible.
    const ok = await client
      .get(`/api/v2/staff/conversations/${conv.id}`)
      .set(authHeader(tokenPour(agentAcheteur)));
    expect(ok.status, ok.text).toBe(200);
  });

  it('conversation inconnue : 404 sur le détail et l\'historique', async () => {
    const { user: agentUser } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    const detail = await client
      .get('/api/v2/staff/conversations/999999')
      .set(authHeader(tokenPour(agentUser)));
    expect(detail.status, detail.text).toBe(404);

    const historique = await client
      .get('/api/v2/staff/conversations/999999/messages')
      .set(authHeader(tokenPour(agentUser)));
    expect(historique.status, historique.text).toBe(404);
  });

  it('un client sur ces routes : 403', async () => {
    const { conv, buyer } = await conversationAcheteur();

    const detail = await client
      .get(`/api/v2/staff/conversations/${conv.id}`)
      .set(authHeader(tokenPour(buyer)));
    expect(detail.status, detail.text).toBe(403);

    const historique = await client
      .get(`/api/v2/staff/conversations/${conv.id}/messages`)
      .set(authHeader(tokenPour(buyer)));
    expect(historique.status, historique.text).toBe(403);
  });
});
