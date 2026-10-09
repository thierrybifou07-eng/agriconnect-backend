import { Router } from 'express';
import {
  createLot,
  listLots,
  getLot,
  updateLot,
  deleteLot,
} from '../controllers/supplierLot.controller.js';
import { protect, requireRole } from '../middlewares/auth.middleware.js';
import { coerceIdParam } from '../middlewares/params.middleware.js';
import upload from '../middlewares/upload.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { lotCreateSchema, lotUpdateSchema } from '../validators/lot.validator.js';

const router = Router();

// :id est un identifiant entier partout (D2) : la conversion numérique
// s'applique avant tout contrôleur.
router.param('id', coerceIdParam);

// Sans ce callback, un sixième fichier arrêterait multer avec
// LIMIT_UNEXPECTED_FILE et l'erreur remonterait en 500 : la limite de 5
// photos est une règle métier, elle répond donc en 400.
const uploadImages = (req, res, next) => {
  upload.array('images', 5)(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Maximum 5 images' : err.message;
    res.status(400).json({ error: message });
  });
};

// POST /api/v2/supplier/lots — déclaration d'un lot avec photos.
//
// multer parse d'abord le multipart (champ `images` + champs texte), puis
// validate contrôle le corps : l'ordre des middlewares est important.
router.post('/lots', protect, requireRole('SUPPLIER'), uploadImages, validate(lotCreateSchema), createLot);
// Les paramètres de liste ne passent pas par validate() : en Express 5,
// req.query est un getter sans setter, et le middleware ne peut pas l'écraser.
// listLots les lit directement et les borne lui-même (status inconnu -> 400).
router.get('/lots', protect, requireRole('SUPPLIER'), listLots);
router.get('/lots/:id', protect, requireRole('SUPPLIER'), getLot);
router.patch('/lots/:id', protect, requireRole('SUPPLIER'), validate(lotUpdateSchema), updateLot);
router.delete('/lots/:id', protect, requireRole('SUPPLIER'), deleteLot);

export default router;
