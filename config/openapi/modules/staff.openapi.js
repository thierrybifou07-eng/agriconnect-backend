// config/openapi/modules/staff.openapi.js
//
// Opérations de l'équipe (AGENT par capacité, ADMIN/ROOT par niveau).
// Chaque famille de routes a sa propre porte d'entrée : les lots et les
// annonces n'exigent pas la même capacité, et un agent sans la capacité
// requise reçoit 403 avant toute lecture.
//
// Règle générale des routes « argent » (/orders/:id/payments, /compensations) :
// requireHumanActor refuse les agents IA.

import Joi from 'joi';
import {
  makeSuccessResponse,
  makeErrorResponse,
  makeValidationErrorResponse,
  makePaginatedResponse,
  makeMultipartRequestBody,
  makeJoiRequestBody,
  makeHeaderParam,
  makePathParam,
  makeQueryParam,
  paginationParams,
  toJsonSchema,
  nullableDateTimeSchema,
  nullableIntegerSchema,
  nullableNumberSchema,
  nullableStringSchema,
  dateTimeSchema,
} from '../openapi.helpers.js';
import { lotCreateSchema, LOT_STATUSES } from '../../../src/validators/lot.validator.js';
import { listingCreateSchema, listingUpdateSchema, LISTING_STATUSES } from '../../../src/validators/listing.validator.js';
import { orderCreateSchema, orderStatusSchema, orderCancelSchema } from '../../../src/validators/order.validator.js';
import { paymentCreateSchema, paymentRefundSchema } from '../../../src/validators/payment.validator.js';
import { compensationCreateSchema } from '../../../src/validators/compensation.validator.js';
import { assignSchema, escalateSchema, staffMessageSchema } from '../../../src/validators/conversation.validator.js';

// ---- Schémas Joi définis en ligne dans staff.routes.js --------------------

// Un lot déclaré au nom d'un fournisseur : mêmes champs que côté fournisseur,
// plus l'identification du fournisseur (stockCreateSchema de la route).
const staffLotCreateSchema = lotCreateSchema.keys({
  supplierUserId: Joi.number().integer().positive().required(),
});

const reasonSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(500).required(),
});

const qualityCheckSchema = Joi.object({
  grade: Joi.string().valid('A', 'B', 'C').required(),
  notes: Joi.string().trim().max(500).allow(null).optional(),
});

// Motif facultatif : une course relancée se justifie d'elle-même.
const deliveryReleaseSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(500).optional(),
});

const deliveryCancelSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(500).required(),
});

// ---- Schémas de réponse --------------------------------------------------

const LotStaffSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 21 },
    lotCode: { type: 'string', example: 'LOT-2026-000021' },
    product: {
      type: 'object',
      properties: {
        id: { type: 'integer', example: 4 },
        name: { type: 'string', example: 'Riz paddy' },
        isPerishable: { type: 'boolean', example: true },
        category: {
          type: 'object',
          properties: { code: { type: 'string', example: 'CEREALS' }, label: { type: 'string', example: 'Céréales' } },
        },
        unit: {
          type: 'object',
          properties: { code: { type: 'string', example: 'KG' }, label: { type: 'string', example: 'Kilogramme' } },
        },
      },
    },
    zone: {
      type: 'object',
      properties: { id: { type: 'integer', example: 3 }, name: { type: 'string', example: 'Zone de Ngaoundéré' } },
    },
    storageType: { type: 'string', enum: ['SUPPLIER_SITE', 'HUB'] },
    hub: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'integer', example: 5 },
        name: { type: 'string', example: 'Dépôt Ngaoundéré Centre' },
        city: nullableStringSchema,
      },
    },
    pickupAddress: nullableStringSchema,
    pickupLatitude: nullableNumberSchema,
    pickupLongitude: nullableNumberSchema,
    agreedUnitPrice: { type: 'number', example: 700 },
    quantityInitial: { type: 'number', example: 500 },
    quantityAvailable: { type: 'number', example: 500 },
    quantityReserved: { type: 'number', example: 0 },
    quantitySold: { type: 'number', example: 0 },
    quantityLost: { type: 'number', example: 0 },
    status: { type: 'string', enum: LOT_STATUSES },
    rejectionReason: nullableStringSchema,
    packagingNote: nullableStringSchema,
    qualityNote: nullableStringSchema,
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri' },
          position: { type: 'integer', example: 0 },
          isPrimary: { type: 'boolean', example: true },
        },
      },
    },
    harvestedAt: nullableDateTimeSchema,
    expiresAt: nullableDateTimeSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    // Champs ajoutés par lotToStaffDto : l'équipe, seule, voit le fournisseur.
    supplier: {
      type: 'object',
      properties: {
        id: { type: 'integer', example: 7 },
        farmName: { type: 'string', example: 'Ferme Nkol' },
        profileVerificationStatus: {
          type: 'string',
          nullable: true,
          enum: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', null],
        },
      },
    },
    validatedAt: nullableDateTimeSchema,
    validatedByAgentId: nullableIntegerSchema,
    qualityGrade: { type: 'string', nullable: true, enum: ['A', 'B', 'C', null] },
  },
};

const ListingStaffSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 12 },
    reference: { type: 'string', example: 'LST-2026-000012' },
    title: { type: 'string', example: 'Riz paddy qualité 1 — lot 500 kg' },
    description: nullableStringSchema,
    unitPrice: { type: 'number', example: 750 },
    status: { type: 'string', enum: LISTING_STATUSES },
    publishedAt: nullableDateTimeSchema,
    product: {
      type: 'object',
      properties: {
        id: { type: 'integer', example: 4 },
        name: { type: 'string', example: 'Riz paddy' },
        category: {
          type: 'object',
          properties: { code: { type: 'string', example: 'CEREALS' }, label: { type: 'string', example: 'Céréales' } },
        },
        unit: {
          type: 'object',
          properties: { code: { type: 'string', example: 'KG' }, label: { type: 'string', example: 'Kilogramme' } },
        },
      },
    },
    zone: {
      type: 'object',
      properties: { id: { type: 'integer', example: 3 }, name: { type: 'string', example: 'Zone de Ngaoundéré' } },
    },
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri' },
          position: { type: 'integer', example: 0 },
          isPrimary: { type: 'boolean', example: true },
        },
      },
    },
    lot: {
      ...LotStaffSchema,
      nullable: true,
      description: 'Lot relié à l\'annonce (une annonce porte exactement un lot)',
    },
    createdByUserId: nullableIntegerSchema,
    createdByAgentId: nullableIntegerSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
};

const OrderItemStaffSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 301 },
    listingId: { type: 'integer', example: 12 },
    listingReference: nullableStringSchema,
    listingTitle: nullableStringSchema,
    quantity: { type: 'number', example: 50 },
    unitPrice: { type: 'number', example: 750 },
    lineTotal: { type: 'number', example: 37500 },
    lotId: { type: 'integer', example: 21 },
    supplierUnitPrice: { type: 'number', example: 700 },
    commissionRate: { type: 'number', example: 0.1 },
    commissionAmount: { type: 'number', example: 3750 },
    supplierNetAmount: { type: 'number', example: 31250 },
  },
};

const OrderStaffSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 45 },
    orderNumber: { type: 'string', example: 'CMD-2026-000045' },
    status: {
      type: 'string',
      enum: ['QUOTED', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED'],
    },
    deliveryMode: { type: 'string', nullable: true, enum: ['HUB_PICKUP', 'AGENCY_DELIVERY', null] },
    items: { type: 'array', items: OrderItemStaffSchema },
    subtotal: { type: 'number', example: 37500 },
    buyerFee: { type: 'number', example: 0 },
    deliveryFee: { type: 'number', example: 2500 },
    total: { type: 'number', example: 40000 },
    delivery: {
      type: 'object',
      nullable: true,
      properties: {
        zoneId: { type: 'integer', example: 3 },
        address: { type: 'string', example: 'Rue Njo-Njo, Yaoundé' },
        latitude: nullableNumberSchema,
        longitude: nullableNumberSchema,
      },
    },
    pickup: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'integer', example: 5 },
        name: { type: 'string', example: 'Dépôt Ngaoundéré Centre' },
        address: { type: 'string', example: 'BP 12, Ngaoundéré' },
        city: nullableStringSchema,
      },
    },
    notes: nullableStringSchema,
    reservedUntil: nullableDateTimeSchema,
    confirmedAt: nullableDateTimeSchema,
    completedAt: nullableDateTimeSchema,
    cancelledAt: nullableDateTimeSchema,
    cancellationReason: nullableStringSchema,
    createdAt: dateTimeSchema,
    commissionTotal: { type: 'number', description: 'Revenu de la plateforme', example: 3750 },
    origins: {
      type: 'array',
      description:
        'Origines d\'enlèvement. Calculées à la création de commande seulement : ' +
        'la liste est vide sur une relecture.',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['HUB', 'SUPPLIER_SITE'] },
          hubId: nullableIntegerSchema,
          hubName: nullableStringSchema,
          address: nullableStringSchema,
          latitude: nullableNumberSchema,
          longitude: nullableNumberSchema,
          distanceKm: nullableNumberSchema,
          agencyCost: { type: 'number', example: 1200 },
          deliveryFee: { type: 'number', example: 2500 },
        },
      },
    },
    buyer: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'integer', example: 19 },
        firstname: { type: 'string', example: 'Awa' },
        lastname: { type: 'string', example: 'Ndiaye' },
      },
    },
    handledByAgentId: nullableIntegerSchema,
    conversationId: nullableIntegerSchema,
    paymentStatus: {
      type: 'string',
      nullable: true,
      enum: ['UNPAID', 'PARTIALLY_PAID', 'PAID', 'REFUNDED', null],
    },
  },
};

const ConversationStaffSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 31 },
    type: { type: 'string', enum: ['BUYER_SUPPORT', 'SUPPLIER_SUPPORT'] },
    status: { type: 'string', enum: ['OPEN', 'WAITING_CUSTOMER', 'CLOSED'] },
    subject: nullableStringSchema,
    listingId: nullableIntegerSchema,
    lotId: nullableIntegerSchema,
    customer: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'integer', example: 19 },
        firstname: { type: 'string', example: 'Awa' },
        lastname: { type: 'string', example: 'Ndiaye' },
      },
    },
    assignedAgentId: nullableIntegerSchema,
    assignedAgent: {
      type: 'object',
      nullable: true,
      properties: { id: { type: 'integer', example: 3 }, displayName: { type: 'string', example: 'Équipe AgriConnect' } },
    },
    escalatedAt: nullableDateTimeSchema,
    escalationReason: nullableStringSchema,
    lastMessageAt: dateTimeSchema,
    createdAt: dateTimeSchema,
  },
};

const MessageStaffSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 512 },
    conversationId: { type: 'integer', example: 31 },
    senderType: { type: 'string', enum: ['CUSTOMER', 'AGENT', 'SYSTEM'] },
    senderUserId: nullableIntegerSchema,
    senderAgentId: nullableIntegerSchema,
    content: { type: 'string', example: 'Bonjour, le lot est-il toujours disponible ?' },
    isInternal: {
      type: 'boolean',
      description: 'Note interne : visible de l\'équipe seule, jamais renvoyée au client',
    },
    createdAt: dateTimeSchema,
  },
};

const PaymentSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 77 },
    orderId: { type: 'integer', example: 45 },
    amount: { type: 'number', example: 40000 },
    method: { type: 'string', enum: ['CASH', 'MOBILE_MONEY', 'BANK_TRANSFER'] },
    status: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED'] },
    reference: nullableStringSchema,
    idempotencyKey: nullableStringSchema,
    paidAt: nullableDateTimeSchema,
    recordedById: nullableIntegerSchema,
    createdAt: dateTimeSchema,
  },
};

const DeliveryStaffSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 88 },
    orderId: { type: 'integer', example: 45 },
    agencyId: { type: 'integer', example: 2 },
    agencyName: {
      ...nullableStringSchema,
      description: "Renseigné uniquement par la liste des livraisons, pas par les routes sur une livraison",
    },
    status: {
      type: 'string',
      enum: ['PENDING', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED'],
    },
    pickupHubId: nullableIntegerSchema,
    pickupAddress: nullableStringSchema,
    pickupLatitude: nullableNumberSchema,
    pickupLongitude: nullableNumberSchema,
    dropoffAddress: { type: 'string', example: 'Marché central, Yaoundé' },
    dropoffLatitude: nullableNumberSchema,
    dropoffLongitude: nullableNumberSchema,
    distanceKm: nullableNumberSchema,
    agencyCost: { type: 'number', example: 1200 },
    deliveryFee: { type: 'number', example: 2500 },
    insuredValue: nullableNumberSchema,
    insurancePolicyNumber: nullableStringSchema,
    acceptedAt: nullableDateTimeSchema,
    pickedUpAt: nullableDateTimeSchema,
    deliveredAt: nullableDateTimeSchema,
    createdAt: dateTimeSchema,
  },
};

const QualityCheckSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 15 },
    lotId: { type: 'integer', example: 21 },
    grade: { type: 'string', enum: ['A', 'B', 'C'] },
    notes: nullableStringSchema,
    inspectedByUserId: nullableIntegerSchema,
    inspectedByAgentId: nullableIntegerSchema,
    createdAt: dateTimeSchema,
  },
};

const CompensationStaffSchema = {
  type: 'object',
  description: 'Ligne brute : le contrôleur ne passe pas par un DTO.',
  properties: {
    id: { type: 'integer', example: 4 },
    supplierId: { type: 'integer', example: 7 },
    lotId: { type: 'integer', example: 21 },
    deliveryId: nullableIntegerSchema,
    reason: { type: 'string', enum: ['EXPIRED_UNSOLD', 'LOST_OR_DAMAGED', 'OTHER'] },
    quantity: { type: 'number', example: 120 },
    unitPrice: { type: 'number', example: 700 },
    rate: { type: 'number', example: 1 },
    amount: { type: 'number', example: 84000 },
    status: { type: 'string', enum: ['PENDING_APPROVAL', 'APPROVED', 'PAID', 'REJECTED'] },
    note: nullableStringSchema,
    approvedById: nullableIntegerSchema,
    approvedAt: nullableDateTimeSchema,
    reference: nullableStringSchema,
    paidById: nullableIntegerSchema,
    paidAt: nullableDateTimeSchema,
    createdAt: dateTimeSchema,
  },
};

// ---- Réponses d'accès partagées ------------------------------------------

const unauthenticated = {
  401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
};

const missingCapability = (capability) => ({
  403: { description: `Capacité ${capability} requise (ou niveau ADMIN et plus)`, content: makeErrorResponse('Capacité requise') },
});

const lotNotFound = {
  404: { description: 'Lot inexistant', content: makeErrorResponse('Lot introuvable') },
};

const invalidTransition = {
  409: { description: "Transition d'état refusée", content: makeErrorResponse('Transition refusée', 'INVALID_STATE_TRANSITION') },
};

