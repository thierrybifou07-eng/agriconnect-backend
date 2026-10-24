import prisma from '../../config/prisma.js';
import { recordAudit } from '../../utils/audit.js';
import { createMessageTx, emitNewMessage, STAFF_ROOM } from '../message.service.js';
import { getIo } from '../../sockets/ioRegistry.js';
import { getAiConfig } from './ai.config.js';
import { buildListingDraftContext, buildReplyContext } from './ai.context.js';
import { AiError } from './ai.error.js';
import { getAiQueue } from './ai.queue.js';
import { validateListingDraftOutput, parseAndValidateSupportOutput } from './ai.guard.js';
import { SYSTEM_LISTING_DRAFT_FR, SYSTEM_SUPPORT_FR } from './ai.prompts.js';
import { listingDraftSchema, supportReplySchema } from './ai.schemas.js';
import { getProvider } from './provider.js';
import { getThrottle } from './ai.throttle.js';

const CAPABILITY_BY_CONVERSATION = {
  BUYER_SUPPORT: 'BUYER_SUPPORT',
  SUPPLIER_SUPPORT: 'SUPPLIER_SUPPORT',
};
const GEMINI_ERRORS = new Set([
  'AI_RATE_LIMITED',
  'AI_AUTH_FAILED',
  'AI_UNREACHABLE',
  'AI_MODEL_MISSING',
  'AI_INVALID_OUTPUT',
]);

let providerFactory = getProvider;
let throttleFactory = getThrottle;

export function setAiProviderFactoryForTests(factory) {
  const previous = providerFactory;
  providerFactory = factory;
  return () => { providerFactory = previous; };
}

export function setAiThrottleForTests(throttle) {
  const previous = throttleFactory;
  throttleFactory = () => throttle;
  return () => { throttleFactory = previous; };
}

function queue() {
  return getAiQueue(processSuggestion);
}

function emitSuggestion(event, suggestion) {
  getIo()?.to(STAFF_ROOM).emit(event, {
    id: suggestion.id,
    kind: suggestion.kind,
    status: suggestion.status,
    conversationId: suggestion.conversationId,
  });
}

async function findAiAgent(capability) {
  return prisma.agent.findFirst({
    where: {
      kind: 'AI',
      isActive: true,
      capabilities: { some: { capability: { code: capability } } },
    },
    include: { capabilities: { include: { capability: { select: { code: true } } } } },
    orderBy: { id: 'asc' },
  });
}

function capabilityFor(kind, conversationType) {
  if (kind === 'LISTING_DRAFT') return 'LISTING_MANAGEMENT';
  return CAPABILITY_BY_CONVERSATION[conversationType] ?? null;
}

async function resolveSuggestionContext({ kind, conversationId, lotId }) {
  if (kind === 'LISTING_DRAFT') {
    const context = await buildListingDraftContext(lotId);
    return { ...context, user: `Rédigez un brouillon d’annonce uniquement à partir de ces faits : ${context.facts}` };
  }
  const context = await buildReplyContext(conversationId);
  const history = context.history.map(({ role, text }) => role === 'client'
    ? `<message_client>${text.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</message_client>`
    : `<message_equipe>${text.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</message_equipe>`).join('\n');
  return {
    ...context,
    user: `<faits>${context.facts}</faits>\n<historique>\n${history}\n</historique>`,
  };
}

function toPayload(kind, guarded) {
  if (kind === 'LISTING_DRAFT') return { listing: guarded.data };
  const data = guarded.data;
  return {
    intent: data.intent,
    language: data.language,
    confidence: data.confidence,
    reply: data.reply,
    needsHuman: data.needs_human,
    reasons: data.reasons,
    warnings: guarded.warnings,
  };
}

async function processSuggestion(id) {
  const suggestion = await prisma.agentSuggestion.findUnique({
    where: { id },
    include: { agent: true },
  });
  if (!suggestion || suggestion.status !== 'PENDING') return;

  try {
    const context = await resolveSuggestionContext(suggestion);
    const listingDraft = suggestion.kind === 'LISTING_DRAFT';
    const provider = providerFactory(suggestion.agent);
    const generated = await provider.generateStructured({
      system: listingDraft ? SYSTEM_LISTING_DRAFT_FR : SYSTEM_SUPPORT_FR,
      user: context.user,
      schema: listingDraft ? listingDraftSchema : supportReplySchema,
    });
    const guarded = listingDraft
      ? validateListingDraftOutput(generated.data)
      : parseAndValidateSupportOutput(generated.data, { allowedNumbers: context.allowedNumbers });
    if (!guarded.ok) throw new AiError('AI_INVALID_OUTPUT', 'La sortie IA ne respecte pas les règles de sécurité');
    const payload = toPayload(suggestion.kind, guarded);
    const ready = await prisma.agentSuggestion.update({
      where: { id },
      data: {
        payload,
        latencyMs: generated.latencyMs,
      },
    });
    emitSuggestion('ai:suggestion_updated', ready);
    if (suggestion.kind === 'REPLY') await maybeExecuteAutonomously(ready, suggestion.agent);
  } catch (error) {
    const code = GEMINI_ERRORS.has(error?.code) ? error.code
      : error?.code === 'AI_DISABLED' ? 'AI_DISABLED'
        : 'AI_UNREACHABLE';
    const failed = await prisma.$transaction(async (tx) => {
      const updated = await tx.agentSuggestion.update({
        where: { id },
        data: { status: 'FAILED', error: code },
      });
      await recordAudit(tx, {
        actorAgent: { id: suggestion.agentId },
        action: 'AI_SUGGESTION_FAILED',
        entityType: 'AgentSuggestion',
        entityId: id,
        metadata: { code },
      });
      return updated;
    });
    emitSuggestion('ai:suggestion_updated', failed);
  }
}

