const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');

// POST /api/conversations  { listingId }
const createConversation = asyncHandler(async (req, res) => {
  const { listingId } = req.body;

  if (!listingId) {
    return res.status(400).json({ error: 'listingId est requis' });
  }

  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }

  if (listing.farmerId === req.user.id) {
    return res.status(400).json({ error: 'Vous ne pouvez pas contacter votre propre annonce' });
  }

  const conversation = await prisma.conversation.upsert({
    where: {
      listingId_buyerId: { listingId, buyerId: req.user.id },
    },
    update: {},
    create: {
      listingId,
      buyerId: req.user.id,
      farmerId: listing.farmerId,
    },
    include: { listing: true },
  });

  res.status(201).json(conversation);
});

// GET /api/conversations
const getMyConversations = asyncHandler(async (req, res) => {
  const conversations = await prisma.conversation.findMany({
    where: {
      OR: [{ buyerId: req.user.id }, { farmerId: req.user.id }],
    },
    include: {
      listing: { select: { id: true, title: true, price: true, photos: true } },
      buyer: { select: { id: true, fullName: true, avatarUrl: true } },
      farmer: { select: { id: true, fullName: true, avatarUrl: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json(conversations);
});

// GET /api/conversations/:id/messages
const getMessages = asyncHandler(async (req, res) => {
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });

  if (!conversation) {
    return res.status(404).json({ error: 'Conversation introuvable' });
  }
  if (![conversation.buyerId, conversation.farmerId].includes(req.user.id)) {
    return res.status(403).json({ error: "Vous n'avez pas accès à cette conversation" });
  }

  const messages = await prisma.message.findMany({
    where: { conversationId: req.params.id },
    orderBy: { createdAt: 'asc' },
  });

  res.json(messages);
});

// POST /api/conversations/:id/messages  { content }
const sendMessage = asyncHandler(async (req, res) => {
  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ error: 'content est requis' });
  }

  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation introuvable' });
  }
  if (![conversation.buyerId, conversation.farmerId].includes(req.user.id)) {
    return res.status(403).json({ error: "Vous n'avez pas accès à cette conversation" });
  }

  const message = await prisma.message.create({
    data: {
      conversationId: req.params.id,
      senderId: req.user.id,
      content,
    },
  });

  const io = req.app.get('io');
  if (io) io.to(req.params.id).emit('new_message', message);

  res.status(201).json(message);
});

module.exports = { createConversation, getMyConversations, getMessages, sendMessage };
