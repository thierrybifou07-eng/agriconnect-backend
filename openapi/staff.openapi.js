// Fragment OpenAPI : /api/v2/staff — validation des lots, annonces, commandes,
// paiements, livraisons, indemnisations (AGENT par capacité, ADMIN/ROOT).

import Joi from 'joi';
import { lotCreateSchema } from '../src/validators/lot.validator.js';
import { listingCreateSchema, listingUpdateSchema } from '../src/validators/listing.validator.js';
import { orderCreateSchema, orderStatusSchema, orderCancelSchema } from '../src/validators/order.validator.js';
import { paymentCreateSchema, paymentRefundSchema } from '../src/validators/payment.validator.js';
import { compensationCreateSchema } from '../src/validators/compensation.validator.js';
import {
  assignSchema,
  escalateSchema,
  staffMessageSchema,
} from '../src/validators/conversation.validator.js';
import { jsonBody, jsonSchema, multipartBody } from './openapi.helpers.js';

const R = (ref) => ({ $ref: `#/components/responses/${ref}` });

// Schémas inline définis dans staff.routes.js (pas dans des fichiers validator) :
// ils sont recopiés ici à l'identique pour que le document reflète le code.
const rejectSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(500).required(),
});

const returnSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(500).required(),
});

const qualityCheckSchema = Joi.object({
  grade: Joi.string().valid('A', 'B', 'C').required(),
  notes: Joi.string().trim().max(500).allow(null).optional(),
});

const deliveryReleaseSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(500).optional(),
});

const deliveryCancelSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(500).required(),
});

// Création d'un lot au nom d'un fournisseur : mêmes champs que le fournisseur
// + supplierUserId (comme dans staff.routes.js).
const staffLotCreateSchema = lotCreateSchema.keys({
  supplierUserId: Joi.number().integer().positive().required(),
});

// Corps multipart d'un lot staff : champs du schéma Joi + champ images.
const staffLotFields = Object.fromEntries(staffLotCreateSchema.$_terms.keys.map((k) => [k.key, k.schema]));

function staffLotMultipart() {
  return multipartBody({
    file: { name: 'images', description: 'Jusqu\'à 5 photos dans le champ "images" : jpeg, png ou webp, 5 Mo max par photo' },
    fields: staffLotFields,
  });
}

