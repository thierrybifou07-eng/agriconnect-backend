// config/openapi/openapi.config.js
//
// Document OpenAPI global : fusion des fragments du dossier modules/, plus la
// configuration commune (info, serveurs, sécurité, tags).
//
// Un fragment = un fichier modules/<module>.openapi.js, collé au routeur qu'il
// documente. Chaque fragment est un mini-document OpenAPI autonome (openapi,
// info, paths) : openapi-merge les assemble en un seul document, sans qu'aucun
// fragment n'ait à connaître les autres.
//
// La sortie est complète mais volontairement sans $ref ni components dans les
// fragments : chaque opération porte ses propres schémas, de sorte qu'une
// opération reste lisible dans l'interface sans avoir à la suivre.

import { merge } from 'openapi-merge';
import { healthOpenApi } from './modules/health.openapi.js';
import { authOpenApi } from './modules/auth.openapi.js';
import { adminOpenApi } from './modules/admin.openapi.js';
import { legalOpenApi } from './modules/legal.openapi.js';
import { supplierOpenApi } from './modules/supplier.openapi.js';
import { staffOpenApi } from './modules/staff.openapi.js';
import { catalogOpenApi } from './modules/catalog.openapi.js';
import { conversationOpenApi } from './modules/conversation.openapi.js';
import { orderOpenApi } from './modules/order.openapi.js';
import { driverOpenApi } from './modules/driver.openapi.js';

// Les fragments écrivent parfois `enum: […, null]` : c'est la notation la plus
// lisible pour « l'un de ces champs, ou absent ». En OpenAPI 3.0, null n'est
// pas une valeur d'énumération valide : il se dit nullable, et sort de la
// liste. La normalisation se fait après la fusion, sur le document complet.
function normalizeNullable(node) {
  if (Array.isArray(node)) {
    node.forEach(normalizeNullable);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.enum) && node.enum.includes(null)) {
    node.enum = node.enum.filter((v) => v !== null);
    if (node.enum.length === 0) delete node.enum;
    node.nullable = true;
  }
  for (const value of Object.values(node)) normalizeNullable(value);
}

