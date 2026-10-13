import { toNumber } from '../money.js';

// Forme API d'un paiement (plan v2, P4.1) : montants en nombres, jamais de
// Decimal ni de donnée interne.
export function paymentToApi(p) {
  return {
    id: p.id,
    orderId: p.orderId,
    amount: toNumber(p.amount),
    method: p.method,
    status: p.status,
    reference: p.reference ?? null,
    idempotencyKey: p.idempotencyKey ?? null,
    paidAt: p.paidAt ?? null,
    recordedById: p.recordedById ?? null,
    createdAt: p.createdAt,
  };
}
