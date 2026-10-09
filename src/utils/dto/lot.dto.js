import { toNumber } from '../money.js';

// Les photos sortent triées : la photo principale d'abord, puis par position.
// Le tri est fait ici plutôt qu'en SQL pour ne pas dépendre de l'ordre
// d'insertion des lignes Media.
function imagesToApi(media) {
  return [...media]
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.position - b.position)
    .map((m) => ({ url: m.url, position: m.position, isPrimary: m.isPrimary }));
}

// Forme fournisseur : tout ce que le promoteur a déclaré sur son lot. Le lot
// reste une donnée interne — ici ni prix public ni aucune donnée acheteur
// n'apparaît (le catalogue, lui, passe par les annonces : P2.6).
export function lotToSupplierDto(lot) {
  return {
    id: lot.id,
    lotCode: lot.lotCode,
    product: {
      id: lot.product.id,
      name: lot.product.name,
      isPerishable: lot.product.isPerishable,
      category: { code: lot.product.category.code, label: lot.product.category.label },
      unit: { code: lot.product.unit.code, label: lot.product.unit.label },
    },
    zone: { id: lot.zone.id, name: lot.zone.name },
    storageType: lot.storageType,
    hub: lot.hub ? { id: lot.hub.id, name: lot.hub.name, city: lot.hub.city } : null,
    pickupAddress: lot.pickupAddress,
    pickupLatitude: lot.pickupLatitude,
    pickupLongitude: lot.pickupLongitude,
    agreedUnitPrice: toNumber(lot.agreedUnitPrice),
    quantityInitial: toNumber(lot.quantityInitial),
    quantityAvailable: toNumber(lot.quantityAvailable),
    quantityReserved: toNumber(lot.quantityReserved),
    quantitySold: toNumber(lot.quantitySold),
    quantityLost: toNumber(lot.quantityLost),
    status: lot.status,
    rejectionReason: lot.rejectionReason,
    packagingNote: lot.packagingNote,
    qualityNote: lot.qualityNote,
    images: imagesToApi(lot.media ?? []),
    harvestedAt: lot.harvestedAt,
    expiresAt: lot.expiresAt,
    createdAt: lot.createdAt,
    updatedAt: lot.updatedAt,
  };
}

// Vue staff (P2.4) : la même forme, plus l'identité du fournisseur. La
// relation supplier doit être chargée avec user.profileVerificationStatus :
// l'équipe ne peut valider que le lot d'un fournisseur vérifié.
export function lotToStaffDto(lot) {
  return {
    ...lotToSupplierDto(lot),
    supplier: {
      id: lot.supplier.id,
      farmName: lot.supplier.farmName,
      profileVerificationStatus: lot.supplier.user?.profileVerificationStatus ?? null,
    },
  };
}
