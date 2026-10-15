// config/openapi/modules/supplier.openapi.js
//
// Lots déclarés par le fournisseur connecté, et consultation de ses
// reversements et de ses indemnisations. Toutes les routes exigent le rôle
// SUPPLIER (requireRole).
//
// Le lot est une donnée interne : la forme renvoyée ici ne contient ni prix
// public ni donnée acheteur (voir lotToSupplierDto).

import {
  makeSuccessResponse,
  makeErrorResponse,
  makeValidationErrorResponse,
  makePaginatedResponse,
  makeMultipartRequestBody,
  makeJoiRequestBody,
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
import { lotCreateSchema, lotUpdateSchema, LOT_STATUSES } from '../../../src/validators/lot.validator.js';

// Schéma défini en ligne dans supplier.routes.js.
const withdrawSchema = {
  type: 'object',
  required: ['reason'],
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Motif du retrait' },
  },
};

const LotSupplierSchema = {
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
    storageType: {
      type: 'string',
      enum: ['SUPPLIER_SITE', 'HUB'],
      description: 'Où le lot est stocké : chez le fournisseur ou dans un point de dépôt',
    },
    hub: {
      type: 'object',
      nullable: true,
      description: 'Point de dépôt, renseigné seulement si storageType vaut HUB',
      properties: {
        id: { type: 'integer', example: 5 },
        name: { type: 'string', example: 'Dépôt Ngaoundéré Centre' },
        city: nullableStringSchema,
      },
    },
    pickupAddress: nullableStringSchema,
    pickupLatitude: nullableNumberSchema,
    pickupLongitude: nullableNumberSchema,
    agreedUnitPrice: { type: 'number', description: 'Prix convenu avec la plateforme', example: 700 },
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
      description: 'Photos, la principale en premier',
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
  },
};

const lotNotFound = {
  404: {
    description: 'Lot inexistant ou appartenant à un autre fournisseur',
    content: makeErrorResponse('Lot introuvable'),
  },
};

const forbiddenRole = {
  403: { description: 'Rôle non autorisé', content: makeErrorResponse('Accès refusé pour ce rôle') },
};

const PayoutSupplierSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 9 },
    orderId: { type: 'integer', example: 45 },
    grossAmount: { type: 'number', example: 40000 },
    commissionAmount: { type: 'number', example: 4000 },
    netAmount: { type: 'number', example: 36000 },
    status: { type: 'string', enum: ['ON_HOLD', 'READY', 'PAID', 'CANCELLED'] },
    reference: nullableStringSchema,
    payoutAccountId: nullableIntegerSchema,
    paidAt: nullableDateTimeSchema,
    createdAt: dateTimeSchema,
  },
};

const CompensationSupplierSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 4 },
    lotId: { type: 'integer', example: 21 },
    deliveryId: nullableIntegerSchema,
    reason: { type: 'string', enum: ['EXPIRED_UNSOLD', 'LOST_OR_DAMAGED', 'OTHER'] },
    quantity: { type: 'number', example: 120 },
    amount: { type: 'number', example: 84000 },
    status: { type: 'string', enum: ['PENDING_APPROVAL', 'APPROVED', 'PAID', 'REJECTED'] },
    note: nullableStringSchema,
    reference: nullableStringSchema,
    paidAt: nullableDateTimeSchema,
    createdAt: dateTimeSchema,
  },
};

