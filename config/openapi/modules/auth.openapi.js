// config/openapi/modules/auth.openapi.js
//
// Authentification, sessions et compte de l'utilisateur connecté.
//
// Les routes /register, /login, /refresh et /forgot-password ont leur propre
// limite de débit (rateLimit.middleware.js) : le 429 est donc documenté sur
// chacune d'elles, et pas sur le reste du fragment.
//
// Volontairement absents de ce fragment : les pages HTML servies par
// /verify-email et /reset-password. Elles ne renvoient pas de JSON et ne
// s'appellent pas depuis un client d'API ; voir les contrôleurs auth.controller.js
// (verifyEmailPage, verifyEmail, resetPasswordPage, resetPassword).

import {
  makeSuccessResponse,
  makeErrorResponse,
  makeValidationErrorResponse,
  makeMultipartRequestBody,
  makeJoiRequestBody,
  makeJsonRequestBody,
  makePathParam,
  toJsonSchema,
  dateTimeSchema,
  nullableIntegerSchema,
  nullableStringSchema,
} from '../openapi.helpers.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  supplierProfileSchema,
  buyerProfileSchema,
  driverProfileSchema,
  payoutAccountCreateSchema,
  payoutAccountUpdateSchema,
} from '../../../src/validators/auth.validator.js';
import { submitDocumentSchema } from '../../../src/validators/verification.validator.js';

// ---- Schémas de réponse --------------------------------------------------

// userToApi : forme unique d'un utilisateur dans l'API. Le hash du mot de
// passe n'y figure jamais, et les coordonnées GPS sont volontairement absentes.
const UserSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 19 },
    firstname: { type: 'string', example: 'Awa' },
    lastname: { type: 'string', example: 'Ndiaye' },
    email: { type: 'string', format: 'email', example: 'awa@example.cm' },
    phone: { type: 'string', example: '+237699112233' },
    location: nullableStringSchema,
    role: {
      type: 'object',
      nullable: true,
      description: 'Référence { code, label }',
      properties: { code: { type: 'string', example: 'BUYER' }, label: { type: 'string', example: 'Acheteur' } },
    },
    userStatus: {
      type: 'object',
      nullable: true,
      properties: { code: { type: 'string', example: 'ACTIVE' }, label: { type: 'string', example: 'Actif' } },
    },
    emailVerified: { type: 'boolean', example: true },
    profileVerificationStatus: {
      type: 'string',
      enum: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'],
      description: "Examen du profil par l'équipe, distinct de la confirmation d'email",
    },
    referralCode: { type: 'string', nullable: true, example: 'ABCD2345' },
    createdAt: dateTimeSchema,
  },
};

// GET /me ajoute les médias et le profil de rôle. Les médias sortent en ligne
// brute (colonnes techniques comprises), sans passer par un DTO.
const MeSchema = {
  ...UserSchema,
  properties: {
    ...UserSchema.properties,
    media: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', example: 63 },
          ownerUserId: { type: 'integer', example: 19 },
          ownerLotId: nullableIntegerSchema,
          ownerVerificationDocumentId: nullableIntegerSchema,
          ownerListingId: nullableIntegerSchema,
          mediaTypeId: { type: 'integer', example: 1 },
          mimeTypeId: { type: 'integer', example: 1 },
          url: { type: 'string', format: 'uri' },
          publicId: nullableStringSchema,
          isPrivate: { type: 'boolean', example: false },
          fileSize: { ...nullableIntegerSchema, example: 24576 },
          width: nullableIntegerSchema,
          height: nullableIntegerSchema,
          isPrimary: { type: 'boolean', example: true },
          position: { type: 'integer', example: 0 },
          createdAt: dateTimeSchema,
        },
      },
    },
    profile: {
      type: 'object',
      nullable: true,
      description:
        'Profil du rôle. Les comptes d\'équipe (ADMIN, AGENT, ROOT) n\'en ont pas : la valeur est alors null.',
      oneOf: [
        {
          title: 'Profil fournisseur',
          properties: {
            farmName: { type: 'string', example: 'Ferme Nkol' },
            description: nullableStringSchema,
            zoneId: nullableIntegerSchema,
          },
        },
        {
          title: 'Profil acheteur',
          properties: {
            buyerType: { type: 'string', enum: ['RETAILER', 'FARMER', 'WHOLESALER', 'OTHER'] },
            businessName: nullableStringSchema,
            zoneId: nullableIntegerSchema,
          },
        },
        {
          title: 'Profil livreur',
          properties: {
            vehicleType: nullableStringSchema,
            plateNumber: nullableStringSchema,
            agencyId: { type: 'integer', example: 2 },
          },
        },
      ],
    },
  },
};

