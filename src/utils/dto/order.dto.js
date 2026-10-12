import { toNumber } from '../money.js';

// Lignes de commande : la forme acheteur n'expose que la référence et le
// titre de l'annonce, jamais le lot, le fournisseur ni les prix internes.
function itemToBuyerApi(item) {
  return {
    id: item.id,
    listingId: item.listingId,
    listingReference: item.listing?.reference ?? null,
    listingTitle: item.listing?.title ?? null,
    quantity: toNumber(item.quantity),
    unitPrice: toNumber(item.unitPrice),
    lineTotal: toNumber(item.lineTotal),
  };
}

// Lignes de commande : la forme staff expose aussi le lot, le prix convenu,
// la commission et le montant net fournisseur — données internes que l'équipe
// est seule à voir.
function itemToStaffApi(item) {
  return {
    ...itemToBuyerApi(item),
    lotId: item.lotId,
    supplierUnitPrice: toNumber(item.supplierUnitPrice),
    commissionRate: toNumber(item.commissionRate),
    commissionAmount: toNumber(item.commissionAmount),
    supplierNetAmount: toNumber(item.supplierNetAmount),
  };
}

// Adresse de livraison : identique dans les deux vues (l'acheteur doit savoir
// où sa commande sera livrée).
function deliveryToApi(order) {
  if (!order.deliveryAddress) return null;
  return {
    zoneId: order.deliveryZoneId,
    address: order.deliveryAddress,
    latitude: order.deliveryLatitude,
    longitude: order.deliveryLongitude,
  };
}

// Point de retrait : identique dans les deux vues.
function pickupToApi(order) {
  if (!order.pickupHub) return null;
  return {
    id: order.pickupHub.id,
    name: order.pickupHub.name,
    address: order.pickupHub.address,
    city: order.pickupHub.city,
  };
}

// Origines d'enlèvement (staff uniquement) : l'acheteur ne doit jamais savoir
// d'où part la marchandise (adresse du fournisseur ou du hub).
function originsToApi(order) {
  return (order.origins ?? []).map((o) => ({
    type: o.type,
    hubId: o.hubId ?? null,
    hubName: o.hubName ?? null,
    address: o.address ?? null,
    latitude: o.latitude ?? null,
    longitude: o.longitude ?? null,
    distanceKm: o.distanceKm,
    agencyCost: toNumber(o.agencyCost),
    deliveryFee: toNumber(o.deliveryFee),
  }));
}

// Vue acheteur (P3.4) : montants, statut, mode de livraison, échéance de
// réservation. JAMAIS de donnée fournisseur (supplierId, farmName, adresse
// d'enlèvement) ni de prix interne (agreedUnitPrice, commission).
export function orderToBuyerDto(order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    deliveryMode: order.deliveryMode?.code ?? null,
    items: (order.items ?? []).map(itemToBuyerApi),
    subtotal: toNumber(order.subtotal),
    buyerFee: toNumber(order.buyerFee),
    deliveryFee: toNumber(order.deliveryFee),
    total: toNumber(order.total),
    delivery: deliveryToApi(order),
    pickup: pickupToApi(order),
    notes: order.notes,
    reservedUntil: order.reservedUntil,
    createdAt: order.createdAt,
  };
}

// Vue staff (P3.4) : tout, y compris les origines d'enlèvement, les montants
// par origine et la commission totale (revenu de la plateforme).
export function orderToStaffDto(order) {
  return {
    ...orderToBuyerDto(order),
    items: (order.items ?? []).map(itemToStaffApi),
    commissionTotal: toNumber(order.commissionTotal),
    origins: originsToApi(order),
    buyer: order.buyer
      ? { id: order.buyer.id, firstname: order.buyer.firstname, lastname: order.buyer.lastname }
      : null,
    handledByAgentId: order.handledByAgentId ?? null,
    conversationId: order.conversationId ?? null,
    paymentStatus: order.paymentStatus ?? null,
    confirmedAt: order.confirmedAt ?? null,
    cancelledAt: order.cancelledAt ?? null,
    cancellationReason: order.cancellationReason ?? null,
  };
}
