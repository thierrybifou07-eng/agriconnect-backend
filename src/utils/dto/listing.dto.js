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
