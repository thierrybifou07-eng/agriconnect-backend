# Changelog v1 → v2

**Branche :** `feature/dev-v2` · **Base :** MySQL, identifiants entiers (`Int @id`)
**Module auth v1 :** conservé (sessions, rotation des refresh tokens, suspension,
vérification d'email, mot de passe oublié) — seule la surface décrite ici change.

La v1 stockait ses référentiels dans des tables lookup et ses machines à états en
enums ; la v2 garde cette convention. Format des erreurs v1 : `{ "error": "message" }`.
Validation : Joi. Préfixe d'API : `/api/v2`.

---

## 1. Routes supprimées

| Route v1 | Pourquoi |
|---|---|
| `POST /api/listings` · `GET /` · `GET/PATCH/DELETE /api/listings/:id` · `POST /api/listings/:id/photos` | Annonces v1 supprimées : l'annonce n'est plus créée par le promoteur ni l'acheteur, mais publiée par l'équipe depuis un lot validé (`/staff/listings`) |
| `POST /api/orders` · `GET /` · `GET /api/orders/:id` · `PATCH /api/orders/:id/{confirm,cancel,complete}` | Commandes v1 réécrites : devis émis par l'équipe (`/staff/orders`), cycle de vie acheteur sous `/orders` |
| `GET/POST /api/conversations` · `GET/POST /api/conversations/:id/messages` | Messagerie v1 remplacée : conversations client ↔ équipe uniquement (`/conversations`, `/staff/conversations`) |
| `GET /api/deliveries/available` · `GET /api/deliveries/mine` · `POST /api/deliveries/:id/accept` · `PATCH /api/deliveries/:id/status` | Livraisons v1 recréées par le flux commande (`/staff/orders/:id/deliveries`); le garde-fou livreur reste sous `/driver` |
| `GET /api/admin/orders` · `GET /api/admin/stats` · `PATCH /api/listings/:id/deactivate` | Supprimés en P0.2, remplacés par `/admin/stats` (P6.4) et le cycle de vie des annonces |
| `GET /api/users/*` | Préfixe libéré : tout ce qu'un utilisateur fait sur son propre compte vit sous `/auth/me` |
| `PATCH /api/auth/me/availability` | D7 : la disponibilité d'un livreur se déduit (compte ACTIVE, aucune livraison en cours). **Côté Flutter : pas d'interrupteur « Je suis disponible »** |

## 2. Routes ajoutées

### Comptes (Phase 1)

| Route | Rôle | Objet |
|---|---|---|
| `PATCH /api/v2/auth/me/profile` | SUPPLIER, BUYER, DRIVER | Schéma par rôle ; zoneId doit exister |
| `GET/POST /api/v2/auth/me/payout-accounts` · `PATCH/DELETE /:id` | SUPPLIER, BUYER | Numéro jamais renvoyé (`accountNumberMasked`) ; un seul `isDefault` |
| `POST /api/v2/auth/me/documents` · `GET /api/v2/auth/me/documents` | SUPPLIER, BUYER | Dépôt de documents (jpeg/png/webp/pdf, 8 Mo) ; liste sans URL |
| `GET /api/v2/auth/me/referral` | tout connecté | Code de parrainage + filleuls (prénom seulement pour le parrain) |
| `POST /api/v2/admin/users` | ADMIN+ (ADMIN par ROOT seul) | `createStaffUser` : ADMIN, AGENT, DRIVER + profil |
| `GET/PATCH /api/v2/admin/agents` · `POST /api/v2/admin/agents/ai` | ADMIN+ | Capacités, autonomie ; agent IA sans compte (C6 : jamais PAYMENT_FOLLOWUP) |
| `GET /api/v2/admin/verifications` · `GET/PATCH /:id` | ADMIN+ ou AGENT(USER_VERIFICATION) | Dossiers (liste filtrable, sans URL) + lien signé de 10 min pour lire la pièce ; décision APPROVE/REJECT |

### Correctif upload et vérification de profil (phases U1 à U7)

Le stockage des médias est **local** (`uploads/`), et le circuit de vérification
de profil est complet et documenté. Détail du plan :
[`PLAN_CORRECTIF_UPLOAD.md`](PLAN_CORRECTIF_UPLOAD.md).

| Phase | Changement | Client |
|---|---|---|
| U1 | Les erreurs d'upload ne sont plus des 500 : un wrapper commun traduit les `MulterError` en 400/413 avec un `code` et le champ attendu | `UNEXPECTED_FILE_FIELD` (+`expectedField`), `INVALID_MULTIPART`, `UNSUPPORTED_MEDIA_TYPE`, `FILE_REQUIRED`, `FILE_TOO_LARGE` |
| U2 | Un seul service de stockage (`services/storage.service.js`) : `saveFile` retourne toujours `{ url, publicId, isPrivate, size }`, écritures asynchrones, `UPLOADS_DIR` configurable, garde anti-remontée de chemin. Fin du service de médias externe et de sa dépendance | `publicId` désormais enregistré pour **tous** les médias ; les URL restent relatives (`/uploads/…`) |
| U3 | Remplacer son avatar supprime l'ancien fichier (uniquement s'il n'est plus référencé) ; le nouveau fichier est effacé si la transaction échoue | — |
| U4 | Aucun fichier orphelin : compensation si la transaction échoue, nettoyage après suppression d'un lot / d'une annonce / d'un document | `npm run uploads:cleanup` (dry-run, `--apply`) |
| U5 | Accès aux pièces privées durci : jeton dédié (`SECRET_FILE_TOKEN`) portant `{ purpose, mediaId, sub }` — plus aucun chemin disque dans un jeton, obligatoire et distinct de `JWT_SECRET` en production ; réponse `no-store` + `nosniff` + nom neutre ; **chaque consultation est auditée** ; plafond de 5 documents `PENDING` ; contrôle des octets de tête avant écriture | 409 `TOO_MANY_PENDING_DOCUMENTS`, 400 `FILE_CONTENT_MISMATCH`, 404 `FILE_MISSING`, 403 si le jeton vient d'un autre compte |
| U6 | File de revue utilisable : filtres validés (`status`, `type`, `role`, `userId`, `page`, `limit`), tri **FIFO** sur `PENDING`, statut du compte dans la liste, décision atomique (deux relecteurs simultanés → 200 + 409), email de décision non bloquant | `GET /admin/verifications?status=PENDING&page=1` |
| U7 | Le statut de vérification **conditionne** des actions : middleware `requireVerifiedProfile` | 403 `PROFILE_NOT_VERIFIED` + `profileVerificationStatus` sur `POST /supplier/lots`, `PATCH /supplier/lots/:id`, `POST /supplier/lots/:id/withdraw`, `POST /orders/:id/confirm` |

Conséquence pour le client mobile : **un seul fichier par requête** pour un
document de vérification (champ `file`, recto et verso = deux requêtes), champ
`avatar` pour l'avatar, champ `images` (5 maximum) pour les lots et les
annonces. Le détail figure dans le README (« Client mobile » et « Stockage des
fichiers ») et dans l'OpenAPI.

### CGU (P1.1)

| Route | Rôle | Objet |
|---|---|---|
| `GET /api/v2/legal` · `GET /api/v2/legal/:code?lang=` | public | Documents PUBLISHED, FR/EN, repli fr |
| `POST /api/v2/admin/legal/:code/versions` · `PATCH /api/v2/admin/legal/versions/:id/publish` | ADMIN+ | Version DRAFT puis publication qui archive l'ancienne |

### Lots et annonces (Phase 2)

| Route | Rôle | Objet |
|---|---|---|
| `POST /api/v2/supplier/lots` · `GET /api/v2/supplier/lots` | SUPPLIER | Déclaration avec photos (5 max) |
| `GET/PATCH/DELETE /api/v2/supplier/lots/:id` · `POST /:id/withdraw` | SUPPLIER | PATCH/DELETE seulement en PENDING_VALIDATION ou REJECTED |
| `POST /api/v2/staff/lots` · `GET /api/v2/staff/lots` · `GET /:id` | STOCK_VALIDATION | Création au nom d'un fournisseur + consultation |
| `POST /api/v2/staff/lots/:id/{validate,reject,return}` | STOCK_VALIDATION | Transitions de lot ; validate exige fournisseur VERIFIED (NOT_VERIFIED) |
| `POST/GET /api/v2/staff/lots/:id/quality-checks` | STOCK_VALIDATION | Note A/B/C, grade du lot mis à jour |
| `GET /api/v2/staff/stock-movements` | STOCK_VALIDATION | Journal des mouvements (RECEIVED, RESERVED, SOLD, EXPIRED…) |
| `POST /api/v2/staff/listings` · `GET /api/v2/staff/listings` · `GET/PATCH /:id` · `POST /:id/{publish,unpublish}` | LISTING_MANAGEMENT | Publication par l'équipe, prix public, une annonce = un lot |
| `GET /api/v2/catalog/categories` · `GET /api/v2/catalog/listings` · `GET /api/v2/catalog/listings/:id` | BUYER, AGENT, ADMIN, ROOT | Catalogue acheteur : jamais les lots |

### Référentiels admin (P2.1)

`GET/POST /api/v2/admin/{categories,units,products,zones,hubs}` et `PATCH /:id` —
ADMIN+. Pas de DELETE : désactivation par `isActive=false`. Unicité → 409.

### Messagerie, commandes, argent (Phases 3–5)

| Route | Rôle | Objet |
|---|---|---|
| `POST /api/v2/conversations` · `GET /api/v2/conversations` | connecté | Conversation + premier message |
| `GET/POST /api/v2/conversations/:id/messages` | connecté | Fil public |
| `GET /api/v2/staff/conversations` · `GET /:id` · `GET/POST /:id/messages` | BUYER_SUPPORT ou SUPPLIER_SUPPORT | Agent limité à son type de conversation |
| `POST /api/v2/staff/conversations/:id/{assign,escalate,close}` | idem | Assignation, escalade (motif), fermeture |
| `POST /api/v2/staff/orders` · `GET /api/v2/staff/orders` · `GET /:id` | ORDER_PROCESSING | Devis (QUOTED) qui réserve le stock et fige les prix |
| `PATCH /api/v2/staff/orders/:id/status` · `POST /:id/{confirm,cancel}` | ORDER_PROCESSING | Cycle de vie ; transitions invalides → 409 INVALID_STATE_TRANSITION |
| `GET /api/v2/orders` · `GET /api/v2/orders/:id` · `POST /:id/{confirm,cancel}` | BUYER | Cycle de vie côté acheteur ; 404 si la commande n'est pas la sienne |
| `POST/GET /api/v2/staff/orders/:id/payments` | PAYMENT_FOLLOWUP (humain) | Paiements manuels idempotents (en-tête Idempotency-Key) |
| `POST /api/v2/staff/payments/:id/refund` | ADMIN+ (humain) | Remboursement ; `force` = dérogation admin |
| `POST /api/v2/staff/orders/:id/deliveries` · `GET /api/v2/staff/deliveries` | DISPATCH_COORDINATION | Création par point d'enlèvement, consultation |
| `POST /api/v2/staff/deliveries/:id/{release,redispatch,cancel}` | DISPATCH_COORDINATION | Reprise des courses bloquées |
| `GET /api/v2/admin/payouts` · `PATCH /:id/pay` | ADMIN+ (humain) | Reversements fournisseurs |
| `GET /api/v2/supplier/payouts` | SUPPLIER | Reversements reçus |

### Parrainage, indemnisations, exploitation (Phase 6)

| Route | Rôle | Objet |
|---|---|---|
| `GET /api/v2/admin/referrals` · `PATCH /:id/{pay,reject}` | ADMIN+ (humain) | Commissions de parrainage |
| `POST /api/v2/staff/compensations` | DISPUTE_HANDLING | Demande pour invendus ou pertes |
| `GET /api/v2/admin/compensations` · `PATCH /:id/{approve,reject,pay}` | ADMIN+ (humain) | Instruction et paiement |
| `GET /api/v2/supplier/compensations` | SUPPLIER | Indemnisations reçues |
| `GET/PATCH /api/v2/admin/settings` | lecture ADMIN+, écriture ROOT | Commission, frais acheteur, tarifs, parrainage, indemnisation |
| `GET /api/v2/admin/audit-logs` | ADMIN+ | Journal (actions MAJUSCULES_AVEC_UNDERSCORES) |
| `GET /api/v2/admin/agencies/:id/drivers` | ADMIN+ | Livreurs d'une agence |
| `PUT/DELETE /api/v2/admin/agencies/:id/zones/:zoneId` | ADMIN+ | Couverture d'une zone avec tarifs |

## 3. Modèles de données

### Ajoutés

`SupplierProfile`, `BuyerProfile`, `DriverProfile` (le `vehicleType` quitte `User`),
`PayoutAccount`, `VerificationDocument`, `StockLot` (déclaration interne du
promoteur), `ListingLot` (une annonce = un lot au MVP), `StockMovement`
(mouvements de stock), `LotQualityCheck`, `Referral`, `TermsAcceptance`,
`LegalDocument` / `LegalDocumentVersion` / `LegalDocumentTranslation` (CGU FR/EN
versionnées), `Zone`, `Hub` (points de dépôt), `Product` + `ProductCategory`
(remplace `ListingCategory`), `Unit`, `Agent` / `AgentCapability` /
`AgentCapabilityLink` (contrôle d'accès par capacité), `PlatformSetting`
(singleton), `AuditLog`, `Payment` (paiements manuels), `SupplierPayout`
(reversements), `SupplierCompensation` (indemnisations).

### Modifiés (ALTER, pas recréation)

- **`User`** : `isAvailable` et `vehicleType` retirés ; `profileVerificationStatus`
  (UNVERIFIED par défaut), `profileVerifiedAt`, `profileVerifiedById` (auto-relation
  « ProfileVerifiedBy ») et `referralCode` ajoutés.
- **`Media`** : `ownerListingId` conservé (photos d'annonce) ; `ownerLotId` (photos
  de lot) et `ownerVerificationDocumentId` (documents privés) ajoutés, avec
  `publicId`, `isPrivate` et `position`. L'avatar reste `ownerUserId` : changer
  d'avatar ne supprime jamais un document de vérification.
- **`Listing`, `Order`, `Delivery`, `Conversation`, `Message`, `DeliveryMode`** :
  conservées et adaptées. `DeliveryMode` : `PICKUP` → `HUB_PICKUP`,
  `DELIVERY` → `AGENCY_DELIVERY`.
- **`ListingCategory`** : supprimée (remplacée par `ProductCategory`).

### Conservés inchangés

`Session`, `RefreshToken`, `EmailVerificationToken`, `PasswordResetToken`,
`UserStatus`, `MediaType`, `MimeType`, `ListingStatus` (codes DRAFT, ACTIVE, SOLD,
INACTIVE) et tout le flux auth.

## 4. Rôles

- `FARMER` → `SUPPLIER` (renommé, même `id` : les comptes existants suivent).
- `AGENT` ajouté (niveau 30, entre opérationnel et ADMIN) : capacité par capacité
  (`requireCapability`) ; `ADMIN` et `ROOT` (niveau ≥ 50) passent toujours.
- Inscription publique : `SUPPLIER` et `BUYER` seulement. `DRIVER` n'est plus public
  — créé par un ADMIN et rattaché à une agence. `ADMIN` n'est délivrable que par ROOT.
- Hiérarchie des niveaux : 10 opérationnel (SUPPLIER/BUYER/DRIVER), 30 AGENT,
  50 ADMIN, 100 ROOT.

## 5. Erreurs

La réponse porte désormais `code` quand l'erreur en porte un : `{ error, code }`.
Codes principaux : `INSUFFICIENT_STOCK`, `INVALID_STATE_TRANSITION`,
`INVALID_AMOUNT`, `NOT_VERIFIED`, `LOT_ALREADY_LINKED`, `LOT_NOT_AVAILABLE`,
`ZONE_NOT_COVERED`, `AGENCY_INSURANCE_EXPIRED`, `INVALID_BUYER_FEE`,
`REFERRAL_CODE_UNKNOWN`, `REFERRAL_CODE_UNAVAILABLE`, `PROFILE_MISSING`,
`NO_DRIVER_PROFILE`, `DELIVERY_ALREADY_ACTIVE`, `DELIVERY_ALREADY_TAKEN`,
`DELIVERY_NOT_FOUND`, `NOT_DELIVERY_OWNER`, `ORDER_NOT_FOUND`,
`BUYER_NOT_FOUND`, `NOT_A_BUYER`, `BUYER_NOT_ACTIVE`, `CONVERSATION_NOT_FOUND`,
`LISTING_NOT_FOUND`, `LISTING_NO_LOT`, `HUB_NOT_FOUND`, `HUB_NO_PICKUP`,
`PRICE_BELOW_SUPPLIER`, `DELIVERIES_ALREADY_CREATED`, `INVALID_DELIVERY_MODE`,
`INVALID_ORDER_STATUS`, `COMPENSATION_RATE_ZERO`.

Ajouts des phases U1 à U7 : `UNEXPECTED_FILE_FIELD` (avec `expectedField`),
`INVALID_MULTIPART`, `UNSUPPORTED_MEDIA_TYPE`, `FILE_REQUIRED`,
`FILE_CONTENT_MISMATCH`, `FILE_TOO_LARGE` (413), `TOO_MANY_PENDING_DOCUMENTS`
(409), `FILE_MISSING` (404), `PROFILE_NOT_VERIFIED` (403, avec
`profileVerificationStatus` dans le corps).

## 6. Autres changements cassants

- Préfixe `/api` → `/api/v2` partout.
- Listes paginées : `{ items, page, limit, total }`.
- Montants et quantités en `Decimal` Prisma, convertis en nombre JSON au moment de
  la réponse (`decimal-json.middleware.js`). Aucun calcul d'argent en `Number`.
- Tâches planifiées dans le processus serveur (`node-cron`), neutralisées par
  `NODE_ENV=test` ou `DISABLE_JOBS=true` — avec plusieurs instances, une seule doit
  les exécuter.
- **Stockage des médias local** : plus d'hébergeur externe. Les fichiers vivent
  sous `UPLOADS_DIR` (défaut `<racine>/uploads`), les URL sont **relatives**
  (`/uploads/…`) et les documents d'identité ne sont plus servis
  statiquement. Deux nouvelles variables : `UPLOADS_DIR` et `SECRET_FILE_TOKEN`
  (obligatoire en production, distinct de `JWT_SECRET`).
