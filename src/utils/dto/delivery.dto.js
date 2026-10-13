import { toNumber } from '../money.js';

// Livraison exposee au livreur : adresses, destinataire, distance et nature
// de la marchandise. JAMAIS de prix ni de montant — le livreur n'a pas a
// connaître la tarification, la valeur assuree ou les frais d'agence.
export function deliveryToDriverDto(delivery) {
  return {
    id: delivery.id,
    status: delivery.status,
    pickupAddress: delivery.pickupAddress ?? null,
    pickupLatitude: delivery.pickupLatitude ?? null,
    pickupLongitude: delivery.pickupLongitude ?? null,
    dropoffAddress: delivery.dropoffAddress,
    dropoffLatitude: delivery.dropoffLatitude ?? null,
    dropoffLongitude: delivery.dropoffLongitude ?? null,
    distanceKm: delivery.distanceKm,
    buyer: delivery.order?.buyer
      ? {
          firstname: delivery.order.buyer.firstname,
          lastname: delivery.order.buyer.lastname,
          phone: delivery.order.buyer.phone,
        }
      : null,
    items: (delivery.order?.items ?? []).map((item) => ({
      productName: item.lot?.product?.name ?? null,
      categoryName: item.lot?.product?.category?.label ?? null,
      quantity: toNumber(item.quantity),
    })),
    acceptedAt: delivery.acceptedAt ?? null,
    pickedUpAt: delivery.pickedUpAt ?? null,
    deliveredAt: delivery.deliveredAt ?? null,
    failureReason: delivery.failureReason ?? null,
  };
}

// Livraison exposée à l'équipe : tarification figée, valeur assurée et police
// d'assurance sont des données internes que seul le staff peut consulter.
export function deliveryToStaffDto(delivery) {
  return {
    id: delivery.id,
    orderId: delivery.orderId,
    agencyId: delivery.agencyId,
    agencyName: delivery.agency?.name ?? null,
    status: delivery.status,
    pickupHubId: delivery.pickupHubId ?? null,
    pickupAddress: delivery.pickupAddress ?? null,
    pickupLatitude: delivery.pickupLatitude ?? null,
    pickupLongitude: delivery.pickupLongitude ?? null,
    dropoffAddress: delivery.dropoffAddress,
    dropoffLatitude: delivery.dropoffLatitude ?? null,
    dropoffLongitude: delivery.dropoffLongitude ?? null,
    distanceKm: delivery.distanceKm,
    agencyCost: toNumber(delivery.agencyCost),
    deliveryFee: toNumber(delivery.deliveryFee),
    insuredValue: toNumber(delivery.insuredValue),
    insurancePolicyNumber: delivery.insurancePolicyNumber ?? null,
    acceptedAt: delivery.acceptedAt ?? null,
    pickedUpAt: delivery.pickedUpAt ?? null,
    deliveredAt: delivery.deliveredAt ?? null,
    createdAt: delivery.createdAt,
  };
}
