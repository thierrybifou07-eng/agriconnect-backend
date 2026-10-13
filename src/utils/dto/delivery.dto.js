import { toNumber } from '../money.js';

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
