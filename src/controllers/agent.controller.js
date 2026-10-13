import prisma from '../config/prisma.js';
import { recordAudit } from '../utils/audit.js';

// Fiche d'agent exposee a l'admin : la fiche, ses capacites et, pour un agent
// humain, l'identite du compte rattache (un admin doit savoir QUI est derriere
// la fiche). L'email est lu via un select explicite : jamais de password.
const agentSelect = {
  id: true,
  kind: true,
  displayName: true,
  userId: true,
  autonomy: true,
  isActive: true,
  aiProvider: true,
  aiModel: true,
  createdAt: true,
  capabilities: { select: { capability: { select: { code: true, label: true } } } },
  user: { select: { id: true, firstname: true, lastname: true, email: true } },
};

// Remplace toutes les capacites d'une fiche par la liste fournie (codes deja
// valides en base : le validator a rejete les inconnus avant la transaction).
async function replaceCapabilities(tx, agentId, codes) {
  const rows = await tx.agentCapability.findMany({
    where: { code: { in: codes } },
    select: { id: true },
  });
  await tx.agentCapabilityLink.deleteMany({ where: { agentId } });
  if (rows.length > 0) {
    await tx.agentCapabilityLink.createMany({
      data: rows.map((row) => ({ agentId, capabilityId: row.id })),
    });
  }
}

// GET /api/v2/admin/agents — toutes les fiches d'agents (ADMIN et plus).
export const listAgents = async (req, res) => {
  const agents = await prisma.agent.findMany({
    select: agentSelect,
    orderBy: { id: 'asc' },
  });

  res.json(agents);
};

// PATCH /api/v2/admin/agents/:id — modification d'une fiche d'agent.
export const updateAgent = async (req, res) => {
  const { displayName, isActive, capabilities, autonomy } = req.body;

  const fiche = await prisma.agent.findUnique({ where: { id: req.params.id } });
  if (!fiche) return res.status(404).json({ error: 'Agent introuvable' });

  // Regle C6 : un agent IA ne peut JAMAIS detenir PAYMENT_FOLLOWUP, meme sur
  // demande explicite de l'admin : l'IA n'agit pas sur l'argent.
  if (fiche.kind === 'AI' && Array.isArray(capabilities) && capabilities.includes('PAYMENT_FOLLOWUP')) {
    return res.status(400).json({ error: 'Un agent IA ne peut pas recevoir la capacité PAYMENT_FOLLOWUP' });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const data = {};
    if (displayName !== undefined) data.displayName = displayName;
    if (isActive !== undefined) data.isActive = isActive;
    if (autonomy !== undefined) data.autonomy = autonomy || null;
    if (capabilities !== undefined) {
      await replaceCapabilities(tx, fiche.id, capabilities);
    }

    const agent = await tx.agent.update({
      where: { id: fiche.id },
      data,
      select: agentSelect,
    });

    // Audit dans la meme transaction : l'historique de modification survit
    // a l'action, pas l'inverse.
    const changes = {};
    if (displayName !== undefined) changes.displayName = displayName;
    if (isActive !== undefined) changes.isActive = isActive;
    if (autonomy !== undefined) changes.autonomy = autonomy || null;
    if (capabilities !== undefined) changes.capabilities = capabilities;

    await recordAudit(tx, {
      actorUser: req.user,
      action: 'AGENT_UPDATED',
      entityType: 'Agent',
      entityId: fiche.id,
      metadata: { changes },
    });

    return agent;
  });

  res.json(updated);
};

// POST /api/v2/admin/agents/ai — creation d'un agent IA, SANS compte
// utilisateur (userId reste null : l'IA n'a pas de connexion).
export const createAiAgent = async (req, res) => {
  const { displayName, aiProvider, aiModel, aiConfig, autonomy } = req.body;

  const agent = await prisma.$transaction(async (tx) => {
    const fiche = await tx.agent.create({
      data: {
        kind: 'AI',
        displayName,
        userId: null,
        aiProvider,
        aiModel,
        aiConfig: aiConfig ?? undefined,
        autonomy,
      },
      select: agentSelect,
    });

    await recordAudit(tx, {
      actorUser: req.user,
      action: 'AGENT_AI_CREATED',
      entityType: 'Agent',
      entityId: fiche.id,
      metadata: { displayName, aiProvider, aiModel, autonomy },
    });

    return fiche;
  });

  res.status(201).json(agent);
};
