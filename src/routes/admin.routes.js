import { Router } from 'express';
import {
  listUsers,
  suspendUser,
  reactivateUser,
  createStaffUser,
  listVerifications,
  getVerification,
  reviewVerification,
} from '../controllers/admin.controller.js';
import { createLegalVersion, publishLegalVersion } from '../controllers/legal.controller.js';
import { listAgents, updateAgent, createAiAgent } from '../controllers/agent.controller.js';
import {
  listCategories,
  createCategory,
  updateCategory,
  listUnits,
  createUnit,
  updateUnit,
  listProducts,
  createProduct,
  updateProduct,
  listZones,
  createZone,
  updateZone,
  listHubs,
  createHub,
  updateHub,
} from '../controllers/referential.controller.js';
import { protect, requireMinLevel } from '../middlewares/auth.middleware.js';
import { requireCapability } from '../middlewares/capability.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { coerceIdParam } from '../middlewares/params.middleware.js';
import { createStaffUserSchema, createLegalVersionSchema } from '../validators/admin.validator.js';
import { updateAgentSchema, createAiAgentSchema } from '../validators/agent.validator.js';
import { reviewVerificationSchema } from '../validators/verification.validator.js';
import {
  createCategorySchema,
  updateCategorySchema,
  createUnitSchema,
  updateUnitSchema,
  createProductSchema,
  updateProductSchema,
  createZoneSchema,
  updateZoneSchema,
  createHubSchema,
  updateHubSchema,
} from '../validators/referential.validator.js';

const router = Router();

// Toutes les cles primaires sont des Int : voir middlewares/params.middleware.js
router.param('id', coerceIdParam);

// Vérification des profils : ADMIN et plus, ou AGENT avec USER_VERIFICATION.
// Monte AVANT le requireMinLevel(50) global : un AGENT (niveau 30) muni de la
// capacite USER_VERIFICATION doit passer ici, alors que le reste de /admin lui
// est ferme. requireCapability laisse passer les niveaux 50+ sans controle.
router.get('/verifications', protect, requireCapability('USER_VERIFICATION'), listVerifications);
router.get('/verifications/:id', protect, requireCapability('USER_VERIFICATION'), getVerification);
router.patch('/verifications/:id', protect, requireCapability('USER_VERIFICATION'), validate(reviewVerificationSchema), reviewVerification);

router.use(protect, requireMinLevel(50));

router.get('/users', listUsers);
router.patch('/users/:id/suspend', suspendUser);
router.patch('/users/:id/reactivate', reactivateUser);

// Le role ADMIN n est delivable que par ROOT : le controleur le verifie
// (403 sinon), car c est une regle d autorisation, pas une regle de forme du
// corps. Cette route reste sous protect + requireMinLevel(50) (AGENTS refused).
router.post('/users', validate(createStaffUserSchema), createStaffUser);

// Gestion des CGU : création de versions brouillons et publication.
router.post('/legal/:code/versions', validate(createLegalVersionSchema), createLegalVersion);
router.patch('/legal/versions/:id/publish', publishLegalVersion);

// Administration des fiches d'agents (ADMIN et plus) : lecture, modification
// (dont les capacités) et création d'agents IA sans compte utilisateur.
router.get('/agents', listAgents);
router.patch('/agents/:id', validate(updateAgentSchema), updateAgent);
router.post('/agents/ai', validate(createAiAgentSchema), createAiAgent);

// Référentiels du catalogue (ADMIN et plus) : catégories, unités, produits,
// zones et points de dépôt. Pas de suppression : une ligne se désactive
// (isActive=false via PATCH), ce qui préserve les lots, commandes et profils
// qui y font référence.
router.get('/categories', listCategories);
router.post('/categories', validate(createCategorySchema), createCategory);
router.patch('/categories/:id', validate(updateCategorySchema), updateCategory);

router.get('/units', listUnits);
router.post('/units', validate(createUnitSchema), createUnit);
router.patch('/units/:id', validate(updateUnitSchema), updateUnit);

router.get('/products', listProducts);
router.post('/products', validate(createProductSchema), createProduct);
router.patch('/products/:id', validate(updateProductSchema), updateProduct);

router.get('/zones', listZones);
router.post('/zones', validate(createZoneSchema), createZone);
router.patch('/zones/:id', validate(updateZoneSchema), updateZone);

router.get('/hubs', listHubs);
router.post('/hubs', validate(createHubSchema), createHub);
router.patch('/hubs/:id', validate(updateHubSchema), updateHub);

export default router;
