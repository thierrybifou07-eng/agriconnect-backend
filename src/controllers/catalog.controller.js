import prisma from '../config/prisma.js';
import { getLookupId } from '../utils/lookupCache.js';
import { listingToBuyerDto } from '../utils/dto/listing.dto.js';
import { categoryToApi } from '../utils/dto/category.dto.js';

// Le DTO acheteur a besoin du statut, du produit (avec catégorie et unité),
// de la zone, des photos et des lots (quantité, qualité, péremption).
const LISTING_BUYER_INCLUDE = {
  status: true,
  product: { include: { category: true, unit: true } },
  zone: true,
  media: true,
  lots: { include: { lot: true } },
};

// Statuts de lot qui n'ont plus rien à vendre : un lot EXPIRED, RETURNED,
// WITHDRAWN ou REJECTED ne compte pas dans la quantité disponible.
const STATUTS_LOTS_INACTIFS = ['EXPIRED', 'RETURNED', 'WITHDRAWN', 'REJECTED'];

// Calcule la quantité disponible d'une annonce : somme des quantityAvailable
// de ses lots non expirés et dans un statut actif.
function quantiteDisponible(listing, maintenant) {
  return (listing.lots ?? []).reduce((sum, lien) => {
    const lot = lien.lot;
    if (STATUTS_LOTS_INACTIFS.includes(lot.status)) return sum;
    if (lot.expiresAt && new Date(lot.expiresAt) <= maintenant) return sum;
    return sum + Number(lot.quantityAvailable);
  }, 0);
}

// GET /api/v2/catalog/categories — catégories de produits actives.
export const listCategories = async (req, res) => {
  const categories = await prisma.productCategory.findMany({
    where: { isActive: true },
    orderBy: { label: 'asc' },
    select: { id: true, code: true, label: true },
  });
  res.json(categories.map(categoryToApi));
};

// GET /api/v2/catalog/listings — annonces ACTIVE avec du stock, paginées.
export const listListings = async (req, res) => {
  const { zoneId, categoryId, q, sort } = req.query;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  // Filtres SQL : zone, catégorie, recherche texte.
  const where = { statusId: await getLookupId('listingStatus', 'ACTIVE') };
  if (zoneId) where.zoneId = Number(zoneId);
  if (categoryId) where.product = { categoryId: Number(categoryId) };
  if (q) {
    where.OR = [
      { title: { contains: q } },
      { description: { contains: q } },
    ];
  }

  const annonces = await prisma.listing.findMany({
    where,
    include: LISTING_BUYER_INCLUDE,
  });

  // Filtrage en JS : quantité disponible > 0 (dépend des lots).
  const maintenant = new Date();
  const avecStock = annonces.filter((a) => quantiteDisponible(a, maintenant) > 0);

  // Tri selon le paramètre sort.
  let triees;
  if (sort === 'price') {
    triees = avecStock.sort((a, b) => Number(a.unitPrice) - Number(b.unitPrice));
  } else if (sort === 'expiry') {
    // Tri par expiresAt le plus proche (null = jamais expiré = en dernier).
    triees = avecStock.sort((a, b) => {
      const ea = a.lots?.[0]?.lot?.expiresAt;
      const eb = b.lots?.[0]?.lot?.expiresAt;
      if (!ea && !eb) return 0;
      if (!ea) return 1;
      if (!eb) return -1;
      return new Date(ea) - new Date(eb);
    });
  } else {
    // Tri par défaut : récence (publishedAt décroissant).
    triees = avecStock.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  }

  const total = triees.length;
  const items = triees.slice((page - 1) * limit, page * limit).map(listingToBuyerDto);

  res.json({ items, page, limit, total });
};

// GET /api/v2/catalog/listings/:id — détail d'une annonce ACTIVE.
export const getListing = async (req, res) => {
  const annonce = await prisma.listing.findUnique({
    where: { id: req.params.id },
    include: LISTING_BUYER_INCLUDE,
  });

  if (!annonce || annonce.status.code !== 'ACTIVE') {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }

  // Vérifie qu'il reste du stock.
  const maintenant = new Date();
  if (quantiteDisponible(annonce, maintenant) <= 0) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }

  res.json(listingToBuyerDto(annonce));
};
