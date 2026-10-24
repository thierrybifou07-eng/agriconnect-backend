import prisma from '../../config/prisma.js';
import { recordAudit } from '../../utils/audit.js';
import { createMessageTx, emitNewMessage } from '../../services/message.service.js';
import { AiError } from '../../services/ai/ai.error.js';
import { enqueueSuggestion } from '../../services/ai/ai.orchestrator.js';

const CAPABILITY_BY_TYPE = {
  BUYER_SUPPORT: 'BUYER_SUPPORT',
  SUPPLIER_SUPPORT: 'SUPPLIER_SUPPORT',
};

function aiSuggestionToDto(suggestion) {
  return {
    id: suggestion.id,
    kind: suggestion.kind,
    status: suggestion.status,
    conversationId: suggestion.conversationId ?? null,
    lotId: suggestion.lotId ?? null,
    agent: { id: suggestion.agent.id, displayName: suggestion.agent.displayName },
    model: suggestion.model,
    latencyMs: suggestion.latencyMs ?? null,
    payload: suggestion.payload ?? null,
    error: suggestion.error ?? null,
    decidedAt: suggestion.decidedAt ?? null,
    executedAt: suggestion.executedAt ?? null,
    createdAt: suggestion.createdAt,
  };
}

function suggestionCapabilities(suggestion) {
  if (suggestion.kind === 'LISTING_DRAFT') return ['LISTING_MANAGEMENT'];
  const capability = CAPABILITY_BY_TYPE[suggestion.conversation?.type];
  return capability ? [capability] : [];
}

function mayAccess(req, suggestion) {
  return req.user.role.level >= 50
    || suggestionCapabilities(suggestion).some((code) => req.agent?.capabilities.includes(code));
}

async function listFilterFor(req) {
  if (req.user.role.level >= 50) return {};
  const capabilities = req.agent?.capabilities ?? [];
  const conditions = [];
  if (capabilities.includes('LISTING_MANAGEMENT')) conditions.push({ kind: 'LISTING_DRAFT' });
  const conversationTypes = [];
  for (const [type, code] of Object.entries(CAPABILITY_BY_TYPE)) {
    if (capabilities.includes(code)) conversationTypes.push(type);
  }
  if (conversationTypes.length) {
    const conversations = await prisma.conversation.findMany({
      where: { type: { in: conversationTypes } },
      select: { id: true },
    });
    if (conversations.length) {
      conditions.push({
        kind: { in: ['REPLY', 'TRIAGE'] },
        conversationId: { in: conversations.map(({ id }) => id) },
      });
    }
  }
  return conditions.length ? { OR: conditions } : { id: -1 };
}

function sendAiError(res, error) {
  const statusByCode = {
    AI_DISABLED: 409,
    AI_BUSY: 409,
    AI_NO_AGENT: 409,
    AI_RATE_LIMITED: 429,
    CONVERSATION_CLOSED: 409,
    CONVERSATION_NOT_FOUND: 404,
    LOT_NOT_FOUND: 404,
    AI_INVALID_KIND: 400,
  };
  if (error instanceof AiError || statusByCode[error?.code]) {
    return res.status(statusByCode[error.code] ?? 502).json({ error: error.message, code: error.code });
  }
  throw error;
}

export async function requestReplySuggestion(req, res) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: req.params.id },
    select: { id: true, type: true },
  });
  if (!conversation) return res.status(404).json({ error: 'Conversation introuvable' });
  const capability = CAPABILITY_BY_TYPE[conversation.type];
  if (req.user.role.level < 50 && !req.agent?.capabilities.includes(capability)) {
    return res.status(403).json({ error: 'Capacité requise', code: 'CAPABILITY_REQUIRED' });
  }
  try {
    const suggestion = await enqueueSuggestion({ kind: 'REPLY', conversationId: conversation.id });
    return res.status(202).json({ suggestionId: suggestion.id, status: suggestion.status });
  } catch (error) {
    return sendAiError(res, error);
  }
}

export async function requestListingDraft(req, res) {
  try {
    const suggestion = await enqueueSuggestion({ kind: 'LISTING_DRAFT', lotId: req.params.id });
    return res.status(202).json({ suggestionId: suggestion.id, status: suggestion.status });
  } catch (error) {
    return sendAiError(res, error);
  }
}

