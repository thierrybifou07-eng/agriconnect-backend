// Fragment OpenAPI : /api/v2/auth — authentification, sessions, profil,
// comptes de paiement, documents, parrainage.
//
// Les schémas de corps sont convertis depuis les vrais validateurs Joi
// (src/validators/*) via openapi.helpers.js. Les réponses communes
// (400/401/403/404) sont des $ref vers #/components/responses/* — définies dans
// openapi.config.js, après le merge.

import {
  registerSchema,
  loginSchema,
  refreshSchema,
  oneTimeTokenSchema,
  resetPasswordSchema,
  forgotPasswordSchema,
  supplierProfileSchema,
  buyerProfileSchema,
  driverProfileSchema,
  payoutAccountCreateSchema,
  payoutAccountUpdateSchema,
} from '../src/validators/auth.validator.js';
import { documentTypeField } from '../src/validators/verification.validator.js';
import { jsonBody, jsonSchema, multipartBody } from './openapi.helpers.js';

const R = (ref) => ({ $ref: `#/components/responses/${ref}` });

export default {
  openapi: '3.0.0',
  paths: {
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Inscription publique (SUPPLIER ou BUYER)',
        description:
          'Crée le compte, son profil, l\'acceptation des CGU requises pour le rôle et éventuellement le parrainage. Ouvre une session (access + refresh token). ADMIN, AGENT, DRIVER et ROOT ne sont jamais acceptés ici.',
        security: [],
        requestBody: jsonBody(registerSchema),
        responses: {
          '201': {
            description: 'Utilisateur créé, session ouverte',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AuthResult' } },
            },
          },
          '400': R('BadRequest'),
          '409': {
            description: 'Email ou téléphone déjà utilisé',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },

    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Connexion (email + mot de passe)',
        security: [],
        requestBody: jsonBody(loginSchema),
        responses: {
          '200': {
            description: 'Session ouverte (plafond 5 sessions par compte)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AuthResult' } },
            },
          },
          '400': R('BadRequest'),
          '401': { description: 'Identifiants invalides', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '403': { description: 'Compte suspendu', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotation du refresh token',
        description: 'Remplace le jeton reçu ; un jeton déjà remplacé est un vol (sauf grâce de 30 s).',
        security: [],
        requestBody: jsonBody(refreshSchema),
        responses: {
          '200': {
            description: 'Nouveau accessToken + nouveau refreshToken',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AuthResult' } },
            },
          },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
        },
      },
    },

    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Ferme la session de l\'appareil (par refresh token)',
        security: [],
        requestBody: jsonBody(refreshSchema),
        responses: {
          '200': {
            description: 'Session fermée',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { message: { type: 'string', example: 'Session fermée' } } },
              },
            },
          },
          '400': R('BadRequest'),
        },
      },
    },

    '/auth/forgot-password': {
      post: {
        tags: ['Auth'],
        summary: 'Demande de réinitialisation de mot de passe',
        description: 'Réponse identique que l\'adresse existe ou non (anti-énumération).',
        security: [],
        requestBody: jsonBody(forgotPasswordSchema),
        responses: {
          '200': {
            description: 'Réponse identique dans tous les cas',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { message: { type: 'string', example: 'Si cette adresse est enregistrée, un lien de réinitialisation a été envoyé' } },
                },
              },
            },
          },
          '400': R('BadRequest'),
        },
      },
    },

    '/auth/reset-password': {
      get: {
        tags: ['Auth'],
        summary: 'Affiche le formulaire de réinitialisation',
        description: 'Page HTML servie par l\'API ; le GET ne consomme pas le jeton.',
        security: [],
        parameters: [{ $ref: '#/components/parameters/TokenParam' }],
        responses: {
          '200': { description: 'Page HTML du formulaire', content: { 'text/html': { schema: { type: 'string' } } } },
          '400': R('BadRequest'),
        },
      },
      post: {
        tags: ['Auth'],
        summary: 'Applique le nouveau mot de passe',
        description: 'Détruit toutes les sessions du compte.',
        security: [],
        requestBody: jsonBody(resetPasswordSchema),
        responses: {
          '200': {
            description: 'Mot de passe modifié',
            content: {
              'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } } } },
            },
          },
          '400': R('BadRequest'),
          '404': { description: 'Jeton invalide ou expiré', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/auth/verify-email': {
      get: {
        tags: ['Auth'],
        summary: 'Affiche la page de vérification d\'adresse',
        security: [],
        parameters: [{ $ref: '#/components/parameters/TokenParam' }],
        responses: {
          '200': { description: 'Page HTML', content: { 'text/html': { schema: { type: 'string' } } } },
          '400': R('BadRequest'),
        },
      },
      post: {
        tags: ['Auth'],
        summary: 'Vérifie l\'adresse (consomme le jeton)',
        security: [],
        requestBody: jsonBody(oneTimeTokenSchema),
        responses: {
          '200': {
            description: 'Adresse vérifiée',
            content: {
              'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } } } },
            },
          },
          '400': R('BadRequest'),
          '404': { description: 'Jeton invalide ou expiré', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/auth/resend-verification': {
      post: {
        tags: ['Auth'],
        summary: 'Renvoie le lien de vérification (cooldown 5 min)',
        responses: {
          '200': { description: 'Lien renvoyé si l\'adresse n\'est pas encore vérifiée' },
          '400': R('BadRequest'),
        },
      },
    },

    '/auth/sessions': {
      get: {
        tags: ['Auth'],
        summary: 'Sessions ouvertes du compte connecté',
        description: 'Identifie l\'appareil courant par le sessionId du jeton d\'accès.',
        responses: {
          '200': {
            description: 'Liste des sessions avec isCurrent',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Session' } } } },
          },
          '401': R('Unauthorized'),
        },
      },
    },

    '/auth/sessions/{id}': {
      delete: {
        tags: ['Auth'],
        summary: 'Ferme une session du compte',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': { description: 'Session fermée' },
          '401': R('Unauthorized'),
          '404': { description: 'Session introuvable', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/auth/logout-all': {
      post: {
        tags: ['Auth'],
        summary: 'Ferme toutes les sessions sauf la courante',
        responses: {
          '200': { description: 'Sessions fermées' },
          '401': R('Unauthorized'),
        },
      },
    },

    '/auth/me': {
      get: {
        tags: ['Utilisateur'],
        summary: 'Profil de l\'utilisateur connecté',
        description: 'userToApi + objet profile selon le rôle (SupplierProfile, BuyerProfile, DriverProfile).',
        responses: {
          '200': {
            description: 'Utilisateur courant',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
          '401': R('Unauthorized'),
        },
      },
      patch: {
        tags: ['Utilisateur'],
        summary: 'Modifie prénom, nom ou localisation',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                minProperties: 1,
                properties: {
                  firstname: { type: 'string', minLength: 2 },
                  lastname: { type: 'string', minLength: 2 },
                  location: { type: 'string', nullable: true },
                  latitude: { type: 'number' },
                  longitude: { type: 'number' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Utilisateur mis à jour',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
        },
      },
    },

    '/auth/me/avatar': {
      post: {
        tags: ['Utilisateur'],
        summary: 'Téléverse un avatar (multipart)',
        description:
          'Remplace l\'avatar ; ne supprime jamais un document de vérification (propriétaires distincts). L\'ancien fichier est supprimé du disque une fois la transaction validée.',
        requestBody: multipartBody({ file: { name: 'avatar', description: 'UN SEUL fichier dans le champ "avatar" : jpeg, png ou webp, 5 Mo max' } }),
        responses: {
          '200': { description: 'Avatar remplacé' },
          '400': R('UploadBadRequest'),
          '401': R('Unauthorized'),
          '413': R('FileTooLarge'),
        },
      },
    },

    '/auth/me/profile': {
      patch: {
        tags: ['Utilisateur'],
        summary: 'Modifie le profil du rôle (SUPPLIER, BUYER, DRIVER)',
        description:
          'Le contrôleur sélectionne le schéma du rôle de l\'appelant : un SUPPLIER n\'a pas à connaître les champs BUYER. Les trois formes acceptées sont listées ci-dessous (celle du rôle de l\'appelant fait foi).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  jsonSchema(supplierProfileSchema),
                  jsonSchema(buyerProfileSchema),
                  jsonSchema(driverProfileSchema),
                ],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Profil mis à jour' },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': { description: 'ADMIN/AGENT/ROOT n\'ont pas de profil de rôle', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/auth/me/payout-accounts': {
      get: {
        tags: ['Utilisateur'],
        summary: 'Comptes de paiement du connecté (numéros masqués)',
        description: 'SUPPLIER et BUYER uniquement ; accountNumberMasked = "••••1234".',
        responses: {
          '200': {
            description: 'Liste des comptes',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/PayoutAccount' } } } },
          },
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
      post: {
        tags: ['Utilisateur'],
        summary: 'Ajoute un compte de paiement',
        requestBody: jsonBody(payoutAccountCreateSchema),
        responses: {
          '201': {
            description: 'Compte créé',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PayoutAccount' } } },
          },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
        },
      },
    },

    '/auth/me/payout-accounts/{id}': {
      patch: {
        tags: ['Utilisateur'],
        summary: 'Modifie un compte de paiement (partiel)',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        requestBody: jsonBody(payoutAccountUpdateSchema),
        responses: {
          '200': {
            description: 'Compte mis à jour',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PayoutAccount' } } },
          },
          '400': R('BadRequest'),
          '401': R('Unauthorized'),
          '404': { description: 'Compte d\'un autre utilisateur', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Utilisateur'],
        summary: 'Supprime un compte de paiement',
        parameters: [{ $ref: '#/components/parameters/IdParam' }],
        responses: {
          '200': { description: 'Compte supprimé' },
          '401': R('Unauthorized'),
          '404': { description: 'Compte d\'un autre utilisateur', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/auth/me/documents': {
      post: {
        tags: ['Utilisateur'],
        summary: 'Dépose un document de vérification (multipart)',
        description:
          'SUPPLIER et BUYER. Crée VerificationDocument (PENDING) + Media privé stocké dans uploads/<type>/, hors du chemin servi statiquement. Si profileVerificationStatus vaut UNVERIFIED ou REJECTED, il passe à PENDING. Plafond de 5 documents PENDING par compte (409 TOO_MANY_PENDING_DOCUMENTS). La liste ne renvoie jamais d\'URL.',
        requestBody: multipartBody({
          file: { name: 'file', description: 'UN SEUL fichier dans le champ "file" : jpeg, png, webp ou pdf, 8 Mo max' },
          // Le type est une CHAÎNE (enum DocumentType), pas un objet : on passe
          // le champ Joi seul, sinon multipartBody le convertirait en objet.
          fields: { type: documentTypeField },
        }),
        responses: {
          '201': { description: 'Document déposé' },
          '400': R('UploadBadRequest'),
          '401': R('Unauthorized'),
          '403': R('Forbidden'),
          '409': R('TooManyPendingDocuments'),
          '413': R('FileTooLarge'),
        },
      },
      get: {
        tags: ['Utilisateur'],
        summary: 'Documents du connecté (sans URL)',
        responses: {
          '200': {
            description: 'Liste id, type, status, note, createdAt — SANS URL',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'integer' },
                      type: { type: 'string', enum: ['ID_CARD', 'BUSINESS_REGISTRATION', 'FARM_PROOF', 'OTHER'] },
                      status: { type: 'string', enum: ['PENDING', 'VERIFIED', 'REJECTED'] },
                      note: { type: 'string', nullable: true },
                      createdAt: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
          },
          '401': R('Unauthorized'),
        },
      },
    },

    '/auth/me/referral': {
      get: {
        tags: ['Utilisateur'],
        summary: 'Parrainage du connecté',
        description: 'Code de parrainage et liste des filleuls (le parrain ne voit que le prénom du filleul).',
        responses: {
          '200': {
            description: 'Code et filleuls',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    referralCode: { type: 'string' },
                    referrals: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'integer' },
                          kind: { type: 'string', enum: ['SUPPLIER', 'BUYER'] },
                          status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] },
                          firstname: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': R('Unauthorized'),
        },
      },
    },
  },
};
