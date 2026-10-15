// Fragment OpenAPI : /api/v2/admin — vérifications, settings, utilisateurs,
// CGU, reversements, agents, référentiels, agences, parrainage, indemnisations,
// stats et audit.

import {
  createStaffUserSchema,
  createLegalVersionSchema,
  updateSettingsSchema,
  payReferralSchema,
  rejectReferralSchema,
} from '../src/validators/admin.validator.js';
import { updateAgentSchema, createAiAgentSchema } from '../src/validators/agent.validator.js';
import { reviewVerificationSchema } from '../src/validators/verification.validator.js';
import { payPayoutSchema } from '../src/validators/payout.validator.js';
import { compensationRejectSchema, compensationPaySchema } from '../src/validators/compensation.validator.js';
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
} from '../src/validators/referential.validator.js';
import {
  createAgencySchema,
  updateAgencySchema,
  upsertAgencyZoneSchema,
} from '../src/validators/agency.validator.js';
import { jsonBody } from './openapi.helpers.js';

const R = (ref) => ({ $ref: `#/components/responses/${ref}` });

export default {
  openapi: '3.0.0',
  paths: {
    '/admin/verifications': {
      get: {
        tags: ['Admin'],
        summary: 'Dossiers de vérification des profils (paginé)',
        description: 'ADMIN et plus, ou AGENT avec la capacité USER_VERIFICATION.',
        parameters: [
          { in: 'query', name: 'status', schema: { type: 'string', enum: ['PENDING', 'VERIFIED', 'REJECTED'] } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': { $ref: '#/components/responses/PaginatedVerifications' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/admin/verifications/{id}': {
      get: {
        tags: ['Admin'],
        summary: 'Détail d\'un dossier (URL signée Cloudinary, 10 min)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': {
            description: 'Détail + URL signée de courte durée',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/VerificationDetail' } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
      patch: {
        tags: ['Admin'],
        summary: 'Décision d\'examen (APPROVE / REJECT)',
        description:
          'APPROVE -> document VERIFIED, utilisateur VERIFIED si aucun document PENDING. REJECT sans document VERIFIED -> utilisateur REJECTED. Audit dans la même transaction.',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(reviewVerificationSchema),
        responses: {
          '200': { description: 'Décision appliquée' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/admin/settings': {
      get: {
        tags: ['Admin'],
        summary: 'Réglages de la plateforme (ADMIN et plus)',
        responses: {
          '200': {
            description: 'Settings de la plateforme (singleton id=1)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PlatformSettings' } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
      patch: {
        tags: ['Admin'],
        summary: 'Modifie les réglages (ROOT seul)',
        description:
          'La commission fournisseur vaut 0 tant qu\'elle n\'est pas fixée par ROOT. currency est en lecture seule. Au moins un champ obligatoire.',
        requestBody: jsonBody(updateSettingsSchema),
        responses: {
          '200': {
            description: 'Réglages mis à jour',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PlatformSettings' } } },
          },
          '400': { description: 'Corps vide ou champ hors bornes (currency fournie -> 400)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '401': R('Unauthorized'),
          '403': { description: 'ADMIN refusé ; ROOT seul', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/admin/users': {
      get: {
        tags: ['Admin'],
        summary: 'Liste des utilisateurs (ADMIN et plus)',
        parameters: [
          { in: 'query', name: 'profileVerificationStatus', schema: { type: 'string', enum: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'] } },
        ],
        responses: {
          '200': {
            description: 'Tableau d\'utilisateurs',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
      post: {
        tags: ['Admin'],
        summary: 'Crée un compte staff (ADMIN, AGENT, DRIVER)',
        description:
          'ADMIN réservé à ROOT (403 sinon). AGENT et DRIVER pour ADMIN et ROOT. Unicité email ET téléphone (409). L\'email de bienvenue n\'est jamais bloquant.',
        requestBody: jsonBody(createStaffUserSchema),
        responses: {
          '201': { description: 'Compte créé avec son profil' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': { description: 'Création d\'un ADMIN par un non-ROOT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '409': { description: 'Email ou téléphone déjà utilisé (codes distincts)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/admin/users/{id}/suspend': {
      patch: {
        tags: ['Admin'],
        summary: 'Suspendre un compte',
        description: 'Ferme ses sessions et déconnecte ses websockets (session_revoked).',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': { description: 'Compte suspendu' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/admin/users/{id}/reactivate': {
      patch: {
        tags: ['Admin'],
        summary: 'Réactiver un compte suspendu',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': { description: 'Compte réactivé' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/admin/legal/{code}/versions': {
      post: {
        tags: ['Admin'],
        summary: 'Crée une version brouillon de CGU',
        description: '"fr" obligatoire, "en" facultatif. La version est DRAFT.',
        parameters: [{ $ref: '#/components/parameters/LegalCodeParam' }],
        requestBody: jsonBody(createLegalVersionSchema),
        responses: {
          '201': { description: 'Version DRAFT créée' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': { description: 'Code inconnu', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/admin/legal/versions/{id}/publish': {
      patch: {
        tags: ['Admin'],
        summary: 'Publie une version de CGU',
        description: 'Passe la version en PUBLISHED et archive la précédente du même document (transaction).',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': { description: 'Version publiée, ancienne archivée' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Version déjà publiée', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/admin/payouts': {
      get: {
        tags: ['Admin'],
        summary: 'Reversements fournisseurs (ADMIN humain)',
        description: 'requireHumanActor — un agent IA ne peut pas déplacer de l\'argent.',
        responses: {
          '200': { $ref: '#/components/responses/PaginatedPayouts' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/admin/payouts/{id}/pay': {
      patch: {
        tags: ['Admin'],
        summary: 'Marque un reversement comme payé',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(payPayoutSchema),
        responses: {
          '200': { description: 'Reversement payé' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/admin/agents': {
      get: {
        tags: ['Admin'],
        summary: 'Fiches d\'agents (humains et IA)',
        responses: {
          '200': {
            description: 'Liste des agents',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Agent' } } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/admin/agents/ai': {
      post: {
        tags: ['Admin'],
        summary: 'Crée un agent IA (sans compte utilisateur)',
        description: 'autonomy par défaut SUGGEST_ONLY. Un IA ne peut jamais recevoir PAYMENT_FOLLOWUP (règle C6 — 400 si demandé).',
        requestBody: jsonBody(createAiAgentSchema),
        responses: {
          '201': {
            description: 'Agent IA créé',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Agent' } } },
          },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/admin/agents/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Modifie une fiche d\'agent',
        description: 'capabilities remplace TOUTES les capacités (liste complète).',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(updateAgentSchema),
        responses: {
          '200': {
            description: 'Fiche mise à jour',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Agent' } } },
          },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/admin/categories': {
      get: {
        tags: ['Admin'],
        summary: 'Catégories de produits',
        parameters: [
          { in: 'query', name: 'active', schema: { type: 'boolean' } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': { $ref: '#/components/responses/PaginatedCategories' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
      post: {
        tags: ['Admin'],
        summary: 'Crée une catégorie',
        requestBody: jsonBody(createCategorySchema),
        responses: {
          '201': { description: 'Catégorie créée' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '409': { description: 'Code déjà utilisé', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/admin/categories/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Modifie ou désactive une catégorie',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(updateCategorySchema),
        responses: {
          '200': { description: 'Catégorie mise à jour' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/admin/units': {
      get: {
        tags: ['Admin'],
        summary: 'Unités de mesure',
        responses: {
          '200': { $ref: '#/components/responses/PaginatedUnits' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
      post: {
        tags: ['Admin'],
        summary: 'Crée une unité',
        requestBody: jsonBody(createUnitSchema),
        responses: {
          '201': { description: 'Unité créée' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '409': { description: 'Code déjà utilisé', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/admin/units/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Modifie une unité (code, label — pas d\'isActive)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(updateUnitSchema),
        responses: {
          '200': { description: 'Unité mise à jour' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/admin/products': {
      get: {
        tags: ['Admin'],
        summary: 'Produits du catalogue',
        parameters: [
          { in: 'query', name: 'active', schema: { type: 'boolean' } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': { $ref: '#/components/responses/PaginatedProducts' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
      post: {
        tags: ['Admin'],
        summary: 'Crée un produit',
        requestBody: jsonBody(createProductSchema),
        responses: {
          '201': { description: 'Produit créé' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/admin/products/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Modifie ou désactive un produit',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(updateProductSchema),
        responses: {
          '200': { description: 'Produit mis à jour' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/admin/zones': {
      get: {
        tags: ['Admin'],
        summary: 'Zones',
        parameters: [
          { in: 'query', name: 'active', schema: { type: 'boolean' } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': { $ref: '#/components/responses/PaginatedZones' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
      post: {
        tags: ['Admin'],
        summary: 'Crée une zone',
        requestBody: jsonBody(createZoneSchema),
        responses: {
          '201': { description: 'Zone créée' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '409': { description: 'Nom déjà utilisé', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/admin/zones/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Modifie ou désactive une zone',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(updateZoneSchema),
        responses: {
          '200': { description: 'Zone mise à jour' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/admin/hubs': {
      get: {
        tags: ['Admin'],
        summary: 'Points de dépôt',
        parameters: [
          { in: 'query', name: 'active', schema: { type: 'boolean' } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': { $ref: '#/components/responses/PaginatedHubs' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
      post: {
        tags: ['Admin'],
        summary: 'Crée un point de dépôt',
        requestBody: jsonBody(createHubSchema),
        responses: {
          '201': { description: 'Hub créé' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/admin/hubs/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Modifie ou désactive un hub',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(updateHubSchema),
        responses: {
          '200': { description: 'Hub mis à jour' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/admin/agencies': {
      get: {
        tags: ['Admin'],
        summary: 'Agences de transport',
        parameters: [
          { in: 'query', name: 'active', schema: { type: 'boolean' } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': { $ref: '#/components/responses/PaginatedAgencies' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
      post: {
        tags: ['Admin'],
        summary: 'Crée une agence de transport',
        description: 'L\'unicité du nom est vérifiée dans le contrôleur (409).',
        requestBody: jsonBody(createAgencySchema),
        responses: {
          '201': { description: 'Agence créée' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '409': { description: 'Nom déjà utilisé', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/admin/agencies/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Modifie ou désactive une agence',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(updateAgencySchema),
        responses: {
          '200': { description: 'Agence mise à jour' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/admin/agencies/{id}/zones/{zoneId}': {
      put: {
        tags: ['Admin'],
        summary: 'Couvre une zone avec tarifs (crée ou met à jour)',
        description: 'Tarifs arrondis au centime par le contrôleur.',
        parameters: [
          { $ref: '#/components/parameters/IdParam' },
          { in: 'path', name: 'zoneId', required: true, schema: { type: 'integer' } },
        ],
        requestBody: jsonBody(upsertAgencyZoneSchema),
        responses: {
          '200': { description: 'Couverture enregistrée' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': { description: 'Agence ou zone introuvable', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Admin'],
        summary: 'Retire la couverture d\'une zone',
        parameters: [
          { $ref: '#/components/parameters/IdParam' },
          { in: 'path', name: 'zoneId', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          '200': { description: 'Couverture retirée' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/admin/agencies/{id}/drivers': {
      get: {
        tags: ['Admin'],
        summary: 'Livreurs rattachés à une agence',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': {
            description: 'Liste des livreurs de l\'agence',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/admin/referrals': {
      get: {
        tags: ['Admin'],
        summary: 'Parrainages (ADMIN humain)',
        description: 'requireHumanActor — un agent IA ne peut pas déplacer de l\'argent.',
        responses: {
          '200': { $ref: '#/components/responses/PaginatedReferrals' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/admin/referrals/{id}/pay': {
      patch: {
        tags: ['Admin'],
        summary: 'Paye une commission de parrainage',
        description: 'Référence de paiement obligatoire (traçabilité audit).',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(payReferralSchema),
        responses: {
          '200': { description: 'Parrainage payé' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/admin/referrals/{id}/reject': {
      patch: {
        tags: ['Admin'],
        summary: 'Rejette un parrainage',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(rejectReferralSchema),
        responses: {
          '200': { description: 'Parrainage rejeté' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/admin/compensations': {
      get: {
        tags: ['Admin'],
        summary: 'Indemnisations fournisseurs (ADMIN humain)',
        description: 'La vue admin affiche le compte de paiement par défaut du fournisseur (numéro complet).',
        responses: {
          '200': { $ref: '#/components/responses/PaginatedCompensations' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/admin/compensations/{id}/approve': {
      patch: {
        tags: ['Admin'],
        summary: 'Approuve une indemnisation',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': { description: 'Indemnisation approuvée' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/admin/compensations/{id}/reject': {
      patch: {
        tags: ['Admin'],
        summary: 'Rejette une indemnisation (justification obligatoire)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(compensationRejectSchema),
        responses: {
          '200': { description: 'Indemnisation rejetée' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/admin/compensations/{id}/pay': {
      patch: {
        tags: ['Admin'],
        summary: 'Paie une indemnisation (référence de virement obligatoire)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(compensationPaySchema),
        responses: {
          '200': { description: 'Indemnisation payée' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/admin/stats': {
      get: {
        tags: ['Admin'],
        summary: 'Tableau de bord',
        responses: {
          '200': {
            description: 'Statistiques agrégées',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/admin/audit-logs': {
      get: {
        tags: ['Admin'],
        summary: 'Journal d\'audit',
        parameters: [
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': { $ref: '#/components/responses/PaginatedAuditLogs' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },
  },
};
