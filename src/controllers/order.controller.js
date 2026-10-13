import prisma from '../config/prisma.js';
import { orderToBuyerDto } from '../utils/dto/order.dto.js';
import { confirmerAvecExpiration, cancelOrder } from '../services/order.service.js';

// Routes acheteur du cycle de vie de la commande (plan v2, P3.5).
// L'acheteur n'agit que sur SES commandes : toute lecture ou action sur une
// commande qui n'est pas la sienne repond 404, sans reveler son existence.

// Include du DTO acheteur : lignes par annonce, mode de livraison, point de
// retrait. Jamais de lot, de fournisseur ni de prix interne.
const ORDER_BUYER_INCLUDE = {
  items: { include: { listing: true } },
  deliveryMode: true,
  pickupHub: true,
};

// Recharge la commande complete pour le DTO acheteur.
async function chargerPourDto(orderId) {
  return prisma.order.findUnique({ where: { id: orderId }, include: ORDER_BUYER_INCLUDE });
}

// L'identite de l'audit : un acheteur n'a jamais de fiche d'agent.
function acteur(req) {
  return { actorUser: req.user, actorAgent: null };
}

// GET /api/v2/orders — les commandes de l'acheteur connecte, paginees.
export const listMesCommandes = async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where: { buyerId: req.user.id },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: ORDER_BUYER_INCLUDE,
    }),
    prisma.order.count({ where: { buyerId: req.user.id } }),
  ]);
  res.json({ items: items.map(orderToBuyerDto), page, limit, total });
};

// Charge la commande en verifiant qu'elle appartient a l'acheteur connecte.
// Retourne null sinon : l'acheteur ne doit meme pas savoir qu'une commande
// existe ailleurs (le 404 ne distingue pas "inconnue" et "pas a lui").
async function chargerMaCommande(req) {
  const commande = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: ORDER_BUYER_INCLUDE,
  });
  if (!commande || commande.buyerId !== req.user.id) {
    return null;
  }
  return commande;
}

// GET /api/v2/orders/:id — le detail de sa commande (404 si pas la sienne).
export const getMaCommande = async (req, res) => {
  const commande = await chargerMaCommande(req);
  if (!commande) {
    return res.status(404).json({ error: 'Commande introuvable' });
  }
  res.json(orderToBuyerDto(commande));
};

// POST /api/v2/orders/:id/confirm — confirmation d'un devis (seulement
// QUOTED : la machine a etats refuse les autres statuts). Un devis expire
// repond 409 QUOTE_EXPIRED et son stock est libere (confirmerAvecExpiration).
export const confirmerCommande = async (req, res) => {
  const commande = await chargerMaCommande(req);
  if (!commande) {
    return res.status(404).json({ error: 'Commande introuvable' });
  }
  await confirmerAvecExpiration(prisma, commande.id, acteur(req));
  res.status(200).json(orderToBuyerDto(await chargerPourDto(req.params.id)));
};

// POST /api/v2/orders/:id/cancel — annulation d'un devis (seulement QUOTED).
// La raison est facultative : une annulation n'a pas toujours a etre justifiee.
export const annulerMaCommande = async (req, res) => {
  const commande = await chargerMaCommande(req);
  if (!commande) {
    return res.status(404).json({ error: 'Commande introuvable' });
  }
  const raison = req.body?.reason ?? null;
  await prisma.$transaction((tx) => cancelOrder(tx, commande.id, acteur(req), raison));
  res.status(200).json(orderToBuyerDto(await chargerPourDto(req.params.id)));
};
