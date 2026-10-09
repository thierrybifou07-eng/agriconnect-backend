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
import { protect } from '../middlewares/auth.middleware.js';
import { requireCapability } from '../middlewares/capability.middleware.js';
import { coerceIdParam } from '../middlewares/params.middleware.js';
import upload from '../middlewares/upload.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { lotCreateSchema } from '../validators/lot.validator.js';
import Joi from 'joi';

const router = Router();

// :id est un identifiant entier partout (D2) : la conversion numérique
// s'applique avant tout contrôleur.
router.param('id', coerceIdParam);

// Les routes staff exigent STOCK_VALIDATION (AGENT) ou ADMIN/ROOT (level >= 50).
const STAFF = [protect, requireCapability('STOCK_VALIDATION')];

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

export default router;
