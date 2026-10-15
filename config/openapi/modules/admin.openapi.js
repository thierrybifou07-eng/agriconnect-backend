// config/openapi/modules/admin.openapi.js
//
// Administration de la plateforme (plan v2, P1 Ã  P6).
//
// Deux portes d'entrÃ©e cohabitent :
//  - /admin/verifications estDeclared AVANT le requireMinLevel(50) global, pour
//    qu'un AGENT muni de la capacitÃ© USER_VERIFICATION puisse examiner un profil ;
//  - tout le reste exige protect + niveau 50 (ADMIN et plus), et les actes
//    d'argent (/payouts, /referrals, /compensations) refusent en plus les agents IA.

import {
  makeSuccessResponse,
  makeErrorResponse,
  makeValidationErrorResponse,
  makePaginatedResponse,
  makeJoiRequestBody,
  makePathParam,
  makeQueryParam,
  paginationParams,
  dateTimeSchema,
  nullableDateTimeSchema,
  nullableIntegerSchema,
  nullableNumberSchema,
  nullableStringSchema,
} from '../openapi.helpers.js';
import {
  createStaffUserSchema,
  createLegalVersionSchema,
  updateSettingsSchema,
  payReferralSchema,
  rejectReferralSchema,
} from '../../../src/validators/admin.validator.js';
import { updateAgentSchema, createAiAgentSchema } from '../../../src/validators/agent.validator.js';
import { reviewVerificationSchema } from '../../../src/validators/verification.validator.js';
import { payPayoutSchema } from '../../../src/validators/payout.validator.js';
import {
  compensationRejectSchema,
  compensationPaySchema,
} from '../../../src/validators/compensation.validator.js';
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
} from '../../../src/validators/referential.validator.js';
import {
  createAgencySchema,
  updateAgencySchema,
  upsertAgencyZoneSchema,
} from '../../../src/validators/agency.validator.js';

// ---- SchÃ©mas de rÃ©ponse --------------------------------------------------

// userSafeSelect : la ligne utilisateur telle que la renvoie l'administration.
const AdminUserSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 19 },
    firstname: { type: 'string', example: 'Awa' },
    lastname: { type: 'string', example: 'Ndiaye' },
    phone: { type: 'string', example: '+237699112233' },
    email: { type: 'string', format: 'email' },
    role: {
      type: 'object',
      properties: {
        code: { type: 'string', enum: ['ROOT', 'ADMIN', 'AGENT', 'SUPPLIER', 'BUYER', 'DRIVER'] },
        label: { type: 'string', example: 'Acheteur' },
        level: { type: 'integer', example: 10 },
      },
    },
    userStatus: {
      type: 'object',
      properties: { code: { type: 'string', example: 'ACTIVE' }, label: { type: 'string', example: 'Actif' } },
    },
    location: nullableStringSchema,
    profileVerificationStatus: { type: 'string', enum: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'] },
    createdAt: dateTimeSchema,
  },
};

const PlatformSettingsSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 1 },
    currency: { type: 'string', example: 'XAF', description: 'Lecture seule : sa modification est refusÃ©e' },
    supplierCommissionRate: { type: 'number', example: 0.1 },
    buyerFeeType: { type: 'string', enum: ['NONE', 'FIXED', 'PERCENT'] },
    buyerFeeValue: {
      type: 'number',
      description: 'Montant si buyerFeeType vaut NONE ou FIXED, taux (1 = 100 %) si PERCENT',
      example: 0,
    },
    transportMarkupRate: { type: 'number', example: 0.1 },
    referralBuyerReward: { type: 'number', example: 5000 },
    referralSupplierReward: { type: 'number', example: 10000 },
    reservationHours: {
      type: 'integer',
      description: 'DurÃ©e d\'une rÃ©servation de stock, entre 1 heure et 168',
      example: 24,
    },
    expiryCompensationRate: { type: 'number', example: 1 },
    updatedAt: dateTimeSchema,
  },
};

const VerificationMediaSchema = {
  type: 'object',
  nullable: true,
  description: 'Fichier privÃ©, servi par une URL signÃ©e valable 10 minutes',
  properties: {
    id: { type: 'integer', example: 71 },
    isPrivate: { type: 'boolean', example: true },
    mimeType: { type: 'string', example: 'image/jpeg' },
    createdAt: dateTimeSchema,
    url: { type: 'string', format: 'uri' },
  },
};

const VerificationListItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 5 },
    type: { type: 'string', enum: ['ID_CARD', 'BUSINESS_REGISTRATION', 'FARM_PROOF', 'OTHER'] },
    status: { type: 'string', enum: ['PENDING', 'VERIFIED', 'REJECTED', 'UNVERIFIED'] },
    note: nullableStringSchema,
    createdAt: dateTimeSchema,
    reviewedAt: nullableDateTimeSchema,
    user: {
      type: 'object',
      properties: {
        id: { type: 'integer', example: 7 },
        firstname: { type: 'string', example: 'Ibrahim' },
        lastname: { type: 'string', example: 'Moussa' },
        email: { type: 'string', format: 'email' },
        role: { type: 'object', properties: { code: { type: 'string', example: 'SUPPLIER' } } },
      },
    },
  },
};

const VerificationDetailSchema = {
  ...VerificationListItemSchema,
  properties: { ...VerificationListItemSchema.properties, media: VerificationMediaSchema },
};

const AgentSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 3 },
    kind: { type: 'string', enum: ['HUMAN', 'AI'] },
    displayName: { type: 'string', example: 'Ã‰quipe AgriConnect' },
    userId: nullableIntegerSchema,
    autonomy: {
      type: 'string',
      nullable: true,
      enum: ['SUGGEST_ONLY', 'ACT_WITH_APPROVAL', 'AUTONOMOUS', null],
    },
    isActive: { type: 'boolean', example: true },
    aiProvider: nullableStringSchema,
    aiModel: nullableStringSchema,
    createdAt: dateTimeSchema,
    capabilities: {
      type: 'array',
      description: 'Remplace intÃ©gralement les capacitÃ©s de la fiche lors d\'un PATCH',
      items: {
        type: 'object',
        properties: {
          capability: {
            type: 'object',
            properties: { code: { type: 'string', example: 'STOCK_VALIDATION' }, label: { type: 'string' } },
          },
        },
      },
    },
    user: {
      type: 'object',
      nullable: true,
      description: 'Un agent IA n\'a pas de compte utilisateur',
      properties: {
        id: { type: 'integer', example: 3 },
        firstname: { type: 'string', example: 'Awa' },
        lastname: { type: 'string', example: 'Ndiaye' },
        email: { type: 'string', format: 'email' },
      },
    },
  },
};

const CategorySchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 1 },
    code: { type: 'string', example: 'CEREALS' },
    label: { type: 'string', example: 'CÃ©rÃ©ales' },
    isActive: { type: 'boolean', example: true },
    createdAt: dateTimeSchema,
  },
};

const UnitSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 1 },
    code: { type: 'string', example: 'KG' },
    label: { type: 'string', example: 'Kilogramme' },
    createdAt: dateTimeSchema,
  },
};

const ProductSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 4 },
    categoryId: { type: 'integer', example: 1 },
    unitId: { type: 'integer', example: 1 },
    name: { type: 'string', example: 'Riz paddy' },
    description: nullableStringSchema,
    imageUrl: nullableStringSchema,
    isPerishable: { type: 'boolean', example: true },
    isActive: { type: 'boolean', example: true },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
};

const ZoneSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 3 },
    name: { type: 'string', example: 'Zone de NgaoundÃ©rÃ©' },
    city: nullableStringSchema,
    region: nullableStringSchema,
    isActive: { type: 'boolean', example: true },
    createdAt: dateTimeSchema,
  },
};

const HubSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 5 },
    name: { type: 'string', example: 'DÃ©pÃ´t NgaoundÃ©rÃ© Centre' },
    address: { type: 'string', example: 'BP 12, NgaoundÃ©rÃ©' },
    city: nullableStringSchema,
    latitude: { type: 'number', example: 7.34 },
    longitude: { type: 'number', example: 13.23 },
    zoneId: { type: 'integer', example: 3 },
    acceptsDropoff: { type: 'boolean', example: true },
    acceptsPickup: { type: 'boolean', example: true },
    isActive: { type: 'boolean', example: true },
    createdAt: dateTimeSchema,
  },
};

const AgencySchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 2 },
    name: { type: 'string', example: 'Agence Express Centre' },
    contactName: nullableStringSchema,
    phone: { type: 'string', example: '+237699887766' },
    email: { type: 'string', nullable: true, format: 'email' },
    insuranceProvider: nullableStringSchema,
    insurancePolicyNumber: nullableStringSchema,
    insuranceExpiresAt: nullableDateTimeSchema,
    isActive: { type: 'boolean', example: true },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
};

// Les tarifs de couverture d'une zone par une agence.
const PayoutAccountFullSchema = {
  type: 'object',
  nullable: true,
  description:
    "Vue d'administration : le numÃ©ro est ici en clair, contrairement Ã  la vue du " +
    'propriÃ©taire du compte.',
  properties: {
    method: { type: 'string', enum: ['MOBILE_MONEY', 'BANK_TRANSFER', 'CASH'] },
    provider: nullableStringSchema,
    accountNumber: { type: 'string', example: '699112233' },
    accountName: nullableStringSchema,
  },
};

const PayoutAdminListItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 9 },
    orderId: { type: 'integer', example: 45 },
    supplierId: { type: 'integer', example: 7 },
    supplier: {
      type: 'object',
      nullable: true,
      properties: {
        farmName: { type: 'string', example: 'Ferme Nkol' },
        firstname: { type: 'string', example: 'Ibrahim' },
        lastname: { type: 'string', example: 'Moussa' },
        email: { type: 'string', format: 'email' },
      },
    },
    grossAmount: { type: 'number', example: 40000 },
    commissionAmount: { type: 'number', example: 4000 },
    netAmount: { type: 'number', example: 36000 },
    status: { type: 'string', enum: ['ON_HOLD', 'READY', 'PAID', 'CANCELLED'] },
    reference: nullableStringSchema,
    payoutAccountId: nullableIntegerSchema,
    payoutAccount: PayoutAccountFullSchema,
    paidAt: nullableDateTimeSchema,
    paidById: nullableIntegerSchema,
    createdAt: dateTimeSchema,
  },
};

const PayoutRowSchema = {
  type: 'object',
  description: 'Ligne brute renvoyÃ©e par les routes de paiement et d\'annulation.',
  properties: {
    id: { type: 'integer', example: 9 },
    orderId: { type: 'integer', example: 45 },
    supplierId: { type: 'integer', example: 7 },
    grossAmount: { type: 'number', example: 40000 },
    commissionAmount: { type: 'number', example: 4000 },
    netAmount: { type: 'number', example: 36000 },
    status: { type: 'string', enum: ['ON_HOLD', 'READY', 'PAID', 'CANCELLED'] },
    payoutAccountId: nullableIntegerSchema,
    reference: nullableStringSchema,
    paidAt: nullableDateTimeSchema,
    paidById: nullableIntegerSchema,
    createdAt: dateTimeSchema,
  },
};

const CompensationRowSchema = {
  type: 'object',
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

const CompensationAdminListItemSchema = {
  ...CompensationRowSchema,
  properties: {
    ...CompensationRowSchema.properties,
    supplier: {
      type: 'object',
      nullable: true,
      description: 'Avec le compte de paiement par dÃ©faut, numÃ©ro en clair',
      properties: {
        farmName: { type: 'string', example: 'Ferme Nkol' },
        firstname: { type: 'string', example: 'Ibrahim' },
        lastname: { type: 'string', example: 'Moussa' },
        email: { type: 'string', format: 'email' },
        payoutAccount: PayoutAccountFullSchema,
      },
    },
  },
};

const ReferralListItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 3 },
    referrer: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'integer', example: 19 },
        firstname: { type: 'string', example: 'Awa' },
        lastname: { type: 'string', example: 'Ndiaye' },
        email: { type: 'string', format: 'email' },
        defaultPayoutAccount: PayoutAccountFullSchema,
      },
    },
    referred: {
      type: 'object',
      properties: {
        id: { type: 'integer', example: 25 },
        firstname: { type: 'string', example: 'Blaise' },
        lastname: { type: 'string', example: 'Etoa' },
        email: { type: 'string', format: 'email' },
      },
    },
    kind: { type: 'string', enum: ['BUYER', 'SUPPLIER'] },
    status: { type: 'string', enum: ['PENDING', 'ELIGIBLE', 'PAID', 'REJECTED'] },
    rewardAmount: { ...nullableNumberSchema, example: 5000 },
    eligibleAt: nullableDateTimeSchema,
    reference: nullableStringSchema,
    paidById: nullableIntegerSchema,
    paidAt: nullableDateTimeSchema,
    rejectionReason: nullableStringSchema,
    createdAt: dateTimeSchema,
  },
};