export function generateOpenApiDocument() {
  // 1. Liste de tous les modules documentés
  const modulesDocs = [
    { oas: healthOpenApi },
    { oas: authOpenApi },
    { oas: adminOpenApi },
    { oas: legalOpenApi },
    { oas: supplierOpenApi },
    { oas: staffOpenApi },
    { oas: catalogOpenApi },
    { oas: conversationOpenApi },
    { oas: orderOpenApi },
    { oas: driverOpenApi },
  ];

  // 2. Fusionner tous les modules de manière sécurisée
  const mergeResult = merge(modulesDocs);

  if (mergeResult.output === undefined) {
    throw new Error(`Erreur lors de la fusion OpenAPI : ${mergeResult.message}`);
  }

  const mergedDocument = mergeResult.output;

  // 2 bis. `enum: […, null]` ne se dit pas : en OpenAPI 3.0, la nullité est
  // `nullable`, et ne figure pas dans la liste des valeurs.
  normalizeNullable(mergedDocument);

  // 3. Configuration globale de l'API
  mergedDocument.info = {
    title: 'AgriConnect API',
    version: '2.0.0',
    description: [
      "## AgriConnect Backend API",
      '',
      "API REST de la plateforme **AgriConnect** — consignation et vente de produits agricoles.",
      'La monnaie est le XAF et tous les montants et quantités sont des **nombres**',
      'JSON (les `Decimal` Prisma sont convertis par `decimal-json.middleware.js`).',
      'Les identifiants sont des entiers.',
      '',
      '### Modules',
      '| Module | Préfixe | Description |',
      '|--------|---------|-------------|',
      '| Auth | `/api/v2/auth` | Inscription, connexion, sessions, profil, comptes de paiement |',
      '| Utilisateur | `/api/v2/auth/me` | Profil, avatar, profil de rôle, documents, parrainage |',
      '| Administration | `/api/v2/admin` | Comptes, réglages, référentiels, agents, argent, audit |',
      '| CGU | `/api/v2/legal` | Documents légaux publics, versionnés |',
      '| Fournisseur | `/api/v2/supplier` | Lots, reversements, indemnisations |',
      '| Équipe | `/api/v2/staff` | Validation des lots, annonces, commandes, livraisons, indemnisations |',
      '| Catalogue | `/api/v2/catalog` | Consultation acheteur du catalogue |',
      '| Conversations | `/api/v2/conversations` | Messagerie client ↔ équipe |',
      '| Commandes | `/api/v2/orders` | Cycle de vie côté acheteur |',
      '| Livreur | `/api/v2/driver` | Courses du livreur connecté |',
      '| Sonde | `/health` | État du service |',
      '',
      '### Authentification',
      "Utilisez le bouton **Authorize** pour saisir votre **Bearer token** (JWT) :",
      '',
      '```',
      'Authorization: Bearer <votre_access_token>',
      '```',
      '',
      "Un jeton se renouvelle via `POST /api/v2/auth/refresh`. Le **numéro d'un compte de paiement**",
      "n'est jamais renvoyé en clair, ni à son propriétaire.",
      '',
      '### Réponses',
      "L'API n'ajoute pas d'enveloppe : les contrôleurs renvoient l'entité, la liste, ou le",
      "conteneur de pagination `{ items, page, limit, total }` directement.",
      "Les erreurs répondent `{ error, code? }`, `code` étant le code métier stable.",
      "Un corps Joi invalide ajoute un tableau `details` champ par champ.",
      '',
      "### Routes volontairement absentes",
      'Les pages HTML servies par `/api/v2/auth/verify-email` et `/api/v2/auth/reset-password`',
      "n'ont pas de contrat JSON : elles servent du HTML fixe (serveur de pages) et ne",
      "s'appellent pas depuis un client d'API.",
    ].join('\n'),
    contact: { name: 'AgriConnect Team', email: 'support@agriconnect.example' },
  };

  // L'API est montée sous /api/v2 (src/app.js) : le chemin de chaque opération
  // porte déjà ce préfixe dans les fragments, donc le serveur est documenté en
  // absolu plutôt qu'en relatif.
  mergedDocument.servers = [
    { url: 'http://localhost:4000', description: 'Serveur local (développement, PORT par défaut)' },
    { url: 'https://api.agriconnect.example', description: 'Serveur de production' },
  ];

  // 4. Schémas de sécurité globaux
  mergedDocument.components = mergedDocument.components || {};
  mergedDocument.components.securitySchemes = {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description:
        "Jeton d'accès JWT, obtenu via POST /api/v2/auth/login ou POST /api/v2/auth/register. " +
        "Le jeton de renouvellement n'est pas accepté en Authorization : il ne sert qu'à /auth/refresh.",
    },
  };

  // 5. Tags globaux
  mergedDocument.tags = [
    { name: 'Système', description: 'Sonde d\'état publique, hors rate limiting' },
    { name: 'Authentification', description: 'Inscription, connexion, sessions' },
    { name: 'Utilisateur', description: 'Profil, comptes de paiement, documents, parrainage du compte connecté' },
    { name: 'Administration', description: 'Comptes, réglages, référentiels, agents, argent, audit (ADMIN et plus)' },
    { name: 'CGU', description: "Conditions d'utilisation versionnées, publiques" },
    { name: 'Fournisseur', description: 'Lots, reversements et indemnisations du fournisseur connecté' },
    { name: 'Équipe', description: 'Validation des lots, annonces, commandes, livraisons, indemnisations (AGENT par capacité, ADMIN/ROOT)' },
    { name: 'Catalogue', description: 'Consultation acheteur du catalogue' },
    { name: 'Conversations', description: 'Messagerie client ↔ équipe' },
    { name: 'Commandes', description: 'Cycle de vie de la commande côté acheteur' },
    { name: 'Livreur', description: 'Courses du livreur connecté' },
  ];

  return mergedDocument;
}

// Le document est calculé une seule fois : la conversion des validateurs Joi
// a un coût, et le contrat ne change pas en cours d'exécution.
let cachedDocument = null;
export function getOpenApiDocument() {
  if (cachedDocument === null) cachedDocument = generateOpenApiDocument();
  return cachedDocument;
}