export const staffOpenApi = {
  openapi: '3.0.3',
  info: { title: 'Module Équipe', version: '1.0.0' },
  paths: {
    // ══ Lots ══════════════════════════════════════════════════════════════
    '/api/v2/staff/lots': {
      post: {
        tags: ['Équipe'],
        summary: 'Déclarer un lot au nom d\'un fournisseur',
        security: [{ bearerAuth: [] }],
        requestBody: makeMultipartRequestBody({
          description: "Multipart : `supplierUserId` identifie le fournisseur, `images` porte les photos (5 maximum).",
          fields: toJsonSchema(staffLotCreateSchema).properties,
          files: { images: { description: 'Photos du lot (jpg, png, webp) — 5 maximum' } },
        }),
        responses: {
          201: { description: 'Lot créé', content: makeSuccessResponse(LotStaffSchema) },
          400: {
            description: 'Fournisseur, produit, zone ou point de dépôt introuvable, ou fichier non supporté',
            content: makeValidationErrorResponse(),
          },
          ...unauthenticated,
        ...missingCapability('STOCK_VALIDATION'),
          404: { description: 'Ressource référencée introuvable', content: makeErrorResponse('Produit introuvable') },
        },
      },

      get: {
        tags: ['Équipe'],
        summary: 'Lister les lots',
        security: [{ bearerAuth: [] }],
        parameters: [
          makeQueryParam('status', 'Filtrer par statut (une valeur inconnue est un 400)', {
            type: 'string',
            enum: LOT_STATUSES,
          }),
          makeQueryParam('supplierId', 'Restreindre à un fournisseur', { type: 'integer' }),
          makeQueryParam('productId', 'Restreindre à un produit', { type: 'integer' }),
          ...paginationParams(),
        ],
        responses: {
          200: { description: 'Lots filtrés', content: makePaginatedResponse(LotStaffSchema) },
          400: { description: 'Statut inconnu', content: makeErrorResponse('Statut invalide') },
          ...unauthenticated,
        ...missingCapability('STOCK_VALIDATION'),
        },
      },
    },

    '/api/v2/staff/lots/{id}': {
      get: {
        tags: ['Équipe'],
        summary: 'Consulter un lot',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant du lot')],
        responses: {
          200: { description: 'Lot trouvé', content: makeSuccessResponse(LotStaffSchema) },
          400: { description: 'Identifiant non numérique', content: makeErrorResponse('Identifiant invalide') },
          ...unauthenticated,
        ...missingCapability('STOCK_VALIDATION'),
          ...lotNotFound,
        },
      },
    },

    '/api/v2/staff/lots/{id}/validate': {
      post: {
        tags: ['Équipe'],
        summary: 'Valider un lot',
        security: [{ bearerAuth: [] }],
        description: 'PENDING_VALIDATION → AVAILABLE. Le fournisseur doit avoir un profil vérifié.',
        parameters: [makePathParam('id', 'Identifiant du lot')],
        requestBody: makeJoiRequestBody(reasonSchema, {
          description: 'Motif obligatoire (le contrôleur n\'en tient pas compte, la route l\'exige).',
        }),
        responses: {
          200: { description: 'Lot validé', content: makeSuccessResponse(LotStaffSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
        ...missingCapability('STOCK_VALIDATION'),
          ...lotNotFound,
          409: {
            description: 'Fournisseur non vérifié, ou transition refusée',
            content: makeErrorResponse('Le fournisseur doit avoir un profil verifie', 'NOT_VERIFIED'),
          },
        },
      },
    },

    '/api/v2/staff/lots/{id}/reject': {
      post: {
        tags: ['Équipe'],
        summary: 'Rejeter un lot',
        security: [{ bearerAuth: [] }],
        description: 'PENDING_VALIDATION → REJECTED. Le motif est conservé sur le lot.',
        parameters: [makePathParam('id', 'Identifiant du lot')],
        requestBody: makeJoiRequestBody(reasonSchema),
        responses: {
          200: { description: 'Lot rejeté', content: makeSuccessResponse(LotStaffSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
        ...missingCapability('STOCK_VALIDATION'),
          ...lotNotFound,
          ...invalidTransition,
        },
      },
    },

    '/api/v2/staff/lots/{id}/return': {
      post: {
        tags: ['Équipe'],
        summary: 'Retourner un lot',
        security: [{ bearerAuth: [] }],
        description:
          'AVAILABLE → RETURNED, ou FULLY_RESERVED sans réservation → RETURNED : le stock ' +
          'encore réservé par des commandes en cours empêche le retour.',
        parameters: [makePathParam('id', 'Identifiant du lot')],
        requestBody: makeJoiRequestBody(reasonSchema),
        responses: {
          200: { description: 'Lot retourné', content: makeSuccessResponse(LotStaffSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
        ...missingCapability('STOCK_VALIDATION'),
          ...lotNotFound,
          ...invalidTransition,
        },
      },
    },

    '/api/v2/staff/stock-movements': {
      get: {
        tags: ['Équipe'],
        summary: 'Consulter le journal de stock',
        security: [{ bearerAuth: [] }],
        description: 'Trace des entrées, réservations, libérations, ventes, pertes et ajustements.',
        parameters: [makeQueryParam('lotId', 'Restreindre à un lot', { type: 'integer' }), ...paginationParams()],
        responses: {
          200: {
            description: 'Mouvements de stock',
            content: makePaginatedResponse({
              type: 'object',
              properties: {
                id: { type: 'integer', example: 300 },
                lotId: { type: 'integer', example: 21 },
                type: {
                  type: 'string',
                  enum: ['RECEIVED', 'RESERVED', 'RESERVATION_RELEASED', 'SOLD', 'EXPIRED', 'RETURNED', 'ADJUSTMENT'],
                },
                quantityDelta: { type: 'number', example: -50, description: 'Négatif pour une sortie' },
                orderItemId: nullableIntegerSchema,
                note: nullableStringSchema,
                actorUserId: nullableIntegerSchema,
                actorAgentId: nullableIntegerSchema,
                createdAt: dateTimeSchema,
              },
            }),
          },
          ...unauthenticated,
        ...missingCapability('STOCK_VALIDATION'),
        },
      },
    },

    '/api/v2/staff/lots/{id}/quality-checks': {
      post: {
        tags: ['Équipe'],
        summary: 'Enregistrer un contrôle qualité',
        security: [{ bearerAuth: [] }],
        description: 'Un lot PENDING_VALIDATION, AVAILABLE ou FULLY_RESERVED peut être inspecté.',
        parameters: [makePathParam('id', 'Identifiant du lot')],
        requestBody: makeJoiRequestBody(qualityCheckSchema),
        responses: {
          201: { description: 'Lot renvoyé avec sa nouvelle note', content: makeSuccessResponse(LotStaffSchema) },
          400: { description: 'Note hors A/B/C, ou corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
        ...missingCapability('STOCK_VALIDATION'),
          ...lotNotFound,
          ...invalidTransition,
        },
      },

      get: {
        tags: ['Équipe'],
        summary: 'Lister les contrôles qualité d\'un lot',
        security: [{ bearerAuth: [] }],
        description: 'Contrôles du plus récent au plus ancien. Un lot inconnu renvoie une liste vide, pas un 404.',
        parameters: [makePathParam('id', 'Identifiant du lot')],
        responses: {
          200: {
            description: 'Contrôles qualité du lot',
            content: makeSuccessResponse({ type: 'array', items: QualityCheckSchema }),
          },
          ...unauthenticated,
        ...missingCapability('STOCK_VALIDATION'),
        },
      },
    },

    // ══ Annonces ═════════════════════════════════════════════════════════
    '/api/v2/staff/listings': {
      post: {
        tags: ['Équipe'],
        summary: 'Créer une annonce à partir d\'un lot',
        security: [{ bearerAuth: [] }],
        description:
          'Une annonce porte exactement un lot : `lotIds` doit contenir une seule valeur, ' +
          'et le lot doit être disponible avec du stock. Le prix public et la zone ' +
          "reprennent ceux du lot quand ils sont absents du corps.",
        requestBody: makeMultipartRequestBody({
          description: "Multipart : `images` porte les photos de l'annonce (5 maximum).",
          fields: toJsonSchema(listingCreateSchema).properties,
          files: { images: { description: 'Photos de l\'annonce (jpg, png, webp) — 5 maximum' } },
        }),
        responses: {
          201: { description: 'Annonce créée', content: makeSuccessResponse(ListingStaffSchema) },
          400: {
            description: 'Plusieurs lots fournis, ou fichier non supporté',
            content: makeValidationErrorResponse(),
          },
          ...unauthenticated,
        ...missingCapability('LISTING_MANAGEMENT'),
          404: { description: 'Lot introuvable', content: makeErrorResponse('Lot introuvable') },
          409: {
            description: 'Lot indisponible ou déjà relié à une annonce',
            content: makeErrorResponse('Le lot doit etre disponible avec du stock', 'LOT_NOT_AVAILABLE'),
          },
        },
      },

      get: {
        tags: ['Équipe'],
        summary: 'Lister les annonces',
        security: [{ bearerAuth: [] }],
        parameters: [
          makeQueryParam('status', 'Filtrer par statut (une valeur inconnue est un 400)', {
            type: 'string',
            enum: LISTING_STATUSES,
          }),
          makeQueryParam('productId', 'Restreindre à un produit', { type: 'integer' }),
          makeQueryParam('supplierId', 'Restreindre à un fournisseur', { type: 'integer' }),
          ...paginationParams(),
        ],
        responses: {
          200: { description: 'Annonces filtrées', content: makePaginatedResponse(ListingStaffSchema) },
          400: { description: 'Statut inconnu', content: makeErrorResponse('Statut invalide') },
          ...unauthenticated,
        ...missingCapability('LISTING_MANAGEMENT'),
        },
      },
    },

    '/api/v2/staff/listings/{id}': {
      get: {
        tags: ['Équipe'],
        summary: 'Consulter une annonce',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant de l\'annonce')],
        responses: {
          200: { description: 'Annonce trouvée', content: makeSuccessResponse(ListingStaffSchema) },
          ...unauthenticated,
        ...missingCapability('LISTING_MANAGEMENT'),
          404: { description: 'Annonce inexistante', content: makeErrorResponse('Annonce introuvable') },
        },
      },

      patch: {
        tags: ['Équipe'],
        summary: 'Modifier une annonce',
        security: [{ bearerAuth: [] }],
        description: 'Une annonce SOLD est figée. Un corps vide est refusé.',
        parameters: [makePathParam('id', 'Identifiant de l\'annonce')],
        requestBody: makeJoiRequestBody(listingUpdateSchema),
        responses: {
          200: { description: 'Annonce mise à jour', content: makeSuccessResponse(ListingStaffSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
        ...missingCapability('LISTING_MANAGEMENT'),
          404: { description: 'Annonce inexistante', content: makeErrorResponse('Annonce introuvable') },
          ...invalidTransition,
        },
      },
    },

    '/api/v2/staff/listings/{id}/publish': {
      post: {
        tags: ['Équipe'],
        summary: 'Publier une annonce',
        security: [{ bearerAuth: [] }],
        description: 'Une annonce DRAFT ou INACTIVE peut être publiée, à condition que le lot ait du stock.',
        parameters: [makePathParam('id', 'Identifiant de l\'annonce')],
        responses: {
          200: { description: 'Annonce publiée (statut ACTIVE)', content: makeSuccessResponse(ListingStaffSchema) },
          ...unauthenticated,
        ...missingCapability('LISTING_MANAGEMENT'),
          404: { description: 'Annonce inexistante', content: makeErrorResponse('Annonce introuvable') },
          ...invalidTransition,
        },
      },
    },

    '/api/v2/staff/listings/{id}/unpublish': {
      post: {
        tags: ['Équipe'],
        summary: 'Dépublier une annonce',
        security: [{ bearerAuth: [] }],
        description: 'Seule une annonce ACTIVE peut être dépubliée : l\'annonce repasse INACTIVE.',
        parameters: [makePathParam('id', 'Identifiant de l\'annonce')],
        responses: {
          200: { description: 'Annonce dépubliée (statut INACTIVE)', content: makeSuccessResponse(ListingStaffSchema) },
          ...unauthenticated,
        ...missingCapability('LISTING_MANAGEMENT'),
          404: { description: 'Annonce inexistante', content: makeErrorResponse('Annonce introuvable') },
          ...invalidTransition,
        },
      },
    },

    // ══ Conversations ════════════════════════════════════════════════════
    '/api/v2/staff/conversations': {
      get: {
        tags: ['Équipe'],
        summary: 'Lister les conversations',
        security: [{ bearerAuth: [] }],
        description: 'Un agent ne voit que les conversations de son type de support ; ce contrôle est fait côté contrôleur.',
        parameters: [
          makeQueryParam('status', 'Filtrer par statut (une valeur inconnue est un 400)', {
            type: 'string',
            enum: ['OPEN', 'WAITING_CUSTOMER', 'CLOSED'],
          }),
          makeQueryParam('unassigned', 'Uniquement les conversations sans agent assigné', { type: 'boolean' }),
          makeQueryParam('mine', 'Uniquement les conversations assignées à l\'agent connecté', { type: 'boolean' }),
          makeQueryParam('escalated', 'Uniquement les conversations escaladées', { type: 'boolean' }),
          ...paginationParams(),
        ],
        responses: {
          200: {
            description: 'Conversations filtrées, la plus active en tête',
            content: makePaginatedResponse(ConversationStaffSchema),
          },
          400: { description: 'Statut inconnu', content: makeErrorResponse('Statut invalide') },
          ...unauthenticated,
        ...missingCapability('BUYER_SUPPORT ou SUPPLIER_SUPPORT'),
        },
      },
    },

    '/api/v2/staff/conversations/{id}': {
      get: {
        tags: ['Équipe'],
        summary: 'Consulter une conversation',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant de la conversation')],
        responses: {
          200: { description: 'Conversation trouvée', content: makeSuccessResponse(ConversationStaffSchema) },
          ...unauthenticated,
        ...missingCapability('BUYER_SUPPORT ou SUPPLIER_SUPPORT'),
          404: { description: 'Conversation inexistante', content: makeErrorResponse('Conversation introuvable') },
        },
      },
    },

    '/api/v2/staff/conversations/{id}/messages': {
      get: {
        tags: ['Équipe'],
        summary: 'Lire les messages d\'une conversation',
        security: [{ bearerAuth: [] }],
        description: 'Contrairement au fil client, celui-ci inclut les notes internes.',
        parameters: [makePathParam('id', 'Identifiant de la conversation'), ...paginationParams()],
        responses: {
          200: { description: 'Messages', content: makePaginatedResponse(MessageStaffSchema) },
          ...unauthenticated,
        ...missingCapability('BUYER_SUPPORT ou SUPPLIER_SUPPORT'),
          404: { description: 'Conversation inexistante', content: makeErrorResponse('Conversation introuvable') },
        },
      },

      post: {
        tags: ['Équipe'],
        summary: 'Répondre au client',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant de la conversation')],
        requestBody: makeJoiRequestBody(staffMessageSchema),
        responses: {
          201: { description: 'Message envoyé', content: makeSuccessResponse(MessageStaffSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
        ...missingCapability('BUYER_SUPPORT ou SUPPLIER_SUPPORT'),
          404: { description: 'Conversation inexistante', content: makeErrorResponse('Conversation introuvable') },
        },
      },
    },

    '/api/v2/staff/conversations/{id}/assign': {
      post: {
        tags: ['Équipe'],
        summary: 'Assigner une conversation à un agent',
        security: [{ bearerAuth: [] }],
        description:
          'Un agent ne peut s\'assigner qu\'à lui-même ; un administrateur doit indiquer `agentId`.',
        parameters: [makePathParam('id', 'Identifiant de la conversation')],
        requestBody: makeJoiRequestBody(assignSchema, {
          description: 'Agent cible. Requis pour un administrateur, refusé pour un autre agent.',
        }),
        responses: {
          200: { description: 'Conversation assignée', content: makeSuccessResponse(ConversationStaffSchema) },
          400: { description: 'Agent inactif, ou agentId manquant pour un administrateur', content: makeValidationErrorResponse() },
          ...unauthenticated,
        ...missingCapability('BUYER_SUPPORT ou SUPPLIER_SUPPORT'),
          404: {
            description: 'Conversation ou agent inexistant',
            content: makeErrorResponse('Conversation introuvable'),
          },
        },
      },
    },

    '/api/v2/staff/conversations/{id}/escalate': {
      post: {
        tags: ['Équipe'],
        summary: 'Escalader une conversation',
        security: [{ bearerAuth: [] }],
        description: "L'escalade date la conversation et libère l'agent qui la portait.",
        parameters: [makePathParam('id', 'Identifiant de la conversation')],
        requestBody: makeJoiRequestBody(escalateSchema),
        responses: {
          200: { description: 'Conversation escaladée', content: makeSuccessResponse(ConversationStaffSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
        ...missingCapability('BUYER_SUPPORT ou SUPPLIER_SUPPORT'),
          404: { description: 'Conversation inexistante', content: makeErrorResponse('Conversation introuvable') },
        },
      },
    },

    '/api/v2/staff/conversations/{id}/close': {
      post: {
        tags: ['Équipe'],
        summary: 'Clore une conversation',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant de la conversation')],
        responses: {
          200: { description: 'Conversation close (statut CLOSED)', content: makeSuccessResponse(ConversationStaffSchema) },
          ...unauthenticated,
        ...missingCapability('BUYER_SUPPORT ou SUPPLIER_SUPPORT'),
          404: { description: 'Conversation inexistante', content: makeErrorResponse('Conversation introuvable') },
        },
      },
    },

    // ══ Commandes ════════════════════════════════════════════════════════
    '/api/v2/staff/orders': {
      post: {
        tags: ['Équipe'],
        summary: 'Émettre un devis',
        security: [{ bearerAuth: [] }],
        description:
          "Le devis réserve le stock et fige les prix. deliveryMode commande le reste : " +
          'HUB_PICKUP exige pickupHubId, AGENCY_DELIVERY exige delivery.',
        requestBody: makeJoiRequestBody(orderCreateSchema),
        responses: {
          201: { description: 'Devis émis (statut QUOTED)', content: makeSuccessResponse(OrderStaffSchema) },
          400: {
            description: 'Mode de livraison incomplet, point de dépôt inutilisable, ou corps invalide',
            content: makeValidationErrorResponse(),
          },
          ...unauthenticated,
        ...missingCapability('ORDER_PROCESSING'),
          403: {
            description: "Compte acheteur inactif ou n'étant pas acheteur",
            content: makeErrorResponse("Ce compte acheteur n'est pas actif", 'BUYER_NOT_ACTIVE'),
          },
          404: {
            description: 'Acheteur, conversation ou annonce introuvable',
            content: makeErrorResponse('Acheteur introuvable', 'BUYER_NOT_FOUND'),
          },
          409: {
            description: 'Stock insuffisant, lot expiré, prix sous le prix convenu, zone non couverte',
            content: makeErrorResponse('Stock insuffisant', 'INSUFFICIENT_STOCK'),
          },
        },
      },

      get: {
        tags: ['Équipe'],
        summary: 'Lister les commandes',
        security: [{ bearerAuth: [] }],
        parameters: paginationParams(),
        responses: {
          200: { description: 'Commandes', content: makePaginatedResponse(OrderStaffSchema) },
          ...unauthenticated,
        ...missingCapability('ORDER_PROCESSING'),
        },
      },
    },

    '/api/v2/staff/orders/{id}': {
      get: {
        tags: ['Équipe'],
        summary: 'Consulter une commande',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant de la commande')],
        responses: {
          200: { description: 'Commande trouvée', content: makeSuccessResponse(OrderStaffSchema) },
          ...unauthenticated,
        ...missingCapability('ORDER_PROCESSING'),
          404: { description: 'Commande inexistante', content: makeErrorResponse('Commande introuvable', 'ORDER_NOT_FOUND') },
        },
      },
    },

    '/api/v2/staff/orders/{id}/status': {
      patch: {
        tags: ['Équipe'],
        summary: 'Changer le statut d\'une commande',
        security: [{ bearerAuth: [] }],
        description:
          'Passer en PREPARING exige un paiement enregistré. OUT_FOR_DELIVERY est ' +
          "refusé ici : ce statut appartient au flux livraison. `force` contourne la " +
          'règle de paiement, pour un administrateur uniquement.',
        parameters: [makePathParam('id', 'Identifiant de la commande')],
        requestBody: makeJoiRequestBody(orderStatusSchema),
        responses: {
          200: { description: 'Statut mis à jour', content: makeSuccessResponse(OrderStaffSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
        ...missingCapability('ORDER_PROCESSING'),
          403: {
            description: 'Forçage demandé par un agent sans niveau administrateur',
            content: makeErrorResponse('Le forcage du statut est reserve aux administrateurs', 'FORCE_FORBIDDEN'),
          },
          404: { description: 'Commande inexistante', content: makeErrorResponse('Commande introuvable', 'ORDER_NOT_FOUND') },
          409: {
            description: 'Transition refusée, ou paiement manquant avant PREPARING',
            content: makeErrorResponse('Transition refusée', 'INVALID_STATE_TRANSITION'),
          },
        },
      },
    },

    '/api/v2/staff/orders/{id}/confirm': {
      post: {
        tags: ['Équipe'],
        summary: 'Confirmer un devis pour le client',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant de la commande')],
        responses: {
          200: { description: 'Devis confirmé', content: makeSuccessResponse(OrderStaffSchema) },
          ...unauthenticated,
        ...missingCapability('ORDER_PROCESSING'),
          404: { description: 'Commande inexistante', content: makeErrorResponse('Commande introuvable', 'ORDER_NOT_FOUND') },
          409: {
            description: 'Devis expiré, ou transition refusée',
            content: makeErrorResponse('Devis expire', 'QUOTE_EXPIRED'),
          },
        },
      },
    },

    '/api/v2/staff/orders/{id}/cancel': {
      post: {
        tags: ['Équipe'],
        summary: 'Annuler une commande',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant de la commande')],
        requestBody: makeJoiRequestBody(orderCancelSchema, {
          required: false,
          description: 'Motif facultatif.',
        }),
        responses: {
          200: { description: 'Commande annulée', content: makeSuccessResponse(OrderStaffSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
        ...missingCapability('ORDER_PROCESSING'),
          404: { description: 'Commande inexistante', content: makeErrorResponse('Commande introuvable', 'ORDER_NOT_FOUND') },
          ...invalidTransition,
        },
      },
    },

    // ══ Paiements ════════════════════════════════════════════════════════
    '/api/v2/staff/orders/{id}/payments': {
      post: {
        tags: ['Équipe'],
        summary: 'Enregistrer un paiement',
        security: [{ bearerAuth: [] }],
        description:
          "L'enregistrement est idempotent : la même clé renvoie le paiement déjà " +
          'enregistré (200) au lieu d\'en créer un second (201). Refuser les agents IA.',
        parameters: [
          makePathParam('id', 'Identifiant de la commande'),
          makeHeaderParam('Idempotency-Key', 'Clé d\'idempotence, obligatoire', { type: 'string' }, {
            required: true,
          }),
        ],
        requestBody: makeJoiRequestBody(paymentCreateSchema),
        responses: {
          200: { description: 'Paiement déjà enregistré pour cette clé', content: makeSuccessResponse(PaymentSchema) },
          201: { description: 'Paiement enregistré', content: makeSuccessResponse(PaymentSchema) },
          400: {
            description: 'En-tête Idempotency-Key absent, montant invalide, ou trop-perçu',
            content: makeValidationErrorResponse(),
          },
          ...unauthenticated,
        ...missingCapability('PAYMENT_FOLLOWUP'),
          403: {
            description: 'Agent IA, ou niveau insuffisant',
            content: makeErrorResponse('Un agent IA ne peut pas effectuer cette action'),
          },
          404: { description: 'Commande inexistante', content: makeErrorResponse('Commande introuvable', 'ORDER_NOT_FOUND') },
          409: {
            description: 'Clé déjà utilisée avec un autre contenu, commande annulée, ou trop-perçu',
            content: makeErrorResponse('Cle d idempotence deja utilisee', 'IDEMPOTENCY_KEY_CONFLICT'),
          },
        },
      },

      get: {
        tags: ['Équipe'],
        summary: 'Lister les paiements d\'une commande',
        security: [{ bearerAuth: [] }],
        description: 'Paiements du plus ancien au plus récent. Cette réponse ne porte pas de pagination.',
        parameters: [makePathParam('id', 'Identifiant de la commande')],
        responses: {
          200: {
            description: 'Paiements de la commande',
            content: makeSuccessResponse({ type: 'object', properties: { items: { type: 'array', items: PaymentSchema } } }),
          },
          ...unauthenticated,
        ...missingCapability('PAYMENT_FOLLOWUP'),
          404: { description: 'Commande inexistante', content: makeErrorResponse('Commande introuvable', 'ORDER_NOT_FOUND') },
        },
      },
    },

    '/api/v2/staff/payments/{id}/refund': {
      post: {
        tags: ['Équipe'],
        summary: 'Rembourser un paiement',
        security: [{ bearerAuth: [] }],
        description:
          "Pouvoir de direction : ADMIN et plus, agent humain obligatoire. `force` permet " +
          "de rembourser même si le reversement fournisseur est déjà payé — le règlement " +
          'fournisseur devient alors un traitement manuel.',
        parameters: [makePathParam('id', 'Identifiant du paiement')],
        requestBody: makeJoiRequestBody(paymentRefundSchema, { required: false, description: 'Corps facultatif.' }),
        responses: {
          200: { description: 'Paiement remboursé (statut REFUNDED)', content: makeSuccessResponse(PaymentSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
          403: {
            description: 'Niveau insuffisant, ou agent IA',
            content: makeErrorResponse('Privilèges insuffisants'),
          },
          404: { description: 'Paiement inexistant', content: makeErrorResponse('Paiement introuvable', 'PAYMENT_NOT_FOUND') },
          409: {
            description: 'Paiement non confirmé, ou reversement fournisseur déjà payé',
            content: makeErrorResponse('Paiement non confirmé', 'PAYMENT_NOT_CONFIRMED'),
          },
        },
      },
    },

    // ══ Livraisons ═══════════════════════════════════════════════════════
    '/api/v2/staff/orders/{id}/deliveries': {
      post: {
        tags: ['Équipe'],
        summary: 'Créer les courses d\'une commande',
        security: [{ bearerAuth: [] }],
        description:
          'Une course par origine d\'enlèvement. Réservé aux commandes en préparation ' +
          'et en livraison agence.',
        parameters: [makePathParam('id', 'Identifiant de la commande')],
        responses: {
          201: {
            description: 'Courses créées',
            content: makeSuccessResponse({ type: 'array', items: DeliveryStaffSchema }),
          },
          ...unauthenticated,
        ...missingCapability('DISPATCH_COORDINATION'),
          404: { description: 'Commande inexistante', content: makeErrorResponse('Commande introuvable', 'ORDER_NOT_FOUND') },
          409: {
            description: 'Mode de livraison ou statut de commande inadapté, courses déjà créées, zone non couverte',
            content: makeErrorResponse('Courses déjà créées', 'DELIVERIES_ALREADY_CREATED'),
          },
        },
      },
    },

    '/api/v2/staff/deliveries': {
      get: {
        tags: ['Équipe'],
        summary: 'Lister les livraisons',
        security: [{ bearerAuth: [] }],
        description: 'Seule cette réponse renseigne `agencyName`.',
        parameters: [
          makeQueryParam('status', 'Filtrer par statut', {
            type: 'string',
            enum: ['PENDING', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED'],
          }),
          makeQueryParam('orderId', 'Restreindre à une commande', { type: 'integer' }),
          ...paginationParams(),
        ],
        responses: {
          200: { description: 'Livraisons filtrées', content: makePaginatedResponse(DeliveryStaffSchema) },
          ...unauthenticated,
        ...missingCapability('DISPATCH_COORDINATION'),
        },
      },
    },

    '/api/v2/staff/deliveries/{id}/release': {
      post: {
        tags: ['Équipe'],
        summary: 'Relâcher une course acceptée',
        security: [{ bearerAuth: [] }],
        description: 'ACCEPTED → PENDING : la course redevient disponible pour un autre livreur.',
        parameters: [makePathParam('id', 'Identifiant de la livraison')],
        requestBody: makeJoiRequestBody(deliveryReleaseSchema, {
          required: false,
          description: 'Motif facultatif.',
        }),
        responses: {
          200: { description: 'Course relâchée', content: makeSuccessResponse(DeliveryStaffSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
        ...missingCapability('DISPATCH_COORDINATION'),
          404: { description: 'Livraison inexistante', content: makeErrorResponse('Livraison introuvable', 'DELIVERY_NOT_FOUND') },
          ...invalidTransition,
        },
      },
    },

    '/api/v2/staff/deliveries/{id}/redispatch': {
      post: {
        tags: ['Équipe'],
        summary: 'Remettre une course en attente',
        security: [{ bearerAuth: [] }],
        description: 'FAILED → PENDING. Le motif d\'incident est conservé mais n\'est pas exposé par le DTO.',
        parameters: [makePathParam('id', 'Identifiant de la livraison')],
        responses: {
          200: { description: 'Course remise en attente', content: makeSuccessResponse(DeliveryStaffSchema) },
          ...unauthenticated,
        ...missingCapability('DISPATCH_COORDINATION'),
          404: { description: 'Livraison inexistante', content: makeErrorResponse('Livraison introuvable', 'DELIVERY_NOT_FOUND') },
          ...invalidTransition,
        },
      },
    },

    '/api/v2/staff/deliveries/{id}/cancel': {
      post: {
        tags: ['Équipe'],
        summary: 'Annuler une course',
        security: [{ bearerAuth: [] }],
        description:
          'PENDING, ACCEPTED ou FAILED → CANCELLED. Le motif est obligatoire : une course ' +
          'annulée doit pouvoir être justifiée après coup (audit).',
        parameters: [makePathParam('id', 'Identifiant de la livraison')],
        requestBody: makeJoiRequestBody(deliveryCancelSchema),
        responses: {
          200: { description: 'Course annulée', content: makeSuccessResponse(DeliveryStaffSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
        ...missingCapability('DISPATCH_COORDINATION'),
          404: { description: 'Livraison inexistante', content: makeErrorResponse('Livraison introuvable', 'DELIVERY_NOT_FOUND') },
          ...invalidTransition,
        },
      },
    },

    // ══ Indemnisations ═══════════════════════════════════════════════════
    '/api/v2/staff/compensations': {
      post: {
        tags: ['Équipe'],
        summary: 'Demander une indemnisation fournisseur',
        security: [{ bearerAuth: [] }],
        description:
          'Indemnisation pour invendus expirés ou pertes. Elle part en attente ' +
          "d'approbation : l'approbation et le paiement sont des actes d'administration.",
        requestBody: makeJoiRequestBody(compensationCreateSchema),
        responses: {
          201: { description: 'Indemnisation demandée', content: makeSuccessResponse(CompensationStaffSchema) },
          400: {
            description: 'Quantité invalide, livraison introuvable, ou taux d\'indemnisation à zéro',
            content: makeValidationErrorResponse(),
          },
          ...unauthenticated,
        ...missingCapability('DISPUTE_HANDLING'),
          404: { description: 'Lot introuvable', content: makeErrorResponse('Lot introuvable', 'LOT_NOT_FOUND') },
          409: {
            description: 'Quantité demandée supérieure au lot',
            content: makeErrorResponse('Quantité trop élevée', 'COMPENSATION_QUANTITY_EXCEEDED'),
          },
        },
      },
    },
  },
};