export const supplierOpenApi = {
  openapi: '3.0.3',
  info: { title: 'Module Fournisseur', version: '1.0.0' },
  paths: {
    // ── POST / GET /supplier/lots ─────────────────────────────────────────
    '/api/v2/supplier/lots': {
      post: {
        tags: ['Fournisseur'],
        summary: 'Déclarer un lot',
        security: [{ bearerAuth: [] }],
        description:
          "Le lot part en attente de validation : c'est l'équipe qui le valide " +
          "avant qu'une annonce puisse en être publiée. Les champs conditionnels " +
          'à storageType (hubId, pickupAddress, pickupLatitude, pickupLongitude) ' +
          'sont décrits par le validateur lui-même.',
        requestBody: makeMultipartRequestBody({
          description:
            'Multipart : les champs texte arrivent en chaîne et sont convertis par le validateur, ' +
            "les photos sont envoyées dans le champ `images` (5 maximum).",
          fields: toJsonSchema(lotCreateSchema).properties,
          files: { images: { description: 'Photos du lot (jpg, png, webp) — 5 maximum' } },
        }),
        responses: {
          201: { description: 'Lot créé', content: makeSuccessResponse(LotSupplierSchema) },
          400: {
            description:
              "Fichier non supporté, plus de 5 images, ou règle de stockage incohérente " +
              "(produit périssable sans date d'expiration, dépôt qui n'accepte pas la dépose)",
            content: makeValidationErrorResponse(),
          },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
        },
      },

      get: {
        tags: ['Fournisseur'],
        summary: 'Lister ses lots',
        security: [{ bearerAuth: [] }],
        parameters: [
          makeQueryParam('status', 'Filtrer par statut (une valeur inconnue est un 400, pas une liste vide)', {
            type: 'string',
            enum: LOT_STATUSES,
          }),
          ...paginationParams(),
        ],
        responses: {
          200: { description: 'Lots du fournisseur connecté', content: makePaginatedResponse(LotSupplierSchema) },
          400: { description: 'Statut inconnu', content: makeErrorResponse('Statut invalide') },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
        },
      },
    },

    // ── GET / PATCH / DELETE /supplier/lots/:id ───────────────────────────
    '/api/v2/supplier/lots/{id}': {
      get: {
        tags: ['Fournisseur'],
        summary: 'Consulter un lot',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant du lot')],
        responses: {
          200: { description: 'Lot trouvé', content: makeSuccessResponse(LotSupplierSchema) },
          400: { description: 'Identifiant non numérique', content: makeErrorResponse('Identifiant invalide') },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
          ...lotNotFound,
        },
      },

      patch: {
        tags: ['Fournisseur'],
        summary: 'Modifier un lot',
        security: [{ bearerAuth: [] }],
        description: "Seul un lot en attente de validation est modifiable. Un corps vide est refusé.",
        parameters: [makePathParam('id', 'Identifiant du lot')],
        requestBody: makeJoiRequestBody(lotUpdateSchema),
        responses: {
          200: { description: 'Lot mis à jour', content: makeSuccessResponse(LotSupplierSchema) },
          400: {
            description: 'Quantité inférieure aux quantités réservées, vendues ou perdues, ou corps invalide',
            content: makeValidationErrorResponse(),
          },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
          ...lotNotFound,
          409: {
            description: "Le lot n'est plus en attente de validation",
            content: makeErrorResponse('Transition refusée', 'INVALID_STATE_TRANSITION'),
          },
        },
      },

      delete: {
        tags: ['Fournisseur'],
        summary: 'Supprimer un lot',
        security: [{ bearerAuth: [] }],
        description: 'Seuls un lot en attente de validation ou rejeté peut être supprimé.',
        parameters: [makePathParam('id', 'Identifiant du lot')],
        responses: {
          204: { description: 'Lot supprimé' },
          400: { description: 'Identifiant non numérique', content: makeErrorResponse('Identifiant invalide') },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
          ...lotNotFound,
          409: {
            description: 'Lot ni en attente de validation, ni rejeté',
            content: makeErrorResponse('Transition refusée', 'INVALID_STATE_TRANSITION'),
          },
        },
      },
    },

    // ── POST /supplier/lots/:id/withdraw ──────────────────────────────────
    '/api/v2/supplier/lots/{id}/withdraw': {
      post: {
        tags: ['Fournisseur'],
        summary: 'Retirer un lot disponible',
        security: [{ bearerAuth: [] }],
        description: "Un lot qui porte une réservation ne peut pas être retiré : le stock d'autres serait libéré.",
        parameters: [makePathParam('id', 'Identifiant du lot')],
        requestBody: makeJoiRequestBody(withdrawSchema),
        responses: {
          200: { description: 'Lot retiré (statut WITHDRAWN)', content: makeSuccessResponse(LotSupplierSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
          ...lotNotFound,
          409: {
            description: 'Lot non disponible, ou portant une réservation',
            content: makeErrorResponse('Transition refusée', 'INVALID_STATE_TRANSITION'),
          },
        },
      },
    },

    // ── GET /supplier/payouts ─────────────────────────────────────────────
    '/api/v2/supplier/payouts': {
      get: {
        tags: ['Fournisseur'],
        summary: 'Lister ses reversements',
        security: [{ bearerAuth: [] }],
        description: 'La vue reprend les lignes figées au moment du paiement : aucun net fournisseur n\'est recalculé ici.',
        parameters: paginationParams(),
        responses: {
          200: {
            description: 'Reversements du fournisseur connecté',
            content: makePaginatedResponse(PayoutSupplierSchema),
          },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
        },
      },
    },

    // ── GET /supplier/compensations ───────────────────────────────────────
    '/api/v2/supplier/compensations': {
      get: {
        tags: ['Fournisseur'],
        summary: 'Lister ses indemnisations',
        security: [{ bearerAuth: [] }],
        description:
          'Indemnisation due au fournisseur pour invendus expirés ou pertes. ' +
          "L'approbation et le paiement sont des actes d'administration (/admin/compensations).",
        parameters: paginationParams(),
        responses: {
          200: {
            description: 'Indemnisations du fournisseur connecté',
            content: makePaginatedResponse(CompensationSupplierSchema),
          },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          ...forbiddenRole,
        },
      },
    },
  },
};