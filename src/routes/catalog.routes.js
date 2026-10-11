import { Router } from 'express';
import { listCategories, listListings, getListing } from '../controllers/catalog.controller.js';
import { protect, requireRole } from '../middlewares/auth.middleware.js';
import { coerceIdParam } from '../middlewares/params.middleware.js';

const router = Router();

// :id est un identifiant entier partout (D2) : la conversion numérique
// s'applique avant tout contrôleur.
router.param('id', coerceIdParam);

// Rôles autorisés : BUYER, AGENT, ADMIN, ROOT. SUPPLIER et DRIVER exclus.
const CATALOG_ROLES = [protect, requireRole('BUYER', 'AGENT', 'ADMIN', 'ROOT')];

// Catalogue acheteur (P2.6) : catégories, liste et détail des annonces.
router.get('/categories', CATALOG_ROLES, listCategories);
router.get('/listings', CATALOG_ROLES, listListings);
router.get('/listings/:id', CATALOG_ROLES, getListing);

export default router;
