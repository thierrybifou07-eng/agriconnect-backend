import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser, createListingForLot } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { overrideAiConfigForTests } from '../../src/services/ai/ai.config.js';
import {
  resetAiQueueForTests,
} from '../../src/services/ai/ai.queue.js';
import {
  expirePendingAiSuggestions,
  setAiProviderFactoryForTests,
  setAiThrottleForTests,
} from '../../src/services/ai/ai.orchestrator.js';
import { buildReplyContext } from '../../src/services/ai/ai.context.js';

const client = api();
let restoreConfig;
let restoreProvider;
let restoreThrottle;

function tokenFor(user) {
  return generateToken({ id: user.id });
}

async function createAgentUser(capabilities = ['BUYER_SUPPORT']) {
  const user = await createUser({ role: 'AGENT' });
  const agent = await prisma.agent.create({
    data: { kind: 'HUMAN', userId: user.id, displayName: 'Agent humain', isActive: true },
  });
  const rows = await prisma.agentCapability.findMany({
    where: { code: { in: capabilities } },
    select: { id: true },
  });
  await prisma.agentCapabilityLink.createMany({
    data: rows.map(({ id }) => ({ agentId: agent.id, capabilityId: id })),
  });
  return { user, agent };
}

async function createAiAgent(capabilities = ['BUYER_SUPPORT'], autonomy = 'SUGGEST_ONLY', aiProvider = 'ollama') {
  const agent = await prisma.agent.create({
    data: { kind: 'AI', displayName: 'Assistant de test', autonomy, aiProvider, aiModel: 'fake-model' },
  });
  const rows = await prisma.agentCapability.findMany({
    where: { code: { in: capabilities } },
    select: { id: true },
  });
  await prisma.agentCapabilityLink.createMany({
    data: rows.map(({ id }) => ({ agentId: agent.id, capabilityId: id })),
  });
  return agent;
}

async function createConversation() {
  const buyer = await createUser({ role: 'BUYER' });
  const conversation = await prisma.conversation.create({
    data: { type: 'BUYER_SUPPORT', customerId: buyer.id, subject: 'Question test' },
  });
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      senderType: 'CUSTOMER',
      senderUserId: buyer.id,
      content: 'Bonjour, pouvez-vous m’aider ?',
    },
  });
  return { buyer, conversation };
}

async function waitForSuggestion(id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suggestion = await prisma.agentSuggestion.findUnique({ where: { id } });
    if (suggestion?.payload || suggestion?.status === 'FAILED') return suggestion;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Le worker IA n’a pas terminé dans le délai');
}

function useFakeProvider(overrides = {}) {
  const generated = {
    intent: 'PRODUCT_QUESTION',
    language: 'fr',
    confidence: 0.95,
    needs_human: false,
    reply: 'Bonjour, nous allons vérifier cette information.',
    reasons: [],
    ...overrides,
  };
  restoreProvider = setAiProviderFactoryForTests(() => ({
    generateStructured: vi.fn(async () => ({ data: generated, latencyMs: 7 })),
  }));
}

async function requestSuggestion(conversation, staff) {
  return client.post(`/api/v2/staff/conversations/${conversation.id}/ai-suggest`)
    .set(authHeader(tokenFor(staff)));
}

afterEach(() => {
  restoreConfig?.();
  restoreProvider?.();
  restoreThrottle?.();
  restoreConfig = null;
  restoreProvider = null;
  restoreThrottle = null;
  resetAiQueueForTests();
});

