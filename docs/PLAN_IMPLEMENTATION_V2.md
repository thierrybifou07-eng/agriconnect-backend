# AgriConnect Backend — Plan d'implémentation v2 (prompts pour OpenCode)

**Date :** 8 octobre 2026 · **Dépôt :** `thierrybifou07-eng/agriconnect-backend`
**Branche de travail :** `feature/v2-consignation`, créée depuis `development` (commit `d83ce69`, état final de la v1)
**Base :** MySQL · identifiants **Int** · module auth de la v1 **conservé**

Ce document remplace `PLAN_REFORME_V2.md` de l'ancienne branche. Il est conçu pour des modèles gratuits : prompts courts, périmètre fermé, critères de sortie vérifiables, **un prompt = un commit**.

---

## 1. Point de départ (constat sur le dépôt)

- `development` = v1 complète, auth terminée (sessions, rotation des refresh tokens, suspension, vérification d'email, mot de passe oublié). Elle utilise **déjà des identifiants Int**.
- L'ancienne branche `refactor/schema-v2-consignation` contient une « Phase 0 » construite sur mon premier schéma : identifiants **UUID**, `fullName`, `passwordHash`. Elle est **incompatible** avec l'auth v1 (`firstname/lastname`, `password`, login par email). Elle est **archivée telle quelle** (jamais fusionnée, jamais supprimée).
- La v1 stocke ses référentiels dans des **tables lookup** (`Role`, `UserStatus`, …) et ses machines à états dans des **enums**. Le plan garde cette convention.
- Format des erreurs v1 : `{ "error": "message" }`. Validation : Joi. Préfixe d'API : `/api`. Montants : `Decimal` converti en nombre par `decimal-json.middleware.js`.

---

## 2. Décisions actées

| # | Décision |
|---|---|
| D1 | Nouvelle branche depuis l'état final de la v1 ; MySQL conservé |
| D2 | Identifiants entiers partout (`Int @id @default(autoincrement())`) |
| D3 | CGU stockées en base, en **français et anglais**, versionnées |
| D4 | Auth v1 conservée : `firstname/lastname`, `roleId/userStatusId`, `emailVerified`, `Session`, `RefreshToken.token`, `EmailVerificationToken`, `PasswordResetToken`, `Media` pour l'avatar |
| D5 | `vehicleType` n'est plus sur `User` : il vit sur `DriverProfile` |
| D6 | `verificationStatus` v2 = vérification du **profil** par l'équipe (futurs badges), **distincte** de `emailVerified` |
| D7 | Pas de `isAvailable` : `userStatusId` porte l'état de l'utilisateur |
| D8 | Stock et rôles : bascule **complète** sur la v2, la v1 est éliminée, aucune fusion |
| D9 | Deux couches distinctes : **StockLot** = stock que le promoteur déclare (interne : prix convenu, quantités, qualité) ; **Listing** (annonce) = offre publique publiée par l'équipe, avec un prix public fixé par l'équipe. Les tables `Listing`, `Order`, `Conversation` de la v1 sont **conservées et adaptées** (ALTER, pas de recréation) |
| D10 | Le promoteur gère ses lots (création, lecture, modification, suppression) avec l'aide de l'équipe ; l'équipe crée les annonces à partir des lots disponibles |

### Le modèle en trois couches

```
Promoteur (SUPPLIER) --déclare-->  StockLot   INTERNE : promoteur, prix convenu, quantités, qualité, expiration
                                      |  ListingLot (une annonce = un lot au MVP)
Équipe (AGENT / ADMIN) --publie--> Listing    PUBLIC  : titre, prix public (fixé par l'équipe), photos, statut
                                      |
Acheteur --consulte l'annonce, écrit à l'équipe--> Conversation --> l'équipe crée Order
                                                   Order -> OrderItem (listingId + lotId, prix figés)
```

Les acheteurs ne voient que `Listing`. Les promoteurs ne voient que leurs `StockLot`. Le prix est contrôlé parce que seule l'équipe fixe le prix public.

---

## 3. Modifications du module auth — À VALIDER AVANT DE LANCER

Principe : **modifier le strict nécessaire**. Tout ce qui n'est pas dans ce tableau reste identique, octet pour octet.

| # | Modification | Pourquoi | Fichiers touchés |
|---|---|---|---|
| M1 | `User` : retrait de `isAvailable` et `vehicleType` ; ajout de `profileVerificationStatus` (`UNVERIFIED` par défaut), `profileVerifiedAt`, `profileVerifiedById`, `referralCode` | D5, D6, D7 et parrainage. J'ai nommé le champ `profileVerificationStatus` plutôt que `verificationStatus` pour qu'on ne le confonde jamais avec `emailVerified` | `schema.prisma` |
| M2 | Rôles : la ligne `FARMER` est **renommée** `SUPPLIER` (même `id`, donc les comptes existants suivent) ; ajout de `AGENT` (niveau 30). `ROOT`, `ADMIN`, `BUYER`, `DRIVER` inchangés | D8 (rôles v2). Les niveaux restent compatibles avec `requireMinLevel` | migration SQL, `seed.js` |
| M3 | Inscription publique : rôles autorisés `SUPPLIER` et `BUYER` seulement. `DRIVER` n'est plus public : il est créé par un ADMIN et rattaché à une agence | Règle v2 : le livreur appartient à l'agence | `auth.controller.js` (`PUBLIC_ROLES`), `auth.validator.js` |
| M4 | Inscription : champs optionnels `referralCode`, `farmName`, `buyerType`, `businessName` ; champ obligatoire `acceptTerms: true`. Tout s'exécute dans **une transaction** : utilisateur + profil + acceptation des CGU + parrainage. L'ouverture de session, les jetons et les emails restent **exactement** comme en v1 | CGU obligatoires (RG-13), profils, parrainage | `auth.controller.js` (`register`), `auth.validator.js` |
| M5 | Suppression de `PATCH /api/v2/auth/me/availability` et de `updateAvailability` | D7 : la disponibilité d'un livreur se déduit (compte ACTIVE et aucune livraison en cours). **Conséquence côté Flutter : pas d'interrupteur « Je suis disponible »** | `auth.routes.js`, `user.controller.js` |
| M6 | `userToApi`, sélection de `protect` et `userSafeSelect` : retrait de `vehicleType` et `isAvailable`, ajout de `profileVerificationStatus` et `referralCode`. `GET /api/v2/auth/me` renvoie en plus l'objet `profile` du rôle | Cohérence avec M1 | `userApi.js`, `auth.middleware.js`, `admin.controller.js`, `user.controller.js` |
| M7 | `createAdmin` devient `createStaffUser` : crée ADMIN (ROOT seulement), AGENT et DRIVER (ADMIN ou plus), avec leur profil. Correction au passage : l'unicité de l'**email** est vérifiée (la v1 ne vérifie que le téléphone, une collision email donnerait une erreur 500) | Comptes d'équipe v2 | `admin.controller.js`, `admin.validator.js`, `admin.routes.js` |
| M8 | `errorHandler` : renvoie aussi `code` quand l'erreur en porte un (`{ error, code }`). Ajout **non cassant** | Le client Flutter doit distinguer `INSUFFICIENT_STOCK`, `INVALID_STATE_TRANSITION`, etc. | `error.middleware.js` |
| M9 | `Media` étendu : **`ownerListingId` conservé** (photos d'annonce, v1) ; ajout des propriétaires `ownerLotId` (photos de lot) et `ownerVerificationDocumentId` (documents), plus `publicId`, `isPrivate`, `position`. **La logique d'avatar ne change pas** : l'avatar reste `ownerUserId`, et les documents ont leur propre propriétaire pour ne jamais être supprimés quand on change d'avatar | Photos suivies par leur propriétaire ; documents d'identité jamais publics | `schema.prisma` |
| M10 | Socket : l'authentification et la salle `user:{id}` restent **intactes** ; seuls les handlers de conversation sont réécrits | Messagerie v2 (client ↔ équipe) | `chat.socket.js` |
| M11 | Helpers de test : `BUSINESS_TABLES` mis à jour, `createListing` retiré, rôle par défaut des fixtures inchangé (`BUYER`) | Suite de tests toujours verte | `tests/helpers/*` |

### Intouchable (aucune modification, sauf M1 à M11)
`utils/session.js`, `utils/refreshToken.js`, `utils/jwt.js`, `utils/oneTimeToken.js`, `utils/emailVerification.js`, `utils/passwordReset.js`, `sockets/revocation.js`, `middlewares/rateLimit.middleware.js`, modèles `Session`, `RefreshToken`, `EmailVerificationToken`, `PasswordResetToken`, flux login / refresh / logout / sessions / verify-email / forgot / reset, charge utile du JWT (`id, role, userStatus, emailVerified, sessionId`).

### Autres choix à valider
| # | Choix | Par défaut |
|---|---|---|
| C1 | Login | **email + mot de passe** (comme la v1). Mes cahiers v2.0 disaient « téléphone » : c'était une erreur de ma part. Le téléphone reste obligatoire et unique |
| C2 | `location`, `latitude`, `longitude` | Restent sur `User` (v1). Les profils ne dupliquent pas l'adresse |
| C3 | Référentiels v2 | Tables lookup : `ListingStatus` (**conservée** de la v1, codes `DRAFT`, `ACTIVE`, `SOLD`, `INACTIVE`), `ProductCategory` (remplace `ListingCategory`), `Unit`, `AgentCapability` (MySQL n'a pas de liste d'enums). `DeliveryMode` est conservée avec les codes `HUB_PICKUP` / `AGENCY_DELIVERY`. Les statuts de lot, commande et livraison restent des enums |
| C4 | Données v1 | La migration **supprime** les tables marketplace (`Listing`, `Order`, `Delivery`, `Conversation`, `Message` v1). Les comptes, sessions et jetons sont **préservés**. On suppose qu'il n'y a **que des données de test** à perdre |
| C5 | Documents d'identité | Envoyés sur Cloudinary en mode **privé** ; le staff y accède par URL signée de courte durée |
| C6 | Charge de l'agent `AI` | Un agent IA ne peut jamais avoir la capacité `PAYMENT_FOLLOWUP` ni agir sur l'argent |
| C7 | Annonce et lot | **Une annonce = un lot** au MVP (règle de code). La table `ListingLot` permet d'en agréger plusieurs plus tard sans migration. Le prix public est fixé par l'équipe ; par défaut il égale le prix convenu avec le promoteur. Nouvelle capacité d'agent : `LISTING_MANAGEMENT` (publication des annonces) |
| C8 | **À TRANCHER** : écart de prix | Si l'équipe fixe un prix public supérieur au prix convenu, qui garde l'écart ? Les deux prix sont figés sur chaque ligne de commande. Par défaut : le promoteur est payé sur le prix convenu moins la commission, et l'écart éventuel est un revenu AgriConnect |

---

## 4. PRÉAMBULE (OpenCode lit cette section avant chaque prompt)

```
CONTEXTE
Projet : agriconnect-backend, branche feature/v2-consignation.
Stack : Node.js ESM, Express 5, Prisma 6 + MySQL, Joi, Socket.io, Cloudinary, Vitest + supertest.
Référence schéma : docs/schema.v2.target.prisma (ne jamais le modifier ; c'est la cible).

RÈGLES ABSOLUES
1. Identifiants entiers (Int). Jamais d'UUID. Toute route avec :id passe par coerceIdParam.
2. Préfixe d'API : /api/v1. Les routes "/me/*" sont /api/v2/auth/me/*.
3. Erreurs : res.status(n).json({ error: 'message en français' }) ; erreurs levées :
   Object.assign(new Error('message'), { statusCode: 409, code: 'CODE_MAJUSCULE' }).
   Succès : objet brut. Listes paginées : { items, page, limit, total }.
4. Validation : Joi via middlewares/validate.middleware.js (lire ce fichier d'abord).
5. Argent et quantités : Prisma.Decimal et utils/money.js. JAMAIS de calcul d'argent en Number.
6. Lookups : getLookupId('role', 'BUYER') (utils/lookupCache.js). Pas de "mode: insensitive" (MySQL).
7. Commentaires et messages en français, dans le style des fichiers existants :
   le commentaire explique le POURQUOI, pas le quoi.
8. NE PAS MODIFIER le module auth (liste "Intouchable" du plan), sauf si le prompt l'écrit.
9. Aucune dépendance npm nouvelle, sauf si le prompt la nomme.
10. Migrations : `npx prisma migrate dev --create-only --name <nom>`, relis le SQL généré,
    puis `npx prisma migrate dev`. SQL écrit à la main uniquement s'il est demandé.
    Jamais de `migrate reset` hors base de développement/test.
11. Tests Vitest obligatoires dans chaque prompt. `npm test` DOIT être vert avant de commiter.
    Si le schéma gagne une table métier, l'ajouter à BUSINESS_TABLES (tests/helpers/db.js).
12. Périmètre : modifie UNIQUEMENT les fichiers que le prompt autorise. Si un fichier hors liste
    te semble nécessaire, ARRÊTE-TOI et demande.
13. Si une instruction est ambiguë ou contredit le code existant : ARRÊTE-TOI et pose la question.
    N'invente pas.
14. Avant d'écrire du code : lis les fichiers cités par le prompt, et uniquement ceux-là.

FIN DE PROMPT (toujours)
a) npm test  -> tout vert.   b) npx prisma validate  -> OK.
c) git status puis git diff --stat : vérifie qu'aucun fichier hors périmètre n'a changé.
d) Commit unique avec le gabarit ci-dessous.
e) Affiche : hash du commit, 5 lignes de résumé, liste des tests ajoutés, points douteux.
```

### Gabarit de commit (la description documente la diff)

```
type(portée): sujet à l'impératif, 72 caractères maximum

Pourquoi :
  <le besoin métier ou technique, 2 à 3 lignes>

Changements :
  - <comportement ajouté / modifié / supprimé, un point par changement>

Fichiers :
  <sortie de git diff --cached --stat, recopiée>

Base de données :
  <migration créée et son effet, ou "aucune">

Tests :
  <commandes lancées, nombre de tests, résultat>

Impact et risques :
  <routes ajoutées ou supprimées, compatibilité, points à surveiller>
```

Le corps doit être rédigé **à partir de `git diff --cached`** : pas de généralités, des faits vérifiables.

### Protocole entre deux prompts (toi)
1. Nouvelle session OpenCode **par prompt** (contexte propre, moins d'erreurs).
2. Colle le prompt. Laisse-le finir sans l'interrompre.
3. Relis `git show --stat` et le diff. Lance `npm test`. Vérifie les critères d'acceptation.
4. Si le résultat dérape : `git reset --hard HEAD~1`, reformule le prompt (plus précis), relance.
5. Prompt suivant seulement quand le commit est propre.

---

## 5. Vue d'ensemble

| Phase | Prompts | Contenu |
|---|---|---|
| 0 — Socle | P0.0 à P0.4 | Branche, docs, retrait marketplace, compte aligné v2, schéma de domaine |
| 1 — Comptes | P1.1 à P1.6 | CGU FR/EN, inscription v2, comptes d'équipe, agents et audit, profils, vérification |
| 2 — Lots et annonces | P2.1 à P2.6 | Référentiels admin, lots du promoteur, service de stock, validation et qualité, annonces publiées par l'équipe, catalogue acheteur |
| 3 — Commandes | P3.1 à P3.5 | Messagerie REST puis temps réel, moteur de prix, devis, cycle de vie |
| 4 — Argent | P4.1 à P4.2 | Paiements manuels idempotents, reversements |
| 5 — Livraison | P5.1 à P5.3 | Agences et tarifs, création des livraisons, dispatch livreur |
| 6 — Équipe et jobs | P6.1 à P6.4 | Parrainage, indemnisation, tâches planifiées, tableau de bord et audit |
| 7 — Finition | P7.1 à P7.3 | Confidentialité, documentation, vérification finale |

**32 commits** après le commit de documentation. Ordre strict : chaque prompt suppose les précédents terminés.

---

## PHASE 0 — Socle

### P0.0 — Branche et documentation *(manuel, toi)*

```
git fetch origin
git checkout development && git pull
git checkout -b feature/v2-consignation
mkdir docs
# copie dans docs/ : PLAN_IMPLEMENTATION_V2.md et schema.v2.target.prisma
git add docs
git commit -m "docs(v2): add the implementation plan and the target schema" \
  -m "Pourquoi : ancrer la refonte v2 sur l'etat final de la v1 (d83ce69), MySQL, ids entiers." \
  -m "Changements : docs/PLAN_IMPLEMENTATION_V2.md (32 commits en 8 phases), docs/schema.v2.target.prisma (schema cible valide)." \
  -m "Impact : aucun code applicatif modifie. L'ancienne branche refactor/schema-v2-consignation est archivee, non fusionnee."
git push -u origin feature/v2-consignation
```

### P0.1 — Baseline *(aucun commit)*

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : mesurer l'état de départ, sans rien modifier.
1. npm ci
2. npx prisma validate
3. npm test
4. Donne : nombre de fichiers de test, nombre de tests, tests en échec éventuels (avec le message).
5. Ne modifie aucun fichier. Ne commite rien.
```

Critère : **tout vert** avant de continuer. Sinon, corrige d'abord (hors plan).

### P0.2 — Retirer le domaine marketplace v1

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : retirer du CODE les modules marketplace de la v1, sans toucher au schéma Prisma
ni au module auth. Les tables restent en base jusqu'à P0.4.
Les tables Listing, Order, Conversation, Message et Delivery sont CONSERVÉES et adaptées en P0.4 ; leur logique
est réécrite plus loin (annonces en P2.5, commandes en P3.x). Ici, seul le CODE v1 est retiré.

Lis d'abord : src/routes/index.js, src/routes/admin.routes.js, src/controllers/admin.controller.js,
src/sockets/chat.socket.js, tests/helpers/factory.js, tests/helpers/db.js.

À SUPPRIMER :
- src/controllers/{listing,order,conversation,delivery}.controller.js
- src/routes/{listing,order,conversation,delivery}.routes.js
- src/validators/{listing,order}.validator.js
- les tests qui ne concernent que ces modules (regression-order-creation, resource-routes,
  decimal-money si elle ne teste que des listings/commandes). Pour un test mixte, retire
  seulement les cas marketplace. Liste dans le commit chaque test supprimé et pourquoi.

À MODIFIER :
- src/routes/index.js : ne garder que /auth et /admin.
- src/routes/admin.routes.js et admin.controller.js : retirer getAllOrders, getStats,
  deactivateListing et leurs routes. Garder listUsers, suspendUser, reactivateUser, createAdmin.
- src/sockets/chat.socket.js : garder io.use(...) d'authentification et joinUserRoom ;
  supprimer join_conversation, leave_conversation, send_message (réécrits en P3.2).
- tests/helpers/factory.js : retirer createListing.

À NE PAS TOUCHER : prisma/schema.prisma, utils/distance.js, utils/money.js, tout le module auth.

Critères : npm test vert ; le serveur démarre ; GET /health répond 200 ;
GET /api/v2/listings répond 404.
Commit : refactor(api): remove the v1 marketplace modules (listings, orders, conversations, deliveries)
```

### P0.3 — Aligner le compte utilisateur sur la v2 (M1, M2, M3, M5, M6, M8, M11 partiel)

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : adapter le modèle User et le code auth au minimum nécessaire pour la v2.
Lis d'abord : prisma/schema.prisma (modèle User), src/controllers/auth.controller.js,
src/validators/auth.validator.js, src/utils/userApi.js, src/middlewares/auth.middleware.js,
src/controllers/user.controller.js, src/routes/auth.routes.js, src/controllers/admin.controller.js,
src/middlewares/error.middleware.js, prisma/seed.js, tests/integration/*.test.js qui citent
isAvailable, vehicleType ou FARMER.

1. prisma/schema.prisma — modèle User UNIQUEMENT :
   - retirer isAvailable et vehicleType ;
   - ajouter l'enum ProfileVerificationStatus (UNVERIFIED, PENDING, VERIFIED, REJECTED) ;
   - ajouter profileVerificationStatus (défaut UNVERIFIED), profileVerifiedAt (DateTime?),
     profileVerifiedById (Int?) avec la relation nommée "ProfileVerifiedBy" (auto-relation,
     voir docs/schema.v2.target.prisma), et referralCode (String? @unique).
2. Migration : npx prisma migrate dev --create-only --name v2_user_account. Ajoute À LA FIN du
   fichier SQL généré :
   UPDATE `Role` SET `code`='SUPPLIER', `label`='Fournisseur' WHERE `code`='FARMER';
   INSERT INTO `Role` (`code`,`label`,`level`,`isActive`,`createdAt`)
     SELECT 'AGENT','Agent AgriConnect',30,1,NOW(3)
     WHERE NOT EXISTS (SELECT 1 FROM `Role` WHERE `code`='AGENT');
   Puis npx prisma migrate dev.
3. seed.js : rôles = ROOT(100,'Super-administrateur'), ADMIN(50,'Administrateur'),
   AGENT(30,'Agent AgriConnect'), SUPPLIER(10,'Fournisseur'), BUYER(10,'Acheteur'),
   DRIVER(10,'Livreur'). Retirer FARMER. Ne pas toucher aux autres référentiels.
4. auth.controller.js : PUBLIC_ROLES = ['SUPPLIER','BUYER'] ; supprimer toute lecture de
   vehicleType ; message d'erreur : 'role doit être SUPPLIER ou BUYER'.
5. auth.validator.js : role Joi.valid('SUPPLIER','BUYER') ; supprimer vehicleType.
6. userApi.js : retirer vehicleType et isAvailable ; ajouter profileVerificationStatus et
   referralCode (null si absent).
7. auth.middleware.js : dans le select de protect, retirer isAvailable et vehicleType ;
   ajouter profileVerificationStatus et referralCode.
8. user.controller.js : supprimer updateAvailability. auth.routes.js : supprimer la route
   PATCH /me/availability et l'import devenu inutile.
9. admin.controller.js : dans userSafeSelect, retirer isAvailable et vehicleType, ajouter
   profileVerificationStatus. Ne rien changer d'autre.
10. error.middleware.js : errorHandler ajoute `code` à la réponse quand err.code est une chaîne
    (réponse { error, code }). Sans code : réponse inchangée.
11. Tests : remplacer FARMER par SUPPLIER partout ; supprimer les cas disponibilité ;
    AJOUTER : PATCH /api/v2/auth/me/availability -> 404 ; register avec role DRIVER ou FARMER -> 400 ;
    GET /me contient profileVerificationStatus = 'UNVERIFIED' et emailVerified indépendant ;
    errorHandler renvoie code quand fourni.

Critères : tous les tests auth/session/suspension/verify-email/reset existants restent verts ;
migrate deploy fonctionne sur une base de test vierge.
Commit : refactor(auth): align the account model with v2 (roles, profile verification, no availability flag)
```

### P0.4 — Schéma de domaine v2 (M9 et tables du domaine)

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : installer le schéma de domaine v2 complet (aucun code métier ici).
Lis d'abord : docs/schema.v2.target.prisma, prisma/schema.prisma, prisma/seed.js,
tests/helpers/db.js.

1. Remplace prisma/schema.prisma par le contenu EXACT de docs/schema.v2.target.prisma.
2. VÉRIFICATION OBLIGATOIRE avant migration : `git diff prisma/schema.prisma` doit montrer que
   ces modèles sont inchangés : Session, RefreshToken, EmailVerificationToken, PasswordResetToken,
   UserStatus, MediaType, MimeType, ListingStatus, et que User et Media ne diffèrent que par les champs
   du plan (M1, M9). Si un autre champ de ces modèles change : ARRÊTE-TOI et signale-le.
3. Les tables qui gardent leur nom (Listing, ListingStatus, Order, Delivery, Conversation, Message,
   DeliveryMode) sont MODIFIÉES (ALTER), pas recréées. ListingCategory est supprimée (remplacée par
   ProductCategory). Prisma refuse d'ajouter une colonne obligatoire à une table qui contient des lignes :
   on vide donc d'abord les données marketplace v1 (données de test, décision C4).
   a) npx prisma migrate dev --create-only --name v2_domain
   b) Ajoute AU TOUT DÉBUT du fichier SQL généré (avant le premier ALTER), dans cet ordre exact :
      DELETE FROM `Delivery`;
      DELETE FROM `Order`;
      DELETE FROM `Message`;
      DELETE FROM `Conversation`;
      DELETE FROM `Media` WHERE `ownerListingId` IS NOT NULL;
      DELETE FROM `Listing`;
   c) Ajoute À LA FIN du fichier SQL :
      UPDATE `DeliveryMode` SET `code`='HUB_PICKUP', `label`='Retrait en point de dépôt' WHERE `code`='PICKUP';
      UPDATE `DeliveryMode` SET `code`='AGENCY_DELIVERY', `label`='Livraison par l''agence' WHERE `code`='DELIVERY';
   d) Relis le SQL : il doit contenir DROP TABLE `ListingCategory`, des CREATE pour ProductCategory, Unit,
      Product, StockLot, ListingLot, etc., et des ALTER sur Listing, Order, Delivery, Conversation, Message.
      Signale tout DROP COLUMN inattendu sur User ou Media.
   e) npx prisma migrate dev.
4. seed.js — AJOUTER ou ADAPTER (upsert par code, idempotent) :
   - listingStatus : DRAFT 'Brouillon', ACTIVE 'Visible', SOLD 'Vendue', INACTIVE 'Masquée'
     (conserver les codes v1 ACTIVE, SOLD, INACTIVE)
   - RETIRER listingCategory ; AJOUTER productCategory : CEREALES, LEGUMES, FRUITS, TUBERCULES, ELEVAGE, AUTRE
   - unit : KG, TON, BAG, CRATE, PIECE, LITER, BUNCH (libellés français)
   - agentCapability : BUYER_SUPPORT, SUPPLIER_SUPPORT, LISTING_MANAGEMENT, ORDER_PROCESSING,
     STOCK_VALIDATION, PAYMENT_FOLLOWUP, DISPATCH_COORDINATION, USER_VERIFICATION, DISPUTE_HANDLING
   - deliveryMode : HUB_PICKUP, AGENCY_DELIVERY
   - platformSetting : upsert id = 1 avec les valeurs par défaut du schéma
   - legalDocument : CGU, BUYER_TERMS, SUPPLIER_CONSIGNMENT_TERMS (sans versions : P1.1)
   Le seed doit pouvoir tourner deux fois de suite sans erreur.
5. Crée prisma/seed.dev.js (script npm "seed:dev") : une Zone "Zone pilote", une TransportAgency
   "Agence pilote" avec assurance fictive, un AgencyZone (baseFee 500, perKmFee 100), un Hub.
   Idempotent. Non exécuté par les tests.
6. tests/helpers/db.js : BUSINESS_TABLES = toutes les tables métier (y compris Listing, ListingLot,
   LotQualityCheck) ; NE PAS inclure les référentiels (Role, UserStatus, MediaType, MimeType, DeliveryMode,
   ListingStatus, ProductCategory, Unit, AgentCapability), ni PlatformSetting, LegalDocument,
   LegalDocumentVersion, LegalDocumentTranslation.

Critères : prisma validate OK ; migrate deploy sur base vierge OK ; seed deux fois OK ;
npm test vert ; test statique prisma-fields vert.
Commit : feat(db): add the v2 consignment domain schema (MySQL, integer ids)
```

---

## PHASE 1 — Comptes, CGU, vérification, agents

### P1.1 — CGU en français et anglais

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : servir les CGU depuis la base, versionnées, en FR et EN.
Lis d'abord : src/routes/index.js, src/routes/admin.routes.js, src/validators/admin.validator.js,
prisma/seed.js, modèles LegalDocument* dans prisma/schema.prisma.

À CRÉER :
- src/utils/legal.js : resolveLocale(req) = ?lang= > en-tête Accept-Language (fr|en) > 'fr' ;
  getCurrentVersion(code) = version PUBLISHED du document ; REQUIRED_DOCUMENTS_BY_ROLE =
  { BUYER: ['CGU','BUYER_TERMS'], SUPPLIER: ['CGU','SUPPLIER_CONSIGNMENT_TERMS'] }.
- src/controllers/legal.controller.js + src/routes/legal.routes.js (monté sur /api/v2/legal, PUBLIC) :
  GET /api/v2/legal -> liste des documents courants { code, label, version, publishedAt } ;
  GET /api/v2/legal/:code?lang= -> { code, version, locale, title, content, publishedAt } ;
  si la langue demandée n'existe pas, repli sur 'fr' et renvoyer le champ locale réel ;
  404 si le code est inconnu ou sans version publiée.
- Admin (ADMIN et plus), dans admin.routes.js :
  POST /api/v2/admin/legal/:code/versions { version, translations:[{locale,title,content}] }
  crée une version DRAFT ('fr' obligatoire, 'en' facultatif) ;
  PATCH /api/v2/admin/legal/versions/:id/publish passe la version en PUBLISHED et archive la
  précédente du même document, dans une transaction ; 409 si déjà publiée.
- prisma/seed-data/legal.js : pour chacun des 3 documents, une version '1.0' PUBLISHED avec une
  traduction fr ET en. Textes COURTS et PROVISOIRES, commençant par la ligne
  "[TEXTE PROVISOIRE — à faire valider juridiquement]". Les conditions fournisseur doivent avoir
  des articles titrés sur : consignation sans transfert de propriété ; prix convenu ; commission ;
  péremption et indemnisation ; confidentialité (aucun contact avec les acheteurs) ;
  transport et assurance. Le seed insère ces versions de façon idempotente.
- validators pour les deux routes admin.

Tests : GET public sans jeton ; langue en et fr ; repli quand 'en' manque ; publication archive
l'ancienne version ; un BUYER ne peut pas publier (403) ; seed idempotent.
Commit : feat(legal): store the terms of use in French and English with versioning
```

### P1.2 — Inscription v2 (M4)

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : l'inscription crée aussi le profil, enregistre l'acceptation des CGU et le parrainage.
Lis d'abord : src/controllers/auth.controller.js (fonction register), src/validators/auth.validator.js,
src/utils/legal.js, tests/helpers/factory.js (registerViaApi), tests/integration/auth.test.js.

1. auth.validator.js (registerSchema) — AJOUTER, sans modifier les champs existants :
   acceptTerms: Joi.boolean().valid(true).required() (message : 'Vous devez accepter les conditions') ;
   referralCode: Joi.string().trim().max(20).optional() ; farmName: Joi.string().trim().min(2).max(120).optional() ;
   buyerType: Joi.string().valid('RETAILER','FARMER','WHOLESALER','OTHER').optional() ;
   businessName: Joi.string().trim().max(120).optional().
2. Dans register, remplace le prisma.user.create seul par UNE transaction (prisma.$transaction) qui :
   a) crée l'utilisateur avec un referralCode unique (8 caractères majuscules/chiffres sans 0, O, 1, I,
      générés avec crypto.randomInt ; réessaie en cas de collision, 5 essais maximum) ;
   b) SUPPLIER -> crée SupplierProfile { farmName par défaut `${firstname} ${lastname}` } ;
      BUYER -> crée BuyerProfile { buyerType par défaut RETAILER, businessName } ;
   c) enregistre une TermsAcceptance par version PUBLISHED des documents de
      REQUIRED_DOCUMENTS_BY_ROLE[role], avec ipAddress = req.ip ;
   d) si referralCode est fourni : cherche le parrain par referralCode ; introuvable -> erreur 400
      'Code de parrainage invalide' (la transaction est annulée) ; sinon crée Referral { referrerId,
      referredId, kind = role (SUPPLIER ou BUYER), status PENDING }.
3. TOUT LE RESTE de register est conservé tel quel, dans le même ordre : openSession,
   accessTokenFor, issueRefreshToken, email de bienvenue, issueVerificationToken, réponse 201.
4. Aucune autre route auth n'est modifiée.

Tests : BUYER s'inscrit -> profil BuyerProfile + 2 TermsAcceptance + referralCode renvoyé par /me ;
SUPPLIER avec farmName -> SupplierProfile ; sans acceptTerms -> 400 ; code de parrainage inconnu ->
400 et AUCUN utilisateur créé ; code valide -> Referral PENDING de kind correct ; DRIVER -> 400 ;
les tests d'inscription existants restent verts (adapter registerViaApi : ajouter acceptTerms: true).
Commit : feat(auth): create the profile, record terms acceptance and handle referral at registration
```

### P1.3 — Comptes d'équipe (M7)

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : créer ADMIN, AGENT et DRIVER par l'API.
Lis d'abord : src/controllers/admin.controller.js (createAdmin), src/validators/admin.validator.js,
src/routes/admin.routes.js, tests/integration (tests admin existants).

1. Remplace createAdmin par createStaffUser (POST /api/v2/admin/users, mêmes protections protect +
   requireMinLevel(50)). Corps : firstname, lastname, phone, email, password (mêmes règles que
   l'inscription), role ∈ ADMIN|AGENT|DRIVER, et selon le rôle :
   AGENT -> agent: { displayName (défaut "Équipe AgriConnect"), capabilities: [codes] } ;
   DRIVER -> driver: { agencyId (obligatoire), vehicleType?, plateNumber? }.
2. Règles : role ADMIN réservé à ROOT (403 sinon) ; AGENT et DRIVER pour ADMIN et ROOT ;
   unicité de l'email ET du téléphone (409 distincts) ; capabilities inconnues -> 400 ;
   agencyId inexistant ou inactif -> 400.
3. Création dans une transaction : User + (Agent kind HUMAN, userId, + AgentCapabilityLink)
   ou DriverProfile. Email 'welcome' non bloquant comme avant (roleLabel = label du rôle).
4. listUsers : ajouter les filtres ?profileVerificationStatus= ; la réponse reste un tableau.
5. Joi : createStaffUserSchema avec .when() sur role.

Tests : matrice (ROOT crée ADMIN ; ADMIN ne crée pas ADMIN ; ADMIN crée AGENT et DRIVER ; AGENT et
BUYER refusés) ; doublon email -> 409 ; doublon téléphone -> 409 ; DRIVER sans agencyId -> 400 ;
AGENT avec capability inconnue -> 400 ; l'AGENT créé a bien ses capacités en base.
Commit : feat(admin): create ADMIN, AGENT and DRIVER accounts with their profiles
```

### P1.4 — Agents, capacités, audit

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : contrôle d'accès par capacité, administration des agents, journal d'audit.
Lis d'abord : src/middlewares/auth.middleware.js, src/routes/admin.routes.js, modèles Agent,
AgentCapability, AgentCapabilityLink, AuditLog dans prisma/schema.prisma.

À CRÉER :
- src/middlewares/capability.middleware.js : requireCapability(...codes). ADMIN et ROOT
  (role.level >= 50) passent. Un AGENT passe s'il a un Agent actif (userId) possédant AU MOINS un des
  codes ; place alors req.agent = { id, kind, capabilities:[codes] }. Sinon 403 'Capacité requise'.
- src/utils/audit.js : recordAudit(db, { actorUser, actorAgent, action, entityType, entityId, metadata })
  où db est prisma ou un client de transaction. Il ne masque jamais ses erreurs. Convention
  d'action : MAJUSCULES_AVEC_UNDERSCORES (ex. LOT_VALIDATED).
- Routes admin (ADMIN et plus), dans admin.routes.js :
  GET /api/v2/admin/agents ; PATCH /api/v2/admin/agents/:id { displayName?, isActive?, capabilities?, autonomy? } ;
  POST /api/v2/admin/agents/ai { displayName, aiProvider, aiModel, aiConfig?, autonomy } crée un agent AI
  SANS utilisateur (autonomy par défaut SUGGEST_ONLY).
- Règle C6 : un agent kind AI ne peut jamais recevoir la capacité PAYMENT_FOLLOWUP (400).
- Chaque création ou modification d'agent écrit un AuditLog dans la même transaction.

Tests : AGENT sans capacité -> 403 ; AGENT avec capacité -> 200 ; ADMIN toujours autorisé ; PATCH
change les capacités ; AI sans PAYMENT_FOLLOWUP (400 si demandé) ; AuditLog créé.
Commit: feat(agents): add capability-based access, agent administration and the audit helper
```

### P1.5 — Profils et comptes de paiement

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : exposer et modifier le profil du rôle ; gérer les comptes de paiement.
Lis d'abord : src/utils/userApi.js, src/controllers/user.controller.js, src/routes/auth.routes.js,
modèles SupplierProfile, BuyerProfile, DriverProfile, PayoutAccount.

1. GET /api/v2/auth/me : ajouter l'objet `profile` (SupplierProfile, BuyerProfile ou DriverProfile
   selon le rôle, sinon null) via le paramètre `extra` de userToApi. Rien d'autre ne change.
2. PATCH /api/v2/auth/me/profile (protect) : SUPPLIER { farmName, description, zoneId } ;
   BUYER { buyerType, businessName, zoneId } ; DRIVER { vehicleType, plateNumber }. Schéma Joi par
   rôle ; zoneId doit exister ; ADMIN/AGENT/ROOT -> 403.
3. Comptes de paiement (SUPPLIER et BUYER uniquement) : GET, POST, PATCH /:id, DELETE /:id sur
   /api/v2/auth/me/payout-accounts. Les réponses n'exposent JAMAIS le numéro complet :
   `accountNumberMasked` ("••••1234"). isDefault : un seul par utilisateur (transaction qui retire
   l'ancien). Un compte ne peut être modifié ou supprimé que par son propriétaire (404 sinon).
4. Toutes ces routes se placent dans auth.routes.js APRÈS les routes existantes ; ne modifie pas
   l'ordre ni le contenu des routes existantes.

Tests : /me contient profile selon le rôle ; mise à jour de profil ; zoneId inconnu -> 400 ;
numéro masqué ; un seul compte par défaut ; accès au compte d'un autre -> 404.
Commit: feat(profile): expose and edit the role profile and manage payout accounts
```

### P1.6 — Vérification du profil (M9)

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : dépôt de documents et validation du profil par l'équipe.
Lis d'abord : src/middlewares/upload.middleware.js, src/utils/cloudinaryUpload.js,
src/config/cloudinary.js, src/controllers/user.controller.js (uploadAvatar),
src/middlewares/capability.middleware.js, src/utils/audit.js.

1. Upload : crée src/middlewares/uploadDocument.middleware.js (multer mémoire, 8 Mo, types
   image/jpeg, image/png, image/webp, application/pdf — tous doivent exister dans MimeType).
   Étends uploadBufferToCloudinary(buffer, options = {}) de façon RÉTROCOMPATIBLE : sans options,
   comportement identique à aujourd'hui ; avec { folder, type: 'authenticated' } l'envoi est privé et
   la fonction renvoie aussi public_id. Ne modifie pas upload.middleware.js (avatars).
2. POST /api/v2/auth/me/documents (protect, SUPPLIER ou BUYER) : champ fichier `file`, champ `type`
   (DocumentType). Crée VerificationDocument (PENDING) et Media (ownerVerificationDocumentId, isPrivate
   true, publicId, mediaType IMAGE ou DOCUMENT selon le mime). Si profileVerificationStatus vaut
   UNVERIFIED ou REJECTED, il passe à PENDING. GET /api/v2/auth/me/documents liste id, type, status,
   note, createdAt — SANS URL.
3. Staff (ADMIN et plus, ou AGENT avec USER_VERIFICATION) :
   GET /api/v2/admin/verifications?status=PENDING (paginé) ;
   GET /api/v2/admin/verifications/:id : détail + URL SIGNÉE valable 10 minutes (utilise l'API du SDK
   Cloudinary v2 ; si tu n'es pas certain de la bonne fonction, ARRÊTE-TOI et demande) ;
   PATCH /api/v2/admin/verifications/:id { decision: 'APPROVE'|'REJECT', note } (note obligatoire pour
   REJECT).
4. Règle : APPROVE -> document VERIFIED. L'utilisateur devient VERIFIED (profileVerifiedAt,
   profileVerifiedById) quand il a au moins un document VERIFIED et aucun PENDING. REJECT sans
   document VERIFIED -> utilisateur REJECTED. Audit dans la même transaction. NE touche PAS au parrainage
   (branché en P6.1).
5. Le changement d'avatar (uploadAvatar) ne doit JAMAIS supprimer un document de vérification : ajoute un
   test qui le prouve.

Tests : dépôt valide ; mime refusé ; GET /me/documents sans URL ; staff voit l'URL signée, un BUYER non ;
transitions PENDING -> VERIFIED / REJECTED ; avatar remplacé sans toucher aux documents ;
AGENT sans USER_VERIFICATION -> 403 (mocker Cloudinary comme les tests existants).
Commit: feat(verification): let users submit profile documents and staff review them
```

---

## PHASE 2 — Lots, annonces, stock

### P2.1 — Référentiels d'administration

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : administrer catégories, unités, produits, zones et points de dépôt.
Lis d'abord : src/routes/admin.routes.js, src/validators/admin.validator.js, src/utils/audit.js,
modèles ProductCategory, Unit, Product, Zone, Hub.

Crée src/controllers/referential.controller.js, src/validators/referential.validator.js et monte
les routes dans admin.routes.js (ADMIN et plus) :
GET, POST, PATCH /:id sur /api/v2/admin/categories, /units, /products, /zones, /hubs.
- Pas de DELETE : on désactive (isActive=false via PATCH). Les listes acceptent ?active=true|false et
  sont paginées { items, page, limit, total }.
- Unicité : code (catégories, unités), couple (categoryId, name) pour les produits, name pour les zones ;
  doublon -> 409.
- Un produit exige categoryId et unitId existants et actifs. Un hub exige zoneId existant.
- Chaque création et modification écrit un AuditLog.
Tests : création, doublon 409, désactivation, filtre active, accès refusé à un AGENT sans rôle admin.
Commit: feat(catalog): administer categories, units, products, zones and hubs
```

### P2.2 — Lots du fournisseur

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : le promoteur (SUPPLIER) déclare et gère ses lots avec photos (création, lecture, modification,
suppression). L'équipe l'aide ensuite par les routes staff.
Lis d'abord : src/middlewares/upload.middleware.js, src/utils/cloudinaryUpload.js, src/utils/money.js,
modèles StockLot, Media, Product.

À CRÉER : src/controllers/supplierLot.controller.js, src/routes/supplier.routes.js (monté sur
/api/v2/supplier, protect + requireRole('SUPPLIER')), src/validators/lot.validator.js,
src/utils/dto/lot.dto.js (fonctions lotToSupplierDto et lotToStaffDto). Le catalogue acheteur n'utilise PAS les lots : il utilise les annonces (P2.5, P2.6).

Routes :
- POST /api/v2/supplier/lots (multipart, champ `images`, 5 maximum, via upload.array) avec productId, zoneId,
  agreedUnitPrice, quantity, storageType (SUPPLIER_SITE|HUB), hubId (obligatoire si HUB, actif et
  acceptsDropoff), pickupAddress + pickupLatitude + pickupLongitude (obligatoires si SUPPLIER_SITE),
  expiresAt (obligatoire si le produit est périssable, date future), harvestedAt?, packagingNote?, qualityNote?.
  Création dans une transaction : StockLot avec quantityInitial = quantityAvailable = quantity, statut
  PENDING_VALIDATION ; lotCode = 'LOT-' + id sur 6 chiffres, écrit juste après l'insertion ; upload des images
  puis lignes Media (ownerLotId, position, isPrimary pour la première).
- GET /api/v2/supplier/lots (paginé, filtre ?status=) ; GET /api/v2/supplier/lots/:id (404 si le lot n'est pas à lui).
- PATCH /api/v2/supplier/lots/:id : autorisé SEULEMENT en PENDING_VALIDATION (409 INVALID_STATE_TRANSITION sinon),
  champs modifiables : prix, quantité (réécrit quantityInitial et quantityAvailable), dates, notes.
- DELETE /api/v2/supplier/lots/:id : autorisé SEULEMENT en PENDING_VALIDATION ou REJECTED (suppression définitive
  du lot et de ses photos Media, aucun mouvement de stock) ; tout autre statut -> 409 (utiliser le retrait, P2.4).
- DTO fournisseur : lotCode, produit, les quatre quantités, prix, statut, rejectionReason, images, dates.
  JAMAIS de donnée acheteur.
Ne pas créer de StockMovement ici (la réception est tracée à la validation, P2.4).
Tests : création complète (Cloudinary mocké), règles conditionnelles (HUB sans hubId -> 400, périssable sans
expiresAt -> 400), lotCode au bon format, PATCH refusé après validation, lot d'un autre fournisseur -> 404,
BUYER -> 403.
Commit: feat(lots): let suppliers declare and edit consigned lots with photos
```

### P2.3 — Service de stock

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : le cœur transactionnel du stock, sans route HTTP.
Lis d'abord : src/utils/money.js, modèles StockLot et StockMovement.

Crée src/services/stock.service.js. Toutes les fonctions reçoivent un client de transaction `tx` en premier
argument et ne s'exécutent JAMAIS hors transaction. Invariant : initial = available + reserved + sold + lost.

Fonctions pures (testables sans base) : assertInvariant(lot) lève une erreur si l'invariant est faux ;
computeLotStatus(lot, now) renvoie AVAILABLE | FULLY_RESERVED | SOLD_OUT | EXPIRED selon les quantités et la date
(un lot REJECTED, RETURNED ou WITHDRAWN n'est jamais recalculé).

Fonctions transactionnelles, chacune écrit un StockMovement (quantityDelta, actor, orderItemId éventuel) :
- receiveLot(tx, lotId, actor) : PENDING_VALIDATION -> AVAILABLE, mouvement RECEIVED de quantityInitial.
- reserve(tx, lotId, qty, ctx) : tx.stockLot.updateMany avec la condition { id, status: 'AVAILABLE',
  quantityAvailable: { gte: qty } } et data { quantityAvailable: { decrement: qty },
  quantityReserved: { increment: qty } } ; si count vaut 0 -> erreur 409 code INSUFFICIENT_STOCK ;
  puis recalcul du statut ; mouvement RESERVED.
- releaseReservation(tx, lotId, qty, ctx) : reserved -> available ; mouvement RESERVATION_RELEASED.
- commitSale(tx, lotId, qty, ctx) : reserved -> sold ; mouvement SOLD ; statut SOLD_OUT si plus rien.
- expireAvailable(tx, lotId, ctx) : available -> lost ; mouvement EXPIRED ; renvoie la quantité perdue.
- returnAvailable(tx, lotId, qty, ctx, finalStatus) : available -> lost ; mouvement RETURNED ; statut RETURNED ou
  WITHDRAWN.
Utilise Prisma.Decimal pour toute arithmétique. Chaque fonction relit le lot après écriture et appelle assertInvariant.

Tests :
- unitaires : invariant (cas valides et invalides), computeLotStatus (tableau de cas) ;
- intégration : 10 appels reserve EN PARALLÈLE (Promise.all, chacun dans sa transaction) sur un lot de 100 avec des
  demandes de 15 -> exactement 6 réussissent (90 réservés), 4 échouent en INSUFFICIENT_STOCK, l'invariant tient,
  la somme des StockMovement égale les compteurs ; cycle reserve -> release ; reserve -> commitSale.
Commit: feat(stock): add the transactional stock service with anti-oversell reservation
```

### P2.4 — Validation et suivi par le staff

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : l'équipe valide, rejette, retourne les lots, note leur qualité et consulte le journal de stock.
Lis d'abord : src/services/stock.service.js, src/utils/dto/lot.dto.js, src/middlewares/capability.middleware.js,
src/utils/audit.js, src/controllers/supplierLot.controller.js.

Crée src/controllers/staffLot.controller.js et src/routes/staff.routes.js (monté sur /api/v2/staff, protect +
requireCapability('STOCK_VALIDATION') pour les routes de ce prompt). Routes :
- GET /api/v2/staff/lots?status=&supplierId=&productId= (paginé, DTO staff avec identité du fournisseur) ;
  GET /api/v2/staff/lots/:id.
- POST /api/v2/staff/lots : création au nom d'un fournisseur (mêmes champs que P2.2 + supplierUserId) ;
  createdByAgentId = req.agent.id si l'acteur est un agent.
- POST /api/v2/staff/lots/:id/validate : exige PENDING_VALIDATION et que le fournisseur ait
  profileVerificationStatus VERIFIED (sinon 409, code NOT_VERIFIED) ; appelle receiveLot ; renseigne
  validatedAt et validatedByAgentId ; AuditLog LOT_VALIDATED.
- POST /api/v2/staff/lots/:id/reject { reason } : PENDING_VALIDATION -> REJECTED ; reason obligatoire ; audit.
- POST /api/v2/staff/lots/:id/return { reason } : AVAILABLE ou FULLY_RESERVED sans réservation -> RETURNED ; audit.
- POST /api/v2/supplier/lots/:id/withdraw (côté fournisseur) : autorisé si quantityReserved = 0 et lot AVAILABLE ->
  WITHDRAWN via returnAvailable ; audit.
- GET /api/v2/staff/stock-movements?lotId= (paginé).
- POST /api/v2/staff/lots/:id/quality-checks { grade: 'A'|'B'|'C', notes? } : lot PENDING_VALIDATION, AVAILABLE ou
  FULLY_RESERVED ; crée un LotQualityCheck (inspecteur = utilisateur, + agent si présent), met StockLot.qualityGrade à
  la dernière note ; audit LOT_QUALITY_CHECKED. GET /api/v2/staff/lots/:id/quality-checks : historique.
Table des transitions de lot dans src/services/lot.state.js ; toute transition interdite -> 409
INVALID_STATE_TRANSITION.
Tests : validation d'un lot ; refus si fournisseur non vérifié ; transitions invalides ; mouvement RECEIVED créé ;
audit écrit ; AGENT sans STOCK_VALIDATION -> 403 ; retrait fournisseur avec réservation -> 409 ;
note de qualité enregistrée et grade du lot mis à jour ; grade invalide -> 400.
Commit: feat(lots): let staff validate, reject, return, inspect and trace consigned lots
```

### P2.5 — Annonces publiées par l'équipe

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : l'équipe publie des annonces à partir des lots validés. L'annonce est la SEULE chose que voient les
acheteurs ; le lot reste interne.
Modèle : StockLot = déclaration interne du promoteur (prix convenu, quantités). Listing = offre publique avec un prix
public fixé par l'équipe (c'est ainsi que les prix sont contrôlés). ListingLot relie l'annonce à son lot.
Lis d'abord : src/services/stock.service.js, src/utils/dto/lot.dto.js, src/controllers/staffLot.controller.js,
src/utils/audit.js, src/utils/lookupCache.js, src/utils/cloudinaryUpload.js, modèles Listing, ListingLot,
ListingStatus, StockLot, Media.

À CRÉER : src/services/listing.service.js, src/controllers/staffListing.controller.js,
src/validators/listing.validator.js, src/utils/dto/listing.dto.js (listingToStaffDto) ; routes dans staff.routes.js
(capability LISTING_MANAGEMENT ; ADMIN et ROOT toujours autorisés).
- POST /api/v2/staff/listings (multipart facultatif, champ `images`, 5 maximum) { lotIds:[id], title, description?,
  unitPrice?, zoneId? } :
  * AU MVP une annonce = EXACTEMENT UN lot (400 'Une annonce correspond à un seul lot' sinon) ; le lot doit être
    AVAILABLE avec quantityAvailable > 0 ; un lot déjà relié à une annonce (quel que soit son statut) -> 409
    'Lot déjà relié à une annonce' (on réutilise publish / unpublish) ;
  * productId = celui du lot (ignorer toute valeur du client) ; unitPrice par défaut = agreedUnitPrice du lot ;
    zoneId par défaut = zone du lot ; statut DRAFT ; reference = 'ANN-' + id sur 6 chiffres, écrite juste après
    l'insertion ;
  * photos : celles envoyées ; sinon copie des photos du lot (nouvelles lignes Media ownerListingId reprenant url et
    publicId, isPrivate false) ;
  * crée la ligne ListingLot ; createdByUserId = utilisateur, createdByAgentId = req.agent?.id ; audit LISTING_CREATED.
- PATCH /api/v2/staff/listings/:id { title, description, unitPrice, zoneId } : annonce DRAFT, ACTIVE ou INACTIVE ; tout
  changement de unitPrice est écrit dans l'audit avec ancienne et nouvelle valeur (metadata).
- POST /api/v2/staff/listings/:id/publish : DRAFT ou INACTIVE -> ACTIVE si le lot est AVAILABLE avec stock > 0 ;
  publishedAt ; audit LISTING_PUBLISHED. POST /api/v2/staff/listings/:id/unpublish : ACTIVE -> INACTIVE ; audit.
- GET /api/v2/staff/listings?status=&productId=&supplierId= (paginé) ; GET /api/v2/staff/listings/:id : DTO staff avec le lot et
  le promoteur.
- Statut automatique : listing.service exporte syncListingsForLot(tx, lotId) : annonce ACTIVE dont tous les lots sont
  SOLD_OUT -> SOLD ; dont tous les lots sont EXPIRED, RETURNED, WITHDRAWN ou REJECTED -> INACTIVE.
  MODIFICATION AUTORISÉE de stock.service.js : ajouter l'appel à syncListingsForLot à la fin de chaque fonction qui change
  un lot, sans rien changer d'autre.
Tests : 2 lots -> 400 ; lot non AVAILABLE refusé ; second annonce sur le même lot -> 409 ; unitPrice par défaut = prix
convenu ; changement de prix tracé dans l'audit ; publication et dépublication ; annonce SOLD automatique quand le lot est
épuisé (commitSale) ; annonce INACTIVE quand le lot expire ; AGENT sans LISTING_MANAGEMENT -> 403 ; photos copiées du lot.
Commit: feat(listings): let staff publish buyer-facing listings from validated stock lots
```

### P2.6 — Catalogue acheteur anonymisé

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : l'acheteur ne voit que les annonces ACTIVE, sans aucune fuite d'identité ni de donnée interne.
Lis d'abord : src/utils/dto/listing.dto.js, modèles Listing, ListingLot, StockLot, Product, Zone, Media.

Crée src/controllers/catalog.controller.js, src/routes/catalog.routes.js (monté sur /api/v2/catalog, protect ;
rôles BUYER, AGENT, ADMIN, ROOT) et ajoute listingToBuyerDto dans listing.dto.js.
- GET /api/v2/catalog/categories : catégories de produits actives.
- GET /api/v2/catalog/listings?zoneId=&categoryId=&q=&sort=price|recent|expiry (paginé) : annonces ACTIVE dont la quantité
  disponible est > 0 (somme des quantityAvailable de leurs lots non expirés). Champs : id, reference, title, description,
  category, unit, unitPrice, quantityAvailable, expiresAt (la plus proche), zone:{id,name,city}, images:[url],
  qualityGrade (le plus bas de ses lots).
- GET /api/v2/catalog/listings/:id : même DTO ; 404 si l'annonce n'est pas ACTIVE.
INTERDIT dans toute réponse de ce module : lotId, lotCode, supplierId, farmName, agreedUnitPrice, supplierUnitPrice,
pickupAddress, pickupLatitude, pickupLongitude, firstname, lastname, phone, email, createdByUserId, createdByAgentId,
validatedByAgentId.

Crée tests/helpers/assertNoLeak.js : fonction assertNoLeak(body, forbiddenKeys) qui parcourt le JSON de façon
récursive et échoue si une clé interdite est trouvée. Elle sera réutilisée par tous les modules acheteur.
Tests : quantités agrégées ; annonces DRAFT, INACTIVE, SOLD ou sans stock exclues ; tri par prix, récence, péremption ;
assertNoLeak sur les trois routes avec des données réalistes (y compris des photos copiées du lot) ; SUPPLIER -> 403.
Commit: feat(catalog): expose published listings to buyers without internal data
```

---

## PHASE 3 — Messagerie, devis, commandes

### P3.1 — Conversations (REST)

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : conversations client ↔ équipe, jamais acheteur ↔ fournisseur.
Lis d'abord : src/middlewares/capability.middleware.js, src/utils/audit.js, modèles Conversation, Message.

Crée src/controllers/conversation.controller.js (client), src/controllers/staffConversation.controller.js,
src/routes/conversation.routes.js (/api/v2/conversations, protect) et complète src/routes/staff.routes.js.
Client :
- POST /api/v2/conversations { listingId?, lotId?, content } : BUYER -> type BUYER_SUPPORT (listingId = annonce ACTIVE,
  facultatif), SUPPLIER -> SUPPLIER_SUPPORT (lotId = un de SES lots, facultatif ; 404 sinon) ;
  crée la conversation ET le premier message (SenderType CUSTOMER) dans une transaction.
- GET /api/v2/conversations (les siennes, paginé) ; GET /api/v2/conversations/:id/messages (paginé, chronologique,
  SANS les messages isInternal) ; POST /api/v2/conversations/:id/messages { content }.
Équipe (capability BUYER_SUPPORT pour type BUYER_SUPPORT, SUPPLIER_SUPPORT pour l'autre ; ADMIN toujours) :
- GET /api/v2/staff/conversations?status=&unassigned=true&mine=true&escalated=true ;
- POST /api/v2/staff/conversations/:id/assign (soi-même ; un ADMIN peut désigner un agentId) ;
- POST /api/v2/staff/conversations/:id/escalate { reason } -> escalatedAt, escalationReason, désassigne ;
- POST /api/v2/staff/conversations/:id/close ;
- POST /api/v2/staff/conversations/:id/messages { content, isInternal? } : senderType AGENT, senderUserId = utilisateur,
  senderAgentId = req.agent?.id.
Chaque message met à jour lastMessageAt. DTO client : le champ `senderLabel` vaut "Vous" ou "Équipe AgriConnect" ;
AUCUN identifiant d'agent ni d'utilisateur tiers n'est renvoyé au client. Lecture d'une conversation d'autrui -> 404.
Tests : création avec premier message ; client ne voit pas les notes internes ; fil d'un autre client -> 404 ;
assign / escalate / close ; agent sans la capacité du bon type -> 403 ; assertNoLeak côté client.
Commit: feat(messaging): add customer-to-team conversations with assignment and escalation
```

### P3.2 — Temps réel

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : événements Socket.io pour la messagerie. L'authentification du socket et la salle `user:{id}` existent
déjà et NE CHANGENT PAS.
Lis d'abord : src/sockets/chat.socket.js, src/sockets/revocation.js, src/server.js,
tests/integration/socket-revocation.test.js (modèle de test), src/controllers/conversation.controller.js.

1. Crée src/services/message.service.js : createMessage({ conversationId, sender..., content, isInternal }) qui écrit
   le message, met à jour lastMessageAt, et émet l'événement. Les contrôleurs REST de P3.1 doivent l'utiliser
   (refactor sans changer leur comportement visible).
2. chat.socket.js : à la connexion, un utilisateur staff (ADMIN, ROOT, AGENT actif) rejoint la salle `staff`.
   Événements client -> serveur : join_conversation(id) vérifie l'accès (propriétaire, ou staff avec la capacité du
   type) puis joint la salle `conversation:{id}` ; leave_conversation(id) ; send_message({conversationId, content})
   appelle message.service. Accès refusé -> émet error_message, ne joint pas.
3. Événements serveur -> client : `message:new` (message non interne) vers la salle de la conversation ;
   les notes internes vers la salle `staff` UNIQUEMENT ; `conversation:assigned` et `conversation:escalated` vers
   `staff`. Les payloads respectent les mêmes DTO que REST (pas de fuite).
4. Les anciens noms d'événements v1 (`new_message`) disparaissent.
Tests (socket.io-client) : client et agent reçoivent message:new ; le client ne reçoit PAS une note interne ;
join_conversation d'une conversation d'autrui refusé ; compte suspendu : connexion refusée (comportement
conservé) ; escalade notifiée à staff.
Commit: feat(sockets): deliver conversation events in real time to customers and staff
```

### P3.3 — Moteur de prix

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : fonctions pures de calcul, entièrement testées. Aucune route.
Lis d'abord : src/utils/money.js, src/utils/distance.js, tests/unit/money.test.js, modèle PlatformSetting,
modèle AgencyZone.

1. money.js : ajoute roundMoney(value, currency) (XAF -> 0 décimale ; autre devise -> 2 décimales ; arrondi
   "half up") SANS changer les exports existants.
2. Crée src/services/pricing.service.js (fonctions pures, Prisma.Decimal) :
   - computeLine({ quantity, unitPrice, supplierUnitPrice, commissionRate }, currency) -> { lineTotal,
     commissionAmount, supplierNetAmount } avec lineTotal = quantity x unitPrice ;
     base fournisseur = quantity x supplierUnitPrice ; commissionAmount = base x commissionRate ;
     supplierNetAmount = base - commissionAmount.
   - computeBuyerFee(subtotal, { type, value }, currency) : NONE -> 0 ; FIXED -> value ; PERCENT -> subtotal x value.
   - computeDeliveryFee({ baseFee, perKmFee, distanceKm, markupRate }, currency) -> { agencyCost, deliveryFee } avec
     agencyCost = baseFee + perKmFee x distanceKm ; deliveryFee = agencyCost x (1 + markupRate).
   - computeOrderTotals({ lines, buyerFee, deliveryFee }) -> { subtotal, buyerFee, deliveryFee, total, commissionTotal }.
   - getSettings(tx) : lit PlatformSetting id 1 ; absent -> erreur 500 'Paramètres de la plateforme manquants'.
3. Tests unitaires TABLEAU (au moins 15 cas) : arrondis XAF et devise à 2 décimales, commission 0 %, 10 %, 12,5 % ;
   frais acheteur NONE, FIXED, PERCENT ; livraison avec marge 0 et 15 % ; retrait sans livraison ; totaux multi-lignes ;
   quantités décimales (2,5 kg) ; aucun résultat en Number flottant (vérifier le type Decimal).
Commit: feat(pricing): add the pure pricing engine for lines, fees, delivery and totals
```

### P3.4 — Devis

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : l'équipe émet un devis qui réserve le stock et fige les prix.
Lis d'abord : src/services/stock.service.js, src/services/pricing.service.js, src/utils/distance.js,
src/utils/audit.js, modèles Order, OrderItem, AgencyZone, Hub.

Crée src/controllers/staffOrder.controller.js, src/validators/order.validator.js, src/utils/dto/order.dto.js
(orderToStaffDto, orderToBuyerDto) et complète staff.routes.js (capability ORDER_PROCESSING).
POST /api/v2/staff/orders { buyerId, conversationId?, items:[{ listingId, quantity, unitPrice? }], deliveryMode:
'HUB_PICKUP'|'AGENCY_DELIVERY', pickupHubId (si HUB_PICKUP), delivery:{ zoneId, address, latitude, longitude }
(si AGENCY_DELIVERY), notes? }.
UNE transaction qui :
1. vérifie buyerId = utilisateur BUYER actif ; charge chaque annonce ACTIVE et son lot (un seul par annonce au MVP,
   via ListingLot) ; 404 ou 409 sinon ;
2. réserve chaque ligne sur le lot de l'annonce avec stock.reserve (INSUFFICIENT_STOCK annule TOUT) ;
3. unitPrice par défaut = unitPrice de l'ANNONCE (prix public) ; supplierUnitPrice = agreedUnitPrice du LOT, figé ; commissionRate figé depuis
   PlatformSetting ; lignes via computeLine ;
4. frais de livraison (AGENCY_DELIVERY) : trouver l'AgencyZone active de delivery.zoneId (409 'Zone non couverte'
   sinon) ; origines d'enlèvement DISTINCTES (hub, ou site fournisseur) avec leurs coordonnées (409 si manquantes) ;
   somme de computeDeliveryFee par origine avec distance Haversine vers la livraison ;
5. retrait HUB_PICKUP : pickupHubId doit être un hub actif acceptsPickup ; aucun frais de transport ;
6. frais acheteur via computeBuyerFee ; totaux via computeOrderTotals ;
7. crée Order (status QUOTED, reservedUntil = maintenant + reservationHours) puis orderNumber =
   `AC-${année}-` + id sur 6 chiffres ; crée les OrderItem (listingId ET lotId renseignés) ; AuditLog ORDER_QUOTED.
DTO acheteur : lignes par référence et titre d'annonce, montants, statut, deliveryMode, reservedUntil — JAMAIS
supplierId, farmName ni adresse d'enlèvement. DTO staff : tout.
Tests : totaux exacts ; rollback complet si une ligne manque de stock (stock inchangé) ; deux devis concurrents sur le
même lot -> pas de survente ; zone non couverte 409 ; DTO acheteur sans fuite (assertNoLeak) ; buyerId d'un non-acheteur 400.
Commit: feat(orders): let staff issue quotes that reserve stock and freeze prices
```

### P3.5 — Cycle de vie de la commande

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : confirmation, annulation et machine à états de la commande.
Lis d'abord : src/services/stock.service.js, src/utils/dto/order.dto.js, src/controllers/staffOrder.controller.js,
src/utils/audit.js.

Crée src/services/order.state.js : table des transitions
QUOTED -> CONFIRMED | CANCELLED ; CONFIRMED -> PREPARING | CANCELLED ; PREPARING -> READY_FOR_PICKUP (HUB_PICKUP seulement)
| OUT_FOR_DELIVERY (AGENCY_DELIVERY seulement, posé par les livraisons en P5.3, interdit en manuel) | CANCELLED ;
READY_FOR_PICKUP -> COMPLETED ; OUT_FOR_DELIVERY -> COMPLETED. Transition interdite -> 409 INVALID_STATE_TRANSITION.
Crée src/services/order.service.js avec : confirmOrder, cancelOrder, completeOrder, changeStatus (toutes
transactionnelles, avec AuditLog).
Routes acheteur (/api/v2/orders, protect + BUYER) : GET /api/v2/orders ; GET /api/v2/orders/:id (404 si pas la sienne) ;
POST /api/v2/orders/:id/confirm ; POST /api/v2/orders/:id/cancel (seulement QUOTED).
Routes staff (ORDER_PROCESSING) : GET /api/v2/staff/orders ; GET /api/v2/staff/orders/:id ; PATCH
/api/v2/staff/orders/:id/status { status, force? } ; POST /api/v2/staff/orders/:id/confirm ; POST /api/v2/staff/orders/:id/cancel.
Effets :
- confirm : refusé si reservedUntil est dépassé (409 'Devis expiré', et libération des réservations) ; sinon
  confirmedAt, reservedUntil = null.
- cancel : libère chaque réservation (RESERVATION_RELEASED), cancelledAt, cancellationReason.
- COMPLETED : commitSale sur chaque ligne (réservé -> vendu), completedAt.
- PREPARING : exige paymentStatus PAID ; `force: true` autorisé aux ADMIN et plus seulement, tracé dans l'audit.
Ne crée PAS encore de reversement (P4.2).
Tests : machine à états (chaque transition valide et interdite) ; confirmation après expiration ; annulation libère le
stock (compteurs et mouvements) ; completion convertit réservé en vendu ; PREPARING sans paiement 409 ; force réservé
aux admins ; commande d'un autre acheteur 404.
Commit: feat(orders): add buyer confirmation, cancellation and the order state machine
```

---

## PHASE 4 — Argent

### P4.1 — Paiements manuels

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : enregistrer les paiements à la main, de façon idempotente.
Lis d'abord : src/services/order.service.js, src/utils/audit.js, src/middlewares/capability.middleware.js,
modèle Payment.

1. Crée src/middlewares/humanActor.middleware.js : requireHumanActor refuse (403) si req.agent?.kind === 'AI'.
   Toute route qui déplace de l'argent l'utilise.
2. Crée src/services/payment.service.js et complète staff.routes.js (capability PAYMENT_FOLLOWUP, ADMIN toujours) :
   POST /api/v2/staff/orders/:id/payments { amount, method, reference?, paidAt? } avec l'en-tête OBLIGATOIRE
   Idempotency-Key (400 sinon). Même clé = même résultat : renvoie le paiement d'origine (HTTP 200) sans doublon,
   même en cas d'appels concurrents (s'appuie sur la contrainte unique ; capture l'erreur P2002 et relis).
   Le paiement est créé CONFIRMED. Refuser un montant <= 0 ou supérieur au solde dû (409 'Montant supérieur au solde').
   Recalcule Order.paymentStatus : somme des paiements CONFIRMED = 0 -> UNPAID, < total -> PARTIALLY_PAID,
   >= total -> PAID. Commande CANCELLED -> 409.
   GET /api/v2/staff/orders/:id/payments.
   POST /api/v2/staff/payments/:id/refund (ADMIN et plus) : CONFIRMED -> REFUNDED, recalcul du statut ; audit.
3. AuditLog PAYMENT_RECORDED et PAYMENT_REFUNDED dans la même transaction.
Tests : paiement partiel puis complet ; surpaiement 409 ; même clé deux fois -> un seul paiement ; deux requêtes
simultanées avec la même clé -> un seul paiement ; clé absente 400 ; remboursement ; agent sans capacité 403.
Commit: feat(payments): record manual payments idempotently and track the order payment status
```

### P4.2 — Reversements fournisseurs

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : générer et régler les reversements.
Lis d'abord : src/services/order.service.js, src/services/payment.service.js, src/middlewares/humanActor.middleware.js,
modèles SupplierPayout, PayoutAccount.

1. Crée src/services/payout.service.js :
   - createPayoutsForOrder(tx, order) : regroupe les OrderItem par fournisseur (via lot.supplierId) ; un
     SupplierPayout par fournisseur : grossAmount = somme(quantité x supplierUnitPrice),
     commissionAmount = somme des commissions de ligne, netAmount = gross - commission, statut ON_HOLD,
     payoutAccountId = compte par défaut du fournisseur (peut être null). Appelée DANS la transaction de
     confirmOrder (modifie P3.5 : ajoute seulement cet appel).
   - refreshPayoutReadiness(tx, orderId) : ON_HOLD -> READY quand la commande est COMPLETED ET PAID. Appelée
     depuis completeOrder et depuis l'enregistrement d'un paiement.
   - cancelPayoutsForOrder(tx, orderId) : ON_HOLD ou READY -> CANCELLED (annulation de commande, remboursement total).
2. Fournisseur : GET /api/v2/supplier/payouts (paginé) : montants, statut, référence, dates ; AUCUNE donnée acheteur.
3. Admin (ADMIN et plus, requireHumanActor) : GET /api/v2/admin/payouts?status= (vue complète avec numéro de compte
   complet) ; PATCH /api/v2/admin/payouts/:id/pay { reference, payoutAccountId? } : seulement READY (409 sinon) ->
   PAID, paidAt, paidById ; audit PAYOUT_PAID.
Tests : un fournisseur = un reversement ; deux fournisseurs dans une commande = deux reversements aux bons montants ;
passage READY seulement quand COMPLETED et PAID (les deux ordres d'événements) ; paiement d'un reversement non READY 409 ;
annulation de commande annule les reversements ; la contrainte unique (commande, fournisseur) tient ; assertNoLeak côté
fournisseur.
Commit: feat(payouts): generate and settle supplier payouts from confirmed orders
```

---

## PHASE 5 — Livraison

### P5.1 — Agences et tarifs

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : administrer l'agence de transport, ses zones et ses tarifs.
Lis d'abord : src/controllers/referential.controller.js, src/utils/audit.js, modèles TransportAgency, AgencyZone.

Crée src/controllers/agency.controller.js, src/validators/agency.validator.js, src/services/agency.service.js et monte
dans admin.routes.js (ADMIN et plus) : GET, POST, PATCH /:id sur /api/v2/admin/agencies (nom, contact, téléphone,
assurance : fournisseur, numéro de police, date d'expiration, isActive) ;
PUT /api/v2/admin/agencies/:id/zones/:zoneId { baseFee, perKmFee, isActive } ; DELETE du même chemin ;
GET /api/v2/admin/agencies/:id/drivers.
agency.service : findActiveAgencyForZone(zoneId) retourne l'agence active couvrant la zone (au MVP : la première par id) ;
409 'Zone non couverte' sinon ; 409 'Assurance de l'agence expirée' si insuranceExpiresAt est passée.
Audit sur chaque modification. Tarifs négatifs refusés.
Tests : CRUD ; tarif par zone ; zone non couverte ; assurance expirée refusée ; accès refusé à un non-admin.
Commit: feat(delivery): administer transport agencies, zone coverage and tariffs
```

### P5.2 — Création des livraisons

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : une livraison par point d'enlèvement, avec assurance et frais figés.
Lis d'abord : src/services/agency.service.js, src/services/pricing.service.js, src/utils/distance.js,
src/services/order.service.js, modèles Delivery, OrderItem.

Complète staff.routes.js (capability DISPATCH_COORDINATION) :
POST /api/v2/staff/orders/:id/deliveries : commande AGENCY_DELIVERY en statut PREPARING seulement.
Dans une transaction : regroupe les OrderItem par origine (clé `hub:{id}` si le lot est en hub, sinon `site:{supplierId}`) ;
pour chaque groupe crée une Delivery : agencyId via findActiveAgencyForZone(order.deliveryZoneId), champs d'enlèvement
(hub ou lot.pickup*), dropoff = adresse de la commande, distanceKm (Haversine), agencyCost et deliveryFee via
computeDeliveryFee, insuredValue = somme des lineTotal du groupe, insurancePolicyNumber figé depuis l'agence ;
renseigne OrderItem.deliveryId. Si des livraisons existent déjà -> 409 (idempotence). Audit DELIVERIES_CREATED.
GET /api/v2/staff/deliveries?status=&orderId= (paginé).
Tests : un seul fournisseur -> une livraison dont deliveryFee égale celui du devis ; deux origines -> deux livraisons ;
refus si la commande n'est pas PREPARING ; refus si déjà créées ; assurance expirée 409 ; insuredValue correcte.
Commit: feat(delivery): create deliveries per pickup origin with insurance and fee snapshots
```

### P5.3 — Dispatch du livreur

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : le livreur choisit ses courses (modèle « pull »), acceptation atomique.
Lis d'abord : src/sockets/chat.socket.js, src/services/order.service.js, src/services/payout.service.js,
modèles Delivery, DriverProfile.

Crée src/controllers/driverDelivery.controller.js, src/routes/driver.routes.js (/api/v2/driver, protect +
requireRole('DRIVER')) et src/services/delivery.state.js (PENDING -> ACCEPTED -> PICKED_UP -> IN_TRANSIT -> DELIVERED ;
FAILED depuis PICKED_UP ou IN_TRANSIT ; CANCELLED seulement par le staff).
- GET /api/v2/driver/deliveries/available : livraisons PENDING sans livreur, de l'agence du livreur, paginées.
  DTO : adresses, nom et téléphone du destinataire, distance, nature de la marchandise. JAMAIS de prix ni de montant.
- GET /api/v2/driver/deliveries/mine?status=.
- POST /api/v2/driver/deliveries/:id/accept : refuse (409) si le livreur a une livraison ACCEPTED, PICKED_UP ou IN_TRANSIT ;
  acceptation ATOMIQUE : tx.delivery.updateMany({ where:{ id, status:'PENDING', driverId:null, agencyId }, data:{ driverId,
  status:'ACCEPTED', acceptedAt } }) ; count 0 -> 409 'Course déjà prise'.
- PATCH /api/v2/driver/deliveries/:id/status { status, failureReason? } (propriétaire seulement ; failureReason obligatoire pour
  FAILED) ; pickedUpAt et deliveredAt renseignés.
Synchronisation de la commande dans la même transaction : premier PICKED_UP -> commande OUT_FOR_DELIVERY ; toutes les livraisons
DELIVERED -> completeOrder (vente validée, reversements prêts via refreshPayoutReadiness).
Sockets : à la création des livraisons, un événement `delivery:available` vers la salle `agency:{id}` (les livreurs rejoignent
`agency:{agencyId}` à la connexion) ; `delivery:status` vers `staff` et vers l'acheteur concerné (payload sans prix).
Tests : 5 livreurs acceptent EN PARALLÈLE la même course -> un seul gagnant, 4 x 409 ; seconde course refusée ; livraison d'une
autre agence invisible ; DTO sans prix (assertNoLeak) ; flux complet -> commande COMPLETED, stock vendu, reversement READY si payé ;
FAILED sans motif 400.
Commit: feat(delivery): add the pull dispatch for drivers with atomic acceptance
```

---

## PHASE 6 — Parrainage, indemnisation, tâches planifiées, tableau de bord

### P6.1 — Parrainage

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : récompenses de parrainage à montant fixe.
Lis d'abord : le contrôleur de vérification (P1.6), src/utils/audit.js, src/middlewares/humanActor.middleware.js,
modèle Referral, PlatformSetting.

1. Crée src/services/referral.service.js : onProfileVerified(tx, userId) — appelée depuis la validation d'un profil (P1.6),
   dans la MÊME transaction. Pour le Referral PENDING du filleul : si le parrain est lui-même VERIFIED -> ELIGIBLE, rewardAmount =
   referralBuyerReward (kind BUYER) ou referralSupplierReward (kind SUPPLIER) lu dans PlatformSetting, eligibleAt = maintenant ;
   si le parrain n'est pas vérifié, reste PENDING. Quand un parrain DEVIENT vérifié, réévalue ses filleuls déjà vérifiés.
2. Utilisateur : GET /api/v2/auth/me/referral -> { code, totals:{ pending, eligible, paid }, referrals:[{ status, kind,
   rewardAmount, createdAt, referredFirstname }] } (prénom seul du filleul, rien d'autre).
3. Admin (ADMIN et plus, requireHumanActor) : GET /api/v2/admin/referrals?status= ; PATCH /api/v2/admin/referrals/:id/pay
   { reference } (ELIGIBLE -> PAID, paidAt) ; PATCH /api/v2/admin/referrals/:id/reject { reason } (PENDING ou ELIGIBLE -> REJECTED).
   Transitions invalides 409. Audit.
Tests : filleul vérifié + parrain vérifié -> ELIGIBLE avec le bon montant ; parrain non vérifié -> reste PENDING puis passe
ELIGIBLE quand il est vérifié ; paiement unique (double paiement 409) ; rejet motivé ; montant figé même si PlatformSetting change ensuite.
Commit: feat(referral): grant fixed-amount rewards when referred users are verified
```

### P6.2 — Indemnisation des fournisseurs

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : indemniser les invendus ou pertes, avec validation humaine.
Lis d'abord : src/services/stock.service.js, src/services/pricing.service.js, src/middlewares/humanActor.middleware.js,
modèle SupplierCompensation.

1. Crée src/services/compensation.service.js :
   - createForLoss(tx, { lot, quantity, reason, deliveryId?, note? }) : amount = roundMoney(quantity x agreedUnitPrice x
     expiryCompensationRate) ; si le taux vaut 0, ne crée rien ; statut PENDING_APPROVAL ; rate figé.
2. Staff : POST /api/v2/staff/compensations { lotId, reason, quantity, deliveryId?, note } (capability DISPUTE_HANDLING ; ADMIN
   toujours) ; quantité > quantité du lot -> 400.
3. Admin (ADMIN et plus, requireHumanActor) : GET /api/v2/admin/compensations?status= ; PATCH /:id/approve ; PATCH /:id/reject
   { note } ; PATCH /:id/pay { reference } ; transitions PENDING_APPROVAL -> APPROVED | REJECTED, APPROVED -> PAID ; invalide ->
   409 ; audit.
4. Fournisseur : GET /api/v2/supplier/compensations (paginé) : motif, quantité, montant, statut.
Tests : montant (arrondi XAF) ; taux 0 -> aucune indemnisation ; cycle complet ; paiement d'une indemnisation non approuvée 409 ;
un AGENT sans capacité 403 ; fournisseur ne voit que les siennes.
Commit: feat(compensation): compensate suppliers for expired or lost goods with an approval flow
```

### P6.3 — Tâches planifiées

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.
Dépendance npm autorisée : node-cron.

Objectif : automatiser les expirations, de façon idempotente.
Lis d'abord : src/server.js, src/services/stock.service.js, src/services/order.service.js,
src/services/compensation.service.js, src/utils/audit.js.

Crée src/jobs/ avec trois fonctions asynchrones exportées, chacune prenant `now` en paramètre (testables) :
- releaseExpiredReservations(now) : commandes QUOTED avec reservedUntil < now -> annulées (raison 'Devis expiré'), réservations
  libérées, audit avec acteur système.
- expireLots(now) : lots AVAILABLE ou FULLY_RESERVED dont expiresAt < now et quantityAvailable > 0 -> expireAvailable, puis
  createForLoss (raison EXPIRED_UNSOLD). Statut EXPIRED seulement si plus rien n'est réservé ; sinon le lot sera retraité à la
  prochaine exécution quand la réservation aura été résolue.
- expiryAlerts(now) : lots expirant sous 48 h et assurances d'agence expirant sous 30 jours -> événement socket `alert:expiring`
  vers `staff` (aucune écriture en base).
src/jobs/index.js : planifie avec node-cron (réservations toutes les 5 minutes, lots toutes les heures, alertes chaque jour à
7 h). server.js démarre les jobs sauf si NODE_ENV === 'test' ou DISABLE_JOBS === 'true' ; documente DISABLE_JOBS dans .env.example.
Tests (appel direct avec un `now` contrôlé) : devis expiré annulé et stock libéré ; lot périmé -> perte + indemnisation
PENDING_APPROVAL ; lot avec réservation active reste traité plus tard ; DEUXIÈME exécution immédiate = aucun doublon (idempotence) ;
alertes émises sans écriture.
Commit: feat(jobs): schedule reservation release, lot expiry and alerts
```

### P6.4 — Tableau de bord et audit

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : indicateurs d'exploitation et consultation du journal d'audit.
Lis d'abord : src/routes/admin.routes.js, modèles Order, StockLot, SupplierPayout, Referral, SupplierCompensation, AuditLog.

1. GET /api/v2/admin/stats?from=&to= (ADMIN et plus) -> { usersByRole, lotsByStatus, ordersByStatus, deliveriesByStatus,
   stock:{ available, reserved, sold, lost }, receivables (montant total des commandes CONFIRMED non PAID), pendingPayouts
   (somme netAmount READY et ON_HOLD), pendingCompensations (nombre et montant), eligibleReferrals (nombre et montant),
   grossRevenue } avec grossRevenue = somme(commissionTotal + buyerFee + (deliveryFee - agencyCost)) des commandes COMPLETED
   sur la période. Calculs côté Prisma.Decimal.
2. GET /api/v2/admin/audit-logs?entityType=&entityId=&actorUserId=&actorAgentId=&from=&to= (paginé, ordre antichronologique).
Tests : jeu de données connu -> chiffres exacts (y compris grossRevenue) ; filtres d'audit ; accès refusé à un AGENT sans rôle admin.
Commit: feat(admin): add the operations dashboard and audit log browsing
```

---

## PHASE 7 — Finition

### P7.1 — Confidentialité et sécurité

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.
Dépendance npm autorisée : helmet.

Objectif : verrouiller la règle d'or et les actions financières.
Lis d'abord : tests/helpers/assertNoLeak.js, src/app.js, src/middlewares/error.middleware.js, tous les fichiers src/utils/dto/.

1. tests/integration/privacy.test.js : monte un scénario complet (acheteur, fournisseur, agent, livreur, lot, devis, commande,
   livraison) et appelle CHAQUE route accessible à BUYER, SUPPLIER et DRIVER ; applique assertNoLeak avec les clés interdites
   adaptées au rôle (acheteur : lotId, lotCode, supplierId, farmName, agreedUnitPrice, supplierUnitPrice, pickupAddress, pickupLatitude,
   pickupLongitude, phone et email d'un tiers ;
   fournisseur : tout identifiant ou nom d'acheteur ; livreur : tout montant ou prix).
2. tests/integration/financial-actions.test.js : un agent kind AI ne peut recevoir PAYMENT_FOLLOWUP ; chaque route d'argent
   (paiement, remboursement, reversement, indemnisation, parrainage) renvoie 403 pour un AGENT sans la capacité ET pour un agent AI.
3. app.js : ajoute helmet() ; vérifie que errorHandler ne journalise ni corps de requête ni mots de passe ; supprime tout console.log
   qui affiche une donnée personnelle.
4. Passe en revue chaque contrôleur : aucun ne renvoie un objet Prisma brut à un rôle non staff. Liste les écarts corrigés dans le
   commit.
Commit: test(security): enforce identity confidentiality and human-only financial actions
```

### P7.2 — Documentation

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : documenter l'API, l'environnement et l'exploitation.
Lis d'abord : README.md, .env.example, src/routes/*.js.

1. README.md : stack, installation, variables d'environnement (y compris DISABLE_JOBS), scripts npm (seed, seed:dev, create:root,
   test), tableau des routes par rôle, description des tâches planifiées, règles de confidentialité.
2. docs/openapi.yaml (OpenAPI 3.0) : TOUTES les routes montées dans src/routes, avec méthode, rôle requis, paramètres, schéma du corps
   Joi, schémas de réponse et codes d'erreur (400, 401, 403, 404, 409 avec leur `code`). Génère-le en lisant les routes et les
   validators ; ne rien inventer.
3. docs/CHANGELOG_V2.md : différences v1 -> v2 (routes supprimées, ajoutées, modèles, rôles).
4. Retire de .env.example toute variable devenue inutile.
Critère : toute route de src/routes figure dans openapi.yaml (écris un test qui compare les deux listes).
Commit: docs(api): document the v2 API, environment and operations
```

### P7.3 — Vérification finale

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : valider la branche avant fusion. Aucune modification de code applicatif.
1. npm ci ; npm audit ; npx prisma validate ; npm test ; npx prisma migrate status.
2. Vérifie dans le code chaque critère transversal : aucun UUID restant ; aucune route v1 marketplace ; module auth intact (git diff
   development -- src/utils/session.js src/utils/refreshToken.js src/utils/jwt.js src/utils/emailVerification.js
   src/utils/passwordReset.js src/sockets/revocation.js doit être VIDE) ; toute route d'argent protégée par requireHumanActor.
3. Écris docs/RELEASE_CHECK_V2.md : résultats des commandes, liste des écarts, TODO restants, résultat du diff ci-dessus.
Commit: docs(release): record the v2 verification report
```

Fusion *(manuel, toi)* : pull request `feature/v2-consignation` → `development`, après lecture de `RELEASE_CHECK_V2.md`.

---

## 6. Errata — écarts des cahiers des charges v2.0

Les cahiers publiés plus tôt contiennent des hypothèses que le dépôt contredit. **En cas de conflit, ce plan prévaut.** Je régénère les cahiers en v2.1 sur demande.

| Cahier v2.0 | Réalité du dépôt / décision |
|---|---|
| PostgreSQL | **MySQL** |
| UUID | **Int** autoincrement |
| express-validator | **Joi** |
| `/api/v2/v1/...`, `/auth/*`, `/me/*` | `/api/v2/...`, `/api/v2/auth/*`, `/api/v2/auth/me/*` |
| Login par téléphone | Login par **email** |
| Réponses `{ data, meta }` | Objet brut ; listes `{ items, page, limit, total }` |
| Erreurs `{ error:{ code, message } }` | `{ error, code? }` (+ `details` pour la validation Joi) |
| `fullName`, `passwordHash`, `RefreshToken.tokenHash` | `firstname/lastname`, `password`, `RefreshToken.token` (haché) |
| `Role` enum | Table lookup `Role` (`FARMER` devient `SUPPLIER`) |
| `verificationStatus` | `profileVerificationStatus` |
| `LotImage`, `VerificationDocument.fileUrl` | Lignes `Media` |
| `capabilities AgentCapability[]` | Table de liaison `AgentCapabilityLink` |
| `TermsAcceptance.document + version` (texte) | `versionId` vers `LegalDocumentVersion` (FR/EN) |
| `DriverProfile.isAvailable`, RG-62, interrupteur Flutter §4.3 | Supprimés : disponibilité déduite |
| Catalogue par produit, offres = lots anonymisés (`lotCode`) | L'acheteur consulte des **annonces** (`Listing`, `reference` ANN-…), publiées par l'équipe avec un prix public ; le `StockLot` reste interne |
| `Conversation.productId` | `listingId` (acheteur) et `lotId` (promoteur) |
| 8 capacités d'agent | 9 : ajout de `LISTING_MANAGEMENT` |
| Table `Listing` supprimée, `StockLot` seul | `Listing` **conservée** (annonce publique) à côté de `StockLot` (stock interne) |

---

## 7. Risques et points d'attention

| Risque | Mitigation |
|---|---|
| Modèles gratuits qui dérivent ou inventent | Prompts courts, périmètre de fichiers fermé, clause « ARRÊTE-TOI et demande », une session par prompt |
| Migration destructive (C4) | Faite sur une base de développement ; sauvegarde avant P0.4 si la base contient autre chose que des tests |
| Documents d'identité exposés | Cloudinary mode privé, URL signée 10 minutes, jamais d'URL dans les listes (P1.6) |
| Survente et double clic | Mise à jour conditionnelle + tests de concurrence (P2.3, P5.3) |
| Double paiement | `Idempotency-Key` + contrainte unique (P4.1) |
| Fuite d'identité acheteur / fournisseur | DTO par rôle + `assertNoLeak` partout + revue finale (P7.1) |
| Textes juridiques provisoires | Marqués comme tels dans la base ; **à faire relire par un juriste avant le lancement** |
| Écart entre prix public et prix convenu (C8) | À trancher avant la production ; les deux prix sont figés par ligne de commande et tout changement de prix d'annonce est tracé dans l'audit |
| Garantie de prix = risque d'invendu porté par AgriConnect | Taux d'indemnisation configurable (`expiryCompensationRate`), approbation humaine obligatoire |
| MySQL : `prisma migrate dev` exige le droit de créer une base fantôme | L'utilisateur MySQL de développement doit avoir ce droit (déjà le cas pour la base de test) |
