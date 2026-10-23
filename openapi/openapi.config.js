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
import reference from './reference.openapi.js';

const fragments = [auth, admin, legal, supplier, staff, catalog, conversation, order, driver, reference];

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
    { name: 'Staff — Vérification de profil', description: 'File de revue des documents d\'identité déposés par les comptes SUPPLIER et BUYER, et lecture des pièces privées. Réservée aux ADMIN et ROOT, et aux AGENT porteurs de la capacité USER_VERIFICATION.\n\nFlux : l\'utilisateur dépose un ou plusieurs documents (`POST /auth/me/documents`, un fichier par requête dans le champ `file`) ; chaque dépôt passe le compte en PENDING. Le staff filtre la file (`GET /admin/verifications`, tri FIFO sur PENDING), ouvre un dossier (`GET /admin/verifications/{id}`) qui lui renvoie un lien signé de 10 minutes — chaque émission est journalisée dans l\'audit `PROFILE_DOCUMENT_VIEWED` — puis tranche (`PATCH /admin/verifications/{id}`).\n\nRègle de calcul du statut du compte : APPROVE met le document VERIFIED et le compte VERIFIED s\'il possède au moins un document VERIFIED et aucun PENDING ; REJECT met le document REJECTED et ne rejette le compte (REJECTED) que s\'il n\'a aucun document VERIFIED. La décision est atomique : deux relecteurs simultanés obtiennent un 200 et un 409. Une fois VERIFIED, le compte peut déclarer un lot ou confirmer un devis (sinon 403 PROFILE_NOT_VERIFIED).' },
    { name: 'Admin', description: 'Administration (ADMIN et ROOT, capacités agent)' },
    { name: 'CGU', description: 'Conditions d\'utilisation versionnées, publiques' },
    { name: 'Fournisseur', description: 'Lots déclarés par le promoteur connecté' },
    { name: 'Équipe', description: 'Validation des lots, annonces, commandes, paiements, livraisons, indemnisations (AGENT par capacité, ADMIN/ROOT)' },
    { name: 'Catalogue', description: 'Consultation du catalogue par l\'acheteur' },
    { name: 'Conversations', description: 'Messagerie client <-> équipe' },
    { name: 'Commandes', description: 'Cycle de vie de la commande côté acheteur' },
    { name: 'Livreur', description: 'Courses du livreur connecté' },
    { name: 'Référentiels', description: 'Listes paginées des données de référence actives accessibles aux comptes connectés' },
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
      // 403 des routes réservées aux profils vérifiés (D2). Le corps porte le
      // code PROFILE_NOT_VERIFIED et le statut courant, que le client affiche
      // pour orienter vers le dépôt de documents. Le 403 de rôle reste possible
      // sur ces mêmes routes : la description couvre les deux causes.
      ForbiddenProfileNotVerified: {
        description: 'Rôle insuffisant, ou profil non vérifié (PROFILE_NOT_VERIFIED)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ProfileNotVerifiedError' } } },
      },
      NotFound: {
        description: 'Ressource introuvable',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      // 400 commun aux routes d'upload. Toutes les routes multipart partagent
      // le même wrapper (src/middlewares/uploadHandler.middleware.js) : une
      // erreur de champ, de format ou de contenu y porte le même statut, et
      // le corps nomme le champ attendu (voir UploadError).
      UploadBadRequest: {
        description:
          'Requête d\'upload refusée : UNEXPECTED_FILE_FIELD (mauvais nom de champ ou trop de fichiers — expectedField renseigne le champ attendu), INVALID_MULTIPART (requête mal formée), UNSUPPORTED_MEDIA_TYPE (format refusé), FILE_REQUIRED (aucun fichier) ou FILE_CONTENT_MISMATCH (les octets ne correspondent pas au format annoncé).',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/UploadError' } } },
      },
      FileTooLarge: {
        description: 'FILE_TOO_LARGE — fichier au-delà de la taille maximale du champ attendu',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/UploadError' } } },
      },
      TooManyPendingDocuments: {
        description: 'TOO_MANY_PENDING_DOCUMENTS — 5 documents au statut PENDING pour ce compte',
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
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                items: { type: 'array', items: { $ref: '#/components/schemas/StaffConversation' } },
                page: { type: 'integer' },
                limit: { type: 'integer' },
                total: { type: 'integer' },
              },
            },
          },
        },
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
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                items: { type: 'array', items: { $ref: '#/components/schemas/Compensation' } },
                page: { type: 'integer' },
                limit: { type: 'integer' },
                total: { type: 'integer' },
              },
            },
          },
        },
      },
      PaginatedDeliveries: {
        description: 'Livraisons paginées',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                items: { type: 'array', items: { $ref: '#/components/schemas/Delivery' } },
                page: { type: 'integer' },
                limit: { type: 'integer' },
                total: { type: 'integer' },
              },
            },
          },
        },
      },
      PaginatedCatalogListings: {
        description: 'Annonces du catalogue paginées',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                items: { type: 'array', items: { $ref: '#/components/schemas/CatalogListing' } },
                page: { type: 'integer' },
                limit: { type: 'integer' },
                total: { type: 'integer' },
              },
            },
          },
        },
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
            description:
              'Code stable. Authentification/autorisation: TOKEN_MISSING, TOKEN_INVALID, ACCOUNT_SUSPENDED, ROLE_FORBIDDEN, LEVEL_FORBIDDEN, CAPABILITY_REQUIRED, HUMAN_ACTOR_REQUIRED. Limitation: RATE_LIMITED.',
            example: 'TOKEN_INVALID',
          },
          details: {
            type: 'array',
            description: 'Détails de validation Joi (présent sur les erreurs 400)',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      // Erreur du middleware requireVerifiedProfile : en plus du message et du
      // code, elle renvoie le statut du profil pour que le client sache s'il
      // doit attendre (PENDING) ou redéposer (REJECTED).
      ProfileNotVerifiedError: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Message en français' },
          code: { type: 'string', example: 'PROFILE_NOT_VERIFIED' },
          profileVerificationStatus: {
            type: 'string',
            enum: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'],
          },
        },
      },
      // Erreur d'upload : Error + le champ fichier attendu, que le client peut
      // corriger sans analyser le message en français.
      UploadError: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Message en français nommant le champ attendu' },
          code: {
            type: 'string',
            enum: [
              'UNEXPECTED_FILE_FIELD',
              'INVALID_MULTIPART',
              'UNSUPPORTED_MEDIA_TYPE',
              'FILE_REQUIRED',
              'FILE_CONTENT_MISMATCH',
              'FILE_TOO_LARGE',
            ],
            example: 'UNEXPECTED_FILE_FIELD',
          },
          expectedField: {
            type: 'string',
            description: 'Champ multipart attendu (avatar, file ou images) — renvoyé avec UNEXPECTED_FILE_FIELD',
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
        },
      },
      UserStatus: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          label: { type: 'string' },
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
          media: { type: 'array', items: { $ref: '#/components/schemas/Media' } },
          agent: { $ref: '#/components/schemas/ClientAgent' },
          profile: {
            description: 'SupplierProfile, BuyerProfile ou DriverProfile selon le rôle ; sinon null',
            nullable: true,
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
          farmName: { type: 'string' },
          description: { type: 'string', nullable: true },
          zoneId: { type: 'integer', nullable: true },
        },
      },
      BuyerProfile: {
        type: 'object',
        properties: {
          buyerType: { type: 'string', enum: ['RETAILER', 'FARMER', 'WHOLESALER', 'OTHER'] },
          businessName: { type: 'string', nullable: true },
          zoneId: { type: 'integer', nullable: true },
        },
      },
      DriverProfile: {
        type: 'object',
        properties: {
          vehicleType: { type: 'string', nullable: true },
          plateNumber: { type: 'string', nullable: true },
          agencyId: { type: 'integer' },
        },
      },
      Session: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          userAgent: { type: 'string', nullable: true },
          ip: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          lastActivityAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' },
          isCurrent: { type: 'boolean' },
        },
      },
      Media: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          url: { type: 'string' },
          isPrimary: { type: 'boolean' },
          position: { type: 'integer' },
        },
      },
      ClientAgent: {
        type: 'object',
        nullable: true,
        properties: {
          id: { type: 'integer' },
          displayName: { type: 'string' },
          kind: { type: 'string', enum: ['HUMAN', 'AI'] },
          autonomy: { type: 'string', enum: ['SUGGEST_ONLY', 'ACT_WITH_APPROVAL', 'AUTONOMOUS'], nullable: true },
          capabilities: { type: 'array', items: { type: 'string' } },
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
          capabilities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                capability: {
                  type: 'object',
                  properties: { code: { type: 'string' }, label: { type: 'string' } },
                },
              },
            },
          },
          user: {
            type: 'object',
            nullable: true,
            properties: {
              id: { type: 'integer' },
              firstname: { type: 'string' },
              lastname: { type: 'string' },
              email: { type: 'string' },
            },
            AdminUser: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                firstname: { type: 'string' },
                lastname: { type: 'string' },
                phone: { type: 'string' },
                email: { type: 'string' },
                role: {
                  type: 'object',
                  properties: {
                    code: { type: 'string', enum: ['ROOT', 'ADMIN', 'AGENT', 'SUPPLIER', 'BUYER', 'DRIVER'] },
                    label: { type: 'string' },
                    level: { type: 'integer' },
                  },
                },
                userStatus: {
                  type: 'object',
                  properties: { code: { type: 'string' }, label: { type: 'string' } },
                },
                location: { type: 'string', nullable: true },
                profileVerificationStatus: {
                  type: 'string',
                  enum: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'],
                },
                createdAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      Category: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          code: { type: 'string' },
          label: { type: 'string' },
        },
      },
      ReferenceCategory: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          code: { type: 'string' },
          label: { type: 'string' },
        },
      },
      ReferenceUnit: {
        type: 'object',
        description: 'Unit n’a pas de colonne isActive dans le schéma Prisma.',
        properties: {
          id: { type: 'integer' },
          code: { type: 'string' },
          label: { type: 'string' },
        },
      },
      ReferenceProduct: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          isPerishable: { type: 'boolean' },
          imageUrl: { type: 'string', nullable: true },
          category: { $ref: '#/components/schemas/ReferenceCategory' },
          unit: { $ref: '#/components/schemas/ReferenceUnit' },
        },
      },
      ReferenceZone: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          city: { type: 'string', nullable: true },
          region: { type: 'string', nullable: true },
        },
      },
      ReferenceHub: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          address: { type: 'string' },
          city: { type: 'string', nullable: true },
          latitude: { type: 'number' },
          longitude: { type: 'number' },
          zoneId: { type: 'integer' },
          acceptsDropoff: { type: 'boolean' },
          acceptsPickup: { type: 'boolean' },
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
          signedUrl: {
            type: 'string',
            nullable: true,
            description:
              'Lien signé vers le fichier privé (GET /admin/files/{token}), valable 10 minutes, lié au compte du staff qui l\'a demandé. Son émission est journalisée dans l\'audit.',
          },
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
          category: {
            type: 'object',
            properties: { code: { type: 'string' }, label: { type: 'string' } },
          },
          unit: {
            type: 'object',
            properties: { code: { type: 'string' }, label: { type: 'string' } },
          },
          unitPrice: { type: 'number' },
          quantityAvailable: { type: 'number' },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          zone: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              name: { type: 'string' },
              city: { type: 'string', nullable: true },
            },
          },
          images: { type: 'array', items: { type: 'string' } },
          qualityGrade: { type: 'string', enum: ['A', 'B', 'C'], nullable: true },
        },
      },
      Conversation: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          type: { type: 'string', enum: ['BUYER_SUPPORT', 'SUPPLIER_SUPPORT'] },
          status: { type: 'string', enum: ['OPEN', 'WAITING_CUSTOMER', 'CLOSED'] },
          subject: { type: 'string', nullable: true },
          listingId: { type: 'integer', nullable: true },
          escalatedAt: { type: 'string', format: 'date-time', nullable: true },
          escalationReason: { type: 'string', nullable: true },
          lastMessageAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      StaffConversation: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          type: { type: 'string', enum: ['BUYER_SUPPORT', 'SUPPLIER_SUPPORT'] },
          status: { type: 'string', enum: ['OPEN', 'WAITING_CUSTOMER', 'CLOSED'] },
          subject: { type: 'string', nullable: true },
          listingId: { type: 'integer', nullable: true },
          lotId: { type: 'integer', nullable: true },
          customer: {
            type: 'object',
            nullable: true,
            properties: {
              id: { type: 'integer' },
              firstname: { type: 'string' },
              lastname: { type: 'string' },
            },
          },
          assignedAgentId: { type: 'integer', nullable: true },
          assignedAgent: {
            type: 'object',
            nullable: true,
            properties: { id: { type: 'integer' }, displayName: { type: 'string' } },
          },
          escalatedAt: { type: 'string', format: 'date-time', nullable: true },
          escalationReason: { type: 'string', nullable: true },
          lastMessageAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Message: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          content: { type: 'string' },
          senderLabel: { type: 'string', enum: ['Vous', 'Équipe AgriConnect'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      StaffMessage: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          conversationId: { type: 'integer' },
          senderType: { type: 'string', enum: ['CUSTOMER', 'AGENT', 'SYSTEM'] },
          senderUserId: { type: 'integer', nullable: true },
          senderAgentId: { type: 'integer', nullable: true },
          content: { type: 'string' },
          isInternal: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      StockMovement: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          lotId: { type: 'integer' },
          type: { type: 'string' },
          quantityDelta: { type: 'number' },
          orderItemId: { type: 'integer', nullable: true },
          note: { type: 'string', nullable: true },
          actorUserId: { type: 'integer', nullable: true },
          actorAgentId: { type: 'integer', nullable: true },
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
          orderId: { type: 'integer' },
          agencyId: { type: 'integer' },
          agencyName: { type: 'string', nullable: true },
          status: {
            type: 'string',
            enum: ['PENDING', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED'],
          },
          pickupHubId: { type: 'integer', nullable: true },
          pickupAddress: { type: 'string', nullable: true },
          pickupLatitude: { type: 'number', nullable: true },
          pickupLongitude: { type: 'number', nullable: true },
          dropoffAddress: { type: 'string' },
          dropoffLatitude: { type: 'number', nullable: true },
          dropoffLongitude: { type: 'number', nullable: true },
          distanceKm: { type: 'number', nullable: true },
          agencyCost: { type: 'number' },
          deliveryFee: { type: 'number' },
          insuredValue: { type: 'number' },
          insurancePolicyNumber: { type: 'string', nullable: true },
          acceptedAt: { type: 'string', format: 'date-time', nullable: true },
          pickedUpAt: { type: 'string', format: 'date-time', nullable: true },
          deliveredAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      DriverDelivery: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          status: { type: 'string', enum: ['PENDING', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED'] },
          pickupAddress: { type: 'string', nullable: true },
          pickupLatitude: { type: 'number', nullable: true },
          pickupLongitude: { type: 'number', nullable: true },
          dropoffAddress: { type: 'string' },
          dropoffLatitude: { type: 'number', nullable: true },
          dropoffLongitude: { type: 'number', nullable: true },
          distanceKm: { type: 'number', nullable: true },
          buyer: {
            type: 'object',
            nullable: true,
            properties: {
              firstname: { type: 'string' },
              lastname: { type: 'string' },
              phone: { type: 'string' },
            },
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                productName: { type: 'string', nullable: true },
                categoryName: { type: 'string', nullable: true },
                quantity: { type: 'number' },
              },
            },
          },
          acceptedAt: { type: 'string', format: 'date-time', nullable: true },
          pickedUpAt: { type: 'string', format: 'date-time', nullable: true },
          deliveredAt: { type: 'string', format: 'date-time', nullable: true },
          failureReason: { type: 'string', nullable: true },
        },
      },
      Compensation: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          supplierId: { type: 'integer' },
          lotId: { type: 'integer' },
          deliveryId: { type: 'integer', nullable: true },
          reason: { type: 'string' },
          quantity: { type: 'number' },
          unitPrice: { type: 'number' },
          rate: { type: 'number' },
          amount: { type: 'number' },
          status: { type: 'string', enum: ['PENDING_APPROVAL', 'APPROVED', 'PAID', 'REJECTED'] },
          note: { type: 'string', nullable: true },
          reference: { type: 'string', nullable: true },
          approvedById: { type: 'integer', nullable: true },
          approvedAt: { type: 'string', format: 'date-time', nullable: true },
          paidById: { type: 'integer', nullable: true },
          paidAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          supplier: { type: 'object', nullable: true },
        },
      },
    },
  },
};

export default document;