export default {
  openapi: '3.0.0',
  paths: {
    '/staff/lots': {
      post: {
        tags: ['Équipe'],
        summary: 'Crée un lot au nom d\'un fournisseur',
        description: 'Mêmes champs que POST /supplier/lots + supplierUserId. STOCK_VALIDATION (AGENT) ou ADMIN/ROOT.',
        requestBody: staffLotMultipart(),
        responses: {
          '201': {
            description: 'Lot créé (PENDING_VALIDATION)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/StaffLot' } } },
          },
          '400': R('UploadBadRequest'),
          '401': R('Unauthorized'),
          '403': { description: 'AGENT sans STOCK_VALIDATION', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '413': R('FileTooLarge'),
        },
      },
      get: {
        tags: ['Équipe'],
        summary: 'Lots de tous les fournisseurs (paginé)',
        parameters: [
          { in: 'query', name: 'status', schema: { type: 'string', enum: ['PENDING_VALIDATION', 'AVAILABLE', 'FULLY_RESERVED', 'SOLD_OUT', 'EXPIRED', 'RETURNED', 'REJECTED', 'WITHDRAWN'] } },
          { in: 'query', name: 'supplierId', schema: { type: 'integer' } },
          { in: 'query', name: 'productId', schema: { type: 'integer' } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': { $ref: '#/components/responses/PaginatedStaffLots' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/staff/lots/{id}': {
      get: {
        tags: ['Équipe'],
        summary: 'Détail d\'un lot (DTO staff + fournisseur)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': {
            description: 'Lot',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/StaffLot' } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/staff/lots/{id}/validate': {
      post: {
        tags: ['Équipe'],
        summary: 'Valide un lot (PENDING_VALIDATION -> AVAILABLE)',
        description:
          'Exige PENDING_VALIDATION et fournisseur VERIFIED (sinon 409 NOT_VERIFIED). Écrit le mouvement RECEIVED de quantityInitial. Audit LOT_VALIDATED.',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': { description: 'Lot validé (AVAILABLE)' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION) ou fournisseur non vérifié (NOT_VERIFIED)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/staff/lots/{id}/reject': {
      post: {
        tags: ['Équipe'],
        summary: 'Rejette un lot (PENDING_VALIDATION -> REJECTED)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(rejectSchema),
        responses: {
          '200': { description: 'Lot rejeté' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/staff/lots/{id}/return': {
      post: {
        tags: ['Équipe'],
        summary: 'Retourne un lot (AVAILABLE ou FULLY_RESERVED sans réservation -> RETURNED)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(returnSchema),
        responses: {
          '200': { description: 'Lot retourné' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/staff/stock-movements': {
      get: {
        tags: ['Équipe'],
        summary: 'Journal des mouvements de stock (paginé)',
        parameters: [
          { in: 'query', name: 'lotId', schema: { type: 'integer' } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': {
            description: 'Mouvements (RECEIVED, RESERVED, RESERVATION_RELEASED, SOLD, EXPIRED, RETURNED)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: { type: 'array', items: { $ref: '#/components/schemas/StockMovement' } },
                    page: { type: 'integer' },
                    limit: { type: 'integer' },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/staff/lots/{id}/quality-checks': {
      post: {
        tags: ['Équipe'],
        summary: 'Note la qualité d\'un lot (A, B ou C)',
        description: 'Met à jour StockLot.qualityGrade avec la dernière note. Audit LOT_QUALITY_CHECKED.',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(qualityCheckSchema),
        responses: {
          '201': { description: 'Contrôle créé' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
      get: {
        tags: ['Équipe'],
        summary: 'Historique des contrôles qualité d\'un lot',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': {
            description: 'Contrôles qualité',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/LotQualityCheck' } } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/staff/listings': {
      post: {
        tags: ['Équipe'],
        summary: 'Publie une annonce à partir d\'un lot validé',
        description:
          'LISTING_MANAGEMENT (AGENT) ou ADMIN/ROOT. Au MVP une annonce = EXACTEMENT UN lot (400 sinon). Lot déjà relié -> 409 LOT_ALREADY_LINKED. Prix public par défaut = prix convenu. Référence \'ANN-\' + id sur 6 chiffres.',
        requestBody: multipartBody({
          file: { name: 'images', description: 'Jusqu\'à 5 photos dans le champ "images" : jpeg, png ou webp, 5 Mo max par photo. Absentes -> photos du lot copiées' },
          fields: Object.fromEntries(listingCreateSchema.$_terms.keys.map((k) => [k.key, k.schema])),
        }),
        responses: {
          '201': {
            description: 'Annonce créée (DRAFT)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/StaffListing' } } },
          },
          '400': { description: 'Plusieurs lots, champ invalide, ou upload refusé (UNEXPECTED_FILE_FIELD, INVALID_MULTIPART, UNSUPPORTED_MEDIA_TYPE, FILE_REQUIRED, FILE_CONTENT_MISMATCH)', content: { 'application/json': { schema: { $ref: '#/components/schemas/UploadError' } } } },
          '401': R('Unauthorized'),
          '403': { description: 'AGENT sans LISTING_MANAGEMENT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '409': { description: 'Lot déjà relié (LOT_ALREADY_LINKED) ou indisponible (LOT_NOT_AVAILABLE)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '413': R('FileTooLarge'),
        },
      },
      get: {
        tags: ['Équipe'],
        summary: 'Annonces de l\'équipe (paginé)',
        parameters: [
          { in: 'query', name: 'status', schema: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'SOLD', 'INACTIVE'] } },
          { in: 'query', name: 'productId', schema: { type: 'integer' } },
          { in: 'query', name: 'supplierId', schema: { type: 'integer' } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': { $ref: '#/components/responses/PaginatedStaffListings' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/staff/listings/{id}': {
      get: {
        tags: ['Équipe'],
        summary: 'Détail d\'une annonce (DTO staff)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': {
            description: 'Annonce avec lot et promoteur',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/StaffListing' } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
      patch: {
        tags: ['Équipe'],
        summary: 'Modifie une annonce (DRAFT, ACTIVE ou INACTIVE)',
        description: 'Changement de unitPrice tracé dans l\'audit (ancienne et nouvelle valeur).',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(listingUpdateSchema),
        responses: {
          '200': {
            description: 'Annonce mise à jour',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/StaffListing' } } },
          },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/staff/listings/{id}/publish': {
      post: {
        tags: ['Équipe'],
        summary: 'Publie une annonce (DRAFT ou INACTIVE -> ACTIVE)',
        description: 'Exige lot AVAILABLE avec stock > 0. Audit LISTING_PUBLISHED.',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': { description: 'Annonce publiée' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION) ou lot épuisé (LOT_NOT_AVAILABLE)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/staff/listings/{id}/unpublish': {
      post: {
        tags: ['Équipe'],
        summary: 'Masque une annonce (ACTIVE -> INACTIVE)',
        description: 'Audit LISTING_UNPUBLISHED.',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': { description: 'Annonce masquée' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/staff/conversations': {
      get: {
        tags: ['Équipe'],
        summary: 'Conversations (BUYER_SUPPORT ou SUPPLIER_SUPPORT requis)',
        description: 'Un agent n\'agit ensuite que sur les conversations de son type (vérifié dans le contrôleur).',
        parameters: [
          { in: 'query', name: 'status', schema: { type: 'string', enum: ['OPEN', 'WAITING_CUSTOMER', 'CLOSED'] } },
          { in: 'query', name: 'unassigned', schema: { type: 'boolean' } },
          { in: 'query', name: 'mine', schema: { type: 'boolean' } },
          { in: 'query', name: 'escalated', schema: { type: 'boolean' } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': { $ref: '#/components/responses/PaginatedConversations' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/staff/conversations/{id}': {
      get: {
        tags: ['Équipe'],
        summary: 'Détail d\'une conversation',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': {
            description: 'Conversation',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/StaffConversation' } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/staff/conversations/{id}/messages': {
      get: {
        tags: ['Équipe'],
        summary: 'Messages d\'une conversation (fil public)',
        parameters: [
          { $ref: '#/components/parameters/IdParam' },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': {
            description: 'Messages',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: { type: 'array', items: { $ref: '#/components/schemas/StaffMessage' } },
                    page: { type: 'integer' },
                    limit: { type: 'integer' },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
      post: {
        tags: ['Équipe'],
        summary: 'Envoie un message (interne ou public)',
        description: 'isInternal=true n\'est visible que par l\'équipe.',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(staffMessageSchema),
        responses: {
          '201': {
            description: 'Message envoyé',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/StaffMessage' } } },
          },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/staff/conversations/{id}/assign': {
      post: {
        tags: ['Équipe'],
        summary: 'S\'assigne la conversation (ou la réassigne par agentId)',
        description: 'Un agent s\'assigne à lui-même ; un admin sans fiche d\'agent fournit agentId.',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: { required: false, content: { 'application/json': { schema: jsonSchema(assignSchema) } } },
        responses: {
          '200': { description: 'Conversation assignée' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/staff/conversations/{id}/escalate': {
      post: {
        tags: ['Équipe'],
        summary: 'Escalade une conversation (motif obligatoire)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(escalateSchema),
        responses: {
          '200': { description: 'Conversation escaladée' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/staff/conversations/{id}/close': {
      post: {
        tags: ['Équipe'],
        summary: 'Ferme une conversation',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': { description: 'Conversation fermée' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/staff/orders': {
      post: {
        tags: ['Équipe'],
        summary: 'Émet un devis pour un acheteur',
        description:
          'ORDER_PROCESSING (AGENT) ou ADMIN/ROOT. Réserve le stock et fige les prix. HUB_PICKUP exige pickupHubId ; AGENCY_DELIVERY exige delivery.{zoneId, address, latitude, longitude}. Lignes OrderItem : listingId + lotId + prix.',
        requestBody: jsonBody(orderCreateSchema),
        responses: {
          '201': {
            description: 'Devis créé (QUOTED)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': { description: 'AGENT sans ORDER_PROCESSING', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Annonce, acheteur ou conversation introuvable', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '409': { description: 'Stock insuffisant (INSUFFICIENT_STOCK), prix sous le convenu (PRICE_BELOW_SUPPLIER), zone non couverte (ZONE_NOT_COVERED), hub invalide', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      get: {
        tags: ['Équipe'],
        summary: 'Commandes (paginé)',
        parameters: [
          { in: 'query', name: 'status', schema: { type: 'string' } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': { $ref: '#/components/responses/PaginatedOrders' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/staff/orders/{id}': {
      get: {
        tags: ['Équipe'],
        summary: 'Détail d\'une commande',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': {
            description: 'Commande',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/staff/orders/{id}/status': {
      patch: {
        tags: ['Équipe'],
        summary: 'Change le statut d\'une commande (manuel)',
        description: 'OUT_FOR_DELIVERY n\'est posable que par le flux livraison. force = dérogation admin (paiement avant PREPARING).',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(orderStatusSchema),
        responses: {
          '200': {
            description: 'Statut mis à jour',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/staff/orders/{id}/confirm': {
      post: {
        tags: ['Équipe'],
        summary: 'Confirme une commande (flux livraison)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': {
            description: 'Commande confirmée',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/staff/orders/{id}/cancel': {
      post: {
        tags: ['Équipe'],
        summary: 'Annule une commande (restitue le stock, transaction)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: { required: false, content: { 'application/json': { schema: jsonSchema(orderCancelSchema) } } },
        responses: {
          '200': { description: 'Commande annulée' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/staff/orders/{id}/payments': {
      post: {
        tags: ['Équipe'],
        summary: 'Enregistre un paiement manuel (idempotent)',
        description: 'PAYMENT_FOLLOWUP (AGENT humain) ou ADMIN/ROOT. En-tête Idempotency-Key obligatoire.',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(paymentCreateSchema),
        responses: {
          '201': { description: 'Paiement enregistré' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': { description: 'Agent IA refusé (requireHumanActor)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': R('NotFound'),
          '409': { description: 'Montant invalide (INVALID_AMOUNT) ou doublon d\'idempotence', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      get: {
        tags: ['Équipe'],
        summary: 'Paiements d\'une commande',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': {
            description: 'Paiements',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Payment' } } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
        },
      },
    },

    '/staff/payments/{id}/refund': {
      post: {
        tags: ['Équipe'],
        summary: 'Rembourse un paiement (ADMIN humain)',
        description: 'force permet de rembourser même si un reversement fournisseur a été payé (le reversement n\'est pas annulé). Un non-admin qui envoie force:true est ignoré (409).',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: { required: false, content: { 'application/json': { schema: jsonSchema(paymentRefundSchema) } } },
        responses: {
          '200': { description: 'Paiement remboursé' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': { description: 'Remboursement réservé aux administrateurs humains', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': R('NotFound'),
          '409': { description: 'Remboursement impossible dans cet état', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/staff/orders/{id}/deliveries': {
      post: {
        tags: ['Équipe'],
        summary: 'Crée les livraisons d\'une commande (par point d\'enlèvement)',
        description: 'DISPATCH_COORDINATION (AGENT) ou ADMIN/ROOT. Refus d\'idempotence si au moins une livraison non annulée existe.',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '201': { description: 'Livraisons créées' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': { description: 'Commande introuvable (ORDER_NOT_FOUND)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '409': { description: 'Mode invalide (INVALID_DELIVERY_MODE), statut invalide (INVALID_ORDER_STATUS) ou livraisons existantes (DELIVERIES_ALREADY_CREATED)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/staff/deliveries': {
      get: {
        tags: ['Équipe'],
        summary: 'Livraisons (paginé)',
        parameters: [
          { in: 'query', name: 'status', schema: { type: 'string' } },
          { in: 'query', name: 'orderId', schema: { type: 'integer' } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
        ],
        responses: {
          '200': { $ref: '#/components/responses/PaginatedDeliveries' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/staff/deliveries/{id}/release': {
      post: {
        tags: ['Équipe'],
        summary: 'Libère une course acceptée (ACCEPTED -> PENDING)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: { required: false, content: { 'application/json': { schema: jsonSchema(deliveryReleaseSchema) } } },
        responses: {
          '200': { description: 'Course libérée' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': { description: 'Livraison introuvable (DELIVERY_NOT_FOUND)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/staff/deliveries/{id}/redispatch': {
      post: {
        tags: ['Équipe'],
        summary: 'Redispatch une course échouée (FAILED -> PENDING)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': { description: 'Course redispatchée' },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/staff/deliveries/{id}/cancel': {
      post: {
        tags: ['Équipe'],
        summary: 'Annule une course (PENDING, ACCEPTED ou FAILED -> CANCELLED)',
        description: 'La raison est obligatoire (audit DELIVERY_CANCELLED).',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(deliveryCancelSchema),
        responses: {
          '200': { description: 'Course annulée' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Transition interdite (INVALID_STATE_TRANSITION)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/staff/compensations': {
      post: {
        tags: ['Équipe'],
        summary: 'Demande une indemnisation fournisseur (invendus ou pertes)',
        description: 'DISPUTE_HANDLING (AGENT) ou ADMIN/ROOT. Quantité > lot -> 400 du service. Rate à 0 -> COMPENSATION_RATE_ZERO si non fixée.',
        requestBody: jsonBody(compensationCreateSchema),
        responses: {
          '201': { description: 'Indemnisation créée (PENDING)' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '404': R('NotFound'),
          '409': { description: 'Taux nul (COMPENSATION_RATE_ZERO)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
  },
};