async function maybeExecuteAutonomously(suggestion, agent) {
  const config = getAiConfig();
  const payload = suggestion.payload;
  if (
    agent.autonomy !== 'AUTONOMOUS'
    || !config.autonomousEnabled
    || !payload
    || !['VERIFICATION_STATUS', 'DELIVERY_QUESTION'].includes(payload.intent)
    || payload.confidence < config.minConfidence
    || payload.warnings?.length
  ) return;

  const consecutive = await prisma.message.findMany({
    where: { conversationId: suggestion.conversationId, isInternal: false },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { senderType: true, senderAgent: { select: { kind: true } } },
  });
  let aiMessages = 0;
  for (const message of consecutive) {
    if (message.senderType === 'AGENT' && message.senderAgent?.kind === 'AI') aiMessages += 1;
    else break;
  }
  if (aiMessages >= 2) return;

  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.agentSuggestion.findUnique({ where: { id: suggestion.id } });
    if (!current || current.status !== 'PENDING') return null;
    const conversation = await tx.conversation.findUnique({ where: { id: suggestion.conversationId } });
    if (!conversation || conversation.status === 'CLOSED') return null;
    const message = await createMessageTx(tx, {
      conversationId: conversation.id,
      senderType: 'AGENT',
      senderUserId: null,
      senderAgentId: agent.id,
      content: payload.reply,
      isInternal: false,
    });
    const updated = await tx.agentSuggestion.update({
      where: { id: suggestion.id },
      data: { status: 'EXECUTED', executedAt: new Date() },
    });
    await recordAudit(tx, {
      actorAgent: { id: agent.id },
      action: 'AI_AUTONOMOUS_REPLY',
      entityType: 'AgentSuggestion',
      entityId: suggestion.id,
      metadata: { intent: payload.intent },
    });
    await recordAudit(tx, {
      actorAgent: { id: agent.id },
      action: 'AI_SUGGESTION_EXECUTED',
      entityType: 'AgentSuggestion',
      entityId: suggestion.id,
    });
    return { message, updated };
  });
  if (!result) return;
  emitNewMessage(getIo(), result.message);
  emitSuggestion('ai:suggestion_updated', result.updated);
}

export async function enqueueSuggestion({ kind, conversationId = null, lotId = null }) {
  const config = getAiConfig();
  if (!config.enabled) throw new AiError('AI_DISABLED', 'Le moteur IA est désactivé');

  let conversation = null;
  if (conversationId !== null) {
    conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) throw new AiError('CONVERSATION_NOT_FOUND', 'Conversation introuvable');
    if (conversation.status === 'CLOSED') throw new AiError('CONVERSATION_CLOSED', 'La conversation est fermée');
  }
  const capability = capabilityFor(kind, conversation?.type);
  if (!capability) throw new AiError('AI_INVALID_KIND', 'Type de suggestion invalide');
  if (kind === 'LISTING_DRAFT') {
    const lot = await prisma.stockLot.findUnique({ where: { id: lotId }, select: { id: true } });
    if (!lot) throw new AiError('LOT_NOT_FOUND', 'Lot introuvable');
  }
  const agent = await findAiAgent(capability);
  if (!agent) throw new AiError('AI_NO_AGENT', 'Aucun agent IA actif ne possède la capacité requise');

  if (agent.aiProvider === 'gemini' || (!agent.aiProvider && config.provider === 'gemini')) {
    const quota = throttleFactory();
    if (!quota.canAcquire().ok) throw new AiError('AI_RATE_LIMITED', 'Quota Gemini dépassé');
  }
  if (conversationId !== null) {
    const busy = await prisma.agentSuggestion.findFirst({
      where: { conversationId, status: 'PENDING' },
      select: { id: true },
    });
    if (busy) throw new AiError('AI_BUSY', 'Une suggestion est déjà en cours pour cette conversation');
  }

  const agentProvider = agent.aiProvider ?? config.provider;
  const model = agent.aiModel || (agentProvider === 'gemini' ? config.gemini.model : config.ollamaModel);
  const suggestion = await prisma.$transaction(async (tx) => {
    const created = await tx.agentSuggestion.create({
      data: { kind, agentId: agent.id, conversationId, lotId, model },
    });
    await recordAudit(tx, {
      actorAgent: { id: agent.id },
      action: 'AI_SUGGESTION_CREATED',
      entityType: 'AgentSuggestion',
      entityId: created.id,
      metadata: { kind, conversationId, lotId },
    });
    return created;
  });

  emitSuggestion('ai:suggestion', suggestion);
  queue().enqueue(suggestion.id);
  return suggestion;
}

export async function maybeAutoSuggest(conversationId) {
  const config = getAiConfig();
  if (!config.enabled || !config.autoSuggestEnabled) return null;
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation || conversation.assignedAgentId !== null || conversation.status === 'CLOSED') return null;
  const capability = CAPABILITY_BY_CONVERSATION[conversation.type];
  if (!capability || !await findAiAgent(capability)) return null;
  const pending = await prisma.agentSuggestion.findFirst({
    where: { conversationId, status: 'PENDING' },
    select: { id: true },
  });
  if (pending) return null;
  return enqueueSuggestion({ kind: 'REPLY', conversationId });
}

export async function expirePendingAiSuggestions() {
  await prisma.agentSuggestion.updateMany({
    where: { status: 'PENDING' },
    data: { status: 'EXPIRED', error: 'EXPIRED_ON_RESTART' },
  });
}

export async function initializeAiOrchestrator() {
  await expirePendingAiSuggestions();
  queue();
}
