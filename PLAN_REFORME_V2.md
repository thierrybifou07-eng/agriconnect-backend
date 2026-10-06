# Plan d'implantation — Réforme AgriConnect Backend v2

Branche dédiée : `refactor/schema-v2-consignation`

## 0. Décision bloquante

Le cahier des charges v2 dit « MySQL », mais le `schema.prisma` v2 fourni déclare `provider = "postgresql"`.

Choix demandé avant Phase 0 :

- **A — PostgreSQL** : aligner l'infrastructure sur `schema.prisma` v2 (recommandé si le schéma v2 est la source de vérité).
- **B — MySQL conservé** : garder MySQL et adapter `schema.prisma` v2 (`provider`, types `Decimal`, `Json`, UUID string, enums) au plus près du schéma v2.

Tant que ce choix n'est pas figé, ne pas exécuter de migration destructive.

## 1. Objectif

Passer d'une marketplace où acheteurs et vendeurs/fournisseurs sont en contact à un modèle **d'intermédiation en consignation** :

- fournisseur dépose des lots chez AgriConnect ;
- équipe AgriConnect (ADMIN/AGENT) gère catalogue, devis, commandes, paiements, reversements et livraisons ;
- acheteurs et fournisseurs ne sont jamais exposés l'un à l'autre ;
- livraison via une agence partenaire, dispatch « pull » ;
- audit, stock, compensations, parrainage et configuration centralisés.

## 2. État actuel (v1)

- Express 5, Prisma, Socket.io, Joi, Cloudinary, EJS emails.
- Schéma actuel orienté marketplace : `User`, `Listing`, `Conversation` acheteur↔vendeur, `Order`, `Delivery`, `Media`, `Session`, refresh tokens, auth/reset/verification récents.
- Auth/session déjà robuste : sessions, rotation refresh, suspension, reset password, email verification.
- DTOs/enveloppes, validations et middlewares existants à réutiliser.

## 3. Cible fonctionnelle v2

### Rôles

`ROOT`, `ADMIN`, `AGENT`, `SUPPLIER`, `BUYER`, `DRIVER`.

`AGENT` est une capacité humaine ou IA, distincte de `User` ; les actions sensibles restent réservées à un `User` humain.

### Domaines

1. Auth/compte : inscription BUYER/SUPPLIER, login téléphone+mot de passe, sessions/refresh, CGU, vérification documents, comptes paiement.
2. Catalogue consolidé : catégories, produits, lots anonymisés.
3. Stock : réservation anti-survente, journal `StockMovement`, expirations, pertes.
4. Messagerie client↔équipe, escalade, notes internes.
5. Devis/commandes créés par agents, confirmation acheteur, statuts.
6. Paiements manuels, reversements fournisseurs, remboursements.
7. Livraison agence : zones, agences, hubs, livreurs, dispatch pull.
8. Indemnisation invendus, parrainage fixe.
9. Plansifiés : libération réservations expirées, lots périmés, éligibilité parrainage, alertes.
10. Administration et audit.

## 4. Écarts majeurs v1 → v2

| Domaine | v1 | v2 |
| --- | --- | --- |
| Modèle commercial | Marketplace directe | Consignation avec intermédiation |
| Fournisseur | `Listing.farmer` | `SupplierProfile` + `StockLot` |
| Acheteur | peut commander son propre flux | catalogue + conversations, commandes créées par agents |
| Conversation | acheteur↔vendeur | acheteur/fournisseur↔équipe |
| Commande | créée par acheteur | devis créé par agent, confirmation acheteur |
| Livreur | indépendant/agent | `DriverProfile` rattaché à `TransportAgency` |
| Stock | quantity simple | quatre compteurs, mouvements, réservations |
| Paiement | non modélisé | `Payment`, `SupplierPayout`, `SupplierCompensation` |
| Prix | figé commande | prix lot, commission figée par ligne |
| Confidentialité | faible | DTO distincts acheteur/fournisseur/livreur/staff |
| Agent | absent | `Agent`, capacités, autonomie |
| Audit | absent | `AuditLog` |
| Paramètres | absent | `PlatformSetting` ligne 1 |

## 5. Stratégie de migration des données

Par défaut : **nouvelle base v2 ou migration encadrée avec sauvegarde et validation**, pas de migration silencieuse.

Ordre recommandé :

1. Décider du moteur DB (PostgreSQL/MySQL).
2. Poser `schema.prisma` v2 en dev.
3. Créer une migration initiale v2 dans une base de travail.
4. Générer un script de seed v2 : ROOT CLI, `PlatformSetting` id=1, une zone, une agence, un hub, catégories, produits.
5. Écrire un script de migration v1→v2 seulement si des données réelles existent ; sinon repartir proprement.

Mapping minimal si reprise v1 nécessaire :

| v1 | v2 |
| --- | --- |
| `User` rôle farmer | `User` + `SupplierProfile` |
| `User` rôle buyer | `User` + `BuyerProfile` |
| `User` rôle driver | `User` + `DriverProfile` |
| `User` rôle admin | `User` + `Agent` HUMAN capability staff |
| `Listing` | `StockLot` + `LotImage` |
| `Order` | `Order` + `OrderItem` |
| `Payment` absent | création vide puis saisie manuelle |
| `RefreshToken` | adapté au `tokenHash` v2 |
| `Media`/avatar | `User.avatarUrl` + documents/lots images |

## 6. Phases d'implantation

### Phase 0 — Socle schéma et base

- Figer le moteur DB.
- Instancier `schema.prisma` v2.
- Migration initiale.
- Seed v2.
- Adapter config Prisma, `.env.example`, tests d'intégration.