export async function listAiSuggestions(req, res) {
  const { status, kind, conversationId, page, limit } = req.query;
  const where = {
    ...(await listFilterFor(req)),
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.agentSuggestion.findMany({
      where,
      include: { agent: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.agentSuggestion.count({ where }),
  ]);
  res.json({ items: items.map(aiSuggestionToDto), page, limit, total });
}

async function loadAccessibleSuggestion(req, res) {
  const suggestion = await prisma.agentSuggestion.findUnique({
    where: { id: req.params.id },
    include: { agent: { select: { id: true, displayName: true, autonomy: true } } },
  });
  if (!suggestion) {
    res.status(404).json({ error: 'Suggestion IA introuvable' });
    return null;
  }
  suggestion.conversation = suggestion.conversationId
    ? await prisma.conversation.findUnique({
        where: { id: suggestion.conversationId },
        select: { id: true, type: true, status: true },
      })
    : null;
  if (!mayAccess(req, suggestion)) {
    res.status(403).json({ error: 'Capacité requise', code: 'CAPABILITY_REQUIRED' });
    return null;
  }
  return suggestion;
}

export async function getAiSuggestion(req, res) {
  const suggestion = await loadAccessibleSuggestion(req, res);
  if (!suggestion) return;
  res.json(aiSuggestionToDto(suggestion));
}

export async function approveAiSuggestion(req, res) {
  const suggestion = await loadAccessibleSuggestion(req, res);
  if (!suggestion) return;
  if (suggestion.status !== 'PENDING' || !suggestion.payload) {
    return res.status(409).json({ error: 'Transition de statut invalide', code: 'INVALID_STATE_TRANSITION' });
  }
  const isReply = suggestion.kind === 'REPLY';
  if (isReply && suggestion.conversation?.status === 'CLOSED') {
    return res.status(409).json({ error: 'La conversation est fermée', code: 'CONVERSATION_CLOSED' });
  }
  const content = req.body.editedContent ?? suggestion.payload.reply;
  if (isReply && (typeof content !== 'string' || content.length > 5000)) {
    return res.status(400).json({ error: 'Contenu de réponse invalide', code: 'AI_INVALID_OUTPUT' });
  }

  let message = null;
  let updated;
  try {
    ({ message, suggestion: updated } = await prisma.$transaction(async (tx) => {
      const current = await tx.agentSuggestion.findUnique({
        where: { id: suggestion.id },
        include: { agent: { select: { id: true, autonomy: true } } },
      });
      const conversation = current?.conversationId
        ? await tx.conversation.findUnique({ where: { id: current.conversationId }, select: { status: true } })
        : null;
      if (!current || current.status !== 'PENDING' || !current.payload) {
        const error = new Error('Transition de statut invalide');
        error.code = 'INVALID_STATE_TRANSITION';
        throw error;
      }
      if (isReply && conversation?.status === 'CLOSED') {
        const error = new Error('La conversation est fermée');
        error.code = 'CONVERSATION_CLOSED';
        throw error;
      }

      const isAiAuthor = current.agent.autonomy !== 'SUGGEST_ONLY';
      if (isReply) {
        message = await createMessageTx(tx, {
          conversationId: current.conversationId,
          senderType: 'AGENT',
          senderUserId: isAiAuthor ? null : req.user.id,
          senderAgentId: isAiAuthor ? current.agentId : (req.agent?.id ?? null),
          content,
          isInternal: false,
        });
      }
      const status = isReply ? 'EXECUTED' : 'APPROVED';
      const changed = await tx.agentSuggestion.update({
        where: { id: current.id },
        data: {
          status,
          decidedByUserId: req.user.id,
          decidedAt: new Date(),
          ...(isReply ? { executedAt: new Date() } : {}),
          ...(isReply && req.body.editedContent !== undefined
            ? { payload: { ...current.payload, reply: req.body.editedContent } }
            : {}),
        },
        include: { agent: { select: { id: true, displayName: true } } },
      });
      await recordAudit(tx, {
        actorUser: { id: req.user.id },
        actorAgent: { id: current.agentId },
        action: 'AI_SUGGESTION_APPROVED',
        entityType: 'AgentSuggestion',
        entityId: current.id,
        metadata: { approvedByUserId: req.user.id },
      });
      if (isReply) {
        await recordAudit(tx, {
          actorUser: { id: req.user.id },
          actorAgent: { id: current.agentId },
          action: 'AI_SUGGESTION_EXECUTED',
          entityType: 'AgentSuggestion',
          entityId: current.id,
        });
      }
      return { message, suggestion: changed };
    }));
  } catch (error) {
    if (error.code === 'INVALID_STATE_TRANSITION' || error.code === 'CONVERSATION_CLOSED') {
      return res.status(409).json({ error: error.message, code: error.code });
    }
    throw error;
  }
  if (message) emitNewMessage(req.app.get('io'), message);
  res.json(aiSuggestionToDto(updated));
}

export async function rejectAiSuggestion(req, res) {
  const suggestion = await loadAccessibleSuggestion(req, res);
  if (!suggestion) return;
  if (suggestion.status !== 'PENDING') {
    return res.status(409).json({ error: 'Transition de statut invalide', code: 'INVALID_STATE_TRANSITION' });
  }
  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.agentSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: 'REJECTED',
        decidedByUserId: req.user.id,
        decidedAt: new Date(),
      },
      include: { agent: { select: { id: true, displayName: true } } },
    });
    await recordAudit(tx, {
      actorUser: { id: req.user.id },
      actorAgent: { id: suggestion.agentId },
      action: 'AI_SUGGESTION_REJECTED',
      entityType: 'AgentSuggestion',
      entityId: suggestion.id,
      metadata: req.body.reason ? { reason: req.body.reason } : undefined,
    });
    return changed;
  });
  res.json(aiSuggestionToDto(updated));
}
