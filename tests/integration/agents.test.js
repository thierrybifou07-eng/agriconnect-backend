import { describe, it, expect } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { requireCapability } from '../../src/middlewares/capability.middleware.js';

const client = api();

// Le jeton ne porte que l'identifiant : protect recharge l'utilisateur (et son
// rôle) en base à chaque requête, comme le font les autres suites.
function tokenFor(user, role) {
  return generateToken({ id: user.id, role });
}

// req.user au format exact de protect : l'identifiant et le rôle complet.
function reqUser(user, role) {
  const levels = { AGENT: 30, ADMIN: 50, ROOT: 100, BUYER: 10 };
  return { id: user.id, role: { code: role, level: levels[role] ?? 10 } };
}

// Crée un compte AGENT et sa fiche d'agent avec les capacités demandées.
async function createAgentUser({ capabilities = [], isActive = true } = {}) {
  const user = await createUser({ role: 'AGENT' });
  const agent = await prisma.agent.create({
    data: { kind: 'HUMAN', userId: user.id, displayName: 'Agent Test', isActive },
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

// Appelle un middleware Express avec un req factice : la réponse est
// interceptée et next() signale que le middleware laisse passer (= la requête
// aurait répondu 200 plus loin dans la chaîne).
function runMiddleware(middleware, user) {
  return new Promise((resolve) => {
    let settled = false;
    const res = {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        settle(false);
        return this;
      },
    };
    const settle = (passed) => {
      if (!settled) {
        settled = true;
        resolve({ req, res, passed });
      }
    };
    const req = { user, params: {}, body: {} };
    middleware(req, res, () => settle(true));
  });
}

describe('requireCapability — contrôle par capacité', () => {
  it('laisse passer un ADMIN sans fiche d\'agent', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const { res, passed } = await runMiddleware(requireCapability('STOCK_VALIDATION'), reqUser(admin, 'ADMIN'));

    expect(passed).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  it('laisse passer un ROOT', async () => {
    const root = await createUser({ role: 'ROOT' });

    const { passed } = await runMiddleware(requireCapability('STOCK_VALIDATION'), reqUser(root, 'ROOT'));

    expect(passed).toBe(true);
  });

  it('refuse un AGENT sans capacité (403)', async () => {
    const { user } = await createAgentUser({ capabilities: [] });

    const { res, passed } = await runMiddleware(requireCapability('STOCK_VALIDATION'), reqUser(user, 'AGENT'));

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Capacité requise');
  });

  it('laisse passer un AGENT qui possède la capacité et renseigne req.agent', async () => {
    const { user, agent } = await createAgentUser({ capabilities: ['STOCK_VALIDATION', 'BUYER_SUPPORT'] });

    const { req, res, passed } = await runMiddleware(requireCapability('STOCK_VALIDATION'), reqUser(user, 'AGENT'));

    expect(passed).toBe(true);
    expect(res.statusCode).toBeNull();
    // req.agent porte toutes les capacités de la fiche : le contrôleur peut
    // savoir ce que l'agent peut faire au-delà du filtre de la requête courante.
    // (L'ordre de la requête SQL n'est pas garanti : on compare trié.)
    expect(req.agent).toMatchObject({ id: agent.id, kind: 'HUMAN' });
    expect([...req.agent.capabilities].sort()).toEqual(['BUYER_SUPPORT', 'STOCK_VALIDATION']);
  });

  it('refuse un AGENT qui possède une autre capacité (403)', async () => {
    const { user } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    const { res, passed } = await runMiddleware(requireCapability('STOCK_VALIDATION'), reqUser(user, 'AGENT'));

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Capacité requise');
  });

  it('refuse un AGENT dont la fiche est inactive (403)', async () => {
    const { user } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'], isActive: false });

    const { res, passed } = await runMiddleware(requireCapability('STOCK_VALIDATION'), reqUser(user, 'AGENT'));

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Capacité requise');
  });

  it('refuse un BUYER (403)', async () => {
    const buyer = await createUser({ role: 'BUYER' });

    const { res, passed } = await runMiddleware(requireCapability('STOCK_VALIDATION'), reqUser(buyer, 'BUYER'));

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Capacité requise');
  });
});

describe('GET /api/v2/admin/agents', () => {
  it('renvoie les fiches avec leurs capacités (ADMIN)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    await createAgentUser({ capabilities: ['STOCK_VALIDATION', 'BUYER_SUPPORT'] });

    const res = await client.get('/api/v2/admin/agents').set(authHeader(tokenFor(admin, 'ADMIN')));

    expect(res.status, res.text).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const fiche = res.body.find((a) => a.kind === 'HUMAN');
    expect(fiche).toMatchObject({ kind: 'HUMAN', displayName: 'Agent Test' });
    expect(fiche.capabilities.map((c) => c.capability.code).sort()).toEqual(['BUYER_SUPPORT', 'STOCK_VALIDATION']);
    // L\'identité du compte rattaché est visible pour l\'admin, jamais son mot de passe.
    expect(fiche.user).toMatchObject({ id: fiche.userId });
    expect(fiche.user).not.toHaveProperty('password');
  });

  it('refuse un AGENT (403 — requireMinLevel(50))', async () => {
    const { user } = await createAgentUser({ capabilities: ['STOCK_VALIDATION'] });

    const res = await client.get('/api/v2/admin/agents').set(authHeader(tokenFor(user, 'AGENT')));

    expect(res.status, res.text).toBe(403);
  });
});

describe('PATCH /api/v2/admin/agents/:id', () => {
  it('modifie le nom, l\'état et les capacités, et écrit un AuditLog', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const { agent } = await createAgentUser({ capabilities: ['BUYER_SUPPORT'] });

    const res = await client
      .patch(`/api/v2/admin/agents/${agent.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({
        displayName: 'Nouveau nom',
        isActive: false,
        capabilities: ['STOCK_VALIDATION', 'ORDER_PROCESSING'],
      });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ displayName: 'Nouveau nom', isActive: false });

    // Les capacités sont bien remplacées en base (liste complète, pas d'ajout).
    const links = await prisma.agentCapabilityLink.findMany({
      where: { agentId: agent.id },
      include: { capability: { select: { code: true } } },
    });
    expect(links.map((l) => l.capability.code).sort()).toEqual(['ORDER_PROCESSING', 'STOCK_VALIDATION']);

    // L'audit est écrit dans la même transaction que la modification.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'AGENT_UPDATED', entityType: 'Agent', entityId: agent.id },
    });
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(admin.id);
    expect(audit.metadata.changes).toMatchObject({ displayName: 'Nouveau nom', isActive: false });
  });

  it('refuse une capacité inconnue (400)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const { agent } = await createAgentUser();

    const res = await client
      .patch(`/api/v2/admin/agents/${agent.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ capabilities: ['NOT_A_CAPABILITY'] });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse un agent inexistant (404)', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .patch('/api/v2/admin/agents/999999')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ displayName: 'Nom' });

    expect(res.status, res.text).toBe(404);
    expect(res.body.error).toContain('introuvable');
  });

  it('refuse PAYMENT_FOLLOWUP sur un agent IA (400 — règle C6)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const ai = await prisma.agent.create({
      data: { kind: 'AI', displayName: 'IA Test', userId: null, aiProvider: 'openai', aiModel: 'gpt-4' },
    });

    const res = await client
      .patch(`/api/v2/admin/agents/${ai.id}`)
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ capabilities: ['PAYMENT_FOLLOWUP'] });

    expect(res.status, res.text).toBe(400);
    expect(res.body.error).toContain('PAYMENT_FOLLOWUP');
    // Aucun lien n'a été écrit : le 400 arrive avant la transaction.
    const links = await prisma.agentCapabilityLink.count({ where: { agentId: ai.id } });
    expect(links).toBe(0);
  });
});