Critères de sortie : `prisma validate`, migration appliquée, seed OK, suite de fumée verte.

### Phase 1 — Auth, comptes, vérification, CGU, admin utilisateurs

- Inscription BUYER/SUPPLIER uniquement via API publique ; ADMIN par ROOT ; AGENT par ADMIN ; DRIVER par ADMIN.
- Login téléphone+mot de passe.
- Sessions/refresh conservées ou alignées sur `RefreshToken.tokenHash`.
- `/me`, `/me/payout-accounts`, `/me/documents`, `/me/referral`, `/me/terms-acceptances`.
- Suspension : révoque refresh tokens et bloque login/refresh/auth/socket.

Critères de sortie : tests auth/session/refresh/suspension adaptés et verts.

### Phase 2 — Catalogue, lots, stock, journal

- `/catalog/categories`, `/catalog/products`, `/catalog/products/:id/offers`.
- Lots fournisseur multipart Cloudinary.
- Validation agent `PENDING_VALIDATION → AVAILABLE/REJECTED`.
- Réservation atomique `quantityAvailable >= quantity` + `StockMovement`.
- Invariant `initial = available + reserved + sold + lost`.

Critères de sortie : test de concurrence sur réservation, mouvements tracés, DTO acheteur sans fuite fournisseur.

### Phase 3 — Messagerie, devis, commandes, réservations

- Conversations client↔équipe, assignation, escalade, notes internes.
- Devis créé par agent depuis conversation.
- `Order` `QUOTED → CONFIRMED → ...`, `reservedUntil`, annulation libère réservation.
- DTO acheteur anonymisé.

Critères de sortie : machines à états testées, transitions invalides `409`, DTO sans `supplierId` côté acheteur.

### Phase 4 — Paiements et reversements

- `POST /staff/orders/:id/payments` avec `Idempotency-Key`.
- Recalcul `Order.paymentStatus`.
- `SupplierPayout` créé à la confirmation `ON_HOLD`, `READY` quand completed+paid, `PAID` manuel.
- Remboursement : `REFUNDED`, payouts `ON_HOLD` annulés.

Critères de sortie : tests calculs commission/frais/total, idempotence paiements.

### Phase 5 — Agence, livraisons, hubs, dispatch pull

- Zones, agences, hubs, `AgencyZone` tarifs.
- Livraisons créées par staff, découpage par enlèvement.
- Acceptation livreur atomique `PENDING + driverId=null`.
- Statuts livraison et commande synchronisés.
- Assurance référencée, incident noté.

Critères de sortie : test acceptation concurrente, livreur sans course active, retrait hub sans frais transport.

### Phase 6 — Parrainage, indemnisation, planifiés, dashboard, audit

- `Referral` PENDING → ELIGIBLE quand filleul vérifié, montant figé.
- `SupplierCompensation` auto à expiration + manuel agent/admin.
- node-cron : réservations expirées, lots périmés, éligibilité parrainage, alertes.
- Dashboard admin et `AuditLog`.

Critères de sortie : tâches idempotentes, audit obligatoire, indemnisation approuvée/payée tracée.

### Phase 7 — Durcissement et livraison

- DTO par rôle, liste blanche.
- helmet, CORS restreint, logs sans PII.
- OpenAPI/Postman.
- `npm install`, `npm audit`, `prisma validate`, tests complets.
- Revue sécurité : fuite d'identité acheteur/fournisseur, prix visibles livreur, actions financières humain uniquement.

## 7. Règles DTO/sécurité transversales

- Acheteur : jamais `supplierId`, nom exploitation, téléphone, adresse enlèvement.
- Fournisseur : jamais identité acheteur.
- Livreur : adresses/destinataire/téléphone OK, prix non exposés.
- Staff : identifiants autorisés selon capability.
- Actions argent : uniquement `User` humain `ADMIN` ou capable, jamais agent IA.

## 8. Variables d'environnement à revoir

- `DATABASE_URL` selon moteur choisi.
- `JWT_SECRET`, `JWT_EXPIRES_IN`, `REFRESH_TOKEN_TTL_DAYS`.
- `CORS_IO`, `APP_URL`, `PORT`.
- `CLOUDINARY_*`.
- `SMTP_*`, `EMAIL_SENDER`, `MAILDEV_API_URL`.
- `SESSION_MAX_PER_USER`, `REFRESH_REUSE_GRACE_SECONDS` si conservés.

## 9. Tests prioritaires

1. Réservation concurrente de stock.
2. Calcul commission/frais/total commande.
3. Machines à états lot/commande/livraison/reversement/indemnisation/parrainage.
4. Acceptation atomique livraison.
5. DTO acheteur sans fuite d'identité fournisseur.
6. Suspension compte : refresh révoqué, login/refresh/auth/socket bloqués.
7. Idempotence paiement avec `Idempotency-Key`.
8. Expiration réservation et lot périmé via tâches planifiées.

## 10. Livrables par phase

- Chaque phase = commits séparés, tests verts, README/API docs mis à jour.
- Avant merge : `npm test`, `prisma validate`, `npm audit`, revue des DTO et audit logs.
- Branche à merger uniquement après Phase 7.

## 11. Risques

| Risque | Mitigation |
| --- | --- |
| Conflit MySQL/PostgreSQL | décision phase 0, pas de migration avant |
| Données v1 incompatibles | migration v1→v2 explicite ou reprise propre |
| Fuite confidentialité | DTOs par rôle + tests de non-régression |
| Survente/stock incohérent | transaction + update conditionnelle + mouvements |
| Double paiement/reversement | contraintes uniques + idempotence + audit |
| Agent IA agit financièrement | middleware `capabilities` + auteur humain obligatoire |
