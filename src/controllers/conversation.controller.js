import prisma from '../config/prisma.js';
import { conversationToClientDto, messageToClientDto } from '../utils/dto/conversation.dto.js';
import { createMessage, createMessageTx, emitNewMessage } from '../services/message.service.js';

// Messagerie client <-> équipe (plan v2, P3.1).
//
// Une conversation relie toujours un CLIENT (acheteur ou fournisseur) à
// l'équipe AgriConnect : jamais un acheteur à un fournisseur. Le type de la
// conversation découle du rôle de son auteur : un acheteur suit une annonce
// (BUYER_SUPPORT), un fournisseur parle de l'un de ses lots (SUPPLIER_SUPPORT).

// Seuls les deux rôles clients peuvent ouvrir une conversation : la messagerie
// n'est ni un outil interne (l'équipe a ses canaux staff) ni un canal
// inter-clients.
const ROLES_CONVERSATION = ['BUYER', 'SUPPLIER'];

// Longueurs de page : mêmes bornes que les autres listes paginées du projet.
const pageLimite = (valeur, defaut) => Math.min(100, Math.max(1, Number(valeur) || defaut));

// Charge une conversation en vérifiant qu'elle appartient à l'utilisateur
// connecté. Une conversation d'autrui répond 404 (et non 403) : révéler son
// existence reviendrait à confirmer qu'un autre client existe.
async function conversationDuClient(req, res) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, customerId: req.user.id },
  });
  if (!conversation) {
    res.status(404).json({ error: 'Conversation introuvable' });
    return null;
  }
  return conversation;
}

// POST /api/v2/conversations — ouvre une conversation et écrit le premier
// message dans la MÊME transaction : un fil sans premier message est un état
// intermédiaire que personne ne doit pouvoir observer.
export const createConversation = async (req, res) => {
  if (!ROLES_CONVERSATION.includes(req.user.role.code)) {
    return res.status(400).json({ error: 'Seuls les acheteurs et les fournisseurs peuvent ouvrir une conversation' });
  }

  const { listingId, lotId, content } = req.body;
  const estAcheteur = req.user.role.code === 'BUYER';

  // Cohérence rôle / référence : un acheteur suit une annonce, un fournisseur
  // parle d'un de ses lots. L'autre champ n'a aucun sens pour ce rôle.
  if (estAcheteur && lotId) {
    return res.status(400).json({ error: "lotId n'est pas autorisé pour un acheteur" });
  }
  if (!estAcheteur && listingId) {
    return res.status(400).json({ error: "listingId n'est pas autorisé pour un fournisseur" });
  }

  // L'annonce doit exister et être ACTIVE : on n'ouvre pas de conversation sur
  // une offre que les acheteurs ne peuvent plus consulter.
  if (estAcheteur && listingId) {
    const annonce = await prisma.listing.findUnique({
      where: { id: listingId },
      include: { status: true },
    });
    if (!annonce || annonce.status.code !== 'ACTIVE') {
      return res.status(400).json({ error: 'Annonce introuvable ou inactive' });
    }
  }

  // Le lot doit exister et appartenir au fournisseur (via son profil) : un
  // fournisseur ne peut pas ouvrir de conversation sur le lot d'un tiers.
  if (!estAcheteur && lotId) {
    const lot = await prisma.stockLot.findFirst({
      where: { id: lotId, supplier: { userId: req.user.id } },
    });
    if (!lot) {
      return res.status(404).json({ error: 'Lot introuvable' });
    }
  }

  // Le premier message est écrit dans la MÊME transaction que la
  // conversation (createMessageTx) : un fil sans premier message est un état
  // intermédiaire que personne ne doit pouvoir observer. L'événement
  // temps réel part après le commit : émettre dans la transaction enverrait
  // message:new avant que l'écriture ne soit garantie.
  const { conversation, message } = await prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: {
        type: estAcheteur ? 'BUYER_SUPPORT' : 'SUPPLIER_SUPPORT',
        customerId: req.user.id,
        listingId: estAcheteur ? listingId : null,
        lotId: estAcheteur ? null : lotId,
      },
    });
    const message = await createMessageTx(tx, {
      conversationId: conversation.id,
      senderType: 'CUSTOMER',
      senderUserId: req.user.id,
      content,
    });
    return { conversation, message };
  });
  emitNewMessage(req.app.get('io'), message);

  // Relecture pour renvoyer le DTO complet (lastMessageAt est posé par défaut
  // à l'insertion, le DTO client le reprend tel quel).
  const cree = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  return res.status(201).json(conversationToClientDto(cree));
};

// GET /api/v2/conversations — les conversations de l'utilisateur, les plus
// récemment actives en premier.
export const listConversations = async (req, res) => {
  const page = pageLimite(req.query.page, 1);
  const limit = pageLimite(req.query.limit, 20);

  const where = { customerId: req.user.id };
  const [items, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.conversation.count({ where }),
  ]);

  res.json({ items: items.map(conversationToClientDto), page, limit, total });
};

// GET /api/v2/conversations/:id/messages — le fil public de la conversation :
// chronologique, SANS les notes internes (isInternal), qui ne sont lisibles
// que par l'équipe.
export const listMessages = async (req, res) => {
  const conversation = await conversationDuClient(req, res);
  if (!conversation) return;

  const page = pageLimite(req.query.page, 1);
  const limit = pageLimite(req.query.limit, 20);

  const where = { conversationId: conversation.id, isInternal: false };
  const [items, total] = await Promise.all([
    prisma.message.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { senderAgent: { select: { kind: true } } },
    }),
    prisma.message.count({ where }),
  ]);

  res.json({ items: items.map(messageToClientDto), page, limit, total });
};

// POST /api/v2/conversations/:id/messages — répondre dans sa propre
// conversation. Chaque message (client ou staff) rafraîchit lastMessageAt :
// c'est lui qui pilote le tri de la liste. L'écriture et l'émission de
// message:new sont déléguées au service de messagerie.
export const sendMessage = async (req, res) => {
  const conversation = await conversationDuClient(req, res);
  if (!conversation) return;

  const message = await createMessage(req.app.get('io'), {
    conversationId: conversation.id,
    senderType: 'CUSTOMER',
    senderUserId: req.user.id,
    content: req.body.content,
  });

  res.status(201).json(messageToClientDto(message));
};
