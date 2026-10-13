import prisma from '../config/prisma.js';
import { conversationToStaffDto, messageToStaffDto } from '../utils/dto/conversation.dto.js';
import { createMessage, emitConversationAssigned, emitConversationEscalated } from '../services/message.service.js';

// Partie staff de la messagerie (plan v2, P3.1).
//
// Deux métiers distincts : le support acheteurs (BUYER_SUPPORT) et le support
// fournisseurs (SUPPLIER_SUPPORT). Un agent n'agit que sur les conversations
// de son type ; ADMIN et ROOT (level >= 50) gardent tous les pouvoirs, sans
// fiche d'agent ni capacité déclarée.

const CAPACITE_PAR_TYPE = {
  BUYER_SUPPORT: 'BUYER_SUPPORT',
  SUPPLIER_SUPPORT: 'SUPPLIER_SUPPORT',
};

const STATUTS = ['OPEN', 'WAITING_CUSTOMER', 'CLOSED'];

const pageLimite = (valeur, defaut) => Math.min(100, Math.max(1, Number(valeur) || defaut));

// Types de conversation visibles par l'utilisateur staff : un agent ne voit
// que son (ou ses) métier(s), l'équipe entière sinon.
const typesVisibles = (req) => {
  if (req.user.role.level >= 50) return Object.keys(CAPACITE_PAR_TYPE);
  return req.agent.capabilities.filter((code) => CAPACITE_PAR_TYPE[code]);
};

// Charge une conversation pour une action staff et contrôle l'accès :
// ADMIN/ROOT toujours, un agent seulement avec la capacité du type de la
// conversation. 404 si elle n'existe pas, 403 si l'agent n'est pas habilité.
async function conversationPourStaff(req, res) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: req.params.id },
    include: {
      customer: { select: { id: true, firstname: true, lastname: true } },
      assignedAgent: { select: { id: true, displayName: true } },
    },
  });
  if (!conversation) {
    res.status(404).json({ error: 'Conversation introuvable' });
    return null;
  }

  const capacite = CAPACITE_PAR_TYPE[conversation.type];
  const autorise = req.user.role.level >= 50 || req.agent?.capabilities.includes(capacite);
  if (!autorise) {
    res.status(403).json({ error: 'Capacité requise' });
    return null;
  }
  return conversation;
}

// GET /api/v2/staff/conversations?status=&unassigned=true&mine=true&escalated=true
// Un agent ne voit que les conversations de son type ; un admin les voit toutes.
export const listConversations = async (req, res) => {
  const { status, unassigned, mine, escalated } = req.query;
  if (status && !STATUTS.includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }

  const where = { type: { in: typesVisibles(req) } };
  if (status) where.status = status;
  if (unassigned === 'true') where.assignedAgentId = null;
  if (escalated === 'true') where.escalatedAt = { not: null };
  if (mine === 'true') {
    // « À moi » n'a de sens que pour un agent : un admin n'a pas de fiche et
    // donc pas de file personnelle à consulter.
    if (req.agent) where.assignedAgentId = req.agent.id;
  }

  const page = pageLimite(req.query.page, 1);
  const limit = pageLimite(req.query.limit, 20);

  const [items, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      include: {
        customer: { select: { id: true, firstname: true, lastname: true } },
        assignedAgent: { select: { id: true, displayName: true } },
      },
      orderBy: { lastMessageAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.conversation.count({ where }),
  ]);

  res.json({ items: items.map(conversationToStaffDto), page, limit, total });
};

// GET /api/v2/staff/conversations/:id — le détail d'une conversation : client,
// annonce ou lot lié, agent assigné, escalade. Mêmes protections que la liste
// (conversationPourStaff : 404 si inconnue, 403 si le type est hors du
// périmètre de l'agent).
export const getConversation = async (req, res) => {
  const conversation = await conversationPourStaff(req, res);
  if (!conversation) return;
  res.json(conversationToStaffDto(conversation));
};

