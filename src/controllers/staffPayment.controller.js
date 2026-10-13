import prisma from '../config/prisma.js';
import { recordPayment, refundPayment, listPayments } from '../services/payment.service.js';
import { paymentToApi } from '../utils/dto/payment.dto.js';

// Résout l'identité de l'acteur pour l'audit (recordAudit attend des objets).
// Un agent connecté a req.agent (requireCapability) ; un admin n'en a pas.
function acteur(req) {
  return {
    actorUser: req.user,
    actorAgent: req.agent ?? null,
  };
}

// POST /api/v2/staff/orders/:id/payments — enregistre un paiement manuel.
// L'en-tête Idempotency-Key est obligatoire : c'est elle qui garantit
// l'idempotence (même clé = même résultat, même en concurrence).
// 201 à la création, 200 quand la clé a déjà été utilisée (rejeu).
export const recordPaymentHandler = async (req, res) => {
  const idempotencyKey = req.get('Idempotency-Key');
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'En-tête Idempotency-Key requis' });
  }
  const { amount, method, reference, paidAt } = req.body;
  const { payment, rejoue } = await recordPayment(
    prisma,
    req.params.id,
    { amount, method, reference, paidAt },
    idempotencyKey,
    acteur(req)
  );
  res.status(rejoue ? 200 : 201).json(paymentToApi(payment));
};

// GET /api/v2/staff/orders/:id/payments — liste les paiements d'une commande.
export const listPaymentsHandler = async (req, res) => {
  const paiements = await listPayments(prisma, req.params.id);
  res.json({ items: paiements.map(paymentToApi) });
};

// POST /api/v2/staff/payments/:id/refund — rembourse un paiement CONFIRMED.
// Pouvoir de direction (ADMIN et plus) : l'argent repart, la décision est
// tracée dans l'audit.
export const refundPaymentHandler = async (req, res) => {
  const payment = await refundPayment(prisma, req.params.id, acteur(req));
  res.json(paymentToApi(payment));
};
