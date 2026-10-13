import { Router } from 'express';
import {
  createLot,
  listLots,
  getLot,
  validateLot,
  rejectLot,
  returnLot,
  listStockMovements,
  createQualityCheck,
  listQualityChecks,
} from '../controllers/staffLot.controller.js';
import {
  createListing,
  listListings,
  getListing,
  updateListing,
  publishListing,
  unpublishListing,
} from '../controllers/staffListing.controller.js';
import {
  createOrder,
  listOrders,
  getOrder,
  changeOrderStatus,
  confirmOrderByStaff,
  cancelOrderByStaff,
} from '../controllers/staffOrder.controller.js';
import {
  listConversations,
  getConversation,
  listMessages,
  assignConversation,
  escalateConversation,
  closeConversation,
  sendStaffMessage,
} from '../controllers/staffConversation.controller.js';
import {
  recordPaymentHandler,
  listPaymentsHandler,
  refundPaymentHandler,
} from '../controllers/staffPayment.controller.js';
import { protect, requireMinLevel } from '../middlewares/auth.middleware.js';
import { requireCapability } from '../middlewares/capability.middleware.js';
import { requireHumanActor } from '../middlewares/humanActor.middleware.js';
import { coerceIdParam } from '../middlewares/params.middleware.js';
import upload from '../middlewares/upload.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { lotCreateSchema } from '../validators/lot.validator.js';
import { listingCreateSchema, listingUpdateSchema } from '../validators/listing.validator.js';
import { orderCreateSchema, orderStatusSchema, orderCancelSchema } from '../validators/order.validator.js';
import { paymentCreateSchema } from '../validators/payment.validator.js';
import {
  assignSchema,
  escalateSchema,
  staffMessageSchema,
} from '../validators/conversation.validator.js';
import Joi from 'joi';

const router = Router();

// :id est un identifiant entier partout (D2) : la conversion numérique
// s'applique avant tout contrôleur.
router.param('id', coerceIdParam);

// Les routes staff exigent STOCK_VALIDATION (AGENT) ou ADMIN/ROOT (level >= 50).
const STAFF = [protect, requireCapability('STOCK_VALIDATION')];

// Les routes d'annonces exigent LISTING_MANAGEMENT (AGENT) ou ADMIN/ROOT.
const STAFF_LISTING = [protect, requireCapability('LISTING_MANAGEMENT')];

// Les conversations exigent AU MOINS UN des deux supports (AGENT) ou ADMIN/ROOT :
// un agent n'agit ensuite que sur les conversations de son type, ce second
// contrôle se fait dans le contrôleur (le type est une donnée, pas une route).
const STAFF_CONVERSATIONS = [protect, requireCapability('BUYER_SUPPORT', 'SUPPLIER_SUPPORT')];

// Les commandes exigent ORDER_PROCESSING (AGENT) ou ADMIN/ROOT.
const STAFF_ORDERS = [protect, requireCapability('ORDER_PROCESSING')];

// Les routes de paiement exigent PAYMENT_FOLLOWUP (AGENT) ou ADMIN/ROOT.
// requireHumanActor refuse les agents IA : l'argent ne se déplace pas tout seul.
const STAFF_PAYMENTS = [protect, requireCapability('PAYMENT_FOLLOWUP'), requireHumanActor];

// Le remboursement est un pouvoir de direction (ADMIN et plus).
const STAFF_REFUND = [protect, requireMinLevel(50), requireHumanActor];

// Sans ce callback, un sixième fichier arrêterait multer avec
// LIMIT_UNEXPECTED_FILE et l'erreur remonterait en 500.
const uploadImages = (req, res, next) => {
  upload.array('images', 5)(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Maximum 5 images' : err.message;
    res.status(400).json({ error: message });
  });
};

// Schémas de validation pour les routes staff.
const staffLotCreateSchema = lotCreateSchema.keys({
  supplierUserId: Joi.number().integer().positive().required().messages({
    'any.required': 'supplierUserId est requis',
    'number.base': 'supplierUserId doit être un entier',
  }),
});

const rejectSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(500).required().messages({
    'any.required': 'reason est requis',
  }),
});

const returnSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(500).required().messages({
    'any.required': 'reason est requis',
  }),
});

const qualityCheckSchema = Joi.object({
  grade: Joi.string().valid('A', 'B', 'C').required().messages({
    'any.required': 'grade est requis',
    'any.only': 'grade doit être A, B ou C',
  }),
  notes: Joi.string().trim().max(500).allow(null).optional(),
});

// Création d'un lot au nom d'un fournisseur (mêmes champs que P2.2 + supplierUserId).
router.post('/lots', STAFF, uploadImages, validate(staffLotCreateSchema), createLot);

// Liste des lots avec filtres.
router.get('/lots', STAFF, listLots);
router.get('/lots/:id', STAFF, getLot);

// Validation, rejet, retour.
router.post('/lots/:id/validate', STAFF, validate(rejectSchema), validateLot);
router.post('/lots/:id/reject', STAFF, validate(rejectSchema), rejectLot);
router.post('/lots/:id/return', STAFF, validate(returnSchema), returnLot);

// Journal de stock.
router.get('/stock-movements', STAFF, listStockMovements);

// Contrôles qualité.
router.post('/lots/:id/quality-checks', STAFF, validate(qualityCheckSchema), createQualityCheck);
router.get('/lots/:id/quality-checks', STAFF, listQualityChecks);

// Annonces publiées par l'équipe à partir des lots validés (P2.5).
router.post('/listings', STAFF_LISTING, uploadImages, validate(listingCreateSchema), createListing);
router.get('/listings', STAFF_LISTING, listListings);
router.get('/listings/:id', STAFF_LISTING, getListing);
router.patch('/listings/:id', STAFF_LISTING, validate(listingUpdateSchema), updateListing);
router.post('/listings/:id/publish', STAFF_LISTING, publishListing);
router.post('/listings/:id/unpublish', STAFF_LISTING, unpublishListing);

// Conversations client <-> équipe (P3.1) : un agent n'agit que sur les
// conversations de son type (vérifié dans le contrôleur).
router.get('/conversations', STAFF_CONVERSATIONS, listConversations);
router.get('/conversations/:id', STAFF_CONVERSATIONS, getConversation);
router.get('/conversations/:id/messages', STAFF_CONVERSATIONS, listMessages);
router.post('/conversations/:id/assign', STAFF_CONVERSATIONS, validate(assignSchema), assignConversation);
router.post('/conversations/:id/escalate', STAFF_CONVERSATIONS, validate(escalateSchema), escalateConversation);
router.post('/conversations/:id/close', STAFF_CONVERSATIONS, closeConversation);
router.post('/conversations/:id/messages', STAFF_CONVERSATIONS, validate(staffMessageSchema), sendStaffMessage);

// Devis (P3.4) : l'équipe émet un devis qui réserve le stock et fige les prix.
router.post('/orders', STAFF_ORDERS, validate(orderCreateSchema), createOrder);

// Cycle de vie de la commande (P3.5) : consultation, changement de statut
// manuel, confirmation et annulation par l'équipe.
router.get('/orders', STAFF_ORDERS, listOrders);
router.get('/orders/:id', STAFF_ORDERS, getOrder);
router.patch('/orders/:id/status', STAFF_ORDERS, validate(orderStatusSchema), changeOrderStatus);
router.post('/orders/:id/confirm', STAFF_ORDERS, confirmOrderByStaff);
router.post('/orders/:id/cancel', STAFF_ORDERS, validate(orderCancelSchema), cancelOrderByStaff);

// Paiements manuels (P4.1) : enregistrement idempotente, consultation et
// remboursement. L'en-tête Idempotency-Key est obligatoire à l'enregistrement.
router.post('/orders/:id/payments', STAFF_PAYMENTS, validate(paymentCreateSchema), recordPaymentHandler);
router.get('/orders/:id/payments', STAFF_PAYMENTS, listPaymentsHandler);
router.post('/payments/:id/refund', STAFF_REFUND, refundPaymentHandler);

export default router;