describe('POST /api/v2/admin/agents/ai', () => {
  it('crée un agent IA sans utilisateur, autonomy SUGGEST_ONLY par défaut, et écrit un AuditLog', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .post('/api/v2/admin/agents/ai')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ displayName: 'Assistant IA', aiProvider: 'openai', aiModel: 'gpt-4' });

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'AI',
      displayName: 'Assistant IA',
      userId: null,
      autonomy: 'SUGGEST_ONLY',
      aiProvider: 'openai',
      aiModel: 'gpt-4',
    });

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'AGENT_AI_CREATED', entityType: 'Agent', entityId: res.body.id },
    });
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(admin.id);
  });

  it('accepte une autonomy explicite', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .post('/api/v2/admin/agents/ai')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ displayName: 'IA autonome', aiProvider: 'anthropic', aiModel: 'claude', autonomy: 'ACT_WITH_APPROVAL' });

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ autonomy: 'ACT_WITH_APPROVAL' });
  });

  it('refuse sans displayName (400)', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    const res = await client
      .post('/api/v2/admin/agents/ai')
      .set(authHeader(tokenFor(admin, 'ADMIN')))
      .send({ aiProvider: 'openai', aiModel: 'gpt-4' });

    expect(res.status, res.text).toBe(400);
  });
});