const AuthSessionSchema = {
  type: 'object',
  required: ['user', 'accessToken', 'refreshToken'],
  properties: {
    user: UserSchema,
    accessToken: {
      type: 'string',
      description: 'Jeton d\'accès JWT, à présenter dans l\'en-tête Authorization',
    },
    refreshToken: {
      type: 'string',
      description: 'Jeton de renouvellement, à présenter à POST /auth/refresh',
    },
  },
};

// payoutAccountToApi : le numéro complet ne sort JAMAIS de l'API, seul un
// masque des quatre derniers caractères est renvoyé.
const PayoutAccountSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 12 },
    method: { type: 'string', enum: ['MOBILE_MONEY', 'BANK_TRANSFER', 'CASH'] },
    provider: nullableStringSchema,
    accountName: nullableStringSchema,
    accountNumberMasked: {
      type: 'string',
      description: 'Numéro masqué : quatre derniers caractères seulement',
      example: '••••1234',
    },
    isDefault: { type: 'boolean', example: true },
    createdAt: dateTimeSchema,
  },
};

const SessionSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 40 },
    userAgent: nullableStringSchema,
    ip: nullableStringSchema,
    createdAt: dateTimeSchema,
    lastActivityAt: dateTimeSchema,
    expiresAt: dateTimeSchema,
    isCurrent: {
      type: 'boolean',
      description: 'Session portée par le jeton d\'accès utilisé pour cet appel',
    },
  },
};

const VerificationDocumentSchema = {
  type: 'object',
  description: "Document déposé pour l'examen du profil. Aucune URL n'est renvoyée : le fichier est privé.",
  properties: {
    id: { type: 'integer', example: 5 },
    type: { type: 'string', enum: ['ID_CARD', 'BUSINESS_REGISTRATION', 'FARM_PROOF', 'OTHER'] },
    status: { type: 'string', enum: ['PENDING', 'VERIFIED', 'REJECTED'] },
    note: nullableStringSchema,
    createdAt: dateTimeSchema,
  },
};

const unauthenticated = {
  401: { description: 'Non authentifié', content: makeErrorResponse('Authentification requise') },
};

const suspended = {
  403: { description: 'Compte suspendu', content: makeErrorResponse('Ce compte a été suspendu') },
};

const rateLimited = {
  429: { description: 'Trop de tentatives', content: makeErrorResponse('Trop de requêtes, réessayez plus tard') },
};