const ReferralRowSchema = {
  type: 'object',
  description: 'Ligne brute renvoyÃ©e par les routes de paiement et de rejet.',
  properties: {
    id: { type: 'integer', example: 3 },
    referrerId: { type: 'integer', example: 19 },
    referredId: { type: 'integer', example: 25 },
    kind: { type: 'string', enum: ['BUYER', 'SUPPLIER'] },
    status: { type: 'string', enum: ['PENDING', 'ELIGIBLE', 'PAID', 'REJECTED'] },
    rewardAmount: nullableNumberSchema,
    eligibleAt: nullableDateTimeSchema,
    reference: nullableStringSchema,
    paidById: nullableIntegerSchema,
    paidAt: nullableDateTimeSchema,
    rejectionReason: nullableStringSchema,
    createdAt: dateTimeSchema,
  },
};

const LegalVersionSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 3 },
    documentId: { type: 'integer', example: 1 },
    version: { type: 'string', example: '1.2' },
    status: { type: 'string', enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'] },
    publishedAt: nullableDateTimeSchema,
    createdAt: dateTimeSchema,
  },
};

const AuditLogSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 501 },
    actorUserId: nullableIntegerSchema,
    actorAgentId: nullableIntegerSchema,
    action: {
      type: 'string',
      example: 'SETTINGS_UPDATED',
      description: 'Acte tracÃ©, par exemple SETTINGS_UPDATED ou PROFILE_DOCUMENT_APPROVED',
    },
    entityType: { type: 'string', example: 'PlatformSetting' },
    entityId: { type: 'integer', example: 1 },
    metadata: {
      type: 'object',
      nullable: true,
      additionalProperties: true,
      description: 'Charge utile libre, propre Ã  chaque action',
    },
    createdAt: dateTimeSchema,
  },
};

// ---- RÃ©ponses d'accÃ¨s partagÃ©es ------------------------------------------

const unauthenticated = {
  401: { description: 'Non authentifiÃ©', content: makeErrorResponse('Authentification requise') },
};

const insufficientLevel = {
  403: {
    description: 'ADMIN ou ROOT requis (niveau 50)',
    content: makeErrorResponse('PrivilÃ¨ges insuffisants'),
  },
};

// Les actes d'argent cumulent deux contrÃ´les qui rendent tous deux un 403 :
// le niveau (ADMIN et plus) et l'obligation d'un acteur humain â€” une IA ne
// dÃ©place pas d'argent. Un seul 403 les dÃ©crit donc, pour ne pas se masquer.
const moneyAccess = {
  403: {
    description: 'Niveau ADMIN ou ROOT requis, et acteur humain obligatoire',
    content: makeErrorResponse('Un agent IA ne peut pas effectuer cette action'),
  },
};

const invalidTransition = {
  409: { description: "Transition d'Ã©tat refusÃ©e", content: makeErrorResponse('Transition refusÃ©e', 'INVALID_STATE_TRANSITION') },
};

