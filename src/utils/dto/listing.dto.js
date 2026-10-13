import { toNumber } from '../money.js';
import { lotToStaffDto } from './lot.dto.js';

// Les photos sortent triées : la photo principale d'abord, puis par position.
// Le tri est fait ici plutôt qu'en SQL pour ne pas dépendre de l'ordre
// d'insertion des lignes Media.
function imagesToApi(media) {
  return [...media]
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.position - b.position)
    .map((m) => ({ url: m.url, position: m.position, isPrimary: m.isPrimary }));
}

// Photos acheteur : uniquement les URLs, triées (principale d'abord).
function imagesToBuyerApi(media) {
  return [...media]
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.position - b.position)
    .map((m) => m.url);
}

// Vue acheteur (P2.6) : l'annonce expose un produit, jamais un lot. Aucune
// donnée interne (lot, fournisseur, prix convenu, adresse de retrait) ne
// transparaît : l'acheteur ne voit que ce qu'il a besoin d'acheter.
export function listingToBuyerDto(listing) {
  const lots = listing.lots ?? [];
  const maintenant = new Date();

  // Un lot est "non expiré" si expiresAt est null ou dans le futur.
  const lotsNonExpires = lots.filter((l) => {
    const lot = l.lot;
    return lot.expiresAt === null || lot.expiresAt === undefined || new Date(lot.expiresAt) > maintenant;
  });

  // Quantité disponible : somme des quantityAvailable des lots non expirés.
  const quantityAvailable = lotsNonExpires.reduce((sum, l) => sum + toNumber(l.lot.quantityAvailable), 0);

  // expiresAt la plus proche parmi les lots non expirés.
  const expiresAt = lotsNonExpires
    .map((l) => l.lot.expiresAt)
    .filter((d) => d !== null && d !== undefined)
    .sort((a, b) => new Date(a) - new Date(b))[0] ?? null;

  // qualityGrade le plus bas (A > B > C) parmi les lots non expirés : le
  // dernier du tri alphabétique est le grade le plus mauvais.
  const grades = lotsNonExpires.map((l) => l.lot.qualityGrade).filter(Boolean);
  const qualityGrade = grades.length > 0 ? [...grades].sort().at(-1) : null;

  return {
    id: listing.id,
    reference: listing.reference,
    title: listing.title,
    description: listing.description,
    category: { code: listing.product.category.code, label: listing.product.category.label },
    unit: { code: listing.product.unit.code, label: listing.product.unit.label },
    unitPrice: toNumber(listing.unitPrice),
    quantityAvailable,
    expiresAt,
    zone: { id: listing.zone.id, name: listing.zone.name, city: listing.zone.city },
    images: imagesToBuyerApi(listing.media ?? []),
    qualityGrade,
  };
}

// Vue staff : l'annonce avec son lot et le promoteur. Le lot est une donnée
// interne : il apparaît ici parce que l'équipe le gère, jamais côté acheteur
// (le catalogue, lui, expose une forme anonymisée : P2.6).
export function listingToStaffDto(listing) {
  const lot = listing.lots?.[0]?.lot ?? null;
  return {
    id: listing.id,
    reference: listing.reference,
    title: listing.title,
    description: listing.description,
    unitPrice: toNumber(listing.unitPrice),
    status: listing.status.code,
    publishedAt: listing.publishedAt,
    product: {
      id: listing.product.id,
      name: listing.product.name,
      category: { code: listing.product.category.code, label: listing.product.category.label },
      unit: { code: listing.product.unit.code, label: listing.product.unit.label },
    },
    zone: { id: listing.zone.id, name: listing.zone.name },
    images: imagesToApi(listing.media ?? []),
    lot: lot ? lotToStaffDto(lot) : null,
    createdByUserId: listing.createdByUserId,
    createdByAgentId: listing.createdByAgentId,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
  };
}
