// Document OpenAPI final : merge des fragments du dossier + méta-données.
//
// Les fragments (auth.openapi.js, staff.openapi.js...) exportent des objets
// { paths } ; openapi-merge les assemble en un seul document en préservant les
// $ref internes (#/components/...). Les composants (schémas, réponses et
// paramètres communs, securitySchemes) sont ajoutés ICI, après le merge : c'est
// eux que les $ref des fragments désignent.
//
// Le document est importé par src/server.js, qui le sert sur
// /agriconnect-openapi via @scalar/express-api-reference.

import { merge } from 'openapi-merge';
import auth from './auth.openapi.js';
import admin from './admin.openapi.js';
import legal from './legal.openapi.js';
import supplier from './supplier.openapi.js';
import staff from './staff.openapi.js';
import catalog from './catalog.openapi.js';
import conversation from './conversation.openapi.js';
import order from './order.openapi.js';
import driver from './driver.openapi.js';

const fragments = [auth, admin, legal, supplier, staff, catalog, conversation, order, driver];

const { output } = merge(fragments.map((fragment) => ({ oas: fragment })));

const document = {
  openapi: '3.0.0',
  info: {
    title: 'AgriConnect API v2',
    version: '2.0.0',
    description:
      'API REST + WebSocket AgriConnect — consignation de lots agricoles.\n\n' +
      'Trois couches : le promoteur (SUPPLIER) déclare des **lots** (StockLot, interne), ' +
      'l\'équipe (AGENT/ADMIN) publie des **annonces** (Listing, prix public) et l\'acheteur ' +
      '(BUYER) ne voit que les annonces. Le lot relié à une annonce est figé dans ListingLot ; ' +
      'une ligne de commande (OrderItem) reprend les deux identifiants et les prix au moment de la vente.\n\n' +
      'Montants et quantités : `Decimal` Prisma, convertis en nombre JSON par ' +
      'decimal-json.middleware.js. Identifiants : entiers (`Int @id`).',
    contact: { name: 'AgriConnect' },
  },
  servers: [{ url: '/api/v2', description: 'Préfixe de l\'API (monté dans src/app.js)' }],
  tags: [
    { name: 'Auth', description: 'Authentification, sessions et récupération de compte' },
    { name: 'Utilisateur', description: 'Profil, comptes de paiement, documents et parrainage de l\'utilisateur connecté' },
    { name: 'Admin', description: 'Administration (ADMIN et ROOT, capacités agent)' },
    { name: 'CGU', description: 'Conditions d\'utilisation versionnées, publiques' },
    { name: 'Fournisseur', description: 'Lots déclarés par le promoteur connecté' },
    { name: 'Équipe', description: 'Validation des lots, annonces, commandes, paiements, livraisons, indemnisations (AGENT par capacité, ADMIN/ROOT)' },
    { name: 'Catalogue', description: 'Consultation du catalogue par l\'acheteur' },
    { name: 'Conversations', description: 'Messagerie client <-> équipe' },
    { name: 'Commandes', description: 'Cycle de vie de la commande côté acheteur' },
    { name: 'Livreur', description: 'Courses du livreur connecté' },
  ],
  paths: output.paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: "Access token JWT — en-tête Authorization: Bearer <token>",
      },
    },
    parameters: {
      IdParam: {
        in: 'path',
        name: 'id',
        required: true,
        description: 'Identifiant entier (coerceIdParam convertit la chaîne)',
        schema: { type: 'integer' },
      },
      TokenParam: {
        in: 'query',
        name: 'token',
        required: true,
        description: 'Jeton à usage unique (hex de 80 caractères)',
        schema: { type: 'string', pattern: '^[a-f0-9]{80}$' },
      },
      LegalCodeParam: {
        in: 'path',
        name: 'code',
        required: true,
        schema: { type: 'string', enum: ['CGU', 'BUYER_TERMS', 'SUPPLIER_CONSIGNMENT_TERMS'] },
      },
      PageParam: {
        in: 'query',
        name: 'page',
        schema: { type: 'integer', minimum: 1, default: 1 },
      },
      LimitParam: {
        in: 'query',
        name: 'limit',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
    responses: {
      BadRequest: {
        description: 'Corps invalide (Joi)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Unauthorized: {
        description: 'Token absent, invalide ou expiré',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Forbidden: {
        description: 'Rôle, capacité ou privilège insuffisant ; compte suspendu',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NotFound: {
        description: 'Ressource introuvable',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      PaginatedVerifications: {
        description: 'Dossiers paginés { items, page, limit, total }',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedPayouts: {
        description: 'Reversements paginés',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedCategories: {
        description: 'Catégories paginées',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedUnits: {
        description: 'Unités paginées',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedProducts: {
        description: 'Produits paginés',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedZones: {
        description: 'Zones paginées',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedHubs: {
        description: 'Points de dépôt paginés',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedAgencies: {
        description: 'Agences paginées',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedSupplierLots: {
        description: 'Lots du fournisseur paginés',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedSupplierCompensations: {
        description: 'Indemnisations du fournisseur paginées',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedStaffLots: {
        description: 'Lots (tous fournisseurs) paginés',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedStaffListings: {
        description: 'Annonces paginées',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedConversations: {
        description: 'Conversations paginées',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedOrders: {
        description: 'Commandes paginées',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedReferrals: {
        description: 'Parrainages paginés',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedCompensations: {
        description: 'Indemnisations (admin) paginées',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedDeliveries: {
        description: 'Livraisons paginées',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedCatalogListings: {
        description: 'Annonces du catalogue paginées',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
      PaginatedAuditLogs: {
        description: 'Journal d\'audit paginé',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Paginated' } } },
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Message en français' },
          code: {
            type: 'string',
            description: 'Code MAJUSCULES_AVEC_UNDERSCORES quand l\'erreur en porte un',
            example: 'INSUFFICIENT_STOCK',
          },
        },
      },
      Paginated: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'object' } },
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
        },
      },
      AuthResult: {
        type: 'object',
        properties: {
          user: { $ref: '#/components/schemas/User' },
          accessToken: { type: 'string' },
          refreshToken: { type: 'string' },
        },
      },
      Role: {
        type: 'object',
        properties: {
          code: { type: 'string', enum: ['ROOT', 'ADMIN', 'AGENT', 'SUPPLIER', 'BUYER', 'DRIVER'] },
          label: { type: 'string' },
          level: { type: 'integer', description: '10 opérationnel, 30 AGENT, 50 ADMIN, 100 ROOT' },
          isActive: { type: 'boolean' },
        },
      },
      UserStatus: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          label: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          firstname: { type: 'string' },
          lastname: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
          location: { type: 'string', nullable: true },
          emailVerified: { type: 'boolean' },
          profileVerificationStatus: {
            type: 'string',
            enum: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'],
            description: 'Distinct de emailVerified — vérification du profil par l\'équipe',
          },
          referralCode: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          role: { $ref: '#/components/schemas/Role' },
          userStatus: { $ref: '#/components/schemas/UserStatus' },
          profile: {
            description: 'SupplierProfile, BuyerProfile ou DriverProfile selon le rôle ; sinon null',
            oneOf: [
              { $ref: '#/components/schemas/SupplierProfile' },
              { $ref: '#/components/schemas/BuyerProfile' },
              { $ref: '#/components/schemas/DriverProfile' },
            ],
          },
        },
      },
      SupplierProfile: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          farmName: { type: 'string' },
          description: { type: 'string', nullable: true },
          zoneId: { type: 'integer', nullable: true },
        },
      },
      BuyerProfile: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          buyerType: { type: 'string', enum: ['RETAILER', 'FARMER', 'WHOLESALER', 'OTHER'] },
          businessName: { type: 'string', nullable: true },
          zoneId: { type: 'integer', nullable: true },
        },
      },
      DriverProfile: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          vehicleType: { type: 'string', nullable: true },
          plateNumber: { type: 'string', nullable: true },
        },
      },
      Session: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          lastActiveAt: { type: 'string', format: 'date-time' },
          closedAt: { type: 'string', format: 'date-time', nullable: true },
          isCurrent: { type: 'boolean' },
        },
      },
      PayoutAccount: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          method: { type: 'string', enum: ['MOBILE_MONEY', 'BANK_TRANSFER', 'CASH'] },
          provider: { type: 'string', nullable: true },
          accountNumberMasked: {
            type: 'string',
            description: '"••••1234" — le numéro complet n\'est jamais renvoyé par l\'API',
          },
          accountName: { type: 'string', nullable: true },
          isDefault: { type: 'boolean' },
        },
      },
      PlatformSettings: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          supplierCommissionRate: { type: 'number', description: '0 tant que ROOT ne l\'a pas fixée' },
          buyerFeeType: { type: 'string', enum: ['NONE', 'FIXED', 'PERCENT'] },
          buyerFeeValue: { type: 'number' },
          transportMarkupRate: { type: 'number' },
          referralBuyerReward: { type: 'number' },
          referralSupplierReward: { type: 'number' },
          reservationHours: { type: 'integer' },
          expiryCompensationRate: { type: 'number' },
          currency: { type: 'string', description: 'Lecture seule' },
        },
      },
      Agent: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          kind: { type: 'string', enum: ['HUMAN', 'AI'] },
          displayName: { type: 'string' },
          aiProvider: { type: 'string', nullable: true },
          aiModel: { type: 'string', nullable: true },
          aiConfig: { type: 'object', nullable: true },
          autonomy: { type: 'string', enum: ['SUGGEST_ONLY', 'ACT_WITH_APPROVAL', 'AUTONOMOUS'] },
          isActive: { type: 'boolean' },
          capabilities: { type: 'array', items: { type: 'string' } },
        },
      },
      Category: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          code: { type: 'string' },
          label: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
      LotQualityCheck: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          grade: { type: 'string', enum: ['A', 'B', 'C'] },
          notes: { type: 'string', nullable: true },
        },
      },
      VerificationDetail: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          type: { type: 'string' },
          status: { type: 'string', enum: ['PENDING', 'VERIFIED', 'REJECTED'] },
          note: { type: 'string', nullable: true },
          signedUrl: { type: 'string', description: 'URL signée Cloudinary, valable 10 minutes (staff uniquement)' },
        },
      },
      SupplierLot: {
        type: 'object',
        description: 'DTO fournisseur — jamais de donnée acheteur',
        properties: {
          id: { type: 'integer' },
          lotCode: { type: 'string', example: 'LOT-000123' },
          product: { type: 'object' },
          quantityInitial: { type: 'number' },
          quantityAvailable: { type: 'number' },
          quantityReserved: { type: 'number' },
          quantitySold: { type: 'number' },
          quantityLost: { type: 'number' },
          agreedUnitPrice: { type: 'number' },
          status: {
            type: 'string',
            enum: ['PENDING_VALIDATION', 'AVAILABLE', 'FULLY_RESERVED', 'SOLD_OUT', 'EXPIRED', 'RETURNED', 'REJECTED', 'WITHDRAWN'],
          },
          rejectionReason: { type: 'string', nullable: true },
          images: { type: 'array', items: { type: 'object' } },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          harvestedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      StaffLot: {
        type: 'object',
        description: 'DTO staff — ajoute l\'identité du fournisseur',
        properties: {
          id: { type: 'integer' },
          lotCode: { type: 'string' },
          status: {
            type: 'string',
            enum: ['PENDING_VALIDATION', 'AVAILABLE', 'FULLY_RESERVED', 'SOLD_OUT', 'EXPIRED', 'RETURNED', 'REJECTED', 'WITHDRAWN'],
          },
          supplier: { type: 'object', description: 'Identité du fournisseur' },
          qualityGrade: { type: 'string', enum: ['A', 'B', 'C'], nullable: true },
        },
      },
      StaffListing: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          reference: { type: 'string', example: 'ANN-000456' },
          title: { type: 'string' },
          description: { type: 'string', nullable: true },
          unitPrice: { type: 'number' },
          status: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'SOLD', 'INACTIVE'] },
          publishedAt: { type: 'string', format: 'date-time', nullable: true },
          product: { type: 'object' },
          media: { type: 'array', items: { type: 'object' } },
          lot: { $ref: '#/components/schemas/StaffLot' },
        },
      },
      CatalogListing: {
        type: 'object',
        description: 'DTO acheteur — prix public, jamais le lot',
        properties: {
          id: { type: 'integer' },
          reference: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string', nullable: true },
          unitPrice: { type: 'number' },
          product: { type: 'object' },
          media: { type: 'array', items: { type: 'object' } },
          zone: { type: 'object' },
        },
      },
      Conversation: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          type: { type: 'string', enum: ['BUYER', 'SUPPLIER'] },
          status: { type: 'string', enum: ['OPEN', 'ASSIGNED', 'ESCALATED', 'CLOSED'] },
          assigneeAgentId: { type: 'integer', nullable: true },
        },
      },
      Message: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          content: { type: 'string' },
          isInternal: { type: 'boolean', description: 'Visible par l\'équipe uniquement' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Order: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          reference: { type: 'string' },
          status: {
            type: 'string',
            enum: ['QUOTED', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED'],
          },
          buyer: { type: 'object' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                listingId: { type: 'integer' },
                lotId: { type: 'integer' },
                unitPrice: { type: 'number' },
                quantity: { type: 'number' },
              },
            },
          },
          deliveryMode: { type: 'string', enum: ['HUB_PICKUP', 'AGENCY_DELIVERY'] },
          totalPrice: { type: 'number' },
          deliveryFee: { type: 'number', nullable: true },
        },
      },
      Payment: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          amount: { type: 'number' },
          method: { type: 'string', enum: ['CASH', 'MOBILE_MONEY', 'BANK_TRANSFER'] },
          reference: { type: 'string', nullable: true },
          paidAt: { type: 'string', format: 'date-time' },
        },
      },
      Delivery: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          status: {
            type: 'string',
            enum: ['PENDING', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED'],
          },
          failureReason: { type: 'string', nullable: true },
          driver: { type: 'object', nullable: true },
        },
      },
    },
  },
};

export default document;