// GET /api/v2/staff/conversations/:id/messages — l'historique COMPLET de la
// conversation : tous les messages, notes internes comprises (côté client, le
// filtre isInternal les masque ; l'équipe, elle, doit tout lire). Ordre
// chronologique, pagination classique.
export const listMessages = async (req, res) => {
  const conversation = await conversationPourStaff(req, res);
  if (!conversation) return;

  const page = pageLimite(req.query.page, 1);
  const limit = pageLimite(req.query.limit, 20);

  const where = { conversationId: conversation.id };
  const [items, total] = await Promise.all([
    prisma.message.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.message.count({ where }),
  ]);

  res.json({ items: items.map(messageToStaffDto), page, limit, total });
};

// POST /api/v2/staff/conversations/:id/assign — prendre une conversation en
// charge. Un agent s'assigne à lui-même ; un ADMIN, sans fiche d'agent, doit
// désigner un agentId.
export const assignConversation = async (req, res) => {
  const conversation = await conversationPourStaff(req, res);
  if (!conversation) return;

  let agentId;
  if (req.agent) {
    const agentIdCorps = req.body.agentId ? Number(req.body.agentId) : null;
    if (agentIdCorps && agentIdCorps !== req.agent.id) {
      return res.status(403).json({ error: 'Un agent ne peut s’assigner qu’à lui-même' });
    }
    agentId = req.agent.id;
  } else {
    agentId = req.body.agentId ? Number(req.body.agentId) : null;
    if (!agentId) {
      return res.status(400).json({ error: 'agentId est requis pour un administrateur' });
    }
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return res.status(404).json({ error: 'Agent introuvable' });
    }
    if (!agent.isActive) {
      return res.status(400).json({ error: 'Agent inactif' });
    }
  }

  const maj = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { assignedAgentId: agentId },
    include: {
      customer: { select: { id: true, firstname: true, lastname: true } },
      assignedAgent: { select: { id: true, displayName: true } },
    },
  });
  // L'équipe est notifiée en temps réel : la prise en charge déplace la
  // conversation dans la file de l'agent, et ceux qui regardaient la file
  // commune doivent le savoir sans rafraîchir.
  emitConversationAssigned(req.app.get('io'), maj);
  res.json(conversationToStaffDto(maj));
};

// POST /api/v2/staff/conversations/:id/escalate { reason } — faire monter une
// conversation vers toute l'équipe. L'escalade désassigne : la conversation
// repart dans la file commune, elle ne reste pas attachée à l'agent qui l'a
// fait monter.
export const escalateConversation = async (req, res) => {
  const conversation = await conversationPourStaff(req, res);
  if (!conversation) return;

  const maj = await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      escalatedAt: new Date(),
      escalationReason: req.body.reason,
      assignedAgentId: null,
    },
    include: {
      customer: { select: { id: true, firstname: true, lastname: true } },
      assignedAgent: { select: { id: true, displayName: true } },
    },
  });
  // L'escalade remet la conversation dans la file commune : toute l'équipe
  // doit le savoir, y compris les agents pas encore assignés.
  emitConversationEscalated(req.app.get('io'), maj);
  res.json(conversationToStaffDto(maj));
};

// POST /api/v2/staff/conversations/:id/close — clore une conversation.
export const closeConversation = async (req, res) => {
  const conversation = await conversationPourStaff(req, res);
  if (!conversation) return;

  const maj = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { status: 'CLOSED' },
    include: {
      customer: { select: { id: true, firstname: true, lastname: true } },
      assignedAgent: { select: { id: true, displayName: true } },
    },
  });
  res.json(conversationToStaffDto(maj));
};

// POST /api/v2/staff/conversations/:id/messages { content, isInternal? } —
// répondre dans une conversation de son type. Le message porte l'identité
// complète de l'auteur (agent ou utilisateur) pour la traçabilité ; une note
// interne n'est jamais renvoyée au client (côté client, le filtre isInternal).
// L'écriture et la diffusion (salle de conversation ou salle staff si note
// interne) sont déléguées au service de messagerie.
export const sendStaffMessage = async (req, res) => {
  const conversation = await conversationPourStaff(req, res);
  if (!conversation) return;

  const message = await createMessage(req.app.get('io'), {
    conversationId: conversation.id,
    senderType: 'AGENT',
    senderUserId: req.user.id,
    senderAgentId: req.agent?.id ?? null,
    content: req.body.content,
    isInternal: req.body.isInternal,
  });

  res.status(201).json(messageToStaffDto(message));
};
