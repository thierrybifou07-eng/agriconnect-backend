// config/openapi/modules/catalog.openapi.js
//
// Catalogue acheteur (plan v2, P2.6). Le catalogue n'expose que des annonces :
// le lot, le fournisseur et le prix convenu sont des données internes et ne
// sortent jamais ici (voir listingToBuyerDto dans utils/dto/listing.dto.js).
//
// Rôles autorisés : BUYER, AGENT, ADMIN, ROOT — SUPPLIER et DRIVER sont refusés.

import {
  makeSuccessResponse,
  makeErrorResponse,
  makePaginatedResponse,
  makePathParam,
  makeQueryParam,
  paginationParams,
  nullableDateTimeSchema,
  nullableStringSchema,
} from '../openapi.helpers.js';

const CategorySchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 1 },
    code: { type: 'string', example: 'CEREALS' },
    label: { type: 'string', example: 'Céréales' },
  },
};

const ListingBuyerSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 12 },
    reference: { type: 'string', example: 'LST-2026-000012' },
    title: { type: 'string', example: 'Riz paddy qualité 1 — lot 500 kg' },
    description: nullableStringSchema,
    category: {
      type: 'object',
      properties: { code: { type: 'string', example: 'CEREALS' }, label: { type: 'string', example: 'Céréales' } },
    },
    unit: {
      type: 'object',
      properties: { code: { type: 'string', example: 'KG' }, label: { type: 'string', example: 'Kilogramme' } },
    },
    unitPrice: { type: 'number', description: 'Prix public par unité', example: 750 },
    quantityAvailable: {
      type: 'number',
      description: 'Somme des quantités disponibles des lots non expirés reliés',
      example: 500,
    },
    expiresAt: {
      ...nullableDateTimeSchema,
      description: 'Date d\'expiration la plus proche parmi les lots non expirés',
    },
    zone: {
      type: 'object',
      properties: {
        id: { type: 'integer', example: 3 },
        name: { type: 'string', example: 'Zone de Ngaoundéré' },
        city: nullableStringSchema,
      },
    },
    images: {
      type: 'array',
      description: 'URLs des photos, la principale en premier',
      items: { type: 'string', format: 'uri' },
    },
    qualityGrade: {
      type: 'string',
      nullable: true,
      enum: ['A', 'B', 'C', null],
      description: 'Note la plus basse parmi les lots non expirés',
    },
  },
};

export const catalogOpenApi = {
  openapi: '3.0.3',
  info: { title: 'Module Catalogue', version: '1.0.0' },
  paths: {
    // ── GET /catalog/categories ───────────────────────────────────────────
    '/api/v2/catalog/categories': {
      get: {
        tags: ['Catalogue'],
        summary: 'Lister les catégories de produits',
        security: [{ bearerAuth: [] }],
        description: 'Seules les catégories actives sont renvoyées, triées par libellé.',
        responses: {
          200: {
            description: 'Catégories actives',
            content: makeSuccessResponse({ type: 'array', items: CategorySchema }),
          },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          403: {
            description: "Rôle non autorisé (SUPPLIER et DRIVER n'ont pas accès au catalogue)",
            content: makeErrorResponse('Accès refusé pour ce rôle'),
          },
        },
      },
    },

    // ── GET /catalog/listings ────────────────────────────────────────────
    '/api/v2/catalog/listings': {
      get: {
        tags: ['Catalogue'],
        summary: 'Parcourir les annonces disponibles',
        security: [{ bearerAuth: [] }],
        description:
          'Filtre et tri sont appliqués en mémoire après chargement : ' +
          '`page` et `limit` découpent la liste filtrée, pas la base.',
        parameters: [
          makeQueryParam('zoneId', 'Restreindre à une zone', { type: 'integer' }),
          makeQueryParam('categoryId', 'Restreindre à une catégorie', { type: 'integer' }),
          makeQueryParam('q', 'Recherche plein texte sur le titre ou la description', { type: 'string' }),
          makeQueryParam('sort', 'Tri de la liste', {
            type: 'string',
            enum: ['recent', 'price', 'expiry'],
            default: 'recent',
          }),
          ...paginationParams(),
        ],
        responses: {
          200: {
            description: 'Annonces publiées ayant du stock',
            content: makePaginatedResponse(ListingBuyerSchema),
          },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          403: { description: 'Rôle non autorisé', content: makeErrorResponse('Accès refusé pour ce rôle') },
        },
      },
    },

    // ── GET /catalog/listings/:id ────────────────────────────────────────
    '/api/v2/catalog/listings/{id}': {
      get: {
        tags: ['Catalogue'],
        summary: 'Consulter une annonce',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant de l\'annonce')],
        responses: {
          200: {
            description: 'Annonce publiée et disponible',
            content: makeSuccessResponse(ListingBuyerSchema),
          },
          400: { description: 'Identifiant non numérique', content: makeErrorResponse('Identifiant invalide') },
          401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
          403: { description: 'Rôle non autorisé', content: makeErrorResponse('Accès refusé pour ce rôle') },
          404: {
            description: 'Annonce inexistante, non publiée, ou sans stock',
            content: makeErrorResponse('Annonce introuvable'),
          },
        },
      },
    },
  },
};