describe('suggestions IA staff', () => {
  it('crée une suggestion asynchrone puis remplit son payload sans quitter PENDING', async () => {
    restoreConfig = overrideAiConfigForTests({ enabled: true, provider: 'ollama', model: 'fake-model' });
    useFakeProvider();
    const staff = await createAgentUser();
    await createAiAgent();
    const { conversation } = await createConversation();

    const response = await requestSuggestion(conversation, staff.user);
    expect(response.status, response.text).toBe(202);
    expect(response.body).toMatchObject({ status: 'PENDING' });
    const ready = await waitForSuggestion(response.body.suggestionId);
    expect(ready).toMatchObject({ status: 'PENDING', model: 'fake-model', latencyMs: 7 });
    expect(ready.payload).toMatchObject({ intent: 'PRODUCT_QUESTION', needsHuman: false });
    expect(ready.error).toBeNull();
    const list = await client.get('/api/v2/staff/ai/suggestions?status=PENDING')
      .set(authHeader(tokenFor(staff.user)));
    expect(list.status).toBe(200);
    expect(list.body.items.map(({ id }) => id)).toContain(ready.id);
    const detail = await client.get(`/api/v2/staff/ai/suggestions/${ready.id}`)
      .set(authHeader(tokenFor(staff.user)));
    expect(detail.status).toBe(200);
    expect(detail.body.agent).toMatchObject({ displayName: 'Assistant de test' });
  });

  it('enregistre les erreurs fournisseur en FAILED sans propager d’exception HTTP', async () => {
    restoreConfig = overrideAiConfigForTests({ enabled: true, provider: 'ollama', model: 'fake-model' });
    restoreProvider = setAiProviderFactoryForTests(() => ({
      generateStructured: vi.fn(async () => {
        const error = new Error('provider offline');
        error.code = 'AI_UNREACHABLE';
        throw error;
      }),
    }));
    const staff = await createAgentUser();
    await createAiAgent();
    const { conversation } = await createConversation();

    const response = await requestSuggestion(conversation, staff.user);
    expect(response.status).toBe(202);
    const failed = await waitForSuggestion(response.body.suggestionId);
    expect(failed).toMatchObject({ status: 'FAILED', error: 'AI_UNREACHABLE', payload: null });
  });

  it('publie une réponse SUGGEST_ONLY sous l’agent humain et refuse une seconde approbation', async () => {
    restoreConfig = overrideAiConfigForTests({ enabled: true, provider: 'ollama', model: 'fake-model' });
    useFakeProvider();
    const staff = await createAgentUser();
    await createAiAgent();
    const { buyer, conversation } = await createConversation();

    const request = await requestSuggestion(conversation, staff.user);
    const ready = await waitForSuggestion(request.body.suggestionId);
    const approved = await client.post(`/api/v2/staff/ai/suggestions/${ready.id}/approve`)
      .set(authHeader(tokenFor(staff.user)))
      .send({});

    expect(approved.status, approved.text).toBe(200);
    expect(approved.body.status).toBe('EXECUTED');
    const message = await prisma.message.findFirst({
      where: { conversationId: conversation.id, senderType: 'AGENT' },
    });
    expect(message).toMatchObject({ senderUserId: staff.user.id, senderAgentId: staff.agent.id, isInternal: false });
    const auditActions = await prisma.auditLog.findMany({
      where: { entityType: 'AgentSuggestion', entityId: ready.id },
      select: { action: true },
    });
    expect(auditActions.map(({ action }) => action)).toEqual(expect.arrayContaining([
      'AI_SUGGESTION_CREATED',
      'AI_SUGGESTION_APPROVED',
      'AI_SUGGESTION_EXECUTED',
    ]));

    const clientMessages = await client.get(`/api/v2/conversations/${conversation.id}/messages`)
      .set(authHeader(tokenFor(buyer)));
    expect(clientMessages.body.items.at(-1).senderLabel).toBe('Équipe AgriConnect');

    const duplicate = await client.post(`/api/v2/staff/ai/suggestions/${ready.id}/approve`)
      .set(authHeader(tokenFor(staff.user)))
      .send({});
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('publie une réponse ACT_WITH_APPROVAL sous la fiche IA avec étiquette transparente', async () => {
    restoreConfig = overrideAiConfigForTests({ enabled: true, provider: 'ollama', model: 'fake-model' });
    useFakeProvider();
    const staff = await createAgentUser();
    const ai = await createAiAgent(['BUYER_SUPPORT'], 'ACT_WITH_APPROVAL');
    const { buyer, conversation } = await createConversation();

    const request = await requestSuggestion(conversation, staff.user);
    const ready = await waitForSuggestion(request.body.suggestionId);
    const approved = await client.post(`/api/v2/staff/ai/suggestions/${ready.id}/approve`)
      .set(authHeader(tokenFor(staff.user)))
      .send({});

    expect(approved.status).toBe(200);
    const message = await prisma.message.findFirst({
      where: { conversationId: conversation.id, senderType: 'AGENT' },
    });
    expect(message).toMatchObject({ senderUserId: null, senderAgentId: ai.id, isInternal: false });
    const clientMessages = await client.get(`/api/v2/conversations/${conversation.id}/messages`)
      .set(authHeader(tokenFor(buyer)));
    expect(clientMessages.body.items.at(-1).senderLabel).toBe('Assistant AgriConnect (IA)');
  });

  it('refuse l’approbation d’une conversation fermée et permet le rejet', async () => {
    restoreConfig = overrideAiConfigForTests({ enabled: true, provider: 'ollama', model: 'fake-model' });
    useFakeProvider();
    const staff = await createAgentUser();
    await createAiAgent();
    const { conversation: closed } = await createConversation();
    const closedRequest = await requestSuggestion(closed, staff.user);
    const closedSuggestion = await waitForSuggestion(closedRequest.body.suggestionId);
    await prisma.conversation.update({ where: { id: closed.id }, data: { status: 'CLOSED' } });
    const closedApproval = await client.post(`/api/v2/staff/ai/suggestions/${closedSuggestion.id}/approve`)
      .set(authHeader(tokenFor(staff.user)))
      .send({});
    expect(closedApproval.status).toBe(409);
    expect(closedApproval.body.code).toBe('CONVERSATION_CLOSED');

    const { conversation } = await createConversation();
    const request = await requestSuggestion(conversation, staff.user);
    const ready = await waitForSuggestion(request.body.suggestionId);
    const rejected = await client.post(`/api/v2/staff/ai/suggestions/${ready.id}/reject`)
      .set(authHeader(tokenFor(staff.user)))
      .send({ reason: 'À reprendre par l’équipe' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('REJECTED');
  });

  it('refuse un agent sans la capacité du type de conversation et respecte AI_DISABLED', async () => {
    restoreConfig = overrideAiConfigForTests({ enabled: true, provider: 'ollama', model: 'fake-model' });
    useFakeProvider();
    const wrongStaff = await createAgentUser(['SUPPLIER_SUPPORT']);
    await createAiAgent();
    const { conversation } = await createConversation();
    const forbidden = await requestSuggestion(conversation, wrongStaff.user);
    expect(forbidden.status).toBe(403);

    restoreConfig?.();
    restoreConfig = overrideAiConfigForTests({ enabled: false, model: '' });
    const authorizedStaff = await createAgentUser(['BUYER_SUPPORT']);
    const disabled = await requestSuggestion(conversation, authorizedStaff.user);
    expect(disabled.status).toBe(409);
    expect(disabled.body.code).toBe('AI_DISABLED');
  });

  it('signale AI_NO_AGENT et AI_BUSY sans lancer de génération', async () => {
    restoreConfig = overrideAiConfigForTests({ enabled: true, provider: 'ollama', model: 'fake-model' });
    const staff = await createAgentUser();
    const { conversation } = await createConversation();

    const noAgent = await requestSuggestion(conversation, staff.user);
    expect(noAgent.status).toBe(409);
    expect(noAgent.body.code).toBe('AI_NO_AGENT');

    const ai = await createAiAgent();
    await prisma.agentSuggestion.create({
      data: { kind: 'REPLY', agentId: ai.id, conversationId: conversation.id, model: 'fake-model' },
    });
    const busy = await requestSuggestion(conversation, staff.user);
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('AI_BUSY');
    expect(await prisma.agentSuggestion.count({ where: { conversationId: conversation.id } })).toBe(1);
  });

  it('expire les suggestions PENDING au démarrage sans rejeu', async () => {
    const ai = await createAiAgent();
    const { conversation } = await createConversation();
    const pending = await prisma.agentSuggestion.create({
      data: { kind: 'REPLY', agentId: ai.id, conversationId: conversation.id, model: 'fake-model' },
    });
    await expirePendingAiSuggestions();
    const expired = await prisma.agentSuggestion.findUnique({ where: { id: pending.id } });
    expect(expired).toMatchObject({ status: 'EXPIRED', error: 'EXPIRED_ON_RESTART', payload: null });
  });

  it('refuse avant création lorsque le quota Gemini est épuisé', async () => {
    restoreConfig = overrideAiConfigForTests({ enabled: true, provider: 'gemini', gemini: { model: 'fake-model', hasKey: true } });
    restoreThrottle = setAiThrottleForTests({ canAcquire: () => ({ ok: false, reason: 'budget' }) });
    const staff = await createAgentUser();
    await createAiAgent(['BUYER_SUPPORT'], 'SUGGEST_ONLY', 'gemini');
    const { conversation } = await createConversation();

    const response = await requestSuggestion(conversation, staff.user);
    expect(response.status).toBe(429);
    expect(response.body.code).toBe('AI_RATE_LIMITED');
    expect(await prisma.agentSuggestion.count({ where: { conversationId: conversation.id } })).toBe(0);
  });

  it('met en file un brouillon de listing depuis les seuls faits du lot', async () => {
    restoreConfig = overrideAiConfigForTests({ enabled: true, provider: 'ollama', model: 'fake-model' });
    restoreProvider = setAiProviderFactoryForTests(() => ({
      generateStructured: vi.fn(async ({ user }) => {
        expect(user).not.toContain('agreedUnitPrice');
        expect(user).not.toContain('FERME_LISTING_PRIVEE');
        return { data: { title: 'Tomates fraîches', description: 'Récolte soigneusement conditionnée.' }, latencyMs: 5 };
      }),
    }));
    const staff = await createAgentUser(['LISTING_MANAGEMENT']);
    await createAiAgent(['LISTING_MANAGEMENT']);
    const supplier = await createUser({ role: 'SUPPLIER' });
    const profile = await prisma.supplierProfile.create({
      data: { userId: supplier.id, farmName: 'FERME_LISTING_PRIVEE' },
    });
    const [category, unit] = await Promise.all([
      prisma.productCategory.findFirst(),
      prisma.unit.findFirst(),
    ]);
    const product = await prisma.product.create({
      data: { categoryId: category.id, unitId: unit.id, name: `Tomates-${randomInt(1_000, 9_999)}` },
    });
    const zone = await prisma.zone.create({ data: { name: `Zone-lot-${randomInt(1_000, 9_999)}` } });
    const lot = await prisma.stockLot.create({
      data: {
        lotCode: `LOT-DRAFT-${randomInt(100_000, 999_999)}`,
        supplierId: profile.id,
        productId: product.id,
        zoneId: zone.id,
        agreedUnitPrice: '1234.56',
        quantityInitial: '20',
        quantityAvailable: '20',
        qualityNote: 'Récolte soigneusement conditionnée',
      },
    });

    const response = await client.post(`/api/v2/staff/lots/${lot.id}/ai-listing-draft`)
      .set(authHeader(tokenFor(staff.user)));
    expect(response.status, response.text).toBe(202);
    const ready = await waitForSuggestion(response.body.suggestionId);
    expect(ready).toMatchObject({ status: 'PENDING', kind: 'LISTING_DRAFT' });
    expect(ready.payload).toEqual({
      listing: { title: 'Tomates fraîches', description: 'Récolte soigneusement conditionnée.' },
    });
  });

  it('construit le contexte acheteur depuis le DTO public sans exposer le fournisseur ou le prix convenu', async () => {
    const supplier = await createUser({ role: 'SUPPLIER' });
    const profile = await prisma.supplierProfile.create({
      data: { userId: supplier.id, farmName: 'FERME_CONFIDENTIELLE' },
    });
    const [category, unit] = await Promise.all([
      prisma.productCategory.findFirst(),
      prisma.unit.findFirst(),
    ]);
    const product = await prisma.product.create({
      data: { categoryId: category.id, unitId: unit.id, name: `Produit-${randomInt(1_000, 9_999)}` },
    });
    const zone = await prisma.zone.create({ data: { name: `Zone-${randomInt(1_000, 9_999)}` } });
    const lot = await prisma.stockLot.create({
      data: {
        lotCode: `LOT-${randomInt(100_000, 999_999)}`,
        supplierId: profile.id,
        productId: product.id,
        zoneId: zone.id,
        agreedUnitPrice: '1234.56',
        quantityInitial: '20',
        quantityAvailable: '20',
        pickupAddress: 'ADRESSE_CONFIDENTIELLE',
      },
    });
    const listing = await createListingForLot(lot);
    await prisma.listing.update({ where: { id: listing.id }, data: { unitPrice: '2500.00' } });
    const buyer = await createUser({ role: 'BUYER' });
    const conversation = await prisma.conversation.create({
      data: { type: 'BUYER_SUPPORT', customerId: buyer.id, listingId: listing.id },
    });

    const context = await buildReplyContext(conversation.id);
    expect(context.facts).toContain('2500');
    expect(context.facts).not.toContain('supplier');
    expect(context.facts).not.toContain('agreedUnitPrice');
    expect(context.facts).not.toContain('1234.56');
    expect(context.facts).not.toContain('FERME_CONFIDENTIELLE');
    expect(context.facts).not.toContain('ADRESSE_CONFIDENTIELLE');
    expect(context.facts).not.toContain(buyer.firstname);
    expect(context.facts).not.toContain(buyer.email);
    expect(context.facts).not.toContain(buyer.phone);
  });
});
