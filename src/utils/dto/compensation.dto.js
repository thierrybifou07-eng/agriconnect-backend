import { toNumber } from '../money.js';

// Forme API d'une indemnisation (plan v2, P6.2) : montants en nombres,
// jamais de Decimal ni de donnee interne.
export function compensationToApi(c) {
  return {
    id: c.id,
    lotId: c.lotId,
    deliveryId: c.deliveryId ?? null,
    reason: c.reason,
    quantity: toNumber(c.quantity),
    unitPrice: toNumber(c.unitPrice),
    rate: toNumber(c.rate),
    amount: toNumber(c.amount),
    status: c.status,
    note: c.note ?? null,
    approvedById: c.approvedById ?? null,
    approvedAt: c.approvedAt ?? null,
    paidAt: c.paidAt ?? null,
    createdAt: c.createdAt,
  };
}
