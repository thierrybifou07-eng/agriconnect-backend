import { Router } from 'express';
import { listLegalDocuments, getLegalDocument } from '../controllers/legal.controller.js';

const router = Router();

// Publique : les CGU doivent être consultables sans compte (mention légale).
router.get('/', listLegalDocuments);
router.get('/:code', getLegalDocument);

export default router;