export const authOpenApi = {
  openapi: '3.0.3',
  info: { title: 'Module Authentification', version: '1.0.0' },
  paths: {
    // ══ Établissement de l'identité ══════════════════════════════════════
    '/api/v2/auth/register': {
      post: {
        tags: ['Authentification'],
        summary: 'Créer un compte fournisseur ou acheteur',
        description:
          "ADMIN, AGENT, ROOT et DRIVER ne sont jamais acceptés ici, même s'ils sont " +
          'envoyés. `acceptTerms` vaut obligatoirement true : le compte enregistre une ' +
          'acceptation par document, sans quoi il n\'y a rien à enregistrer.',
        requestBody: makeJoiRequestBody(registerSchema),
        responses: {
          201: { description: 'Compte créé et session ouverte', content: makeSuccessResponse(AuthSessionSchema) },
          400: {
            description: 'Corps invalide, ou code de parrainage inconnu',
            content: makeValidationErrorResponse(),
          },
          409: {
            description: 'Numéro de téléphone ou email déjà utilisé',
            content: makeErrorResponse('Un compte existe déjà avec cet numéro'),
          },
          ...rateLimited,
        },
      },
    },

    '/api/v2/auth/login': {
      post: {
        tags: ['Authentification'],
        summary: 'Se connecter',
        requestBody: makeJoiRequestBody(loginSchema),
        responses: {
          200: { description: 'Session ouverte', content: makeSuccessResponse(AuthSessionSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          401: { description: 'Identifiants invalides', content: makeErrorResponse('Identifiants invalides') },
          ...suspended,
          ...rateLimited,
        },
      },
    },

    '/api/v2/auth/refresh': {
      post: {
        tags: ['Authentification'],
        summary: 'Renouveler le jeton d\'accès',
        description:
          'Rotation : le jeton de renouvellement est remplacé. Une réutilisation ' +
          'd\'un ancien jeton hors délai de tolérance révoque la session.',
        requestBody: makeJoiRequestBody(refreshSchema),
        responses: {
          200: {
            description: 'Nouvelle paire de jetons',
            content: makeSuccessResponse({
              type: 'object',
              required: ['accessToken', 'refreshToken'],
              properties: {
                accessToken: { type: 'string' },
                refreshToken: { type: 'string' },
              },
            }),
          },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          401: {
            description: 'Jeton invalide, révoqué, ou utilisateur introuvable',
            content: makeErrorResponse('Refresh token invalide ou expiré'),
          },
          ...suspended,
          ...rateLimited,
        },
      },
    },

    '/api/v2/auth/logout': {
      post: {
        tags: ['Authentification'],
        summary: 'Fermer la session courante',
        description: 'Route publique et idempotente : un jeton inconnu répond quand même 204.',
        requestBody: makeJoiRequestBody(refreshSchema, {
          description: 'Le jeton de renouvellement de la session à fermer.',
        }),
        responses: {
          204: { description: 'Session fermée' },
          400: { description: 'refreshToken absent', content: makeValidationErrorResponse() },
        },
      },
    },

    '/api/v2/auth/logout-all': {
      post: {
        tags: ['Authentification'],
        summary: 'Fermer toutes les sessions',
        security: [{ bearerAuth: [] }],
        description: 'La session qui porte l\'appel est préservée : les autres appareils sont seuls déconnectés.',
        responses: {
          204: { description: 'Autres sessions fermées' },
          ...unauthenticated,
        },
      },
    },

    // ══ Récupération de compte ════════════════════════════════════════════
    '/api/v2/auth/forgot-password': {
      post: {
        tags: ['Authentification'],
        summary: 'Demander un lien de réinitialisation',
        description:
          "La réponse est identique que le compte existe ou non : elle ne doit pas " +
          "révéler quels emails sont enregistrés.",
        requestBody: makeJoiRequestBody(forgotPasswordSchema),
        responses: {
          200: {
            description: 'Demande enregistrée',
            content: makeSuccessResponse({
              type: 'object',
              required: ['message'],
              properties: {
                message: {
                  type: 'string',
                  example:
                    'Si un compte est enregistre avec cette adresse, un email vient de lui etre envoye.',
                },
              },
            }),
          },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...rateLimited,
        },
      },
    },

    '/api/v2/auth/resend-verification': {
      post: {
        tags: ['Authentification'],
        summary: 'Renvoyer l\'email de vérification',
        security: [{ bearerAuth: [] }],
        description: "Agit sur le compte connecté, et non sur une adresse fournie dans le corps.",
        responses: {
          202: {
            description: 'Email renvoyé',
            content: makeSuccessResponse({
              type: 'object',
              required: ['message'],
              properties: {
                message: {
                  type: 'string',
                  example: 'Si cette adresse est valide, un email vient de lui etre envoye.',
                },
              },
            }),
          },
          ...unauthenticated,
        },
      },
    },

    // ══ Sessions ═════════════════════════════════════════════════════════
    '/api/v2/auth/sessions': {
      get: {
        tags: ['Authentification'],
        summary: 'Lister ses sessions actives',
        security: [{ bearerAuth: [] }],
        description: 'Seules les sessions non révoquées et non expirées sont renvoyées.',
        responses: {
          200: {
            description: 'Sessions du compte connecté, la plus récemment active en tête',
            content: makeSuccessResponse({
              type: 'object',
              required: ['sessions'],
              properties: { sessions: { type: 'array', items: SessionSchema } },
            }),
          },
          ...unauthenticated,
        },
      },
    },

    '/api/v2/auth/sessions/{id}': {
      delete: {
        tags: ['Authentification'],
        summary: 'Fermer une session',
        security: [{ bearerAuth: [] }],
        description: 'Agit sur une session du compte connecté, identifiée par son propre identifiant — jamais par le refresh token, qui ne dit rien de l\'appareil.',
        parameters: [makePathParam('id', 'Identifiant de la session')],
        responses: {
          204: { description: 'Session fermée' },
          400: { description: 'Identifiant non numérique', content: makeErrorResponse('Identifiant invalide') },
          ...unauthenticated,
          404: { description: 'Session inexistante ou déjà révoquée', content: makeErrorResponse('Session introuvable') },
        },
      },
    },

    // ══ Profil ═══════════════════════════════════════════════════════════
    '/api/v2/auth/me': {
      get: {
        tags: ['Utilisateur'],
        summary: 'Consulter son profil',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Profil du compte connecté, médias et profil de rôle inclus',
            content: makeSuccessResponse(MeSchema),
          },
          ...unauthenticated,
        },
      },

      patch: {
        tags: ['Utilisateur'],
        summary: 'Modifier son identité',
        security: [{ bearerAuth: [] }],
        description:
          "Changer d'email remet sa vérification à zéro. Les deux moitiés du nom " +
          'sont indépendantes : ne renvoyer que l\'une des deux n\'efface pas l\'autre. ' +
          "Le corps n'est pas validé par Joi sur cette route (auth.routes.js), et le " +
          'numéro de téléphone ne se modifie pas ici.',
        requestBody: makeJsonRequestBody(
          {
            type: 'object',
            properties: {
              firstname: { type: 'string', example: 'Awa' },
              lastname: { type: 'string', example: 'Ndiaye' },
              email: { type: 'string', format: 'email', example: 'awa@example.cm' },
              location: nullableStringSchema,
            },
          },
          { required: false, description: 'Tous les champs sont facultatifs.' },
        ),
        responses: {
          200: {
            description: 'Profil mis à jour (sans les médias ni le profil de rôle)',
            content: makeSuccessResponse(UserSchema),
          },
          401: { description: 'Non authentifié ou token invalide', content: makeErrorResponse('Authentification requise') },
          409: {
            description: 'Email déjà utilisé',
            content: makeErrorResponse('Un compte existe déjà avec cet email'),
          },
        },
      },
    },

    '/api/v2/auth/me/avatar': {
      post: {
        tags: ['Utilisateur'],
        summary: 'Changer son avatar',
        security: [{ bearerAuth: [] }],
        requestBody: makeMultipartRequestBody({
          description: 'Un seul fichier, dans le champ `avatar`.',
          files: { avatar: { description: 'Image jpg, png ou webp' } },
        }),
        responses: {
          201: {
            description: 'Avatar enregistré',
            content: makeSuccessResponse({
              type: 'object',
              properties: {
                id: { type: 'integer', example: 64 },
                url: { type: 'string', format: 'uri' },
                isPrimary: { type: 'boolean', example: true },
                position: { type: 'integer', example: 0 },
              },
            }),
          },
          400: {
            description: 'Aucun fichier fourni, ou format d\'image non supporté',
            content: makeErrorResponse('Aucune image fournie (champ "avatar")'),
          },
          ...unauthenticated,
        },
      },
    },

    '/api/v2/auth/me/profile': {
      patch: {
        tags: ['Utilisateur'],
        summary: 'Modifier le profil de son rôle',
        security: [{ bearerAuth: [] }],
        description:
          'Le schéma dépend du rôle, et un rôle ne connaît pas les champs d\'un autre : ' +
          'un champ hors profil est refusé, jamais ignoré. Réservé à SUPPLIER, BUYER et ' +
          'DRIVER — un compte d\'équipe n\'a pas de profil.',
        requestBody: makeJsonRequestBody(
          {
            oneOf: [
              toJsonSchema(supplierProfileSchema),
              toJsonSchema(buyerProfileSchema),
              toJsonSchema(driverProfileSchema),
            ],
            description:
              'Formulaire du rôle connecté : ferme (SUPPLIER), acheteur (BUYER) ou véhicule (DRIVER).',
          },
          { description: 'Le schéma appliqué dépend du rôle porté par le jeton d\'accès.' },
        ),
        responses: {
          200: {
            description: 'Profil de rôle mis à jour',
            content: makeSuccessResponse({
              type: 'object',
              properties: {
                farmName: { type: 'string', example: 'Ferme Nkol' },
                buyerType: { type: 'string', enum: ['RETAILER', 'FARMER', 'WHOLESALER', 'OTHER'] },
                businessName: nullableStringSchema,
                description: nullableStringSchema,
                vehicleType: nullableStringSchema,
                plateNumber: nullableStringSchema,
                zoneId: nullableIntegerSchema,
              },
              description: 'La forme renvoyée ne contient que les champs du rôle du compte connecté.',
            }),
          },
          400: {
            description: 'Corps invalide, ou zone introuvable',
            content: makeValidationErrorResponse(),
          },
          ...unauthenticated,
          403: {
            description: "Rôle sans profil, ou livreur sans agence",
            content: makeErrorResponse("Les comptes d'équipe n'ont pas de profil"),
          },
        },
      },
    },

    // ══ Comptes de paiement ═══════════════════════════════════════════════
    '/api/v2/auth/me/payout-accounts': {
      get: {
        tags: ['Utilisateur'],
        summary: 'Lister ses comptes de paiement',
        security: [{ bearerAuth: [] }],
        description: 'Réservé à SUPPLIER et BUYER, seuls rôles qui reçoivent de l\'argent de la plateforme.',
        responses: {
          200: {
            description: 'Comptes de paiement, numéros masqués',
            content: makeSuccessResponse({ type: 'array', items: PayoutAccountSchema }),
          },
          ...unauthenticated,
          403: { description: 'Rôle non autorisé', content: makeErrorResponse('Accès refusé pour ce rôle') },
        },
      },

      post: {
        tags: ['Utilisateur'],
        summary: 'Ajouter un compte de paiement',
        security: [{ bearerAuth: [] }],
        description: 'Réservé à SUPPLIER et BUYER.',
        requestBody: makeJoiRequestBody(payoutAccountCreateSchema),
        responses: {
          201: { description: 'Compte créé', content: makeSuccessResponse(PayoutAccountSchema) },
          400: { description: 'Corps invalide', content: makeValidationErrorResponse() },
          ...unauthenticated,
          403: { description: 'Rôle non autorisé', content: makeErrorResponse('Accès refusé pour ce rôle') },
        },
      },
    },

    '/api/v2/auth/me/payout-accounts/{id}': {
      patch: {
        tags: ['Utilisateur'],
        summary: 'Modifier un compte de paiement',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant du compte de paiement')],
        requestBody: makeJoiRequestBody(payoutAccountUpdateSchema, {
          description: 'Formulaire partiel : un PATCH ne renvoie que ce qui change.',
        }),
        responses: {
          200: { description: 'Compte mis à jour', content: makeSuccessResponse(PayoutAccountSchema) },
          400: { description: 'Corps invalide ou identifiant non numérique', content: makeValidationErrorResponse() },
          ...unauthenticated,
          403: { description: 'Rôle non autorisé', content: makeErrorResponse('Accès refusé pour ce rôle') },
          404: { description: 'Compte inexistant', content: makeErrorResponse('Compte introuvable') },
        },
      },

      delete: {
        tags: ['Utilisateur'],
        summary: 'Supprimer un compte de paiement',
        security: [{ bearerAuth: [] }],
        parameters: [makePathParam('id', 'Identifiant du compte de paiement')],
        responses: {
          204: { description: 'Compte supprimé' },
          400: { description: 'Identifiant non numérique', content: makeErrorResponse('Identifiant invalide') },
          ...unauthenticated,
          403: { description: 'Rôle non autorisé', content: makeErrorResponse('Accès refusé pour ce rôle') },
          404: { description: 'Compte inexistant', content: makeErrorResponse('Compte introuvable') },
        },
      },
    },

    // ══ Documents de vérification ═════════════════════════════════════════
    '/api/v2/auth/me/documents': {
      post: {
        tags: ['Utilisateur'],
        summary: 'Déposer un document de vérification',
        security: [{ bearerAuth: [] }],
        description:
          'Multipart : le fichier est dans le champ `file`, son type dans le champ ' +
          'texte `type`. Le fichier est privé : aucune URL n\'est renvoyée. Réservé à ' +
          'SUPPLIER et BUYER.',
        requestBody: makeMultipartRequestBody({
          fields: toJsonSchema(submitDocumentSchema).properties,
          files: { file: { description: 'Pièce justificative (jpg, png, webp, pdf)' } },
        }),
        responses: {
          201: { description: 'Document déposé', content: makeSuccessResponse(VerificationDocumentSchema) },
          400: {
            description: 'Aucun fichier, format non supporté, ou type de fichier inconnu',
            content: makeErrorResponse('Format de fichier non supporté (jpg, png, webp, pdf)'),
          },
          ...unauthenticated,
          403: { description: 'Rôle non autorisé', content: makeErrorResponse('Accès refusé pour ce rôle') },
        },
      },

      get: {
        tags: ['Utilisateur'],
        summary: 'Lister ses documents de vérification',
        security: [{ bearerAuth: [] }],
        description: 'Réservé à SUPPLIER et BUYER.',
        responses: {
          200: {
            description: 'Documents déposés par le compte connecté',
            content: makeSuccessResponse({ type: 'array', items: VerificationDocumentSchema }),
          },
          ...unauthenticated,
          403: { description: 'Rôle non autorisé', content: makeErrorResponse('Accès refusé pour ce rôle') },
        },
      },
    },

    // ══ Parrainage ═══════════════════════════════════════════════════════
    '/api/v2/auth/me/referral': {
      get: {
        tags: ['Utilisateur'],
        summary: 'Consulter son parrainage',
        security: [{ bearerAuth: [] }],
        description: 'Le parrain ne voit que le prénom de ses filleuls, jamais leur compte.',
        responses: {
          200: {
            description: 'Code de parrainage, totaux et liste des filleuls',
            content: makeSuccessResponse({
              type: 'object',
              required: ['code', 'totals', 'referrals'],
              properties: {
                code: { type: 'string', example: 'ABCD2345' },
                totals: {
                  type: 'object',
                  properties: {
                    pending: { type: 'integer', example: 0 },
                    eligible: { type: 'integer', example: 1 },
                    paid: { type: 'integer', example: 0 },
                  },
                },
                referrals: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['PENDING', 'ELIGIBLE', 'PAID', 'REJECTED'] },
                      kind: { type: 'string', enum: ['BUYER', 'SUPPLIER'] },
                      rewardAmount: { type: 'number', nullable: true, example: 5000 },
                      createdAt: dateTimeSchema,
                      referredFirstname: { type: 'string', example: 'Awa' },
                    },
                  },
                },
              },
            }),
          },
          ...unauthenticated,
        },
      },
    },
  },
};