// Les cinq rÃ©fÃ©rentiels du catalogue ont exactement la mÃªme surface : liste
// paginÃ©e, crÃ©ation, et dÃ©sactivation par PATCH. Seuls le schÃ©ma de ligne, le
// filtre `?active=` (absent des unitÃ©s) et le libellÃ© d'erreur changent.
function referentialPaths({ path, schema, createSchema, updateSchema, activeFilter, created, updated, notFound }) {
  return {
    [path]: {
      get: {
        tags: ['Administration'],
        summary: `Lister les ${path.split('/').pop()}`,
        security: [{ bearerAuth: [] }],
        ...(activeFilter
          ? {
              parameters: [
                makeQueryParam('active', 'Filtrer sur les lignes actives ou inactives', {
                  type: 'boolean',
                  example: 'true',
                }),
                ...paginationParams(),
              ],
            }
          : { parameters: paginationParams() }),
        responses: {
          200: { description: 'Lignes du rÃ©fÃ©rentiel, triÃ©es par identifiant', content: makePaginatedResponse(schema) },
          400: {
            description: 'Valeur de active non boolÃ©enne',
            content: makeErrorResponse("Le paramÃ¨tre active doit valoir 'true' ou 'false'"),
          },
          ...unauthenticated,
          ...insufficientLevel,
        },
      },

      post: {
        tags: ['Administration'],
        summary: `CrÃ©er une entrÃ©e de ${path.split('/').pop()}`,
        security: [{ bearerAuth: [] }],
        requestBody: makeJoiRequestBody(createSchema),
        responses: {
          201: { description: 'EntrÃ©e crÃ©Ã©e', content: makeSuccessResponse(schema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
          ...insufficientLevel,
          409: { description: created, content: makeErrorResponse(created) },
        },
      },
    },

    [`${path}/{id}`]: {
      patch: {
        tags: ['Administration'],
        summary: 'Modifier une entrÃ©e (une ligne se dÃ©sactive, elle ne se supprime pas)',
        security: [{ bearerAuth: [] }],
        description:
          'Pas de suppression : dÃ©sactiver une ligne prÃ©serve les lots, commandes et profils qui y font rÃ©fÃ©rence.',
        parameters: [makePathParam('id', 'Identifiant de l\'entrÃ©e')],
        requestBody: makeJoiRequestBody(updateSchema, { description: 'Corps partiel, au moins un champ.' }),
        responses: {
          200: { description: 'EntrÃ©e mise Ã  jour', content: makeSuccessResponse(schema) },
          400: { description: 'Corps vide ou invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
          ...insufficientLevel,
          404: { description: notFound, content: makeErrorResponse(notFound) },
          409: { description: updated, content: makeErrorResponse(updated) },
        },
      },
    },
  };
}

export const adminOpenApi = {
  openapi: '3.0.3',
  info: { title: 'Module Administration', version: '1.0.0' },
  paths: {
    // â•â• VÃ©rification des profils â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    '/api/v2/admin/verifications': {
      get: {
        tags: ['Administration'],
        summary: 'Lister les documents Ã  examiner',
        security: [{ bearerAuth: [] }],
        description:
          'Accessible Ã  un AGENT muni de la capacitÃ© USER_VERIFICATION : cette route est ' +
          'dÃ©clarÃ©e avant la porte de niveau 50 qui ferme le reste de /admin.',
        parameters: [
          makeQueryParam('status', "Filtrer sur l'Ã©tat d'examen", {
            type: 'string',
            enum: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'],
          }),
          ...paginationParams(),
        ],
        responses: {
          200: { description: 'Documents dÃ©posÃ©s', content: makePaginatedResponse(VerificationListItemSchema) },
          ...unauthenticated,
          403: { description: 'CapacitÃ© requise', content: makeErrorResponse('CapacitÃ© requise') },
        },
      },
    },

    '/api/v2/admin/verifications/{id}': {
      get: {
        tags: ['Administration'],
        summary: 'Examiner un document',
        security: [{ bearerAuth: [] }],
        description: 'Le fichier privÃ© est servi par une URL signÃ©e valable 10 minutes.',
        parameters: [makePathParam('id', 'Identifiant du document')],
        responses: {
          200: { description: 'Document et fichier associÃ©', content: makeSuccessResponse(VerificationDetailSchema) },
          400: { description: 'Identifiant non numÃ©rique', content: makeErrorResponse('Identifiant invalide') },
          ...unauthenticated,
          403: { description: 'CapacitÃ© requise', content: makeErrorResponse('CapacitÃ© requise') },
          404: { description: 'Document inexistant', content: makeErrorResponse('Document introuvable') },
        },
      },

      patch: {
        tags: ['Administration'],
        summary: 'DÃ©cider sur un document',
        security: [{ bearerAuth: [] }],
        description: 'La note est obligatoire en cas de rejet : sans elle, l\'utilisateur n\'a rien Ã  corriger.',
        parameters: [makePathParam('id', 'Identifiant du document')],
        requestBody: makeJoiRequestBody(reviewVerificationSchema),
        responses: {
          200: { description: 'DÃ©cision enregistrÃ©e', content: makeSuccessResponse(VerificationDetailSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
          403: { description: 'CapacitÃ© requise', content: makeErrorResponse('CapacitÃ© requise') },
          404: { description: 'Document inexistant', content: makeErrorResponse('Document introuvable') },
          409: { description: 'Document dÃ©jÃ  examinÃ©', content: makeErrorResponse('Ce document a dÃ©jÃ  Ã©tÃ© examinÃ©') },
        },
      },
    },

    // â•â• RÃ©glages de la plateforme â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    '/api/v2/admin/settings': {
      get: {
        tags: ['Administration'],
        summary: 'Lire les rÃ©glages de la plateforme',
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'RÃ©glages courants', content: makeSuccessResponse(PlatformSettingsSchema) },
          ...unauthenticated,
          ...insufficientLevel,
          500: {
            description: 'Aucun enregistrement de rÃ©glages en base',
            content: makeErrorResponse('ParamÃ¨tres de la plateforme manquants'),
          },
        },
      },

      patch: {
        tags: ['Administration'],
        summary: 'Modifier les rÃ©glages de la plateforme',
        security: [{ bearerAuth: [] }],
        description: 'RÃ©servÃ© Ã  ROOT. Au moins un champ, et `currency` est en lecture seule.',
        requestBody: makeJoiRequestBody(updateSettingsSchema),
        responses: {
          200: { description: 'RÃ©glages mis Ã  jour', content: makeSuccessResponse(PlatformSettingsSchema) },
          400: {
            description: 'Corps invalide, ou frais acheteur dÃ©sactivÃ©s avec une valeur non nulle',
            content: makeValidationErrorResponse(),
          },
          ...unauthenticated,
          403: {
            description: 'ROOT seul peut modifier les rÃ©glages',
            content: makeErrorResponse('Seul ROOT peut modifier les rÃ©glages de la plateforme'),
          },
        },
      },
    },

    // â•â• Comptes â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    '/api/v2/admin/users': {
      get: {
        tags: ['Administration'],
        summary: 'Lister les comptes',
        security: [{ bearerAuth: [] }],
        description: 'RÃ©ponse non paginÃ©e : la liste complÃ¨te est renvoyÃ©e.',
        parameters: [
          makeQueryParam('role', 'Filtrer par rÃ´le', {
            type: 'string',
            enum: ['ROOT', 'ADMIN', 'AGENT', 'SUPPLIER', 'BUYER', 'DRIVER'],
          }),
          makeQueryParam('search', 'Recherche sur le nom, l\'email ou le tÃ©lÃ©phone', { type: 'string' }),
          makeQueryParam('status', 'Filtrer par statut de compte', { type: 'string', enum: ['ACTIVE', 'SUSPENDED'] }),
          makeQueryParam(
            'profileVerificationStatus',
            'Filtrer par Ã©tat de vÃ©rification du profil',
            { type: 'string', enum: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'] },
          ),
        ],
        responses: {
          200: {
            description: 'Comptes, du plus rÃ©cent au plus ancien',
            content: makeSuccessResponse({ type: 'array', items: AdminUserSchema }),
          },
          ...unauthenticated,
          ...insufficientLevel,
        },
      },

      post: {
        tags: ['Administration'],
        summary: 'CrÃ©er un compte d\'Ã©quipe',
        security: [{ bearerAuth: [] }],
        description:
          'CrÃ©e un ADMIN, un AGENT ou un DRIVER. Le corps emporte `agent` ou ' +
          '`driver` selon le rÃ´le, et l\'un des deux est refusÃ© pour l\'autre. ' +
          'Seul ROOT peut crÃ©er un compte ADMIN.',
        requestBody: makeJoiRequestBody(createStaffUserSchema),
        responses: {
          201: { description: 'Compte crÃ©Ã©', content: makeSuccessResponse(AdminUserSchema) },
          400: {
            description: 'Corps invalide, capacitÃ© inconnue, ou agence de livraison inactive',
            content: makeValidationErrorResponse(),
          },
          ...unauthenticated,
          403: {
            description: 'Seul ROOT peut crÃ©er un compte administrateur',
            content: makeErrorResponse('Seul ROOT peut crÃ©er un compte administrateur'),
          },
          409: { description: 'TÃ©lÃ©phone ou email dÃ©jÃ  utilisÃ©', content: makeErrorResponse('Un compte existe dÃ©jÃ  avec ce numÃ©ro') },
        },
      },
    },

    '/api/v2/admin/users/{id}/suspend': {
      patch: {
        tags: ['Administration'],
        summary: 'Suspendre un compte',
        security: [{ bearerAuth: [] }],
        description: 'La suspension ferme toutes les sessions du compte et notifie ses appareils.',
        parameters: [makePathParam('id', 'Identifiant du compte')],
        responses: {
          200: { description: 'Compte suspendu', content: makeSuccessResponse(AdminUserSchema) },
          400: { description: 'Identifiant non numÃ©rique', content: makeErrorResponse('Identifiant invalide') },
          ...unauthenticated,
          ...insufficientLevel,
          403: {
            description: 'Compte ROOT non suspendable, ou compte administrateur suspendu par un simple ADMIN',
            content: makeErrorResponse('Seul ROOT peut suspendre un compte administrateur'),
          },
          404: { description: 'Compte inexistant', content: makeErrorResponse('Utilisateur introuvable') },
        },
      },
    },

    '/api/v2/admin/users/{id}/reactivate': {
      patch: {
        tags: ['Administration'],
        summary: 'RÃ©activer un compte',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant du compte')],
        responses: {
          200: { description: 'Compte rÃ©activÃ©', content: makeSuccessResponse(AdminUserSchema) },
          400: { description: 'Identifiant non numÃ©rique', content: makeErrorResponse('Identifiant invalide') },
          ...unauthenticated,
          ...insufficientLevel,
          403: {
            description: 'RÃ©activer un compte administrateur relÃ¨ve de ROOT',
            content: makeErrorResponse('Seul ROOT peut rÃ©activer un compte administrateur'),
          },
          404: { description: 'Compte inexistant', content: makeErrorResponse('Utilisateur introuvable') },
        },
      },
    },

    // â•â• CGU â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    '/api/v2/admin/legal/{code}/versions': {
      post: {
        tags: ['Administration'],
        summary: 'CrÃ©er une version brouillon d\'un document lÃ©gal',
        security: [{ bearerAuth: [] }],
        description: 'La traduction fr est obligatoire, en : elle sert de repli au public.',
        parameters: [makePathParam('code', 'Code du document (CGU, CGV...)', { type: 'string' })],
        requestBody: makeJoiRequestBody(createLegalVersionSchema),
        responses: {
          201: {
            description: 'Version brouillon crÃ©Ã©e',
            content: makeSuccessResponse({
              ...LegalVersionSchema,
              properties: {
                ...LegalVersionSchema.properties,
                translations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'integer', example: 8 },
                      versionId: { type: 'integer', example: 3 },
                      locale: { type: 'string', enum: ['fr', 'en'] },
                      title: { type: 'string', example: 'Conditions gÃ©nÃ©rales' },
                      content: { type: 'string' },
                    },
                  },
                },
              },
            }),
          },
          400: { description: 'Corps invalide, ou traduction fr manquante', content: makeValidationErrorResponse() },
          ...unauthenticated,
          ...insufficientLevel,
          404: { description: 'Document inexistant', content: makeErrorResponse('Document introuvable') },
          409: { description: 'Version dÃ©jÃ  existante', content: makeErrorResponse('Cette version existe dÃ©jÃ  pour ce document') },
        },
      },
    },

    '/api/v2/admin/legal/versions/{id}/publish': {
      patch: {
        tags: ['Administration'],
        summary: 'Publier une version de document lÃ©gal',
        security: [{ bearerAuth: [] }],
        description: 'La version prÃ©cÃ©dente est archivÃ©e dans la mÃªme transaction : une seule reste publiÃ©e.',
        parameters: [makePathParam('id', 'Identifiant de la version')],
        responses: {
          200: { description: 'Version publiÃ©e', content: makeSuccessResponse(LegalVersionSchema) },
          400: { description: 'Identifiant non numÃ©rique', content: makeErrorResponse('Identifiant invalide') },
          ...unauthenticated,
          ...insufficientLevel,
          404: { description: 'Version inexistante', content: makeErrorResponse('Version introuvable') },
          409: { description: 'Version dÃ©jÃ  publiÃ©e', content: makeErrorResponse('Cette version est dÃ©jÃ  publiÃ©e') },
        },
      },
    },

    // â•â• Reversements â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    '/api/v2/admin/payouts': {
      get: {
        tags: ['Administration'],
        summary: 'Lister les reversements',
        security: [{ bearerAuth: [] }],
        description: 'Vue d\'administration : le compte de paiement du fournisseur est affichÃ© en clair.',
        parameters: [
          makeQueryParam('status', 'Filtrer par statut', { type: 'string', enum: ['ON_HOLD', 'READY', 'PAID', 'CANCELLED'] }),
          ...paginationParams(),
        ],
        responses: {
          200: { description: 'Reversements filtrÃ©s', content: makePaginatedResponse(PayoutAdminListItemSchema) },
          ...unauthenticated,
          ...moneyAccess,
        },
      },
    },

    '/api/v2/admin/payouts/{id}/pay': {
      patch: {
        tags: ['Administration'],
        summary: 'Marquer un reversement comme payÃ©',
        security: [{ bearerAuth: [] }],
        description: 'Seul un reversement READY est payable. Un compte de paiement peut Ãªtre imposÃ© si celui par dÃ©faut ne convient pas.',
        parameters: [makePathParam('id', 'Identifiant du reversement')],
        requestBody: makeJoiRequestBody(payPayoutSchema),
        responses: {
          200: { description: 'Reversement payÃ©', content: makeSuccessResponse(PayoutRowSchema) },
          400: {
            description: 'Compte de reversement n\'appartenant pas au fournisseur, ou corps invalide',
            content: makeErrorResponse('Compte de reversement invalide pour ce fournisseur', 'INVALID_PAYOUT_ACCOUNT'),
          },
          ...unauthenticated,
          ...moneyAccess,
          404: { description: 'Reversement inexistant', content: makeErrorResponse('Reversement introuvable', 'PAYOUT_NOT_FOUND') },
          ...invalidTransition,
        },
      },
    },

    // â•â• Agents â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    '/api/v2/admin/agents': {
      get: {
        tags: ['Administration'],
        summary: 'Lister les fiches d\'agents',
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'Agents humains et IA', content: makeSuccessResponse({ type: 'array', items: AgentSchema }) },
          ...unauthenticated,
          ...insufficientLevel,
        },
      },
    },

    '/api/v2/admin/agents/ai': {
      post: {
        tags: ['Administration'],
        summary: 'CrÃ©er un agent IA',
        security: [{ bearerAuth: [] }],
        description:
          'Un agent IA n\'a pas de compte utilisateur : il ne se connecte pas. Il ne ' +
          'suggestion par dÃ©faut, et ne peut porter ni la capacitÃ© de paiement ni les ' +
          'actes rÃ©servÃ©s aux agents humains.',
        requestBody: makeJoiRequestBody(createAiAgentSchema),
        responses: {
          201: { description: 'Agent IA crÃ©Ã©', content: makeSuccessResponse(AgentSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
          ...insufficientLevel,
        },
      },
    },

    '/api/v2/admin/agents/{id}': {
      patch: {
        tags: ['Administration'],
        summary: 'Modifier une fiche d\'agent',
        security: [{ bearerAuth: [] }],
        description:
          '`capabilities` remplace la liste complÃ¨te des capacitÃ©s, elle ne s\'y ajoute pas. ' +
          'La capacitÃ© PAYMENT_FOLLOWUP est refusÃ©e Ã  un agent IA.',
        parameters: [makePathParam('id', 'Identifiant de l\'agent')],
        requestBody: makeJoiRequestBody(updateAgentSchema),
        responses: {
          200: { description: 'Fiche mise Ã  jour', content: makeSuccessResponse(AgentSchema) },
          400: {
            description: 'CapacitÃ© inconnue ou interdite pour un agent IA, ou corps invalide',
            content: makeValidationErrorResponse(),
          },
          ...unauthenticated,
          ...insufficientLevel,
          404: { description: 'Agent inexistant', content: makeErrorResponse('Agent introuvable') },
        },
      },
    },

    // â•â• RÃ©fÃ©rentiels du catalogue â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    ...referentialPaths({
      path: '/api/v2/admin/categories',
      schema: CategorySchema,
      createSchema: createCategorySchema,
      updateSchema: updateCategorySchema,
      activeFilter: true,
      created: 'Une catÃ©gorie existe dÃ©jÃ  avec ce code',
      notFound: 'CatÃ©gorie introuvable',
      updated: 'Une catÃ©gorie existe dÃ©jÃ  avec ce code',
    }),

    ...referentialPaths({
      path: '/api/v2/admin/units',
      schema: UnitSchema,
      createSchema: createUnitSchema,
      updateSchema: updateUnitSchema,
      activeFilter: false, // Unit n'a pas de colonne isActive.
      created: 'Une unitÃ© existe dÃ©jÃ  avec ce code',
      notFound: 'UnitÃ© introuvable',
      updated: 'Une unitÃ© existe dÃ©jÃ  avec ce code',
    }),

    ...referentialPaths({
      path: '/api/v2/admin/products',
      schema: ProductSchema,
      createSchema: createProductSchema,
      updateSchema: updateProductSchema,
      activeFilter: true,
      created: 'Un produit existe dÃ©jÃ  avec ce nom dans cette catÃ©gorie',
      notFound: 'Produit introuvable',
      updated: 'Un produit existe dÃ©jÃ  avec ce nom dans cette catÃ©gorie',
    }),

    ...referentialPaths({
      path: '/api/v2/admin/zones',
      schema: ZoneSchema,
      createSchema: createZoneSchema,
      updateSchema: updateZoneSchema,
      activeFilter: true,
      created: 'Une zone existe dÃ©jÃ  avec ce nom',
      notFound: 'Zone introuvable',
      updated: 'Une zone existe dÃ©jÃ  avec ce nom',
    }),

    ...referentialPaths({
      path: '/api/v2/admin/hubs',
      schema: HubSchema,
      createSchema: createHubSchema,
      updateSchema: updateHubSchema,
      activeFilter: true,
      created: 'Un point de dÃ©pÃ´t existe dÃ©jÃ  avec ce nom',
      notFound: 'Point de dÃ©pÃ´t introuvable',
      updated: 'Un point de dÃ©pÃ´t existe dÃ©jÃ  avec ce nom',
    }),

    // â•â• Agences de transport â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    '/api/v2/admin/agencies': {
      get: {
        tags: ['Administration'],
        summary: 'Lister les agences de transport',
        security: [{ bearerAuth: [] }],
        parameters: [
          makeQueryParam('active', 'Filtrer sur les agences actives ou inactives', { type: 'boolean' }),
          ...paginationParams(),
        ],
        responses: {
          200: { description: 'Agences', content: makePaginatedResponse(AgencySchema) },
          ...unauthenticated,
          ...insufficientLevel,
        },
      },

      post: {
        tags: ['Administration'],
        summary: 'CrÃ©er une agence de transport',
        security: [{ bearerAuth: [] }],
        requestBody: makeJoiRequestBody(createAgencySchema),
        responses: {
          201: { description: 'Agence crÃ©Ã©e', content: makeSuccessResponse(AgencySchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
          ...insufficientLevel,
          409: { description: 'Nom dÃ©jÃ  utilisÃ©', content: makeErrorResponse('Une agence existe dÃ©jÃ  avec ce nom') },
        },
      },
    },

    '/api/v2/admin/agencies/{id}': {
      patch: {
        tags: ['Administration'],
        summary: 'Modifier une agence',
        security: [{ bearerAuth: [] }],
        description: 'Pas de suppression : une agence se dÃ©sactive, pour prÃ©server ses livreurs et ses tarifs.',
        parameters: [makePathParam('id', 'Identifiant de l\'agence')],
        requestBody: makeJoiRequestBody(updateAgencySchema),
        responses: {
          200: { description: 'Agence mise Ã  jour', content: makeSuccessResponse(AgencySchema) },
          400: { description: 'Corps vide ou invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
          ...insufficientLevel,
          404: { description: 'Agence inexistante', content: makeErrorResponse('Agence introuvable') },
          409: { description: 'Nom dÃ©jÃ  utilisÃ©', content: makeErrorResponse('Une agence existe dÃ©jÃ  avec ce nom') },
        },
      },
    },

    '/api/v2/admin/agencies/{id}/zones/{zoneId}': {
      put: {
        tags: ['Administration'],
        summary: 'Couvrir une zone et fixer ses tarifs',
        security: [{ bearerAuth: [] }],
        description: 'CrÃ©e la couverture si elle n\'existe pas, la met Ã  jour sinon (201 Ã  la crÃ©ation, 200 Ã  la mise Ã  jour).',
        parameters: [
          makePathParam('id', 'Identifiant de l\'agence'),
          makePathParam('zoneId', 'Identifiant de la zone', { type: 'integer' }),
        ],
        requestBody: makeJoiRequestBody(upsertAgencyZoneSchema),
        responses: {
          200: {
            description: 'Couverture mise Ã  jour',
            content: makeSuccessResponse({
              type: 'object',
              properties: {
                agencyId: { type: 'integer', example: 2 },
                zoneId: { type: 'integer', example: 3 },
                baseFee: { type: 'number', example: 1000 },
                perKmFee: { type: 'number', example: 120 },
                isActive: { type: 'boolean', example: true },
              },
            }),
          },
          201: {
            description: 'Couverture crÃ©Ã©e',
            content: makeSuccessResponse({
              type: 'object',
              properties: {
                agencyId: { type: 'integer', example: 2 },
                zoneId: { type: 'integer', example: 3 },
                baseFee: { type: 'number', example: 1000 },
                perKmFee: { type: 'number', example: 120 },
                isActive: { type: 'boolean', example: true },
              },
            }),
          },
          400: {
            description: 'Tarif nÃ©gatif, zone introuvable, ou zoneId non numÃ©rique',
            content: makeValidationErrorResponse(),
          },
          ...unauthenticated,
          ...insufficientLevel,
          404: { description: 'Agence ou zone inexistante', content: makeErrorResponse('Agence introuvable') },
        },
      },

      delete: {
        tags: ['Administration'],
        summary: 'Retirer la couverture d\'une zone',
        security: [{ bearerAuth: [] }],
        parameters: [
          makePathParam('id', 'Identifiant de l\'agence'),
          makePathParam('zoneId', 'Identifiant de la zone', { type: 'integer' }),
        ],
        responses: {
          200: {
            description: 'Couverture retirÃ©e',
            content: makeSuccessResponse({
              type: 'object',
              properties: {
                agencyId: { type: 'integer', example: 2 },
                zoneId: { type: 'integer', example: 3 },
              },
            }),
          },
          400: { description: 'zoneId non numÃ©rique', content: makeErrorResponse('Identifiant invalide') },
          ...unauthenticated,
          ...insufficientLevel,
          404: {
            description: 'Agence inexistante, ou couverture dÃ©jÃ  retirÃ©e',
            content: makeErrorResponse('Couverture de zone introuvable'),
          },
        },
      },
    },

    '/api/v2/admin/agencies/{id}/drivers': {
      get: {
        tags: ['Administration'],
        summary: 'Lister les livreurs d\'une agence',
        security: [{ bearerAuth: [] }],
        description: 'Cette rÃ©ponse ne porte pas de pagination : elle contient `items` et `total` seulement.',
        parameters: [makePathParam('id', 'Identifiant de l\'agence')],
        responses: {
          200: {
            description: 'Livreurs rattachÃ©s',
            content: makeSuccessResponse({
              type: 'object',
              required: ['items', 'total'],
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'integer', example: 30 },
                      userId: { type: 'integer', example: 41 },
                      agencyId: { type: 'integer', example: 2 },
                      vehicleType: nullableStringSchema,
                      plateNumber: nullableStringSchema,
                      createdAt: dateTimeSchema,
                      updatedAt: dateTimeSchema,
                      user: {
                        type: 'object',
                        properties: {
                          id: { type: 'integer', example: 41 },
                          firstname: { type: 'string', example: 'Paul' },
                          lastname: { type: 'string', example: 'Mbarga' },
                          phone: { type: 'string' },
                          email: { type: 'string', format: 'email' },
                          userStatus: {
                            type: 'object',
                            properties: { code: { type: 'string', example: 'ACTIVE' } },
                          },
                        },
                      },
                    },
                  },
                },
                total: { type: 'integer', example: 3 },
              },
            }),
          },
          400: { description: 'Identifiant non numÃ©rique', content: makeErrorResponse('Identifiant invalide') },
          ...unauthenticated,
          ...insufficientLevel,
          404: { description: 'Agence inexistante', content: makeErrorResponse('Agence introuvable') },
        },
      },
    },

    // â•â• Parrainage â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    '/api/v2/admin/referrals': {
      get: {
        tags: ['Administration'],
        summary: 'Lister les parrainages',
        security: [{ bearerAuth: [] }],
        parameters: [
          makeQueryParam('status', 'Filtrer par statut', {
            type: 'string',
            enum: ['PENDING', 'ELIGIBLE', 'PAID', 'REJECTED'],
          }),
          ...paginationParams(),
        ],
        responses: {
          200: { description: 'Parrainages filtrÃ©s', content: makePaginatedResponse(ReferralListItemSchema) },
          ...unauthenticated,
          ...moneyAccess,
        },
      },
    },

    '/api/v2/admin/referrals/{id}/pay': {
      patch: {
        tags: ['Administration'],
        summary: 'Payer une rÃ©compense de parrainage',
        security: [{ bearerAuth: [] }],
        description: 'La rÃ©fÃ©rence est obligatoire : elle permet de tracer le paiement dans l\'audit.',
        parameters: [makePathParam('id', 'Identifiant du parrainage')],
        requestBody: makeJoiRequestBody(payReferralSchema),
        responses: {
          200: { description: 'Parrainage payÃ©', content: makeSuccessResponse(ReferralRowSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
          ...moneyAccess,
          404: { description: 'Parrainage inexistant', content: makeErrorResponse('Parrainage introuvable') },
          ...invalidTransition,
        },
      },
    },

    '/api/v2/admin/referrals/{id}/reject': {
      patch: {
        tags: ['Administration'],
        summary: 'Rejeter un parrainage',
        security: [{ bearerAuth: [] }],
        description: 'Le motif est obligatoire : sans lui, le parrain n\'aurait aucun moyen de corriger son dossier.',
        parameters: [makePathParam('id', 'Identifiant du parrainage')],
        requestBody: makeJoiRequestBody(rejectReferralSchema),
        responses: {
          200: { description: 'Parrainage rejetÃ©', content: makeSuccessResponse(ReferralRowSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
          ...moneyAccess,
          404: { description: 'Parrainage inexistant', content: makeErrorResponse('Parrainage introuvable') },
          ...invalidTransition,
        },
      },
    },

    // â•â• Indemnisations â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    '/api/v2/admin/compensations': {
      get: {
        tags: ['Administration'],
        summary: 'Lister les indemnisations fournisseurs',
        security: [{ bearerAuth: [] }],
        parameters: [
          makeQueryParam('status', 'Filtrer par statut', {
            type: 'string',
            enum: ['PENDING_APPROVAL', 'APPROVED', 'PAID', 'REJECTED'],
          }),
          ...paginationParams(),
        ],
        responses: {
          200: {
            description: 'Indemnisations filtrÃ©es',
            content: makePaginatedResponse(CompensationAdminListItemSchema),
          },
          ...unauthenticated,
          ...moneyAccess,
        },
      },
    },

    '/api/v2/admin/compensations/{id}/approve': {
      patch: {
        tags: ['Administration'],
        summary: 'Approuver une indemnisation',
        security: [{ bearerAuth: [] }],
        description: 'PENDING_APPROVAL â†’ APPROVED. Aucun corps attendu.',
        parameters: [makePathParam('id', 'Identifiant de l\'indemnisation')],
        responses: {
          200: { description: 'Indemnisation approuvÃ©e', content: makeSuccessResponse(CompensationRowSchema) },
          ...unauthenticated,
          ...moneyAccess,
          404: {
            description: 'Indemnisation inexistante',
            content: makeErrorResponse('Indemnisation introuvable', 'COMPENSATION_NOT_FOUND'),
          },
          ...invalidTransition,
        },
      },
    },

    '/api/v2/admin/compensations/{id}/reject': {
      patch: {
        tags: ['Administration'],
        summary: 'Rejeter une indemnisation',
        security: [{ bearerAuth: [] }],
        description: 'La justification est obligatoire : un rejet doit pouvoir Ãªtre expliquÃ© aprÃ¨s coup (audit).',
        parameters: [makePathParam('id', 'Identifiant de l\'indemnisation')],
        requestBody: makeJoiRequestBody(compensationRejectSchema),
        responses: {
          200: { description: 'Indemnisation rejetÃ©e', content: makeSuccessResponse(CompensationRowSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
          ...moneyAccess,
          404: {
            description: 'Indemnisation inexistante',
            content: makeErrorResponse('Indemnisation introuvable', 'COMPENSATION_NOT_FOUND'),
          },
          ...invalidTransition,
        },
      },
    },

    '/api/v2/admin/compensations/{id}/pay': {
      patch: {
        tags: ['Administration'],
        summary: 'Payer une indemnisation',
        security: [{ bearerAuth: [] }],
        description: 'APPROVED â†’ PAID. La rÃ©fÃ©rence est l\'identifiant du virement, tracÃ© pour rÃ©conciliation.',
        parameters: [makePathParam('id', 'Identifiant de l\'indemnisation')],
        requestBody: makeJoiRequestBody(compensationPaySchema),
        responses: {
          200: { description: 'Indemnisation payÃ©e', content: makeSuccessResponse(CompensationRowSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
          ...moneyAccess,
          404: {
            description: 'Indemnisation inexistante',
            content: makeErrorResponse('Indemnisation introuvable', 'COMPENSATION_NOT_FOUND'),
          },
          ...invalidTransition,
        },
      },
    },

    // â•â• Tableau de bord et audit â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    '/api/v2/admin/stats': {
      get: {
        tags: ['Administration'],
        summary: 'Tableau de bord',
        security: [{ bearerAuth: [] }],
        description:
          'Tous les montants sont des nombres. Une borne de date illisible est ignorÃ©e ' +
          'plutÃ´t que de faire Ã©chouer la requÃªte.',
        parameters: [
          makeQueryParam('from', 'DÃ©but de la pÃ©riode', { type: 'string', format: 'date-time' }),
          makeQueryParam('to', 'Fin de la pÃ©riode', { type: 'string', format: 'date-time' }),
        ],
        responses: {
          200: {
            description: 'Indicateurs de la plateforme',
            content: makeSuccessResponse({
              type: 'object',
              properties: {
                usersByRole: {
                  type: 'object',
                  description: 'Tous les rÃ´les semÃ©s apparaissent, Ã  0 compris',
                  additionalProperties: { type: 'integer' },
                  example: { ROOT: 1, ADMIN: 2, AGENT: 3, SUPPLIER: 12, BUYER: 48, DRIVER: 6 },
                },
                lotsByStatus: { type: 'object', additionalProperties: { type: 'integer' } },
                ordersByStatus: { type: 'object', additionalProperties: { type: 'integer' } },
                deliveriesByStatus: { type: 'object', additionalProperties: { type: 'integer' } },
                stock: {
                  type: 'object',
                  properties: {
                    available: { type: 'number', example: 12500 },
                    reserved: { type: 'number', example: 3000 },
                    sold: { type: 'number', example: 84000 },
                    lost: { type: 'number', example: 120 },
                  },
                },
                receivables: { type: 'number', example: 1250000 },
                receivablesCount: { type: 'integer', example: 18 },
                pendingPayouts: { type: 'number', example: 240000 },
                pendingCompensations: {
                  type: 'object',
                  properties: { count: { type: 'integer', example: 2 }, amount: { type: 'number', example: 84000 } },
                },
                eligibleReferrals: {
                  type: 'object',
                  properties: { count: { type: 'integer', example: 3 }, amount: { type: 'number', example: 15000 } },
                },
                grossRevenue: { type: 'number', example: 4820000 },
              },
            }),
          },
          ...unauthenticated,
          ...insufficientLevel,
        },
      },
    },

    '/api/v2/admin/audit-logs': {
      get: {
        tags: ['Administration'],
        summary: 'Consulter le journal d\'audit',
        security: [{ bearerAuth: [] }],
        description: 'Trace des actes d\'administration et des actes financiers, du plus rÃ©cent au plus ancien.',
        parameters: [
          makeQueryParam('entityType', 'Restreindre Ã  un type d\'entitÃ©', { type: 'string', example: 'PlatformSetting' }),
          makeQueryParam('entityId', 'Restreindre Ã  une entitÃ©', { type: 'integer' }),
          makeQueryParam('actorUserId', 'Restreindre Ã  un acteur humain', { type: 'integer' }),
          makeQueryParam('actorAgentId', 'Restreindre Ã  un acteur agent', { type: 'integer' }),
          makeQueryParam('from', 'DÃ©but de la pÃ©riode', { type: 'string', format: 'date-time' }),
          makeQueryParam('to', 'Fin de la pÃ©riode', { type: 'string', format: 'date-time' }),
          ...paginationParams(),
        ],
        responses: {
          200: { description: 'EntrÃ©es du journal', content: makePaginatedResponse(AuditLogSchema) },
          ...unauthenticated,
          ...insufficientLevel,
        },
      },
    },
  },
};