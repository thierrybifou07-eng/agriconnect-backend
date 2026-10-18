# AgriConnect Backend — Plan d'implémentation v2 (prompts pour OpenCode)

**Date :** 8 octobre 2026 · **Dépôt :** `thierrybifou07-eng/agriconnect-backend`
**Branche de travail :** `feature/dev-v2` (créée depuis `development`, commit `d83ce69`, état final de la v1)
**Progression :** P0.2 à P6.1, S1 à S6 réalisés. **Prochaine étape : S7 (références de paiement), puis P6.2.**
**Base :** MySQL · identifiants **Int** · module auth de la v1 **conservé**

Ce document remplace `PLAN_REFORME_V2.md` de l'ancienne branche. Il est conçu pour des modèles gratuits : prompts courts, périmètre fermé, critères de sortie vérifiables, **un prompt = un commit**.

---

## 1. Point de départ (constat sur le dépôt)

- `development` = v1 complète, auth terminée (sessions, rotation des refresh tokens, suspension, vérification d'email, mot de passe oublié). Elle utilise **déjà des identifiants Int**.
- L'ancienne branche `refactor/schema-v2-consignation` contient une « Phase 0 » construite sur mon premier schéma : identifiants **UUID**, `fullName`, `passwordHash`. Elle est **incompatible** avec l'auth v1 (`firstname/lastname`, `password`, login par email). Elle est **archivée telle quelle** (jamais fusionnée, jamais supprimée).
- La v1 stocke ses référentiels dans des **tables lookup** (`Role`, `UserStatus`, …) et ses machines à états dans des **enums**. Le plan garde cette convention.
- Format des erreurs v1 : `{ "error": "message" }`. Validation : Joi. Préfixe d'API : `/api/v2`. Montants : `Decimal` converti en nombre par `decimal-json.middleware.js`.

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
| M5 | Suppression de `PATCH /api/auth/me/availability` et de `updateAvailability` | D7 : la disponibilité d'un livreur se déduit (compte ACTIVE et aucune livraison en cours). **Conséquence côté Flutter : pas d'interrupteur « Je suis disponible »** | `auth.routes.js`, `user.controller.js` |
| M6 | `userToApi`, sélection de `protect` et `userSafeSelect` : retrait de `vehicleType` et `isAvailable`, ajout de `profileVerificationStatus` et `referralCode`. `GET /api/auth/me` renvoie en plus l'objet `profile` du rôle | Cohérence avec M1 | `userApi.js`, `auth.middleware.js`, `admin.controller.js`, `user.controller.js` |
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
| C5 | Documents d'identité | Stockés sur disque dans un dossier **privé** sous `uploads/<type>/`, jamais servi statiquement ; le staff y accède par un lien signé de courte durée, lié à son compte et journalisé dans l'audit |
| C6 | Charge de l'agent `AI` | Un agent IA ne peut jamais avoir la capacité `PAYMENT_FOLLOWUP` ni agir sur l'argent |
| C7 | Annonce et lot | **Une annonce = un lot** au MVP (règle de code). La table `ListingLot` permet d'en agréger plusieurs plus tard sans migration. Le prix public est fixé par l'équipe ; par défaut il égale le prix convenu avec le promoteur. Nouvelle capacité d'agent : `LISTING_MANAGEMENT` (publication des annonces) |
| C8 | **À TRANCHER** : écart de prix | Si l'équipe fixe un prix public supérieur au prix convenu, qui garde l'écart ? Les deux prix sont figés sur chaque ligne de commande. Par défaut : le promoteur est payé sur le prix convenu moins la commission, et l'écart éventuel est un revenu AgriConnect |

---

## 4. PRÉAMBULE (OpenCode lit cette section avant chaque prompt)

```
CONTEXTE
Projet : agriconnect-backend, branche feature/dev-v2.
Stack : Node.js ESM, Express 5, Prisma 6 + MySQL, Joi 18, Socket.io, stockage local des fichiers, Vitest + supertest.
Source de vérité du schéma : prisma/schema.prisma ET docs/schema.v2.target.prisma, toujours IDENTIQUES.

RÈGLES ABSOLUES
1. Identifiants entiers (Int). Jamais d'UUID. Toute route avec :id passe par coerceIdParam.
2. Préfixe d'API : /api/v2. Dans les prompts, toute route écrite "/api/xxx" se lit "/api/v2/xxx", et "/me/*"
   est /api/v2/auth/me/*. src/routes/router.js peut être modifié UNIQUEMENT pour monter un nouveau routeur.
3. Erreurs : res.status(n).json({ error: 'message en français' }) ; erreurs levées :
   Object.assign(new Error('message'), { statusCode: 409, code: 'CODE_MAJUSCULE' }).
   Succès : objet brut. Listes paginées : { items, page, limit, total }.
4. Validation : Joi via middlewares/validate.middleware.js (lire ce fichier d'abord).
5. Argent et quantités : Prisma.Decimal et utils/money.js. JAMAIS de calcul d'argent en Number
   (un DTO peut convertir en Number pour l'AFFICHAGE seulement).
6. Lookups : getLookupId('role', 'BUYER') (utils/lookupCache.js). Pas de "mode: insensitive" (MySQL).
7. Commentaires et messages en français, dans le style des fichiers existants :
   le commentaire explique le POURQUOI, pas le quoi.
8. NE PAS MODIFIER le module auth (liste "Intouchable" du plan), sauf si le prompt l'écrit.
9. Aucune dépendance npm nouvelle, sauf si le prompt la nomme.
10. Migrations : `prisma migrate dev` est interactif et échoue sans terminal. Procédure :
    a) modifie prisma/schema.prisma ; b) enregistre l'ANCIEN schéma hors du dépôt (git show HEAD:prisma/schema.prisma) ;
    c) génère le SQL : npx prisma migrate diff --from-schema-datamodel <ancien> --to-schema-datamodel prisma/schema.prisma --script ;
    d) crée prisma/migrations/<AAAAMMJJHHMMSS>_<nom>/migration.sql avec ce SQL (noms de tables en casse mixte comme les
       migrations existantes : User, StockLot...) ; e) npx prisma migrate deploy ; f) npx prisma generate.
    Si le SQL contient un DROP que le prompt n'annonce pas : ARRÊTE-TOI. Jamais de `migrate reset` hors base de développement
    ou de test.
11. Schéma : tout changement de prisma/schema.prisma est recopié à l'identique dans docs/schema.v2.target.prisma, dans le
    MÊME commit. Si un prompt suppose un modèle ou un champ absent du schéma : ARRÊTE-TOI et demande ; ne le crée pas de ta
    propre initiative.
12. Tests : Vitest obligatoire. `npm test` DOIT être entièrement vert avant de commiter.
    INTERDIT : commiter avec un test rouge ; affaiblir ou contourner un test (relever une limite, retirer une assertion,
    skip) pour le faire passer. Un test rouge qui semble préexistant : vérifie avec `git stash`, puis ARRÊTE-TOI, ne
    commite pas et explique.
    Toute nouvelle table est ajoutée à BUSINESS_TABLES (données de test) ou REFERENCE_TABLES (référentiel seedé) dans
    tests/helpers/db.js.
13. Périmètre : modifie UNIQUEMENT les fichiers que le prompt autorise. Si un fichier hors liste te semble nécessaire,
    ARRÊTE-TOI et demande.
14. Si une instruction est ambiguë ou contredit le code existant : ARRÊTE-TOI et pose la question. N'invente pas.
15. Avant d'écrire du code : lis les fichiers cités par le prompt, et uniquement ceux-là.

FIN DE PROMPT (toujours)
a) npm test -> tout vert.   b) npx prisma validate -> OK.
c) Si le schéma a changé : npm run db:drift -> code 0. Un écart qui ne concerne QUE la casse des noms de tables
   (artefact Windows, lower_case_table_names=1) se signale mais ne bloque pas ; tout autre écart : ARRÊTE-TOI.
d) git status puis git diff --stat : vérifie qu'aucun fichier hors périmètre n'a changé.
e) Commit unique avec le gabarit ci-dessous.
f) Termine par UN SEUL bloc final intitulé "RÉSUMÉ <ID du prompt>" contenant : la sortie de `git log -1 --oneline`
   (copiée, jamais écrite de mémoire), 5 lignes de résumé, les tests ajoutés, les points douteux. RIEN après ce bloc.
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
6. Quand tu me transmets la réponse d'OpenCode, copie UNIQUEMENT le bloc final « RÉSUMÉ <ID> » (jamais les messages intermédiaires) : les points douteux y sont tous.

---

## 5. Vue d'ensemble

| Phase | Prompts | Contenu |
|---|---|---|
| 0 — Socle | P0.0 à P0.4 | Branche, docs, retrait marketplace, compte aligné v2, schéma de domaine |
| 1 — Comptes | P1.1 à P1.6 | CGU FR/EN, inscription v2, comptes d'équipe, agents et audit, profils, vérification |
| 2 — Lots et annonces | P2.1 à P2.6 | Référentiels admin, lots du promoteur, service de stock, validation et qualité, annonces publiées par l'équipe, catalogue acheteur |
| S — Stabilisation | S1 à S7 | Schéma réconcilié et contrôle de dérive, fiabilité des tests, règles de péremption, profils manquants, correctifs de revue (post-P3.5, post-P5.3), références de paiement du parrainage et des indemnisations |
| 3 — Commandes | P3.1 à P3.5 | Messagerie REST puis temps réel, moteur de prix, devis, cycle de vie |
| 4 — Argent | P4.1 à P4.2 | Paiements manuels idempotents, reversements |
| 5 — Livraison | P5.1 à P5.4 | Agences et tarifs, création des livraisons, dispatch livreur, reprise des livraisons bloquées |
| 6 — Équipe et jobs | P6.0 à P6.4 | Paramètres de la plateforme, parrainage, indemnisation, tâches planifiées, tableau de bord et audit |
| 7 — Finition | P7.1 à P7.3 | Confidentialité, documentation, vérification finale |

**41 commits** après le commit de documentation (34 prompts du plan + 7 de stabilisation). Ordre strict : chaque prompt suppose les précédents terminés.

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

Lis d'abord : src/routes/router.js, src/routes/admin.routes.js, src/controllers/admin.controller.js,
src/sockets/chat.socket.js, tests/helpers/factory.js, tests/helpers/db.js.

À SUPPRIMER :
- src/controllers/{listing,order,conversation,delivery}.controller.js
- src/routes/{listing,order,conversation,delivery}.routes.js
- src/validators/{listing,order}.validator.js
- les tests qui ne concernent que ces modules (regression-order-creation, resource-routes,
  decimal-money si elle ne teste que des listings/commandes). Pour un test mixte, retire
  seulement les cas marketplace. Liste dans le commit chaque test supprimé et pourquoi.

À MODIFIER :
- src/routes/router.js : ne garder que /auth et /admin.
- src/routes/admin.routes.js et admin.controller.js : retirer getAllOrders, getStats,
  deactivateListing et leurs routes. Garder listUsers, suspendUser, reactivateUser, createAdmin.
- src/sockets/chat.socket.js : garder io.use(...) d'authentification et joinUserRoom ;
  supprimer join_conversation, leave_conversation, send_message (réécrits en P3.2).
- tests/helpers/factory.js : retirer createListing.

À NE PAS TOUCHER : prisma/schema.prisma, utils/distance.js, utils/money.js, tout le module auth.

Critères : npm test vert ; le serveur démarre ; GET /health répond 200 ;
GET /api/listings répond 404.
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
    AJOUTER : PATCH /api/auth/me/availability -> 404 ; register avec role DRIVER ou FARMER -> 400 ;
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
Lis d'abord : src/routes/router.js, src/routes/admin.routes.js, src/validators/admin.validator.js,
prisma/seed.js, modèles LegalDocument* dans prisma/schema.prisma.

À CRÉER :
- src/utils/legal.js : resolveLocale(req) = ?lang= > en-tête Accept-Language (fr|en) > 'fr' ;
  getCurrentVersion(code) = version PUBLISHED du document ; REQUIRED_DOCUMENTS_BY_ROLE =
  { BUYER: ['CGU','BUYER_TERMS'], SUPPLIER: ['CGU','SUPPLIER_CONSIGNMENT_TERMS'] }.
- src/controllers/legal.controller.js + src/routes/legal.routes.js (monté sur /api/legal, PUBLIC) :
  GET /api/legal -> liste des documents courants { code, label, version, publishedAt } ;
  GET /api/legal/:code?lang= -> { code, version, locale, title, content, publishedAt } ;
  si la langue demandée n'existe pas, repli sur 'fr' et renvoyer le champ locale réel ;
  404 si le code est inconnu ou sans version publiée.
- Admin (ADMIN et plus), dans admin.routes.js :
  POST /api/admin/legal/:code/versions { version, translations:[{locale,title,content}] }
  crée une version DRAFT ('fr' obligatoire, 'en' facultatif) ;
  PATCH /api/admin/legal/versions/:id/publish passe la version en PUBLISHED et archive la
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

1. Remplace createAdmin par createStaffUser (POST /api/admin/users, mêmes protections protect +
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
  GET /api/admin/agents ; PATCH /api/admin/agents/:id { displayName?, isActive?, capabilities?, autonomy? } ;
  POST /api/admin/agents/ai { displayName, aiProvider, aiModel, aiConfig?, autonomy } crée un agent AI
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

1. GET /api/auth/me : ajouter l'objet `profile` (SupplierProfile, BuyerProfile ou DriverProfile
   selon le rôle, sinon null) via le paramètre `extra` de userToApi. Rien d'autre ne change.
2. PATCH /api/auth/me/profile (protect) : SUPPLIER { farmName, description, zoneId } ;
   BUYER { buyerType, businessName, zoneId } ; DRIVER { vehicleType, plateNumber }. Schéma Joi par
   rôle ; zoneId doit exister ; ADMIN/AGENT/ROOT -> 403.
3. Comptes de paiement (SUPPLIER et BUYER uniquement) : GET, POST, PATCH /:id, DELETE /:id sur
   /api/auth/me/payout-accounts. Les réponses n'exposent JAMAIS le numéro complet :
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
Lis d'abord : src/middlewares/upload.middleware.js, src/utils/localUpload.js,
src/controllers/user.controller.js (uploadAvatar),
src/middlewares/capability.middleware.js, src/utils/audit.js.

1. Upload : crée src/middlewares/uploadDocument.middleware.js (multer mémoire, 8 Mo, types
   image/jpeg, image/png, image/webp, application/pdf — tous doivent exister dans MimeType).
   Étends uploadFileLocally(buffer, options = {}) de façon RÉTROCOMPATIBLE : sans options,
   comportement identique à aujourd'hui ; avec { documentType } l'écriture est privée (sous-dossier
   uploads/<documentType>) et la fonction renvoie aussi publicId. Ne modifie pas
   upload.middleware.js (avatars).
2. POST /api/auth/me/documents (protect, SUPPLIER ou BUYER) : champ fichier `file`, champ `type`
   (DocumentType). Crée VerificationDocument (PENDING) et Media (ownerVerificationDocumentId, isPrivate
   true, publicId, mediaType IMAGE ou DOCUMENT selon le mime). Si profileVerificationStatus vaut
   UNVERIFIED ou REJECTED, il passe à PENDING. GET /api/auth/me/documents liste id, type, status,
   note, createdAt — SANS URL.
3. Staff (ADMIN et plus, ou AGENT avec USER_VERIFICATION) :
   GET /api/admin/verifications?status=PENDING (paginé) ;
   GET /api/admin/verifications/:id : détail + lien SIGNÉ valable 10 minutes vers
   GET /api/admin/files/:token (le jeton porte l'identifiant du Media et le compte du relecteur ;
   si tu n'es pas certain de la forme attendue, ARRÊTE-TOI et demande) ;
   PATCH /api/admin/verifications/:id { decision: 'APPROVE'|'REJECT', note } (note obligatoire pour
   REJECT).
4. Règle : APPROVE -> document VERIFIED. L'utilisateur devient VERIFIED (profileVerifiedAt,
   profileVerifiedById) quand il a au moins un document VERIFIED et aucun PENDING. REJECT sans
   document VERIFIED -> utilisateur REJECTED. Audit dans la même transaction. NE touche PAS au parrainage
   (branché en P6.1).
5. Le changement d'avatar (uploadAvatar) ne doit JAMAIS supprimer un document de vérification : ajoute un
   test qui le prouve.

Tests : dépôt valide ; mime refusé ; GET /me/documents sans URL ; le staff obtient le lien signé, un
BUYER non ; transitions PENDING -> VERIFIED / REJECTED ; avatar remplacé sans toucher aux documents ;
AGENT sans USER_VERIFICATION -> 403 (mocker le service de stockage comme les tests existants).
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
GET, POST, PATCH /:id sur /api/admin/categories, /units, /products, /zones, /hubs.
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
Lis d'abord : src/middlewares/upload.middleware.js, src/utils/localUpload.js, src/utils/money.js,
modèles StockLot, Media, Product.

À CRÉER : src/controllers/supplierLot.controller.js, src/routes/supplier.routes.js (monté sur
/api/supplier, protect + requireRole('SUPPLIER')), src/validators/lot.validator.js,
src/utils/dto/lot.dto.js (fonctions lotToSupplierDto et lotToStaffDto). Le catalogue acheteur n'utilise PAS les lots : il utilise les annonces (P2.5, P2.6).

Routes :
- POST /api/supplier/lots (multipart, champ `images`, 5 maximum, via upload.array) avec productId, zoneId,
  agreedUnitPrice, quantity, storageType (SUPPLIER_SITE|HUB), hubId (obligatoire si HUB, actif et
  acceptsDropoff), pickupAddress + pickupLatitude + pickupLongitude (obligatoires si SUPPLIER_SITE),
  expiresAt (obligatoire si le produit est périssable, date future), harvestedAt?, packagingNote?, qualityNote?.
  Création dans une transaction : StockLot avec quantityInitial = quantityAvailable = quantity, statut
  PENDING_VALIDATION ; lotCode = 'LOT-' + id sur 6 chiffres, écrit juste après l'insertion ; upload des images
  puis lignes Media (ownerLotId, position, isPrimary pour la première).
- GET /api/supplier/lots (paginé, filtre ?status=) ; GET /api/supplier/lots/:id (404 si le lot n'est pas à lui).
- PATCH /api/supplier/lots/:id : autorisé SEULEMENT en PENDING_VALIDATION (409 INVALID_STATE_TRANSITION sinon),
  champs modifiables : prix, quantité (réécrit quantityInitial et quantityAvailable), dates, notes.
- DELETE /api/supplier/lots/:id : autorisé SEULEMENT en PENDING_VALIDATION ou REJECTED (suppression définitive
  du lot et de ses photos Media, aucun mouvement de stock) ; tout autre statut -> 409 (utiliser le retrait, P2.4).
- DTO fournisseur : lotCode, produit, les quatre quantités, prix, statut, rejectionReason, images, dates.
  JAMAIS de donnée acheteur.
Ne pas créer de StockMovement ici (la réception est tracée à la validation, P2.4).
Tests : création complète (service de stockage mocké), règles conditionnelles (HUB sans hubId -> 400, périssable sans
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

Crée src/controllers/staffLot.controller.js et src/routes/staff.routes.js (monté sur /api/staff, protect +
requireCapability('STOCK_VALIDATION') pour les routes de ce prompt). Routes :
- GET /api/staff/lots?status=&supplierId=&productId= (paginé, DTO staff avec identité du fournisseur) ;
  GET /api/staff/lots/:id.
- POST /api/staff/lots : création au nom d'un fournisseur (mêmes champs que P2.2 + supplierUserId) ;
  createdByAgentId = req.agent.id si l'acteur est un agent.
- POST /api/staff/lots/:id/validate : exige PENDING_VALIDATION et que le fournisseur ait
  profileVerificationStatus VERIFIED (sinon 409, code NOT_VERIFIED) ; appelle receiveLot ; renseigne
  validatedAt et validatedByAgentId ; AuditLog LOT_VALIDATED.
- POST /api/staff/lots/:id/reject { reason } : PENDING_VALIDATION -> REJECTED ; reason obligatoire ; audit.
- POST /api/staff/lots/:id/return { reason } : AVAILABLE ou FULLY_RESERVED sans réservation -> RETURNED ; audit.
- POST /api/supplier/lots/:id/withdraw (côté fournisseur) : autorisé si quantityReserved = 0 et lot AVAILABLE ->
  WITHDRAWN via returnAvailable ; audit.
- GET /api/staff/stock-movements?lotId= (paginé).
- POST /api/staff/lots/:id/quality-checks { grade: 'A'|'B'|'C', notes? } : lot PENDING_VALIDATION, AVAILABLE ou
  FULLY_RESERVED ; crée un LotQualityCheck (inspecteur = utilisateur, + agent si présent), met StockLot.qualityGrade à
  la dernière note ; audit LOT_QUALITY_CHECKED. GET /api/staff/lots/:id/quality-checks : historique.
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
src/utils/audit.js, src/utils/lookupCache.js, src/utils/localUpload.js, modèles Listing, ListingLot,
ListingStatus, StockLot, Media.

À CRÉER : src/services/listing.service.js, src/controllers/staffListing.controller.js,
src/validators/listing.validator.js, src/utils/dto/listing.dto.js (listingToStaffDto) ; routes dans staff.routes.js
(capability LISTING_MANAGEMENT ; ADMIN et ROOT toujours autorisés).
- POST /api/staff/listings (multipart facultatif, champ `images`, 5 maximum) { lotIds:[id], title, description?,
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
- PATCH /api/staff/listings/:id { title, description, unitPrice, zoneId } : annonce DRAFT, ACTIVE ou INACTIVE ; tout
  changement de unitPrice est écrit dans l'audit avec ancienne et nouvelle valeur (metadata).
- POST /api/staff/listings/:id/publish : DRAFT ou INACTIVE -> ACTIVE si le lot est AVAILABLE avec stock > 0 ;
  publishedAt ; audit LISTING_PUBLISHED. POST /api/staff/listings/:id/unpublish : ACTIVE -> INACTIVE ; audit.
- GET /api/staff/listings?status=&productId=&supplierId= (paginé) ; GET /api/staff/listings/:id : DTO staff avec le lot et
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

Crée src/controllers/catalog.controller.js, src/routes/catalog.routes.js (monté sur /api/catalog, protect ;
rôles BUYER, AGENT, ADMIN, ROOT) et ajoute listingToBuyerDto dans listing.dto.js.
- GET /api/catalog/categories : catégories de produits actives.
- GET /api/catalog/listings?zoneId=&categoryId=&q=&sort=price|recent|expiry (paginé) : annonces ACTIVE dont la quantité
  disponible est > 0 (somme des quantityAvailable de leurs lots non expirés). Champs : id, reference, title, description,
  category, unit, unitPrice, quantityAvailable, expiresAt (la plus proche), zone:{id,name,city}, images:[url],
  qualityGrade (le plus bas de ses lots).
- GET /api/catalog/listings/:id : même DTO ; 404 si l'annonce n'est pas ACTIVE.
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

## BLOC S — Stabilisation (à faire AVANT P3.1)

Origine : revue du code P0 à P2.6 (voir l'analyse). Quatre correctifs courts, un commit chacun. **P3.x suppose ce bloc terminé.**

### S0 — Synchroniser la documentation *(manuel, toi)*

```
# remplace dans docs/ : PLAN_IMPLEMENTATION_V2.md et schema.v2.target.prisma (version RÉCONCILIÉE)
git add docs
git commit -m "docs(v2): sync the plan and the reconciled target schema" \
  -m "Pourquoi : la cible documentee etait en retard sur le schema reel (annonces, qualite) et le plan ignorait le prefixe /api/v2." \
  -m "Changements : preambule durci (tests, schema, migrations), bloc de stabilisation S1-S4, schema cible reconcilie." \
  -m "Impact : la cible est volontairement en avance sur prisma/schema.prisma jusqu'a S1."
```

### S1 — Réconcilier le schéma et contrôler la dérive

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : aligner prisma/schema.prisma sur docs/schema.v2.target.prisma (version réconciliée) avec UNE migration,
et créer le contrôle de dérive des migrations.
Lis d'abord : prisma/schema.prisma, docs/schema.v2.target.prisma, package.json, .env.example,
tests/setup/integration.js, tests/helpers/factory.js, tests/integration/stock.service.test.js (il crée des OrderItem).

Écarts ATTENDUS entre les deux fichiers (et SEULEMENT ceux-là) :
 a) enum QualityGrade { A B C } ajouté ; LotQualityCheck.grade et StockLot.qualityGrade passent de String à QualityGrade ;
 b) Conversation : productId / product remplacés par listingId / listing et lotId / lot (+ deux index) ;
    Product perd la relation conversations ;
 c) OrderItem : listingId obligatoire + relation + index ; Listing gagne orderItems et conversations ;
    StockLot gagne conversations.
1. Vérifie avec `git diff --no-index prisma/schema.prisma docs/schema.v2.target.prisma` que les écarts sont exactement
   a, b, c. Tout autre écart : ARRÊTE-TOI.
2. Sécurité des données (base de développement) : exécute
   SELECT COUNT(*) FROM `OrderItem`;  SELECT DISTINCT `grade` FROM `LotQualityCheck`;
   SELECT DISTINCT `qualityGrade` FROM `StockLot`;
   Si OrderItem contient des lignes, ou si une valeur de grade n'est pas A, B ou C : ARRÊTE-TOI et demande (ne supprime rien).
   (Perdre Conversation.productId est accepté : données de test, décision C4.)
3. Copie docs/schema.v2.target.prisma sur prisma/schema.prisma.
4. Migration `v2_reconcile` selon la règle 10 du préambule. SQL attendu : colonnes grade et qualityGrade en ENUM('A','B','C') ;
   Conversation : ajout de listingId et lotId (index + clés étrangères), suppression de productId (clé étrangère + colonne) ;
   OrderItem : ajout de listingId NOT NULL (+ clé étrangère + index). Ajoute EN TÊTE du SQL :
   DELETE FROM `OrderItem`;
   (nécessaire pour ajouter une colonne obligatoire ; la table doit être vide, vérifié à l'étape 2). Aucun autre DROP.
5. Adapte le code et les tests : toute création d'OrderItem doit fournir listingId. Ajoute à tests/helpers/factory.js une
   fonction createListingForLot(lot, overrides) qui crée une annonce ACTIVE reliée au lot (ListingLot) avec les valeurs minimales
   valides, et utilise-la dans les tests qui créent des OrderItem. Les comparaisons de grade ('A', 'B', 'C') ne changent pas.
6. Contrôle de dérive : crée scripts/check-drift.js (charge .env avec dotenv ; exige SHADOW_DATABASE_URL, sinon message d'aide
   et code de sortie 2 ; exécute avec child_process.spawnSync, sans shell :
   npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma
   --shadow-database-url <url> --exit-code ; renvoie le code de sortie). Ajoute le script npm "db:drift". Documente
   SHADOW_DATABASE_URL dans .env.example (base VIDE dédiée, utilisateur MySQL avec droits CREATE et DROP).
   Lance `npm run db:drift` : code 0 attendu. Si l'écart ne concerne que la casse des noms de tables (Windows), dis-le et continue.
Critères : npm test vert ; prisma validate OK ; migrate deploy sur base vierge OK ; diff vide entre prisma/schema.prisma et
docs/schema.v2.target.prisma.
Commit : refactor(db): reconcile the schema with the v2 target (listing links, quality grade enum, drift check)
```

### S2 — Fiabiliser les tests et corriger validate()

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : une suite de tests isolée et un validate() correct pour les requêtes (query).
Lis d'abord : tests/helpers/db.js, tests/setup/*.js, tests/integration/referential.test.js, prisma/seed.js,
src/middlewares/validate.middleware.js, src/validators/admin.validator.js, tests/unit/.

1. prisma/seed-data/referentials.js : exporte PRODUCT_CATEGORIES et UNITS (les tableaux { code, label } actuellement écrits
   dans seed.js) ; seed.js les importe à la place de ses listes en ligne. Même contenu, même comportement.
2. tests/helpers/db.js : exporte BUSINESS_TABLES et REFERENCE_TABLES (Role, UserStatus, MediaType, MimeType, DeliveryMode,
   ListingStatus, ProductCategory, Unit, AgentCapability, PlatformSetting, LegalDocument, LegalDocumentVersion,
   LegalDocumentTranslation). Dans le nettoyage entre tests, après les DELETE des tables métier : supprimer les lignes de
   ProductCategory et de Unit dont le code n'appartient pas aux listes seedées. Le nettoyage reste en DELETE (pas TRUNCATE).
3. tests/static/test-tables.test.js : lit prisma/schema.prisma (modèles : lignes `model Nom {`), vérifie que CHAQUE modèle est dans
   exactement UNE des deux listes, et qu'aucune table des listes n'est absente du schéma. Le message d'échec nomme le modèle fautif.
4. tests/integration/referential.test.js : retire le contournement `limit=100` ajouté en P2.4 ; le test doit passer grâce au
   nettoyage du point 2. Ne change aucune assertion.
5. validate.middleware.js : sous Express 5, req.query est un accesseur sans setter. Pour property === 'query', écris la valeur
   validée avec Object.defineProperty(req, 'query', { value, writable: true, configurable: true, enumerable: true }) ;
   pour 'body' et 'params', garde l'affectation actuelle. Nouveau tests/unit/validate-middleware.test.js : mini-application
   Express avec une route GET validée en query : '5' devient 5 ; un champ inconnu est supprimé ; une valeur invalide renvoie 400
   { error: 'Données invalides', details }.
6. admin.validator.js : remplace helpers.error('agency.unknown') et helpers.error('agency.inactive') (et équivalents dans le
   même fichier) par helpers.message({ custom: '...' }) avec un texte français (ex. 'Agence introuvable', 'Agence inactive').
   Ajoute un test : création d'un DRIVER avec un agencyId inconnu renvoie 400 avec un message en français.
Ne modifie aucun contrôleur existant.
Critères : npm test vert DEUX FOIS de suite (lance-le deux fois) ; le test statique échoue si on retire une table d'une liste
(vérifie-le à la main, puis annule).
Commit : test(infra): guarantee test isolation and fix query validation under Express 5
```

### S3 — Règles de péremption du stock

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : corriger la gestion de la péremption (P2.3) avant que les commandes ne s'appuient dessus.
Lis d'abord : src/services/stock.service.js, src/services/listing.service.js, tests/unit/stock.service.test.js,
tests/integration/stock.service.test.js, tests/integration/staff-listings.test.js.

Problèmes (actuel -> attendu) :
1. computeLotStatus donne la priorité à EXPIRED sur SOLD_OUT. Nouvel ordre ; les statuts REJECTED, RETURNED, WITHDRAWN et
   PENDING_VALIDATION restent inchangés et ne sont jamais recalculés :
   - plus rien (disponible = 0 ET réservé = 0) : EXPIRED si quantityLost > 0, sinon SOLD_OUT ;
   - sinon, si la date d'expiration est passée : FULLY_RESERVED si réservé > 0, sinon EXPIRED ;
   - sinon : FULLY_RESERVED si disponible = 0, sinon AVAILABLE.
   Une réservation en cours n'est jamais « périmée » : elle va à son terme.
2. expireAvailable déplace TOUT le disponible vers perdu (mouvement EXPIRED, comme avant) mais NE FORCE PLUS le statut : il
   écrit computeLotStatus(lot, maintenant). Il renvoie toujours la quantité perdue (Decimal).
3. reserve : la condition atomique du updateMany refuse un lot dont la date est passée (ajouter : expiresAt nul OU expiresAt > maintenant).
   Si count vaut 0, relis le lot : date passée -> erreur 409 code LOT_EXPIRED ; sinon INSUFFICIENT_STOCK comme avant.
4. releaseReservation et commitSale ne changent pas, mais leurs tests prouvent le comportement attendu.
Ajoute en commentaire dans stock.service.js : « les tâches d'expiration (P6.3) sélectionnent les lots par quantityAvailable > 0 et
expiresAt passé, QUEL QUE SOIT leur statut : une réservation libérée peut remettre du disponible dans un lot déjà EXPIRED ».
Tests : computeLotStatus en tableau (au moins 12 cas, dont : vendu entièrement après la date -> SOLD_OUT ; 60 vendus + 40 perdus ->
EXPIRED ; réservé + date passée -> FULLY_RESERVED ; disponible + date passée sans réservation -> EXPIRED ; sans date -> jamais EXPIRED) ;
intégration : reserve sur un lot dont la date est passée mais dont le statut est encore AVAILABLE -> 409 LOT_EXPIRED ;
expireAvailable avec réservation en cours -> réservé intact, perdu augmenté, statut FULLY_RESERVED ; puis releaseReservation ->
disponible > 0 et statut EXPIRED ; puis expireAvailable -> tout en perdu ; annonce : lot entièrement vendu après sa date -> annonce SOLD
(et non INACTIVE). Les 23 + 17 tests existants restent verts (corrige seulement ceux qui encodaient l'ancien comportement, en le disant
dans le commit).
Commit : fix(stock): handle expiry with pending reservations and let sold-out win over expired
```

### S4 — Profils manquants

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : plus aucun SUPPLIER ni BUYER bloqué faute de profil (comptes créés avant P1.2, anciens FARMER devenus SUPPLIER).
Lis d'abord : src/controllers/user.controller.js (updateMyProfile), src/controllers/supplierLot.controller.js,
src/controllers/auth.controller.js (register : création de profil), src/utils/userApi.js, package.json,
tests/integration/user-profile.test.js, tests/integration/supplier-lots.test.js.

1. src/utils/profile.js : ensureProfile(db, user) : SUPPLIER -> upsert de SupplierProfile (farmName = `${firstname} ${lastname}` à la
   création) ; BUYER -> upsert de BuyerProfile (buyerType RETAILER) ; renvoie le profil. DRIVER : ne crée rien, lève 409 code
   PROFILE_MISSING 'Livreur sans agence : contactez un administrateur'. ADMIN, AGENT, ROOT : lève 403.
   (register garde sa propre création en transaction : ne le modifie pas.)
2. updateMyProfile : au lieu de répondre 404 quand le profil manque, appelle ensureProfile puis applique la mise à jour.
3. Création de lot (supplierLot.controller) : si le SupplierProfile manque, ensureProfile le crée au lieu d'échouer.
4. scripts/backfill-profiles.js (script npm "backfill:profiles") : exporte backfillProfiles({ apply }). Sans --apply : mode simulation
   (compte et affiche, n'écrit rien). Avec --apply : crée les profils manquants des SUPPLIER et BUYER. Les DRIVER sans DriverProfile
   sont listés, jamais créés. Idempotent. Affiche un résumé chiffré.
Tests : PATCH /me/profile d'un SUPPLIER sans profil -> 200 et profil créé ; création de lot par un SUPPLIER sans profil -> 201 ;
BUYER idem ; DRIVER sans profil -> 409 PROFILE_MISSING ; backfillProfiles : simulation sans écriture, apply qui crée, second apply
qui crée 0 ; compte déjà profilé inchangé.
Commit : fix(profile): create missing role profiles on demand and add a backfill script
```

---

## PHASE 3 — Messagerie, devis, commandes

*Prérequis : le bloc S est terminé (schéma réconcilié : `Conversation.listingId` / `lotId`, `OrderItem.listingId`).*

### P3.1 — Conversations (REST)

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : conversations client ↔ équipe, jamais acheteur ↔ fournisseur.
Lis d'abord : src/middlewares/capability.middleware.js, src/utils/audit.js, modèles Conversation, Message.

Crée src/controllers/conversation.controller.js (client), src/controllers/staffConversation.controller.js,
src/routes/conversation.routes.js (/api/conversations, protect) et complète src/routes/staff.routes.js.
Client :
- POST /api/conversations { listingId?, lotId?, content } : BUYER -> type BUYER_SUPPORT (listingId = annonce ACTIVE,
  facultatif), SUPPLIER -> SUPPLIER_SUPPORT (lotId = un de SES lots, facultatif ; 404 sinon) ;
  crée la conversation ET le premier message (SenderType CUSTOMER) dans une transaction.
- GET /api/conversations (les siennes, paginé) ; GET /api/conversations/:id/messages (paginé, chronologique,
  SANS les messages isInternal) ; POST /api/conversations/:id/messages { content }.
Équipe (capability BUYER_SUPPORT pour type BUYER_SUPPORT, SUPPLIER_SUPPORT pour l'autre ; ADMIN toujours) :
- GET /api/staff/conversations?status=&unassigned=true&mine=true&escalated=true ;
- POST /api/staff/conversations/:id/assign (soi-même ; un ADMIN peut désigner un agentId) ;
- POST /api/staff/conversations/:id/escalate { reason } -> escalatedAt, escalationReason, désassigne ;
- POST /api/staff/conversations/:id/close ;
- POST /api/staff/conversations/:id/messages { content, isInternal? } : senderType AGENT, senderUserId = utilisateur,
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
POST /api/staff/orders { buyerId, conversationId?, items:[{ listingId, quantity, unitPrice? }], deliveryMode:
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
Routes acheteur (/api/orders, protect + BUYER) : GET /api/orders ; GET /api/orders/:id (404 si pas la sienne) ;
POST /api/orders/:id/confirm ; POST /api/orders/:id/cancel (seulement QUOTED).
Routes staff (ORDER_PROCESSING) : GET /api/staff/orders ; GET /api/staff/orders/:id ; PATCH
/api/staff/orders/:id/status { status, force? } ; POST /api/staff/orders/:id/confirm ; POST /api/staff/orders/:id/cancel.
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

### S5 — Correctifs de revue (après P3.5, AVANT P4.1)

Origine : revue de S3 à P3.5. Quatre points à corriger avant que l'argent ne s'appuie sur les devis.

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : corriger les points relevés à la revue de S3 à P3.5, avant les paiements et les reversements (P4).
Lis d'abord : src/controllers/staffOrder.controller.js, src/services/stock.service.js, src/controllers/staffConversation.controller.js,
src/controllers/conversation.controller.js, src/routes/staff.routes.js, scripts/check-drift.js,
tests/integration/staff-orders.test.js, tests/integration/conversations.test.js, tests/unit/stock.service.test.js.

1. Historique des conversations pour l'équipe. Ajoute (mêmes protections que les autres routes de conversations du staff) :
   GET /api/v2/staff/conversations/:id : détail { type, statut, client { id, firstname, lastname }, annonce ou lot lié, agent assigné,
   escalade } ;
   GET /api/v2/staff/conversations/:id/messages (paginé { items, page, limit, total }, chronologique) : TOUS les messages, notes
   internes comprises, avec senderType, senderUserId, senderAgentId et isInternal.
   Accès identique à la liste : un agent ne voit que les conversations de son type, ADMIN et ROOT voient tout, sinon 403 ; id inconnu -> 404.
   Les routes client et leurs DTO ne changent pas.
2. Prix de vente d'un devis. Dans createOrder, quand l'agent fournit un unitPrice :
   - s'il diffère du prix de l'annonce : ajoute à l'AuditLog ORDER_QUOTED une metadata
     { priceOverrides: [{ listingId, listingPrice, appliedPrice }] } ;
   - s'il est INFÉRIEUR au supplierUnitPrice (prix convenu du lot) : 409 code PRICE_BELOW_SUPPLIER
     'Prix inférieur au prix convenu avec le promoteur', SAUF si l'utilisateur est ADMIN ou ROOT ET que le corps contient
     force: true (champ booléen optionnel à ajouter au schéma Joi) ; dans ce cas l'audit porte forced: true sur la ligne concernée.
   Un 409 annule toute la transaction (stock inchangé).
3. Traçabilité de la réservation. Dans createOrder, crée l'Order puis les OrderItem AVANT de réserver, puis appelle reserve avec
   orderItemId pour chaque ligne, afin que le mouvement RESERVED soit relié à sa ligne. Même transaction, même rollback en cas
   d'INSUFFICIENT_STOCK, même comportement observable (réponse, DTO, montants). order.service.js ne change pas.
4. stock.service.js : quantitePositive utilise valeur.greaterThan(0) au lieu de isPositive() (decimal.js considère 0 comme positif).
5. scripts/check-drift.js : codes de sortie sans ambiguïté : 0 = aucun écart ; 1 = écart détecté (Prisma renvoie 2) ; 2 = configuration
   manquante ; 3 = erreur d'exécution (Prisma renvoie 1, ou échec du lancement). Corrige le commentaire d'en-tête du fichier.
Tests : messages staff avec notes internes, ordre chronologique, pagination ; agent d'un autre type -> 403 ; conversation inconnue -> 404 ;
un client sur ces routes -> 403 ; prix inférieur au prix convenu -> 409 PRICE_BELOW_SUPPLIER et stock inchangé ; ADMIN avec force -> 201 et
audit forced ; prix différent mais >= prix convenu -> 201 avec metadata priceOverrides ; le mouvement RESERVED porte bien l'orderItemId
(vérification en base) ; reserve avec quantité 0 -> 400 INVALID_QUANTITY (test unitaire du service). Les tests existants restent verts.
Commit : fix(orders,messaging): let staff read conversations, guard sale prices and trace reservations
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
   POST /api/staff/orders/:id/payments { amount, method, reference?, paidAt? } avec l'en-tête OBLIGATOIRE
   Idempotency-Key (400 sinon). Même clé = même résultat : renvoie le paiement d'origine (HTTP 200) sans doublon,
   même en cas d'appels concurrents (s'appuie sur la contrainte unique ; capture l'erreur P2002 et relis).
   Le paiement est créé CONFIRMED. Refuser un montant <= 0 ou supérieur au solde dû (409 'Montant supérieur au solde').
   Recalcule Order.paymentStatus : somme des paiements CONFIRMED = 0 -> UNPAID, < total -> PARTIALLY_PAID,
   >= total -> PAID. Commande CANCELLED -> 409.
   GET /api/staff/orders/:id/payments.
   POST /api/staff/payments/:id/refund (ADMIN et plus) : CONFIRMED -> REFUNDED, recalcul du statut ; audit.
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
2. Fournisseur : GET /api/supplier/payouts (paginé) : montants, statut, référence, dates ; AUCUNE donnée acheteur.
3. Admin (ADMIN et plus, requireHumanActor) : GET /api/admin/payouts?status= (vue complète avec numéro de compte
   complet) ; PATCH /api/admin/payouts/:id/pay { reference, payoutAccountId? } : seulement READY (409 sinon) ->
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
dans admin.routes.js (ADMIN et plus) : GET, POST, PATCH /:id sur /api/admin/agencies (nom, contact, téléphone,
assurance : fournisseur, numéro de police, date d'expiration, isActive) ;
PUT /api/admin/agencies/:id/zones/:zoneId { baseFee, perKmFee, isActive } ; DELETE du même chemin ;
GET /api/admin/agencies/:id/drivers.
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
IMPORTANT : réutilise EXACTEMENT le calcul des origines et des frais déjà écrit dans staffOrder.controller.js (P3.4). S'il est
enfermé dans le contrôleur, EXTRAIS-LE dans src/services/delivery.pricing.js (modification autorisée de staffOrder.controller.js,
limitée à cette extraction, comportement identique) pour que les frais de livraison égalent ceux du devis.
Lis d'abord : src/services/agency.service.js, src/services/pricing.service.js, src/utils/distance.js,
src/services/order.service.js, modèles Delivery, OrderItem.

Complète staff.routes.js (capability DISPATCH_COORDINATION) :
POST /api/staff/orders/:id/deliveries : commande AGENCY_DELIVERY en statut PREPARING seulement.
Dans une transaction : regroupe les OrderItem par origine (clé `hub:{id}` si le lot est en hub, sinon `site:{supplierId}`) ;
pour chaque groupe crée une Delivery : agencyId via findActiveAgencyForZone(order.deliveryZoneId), champs d'enlèvement
(hub ou lot.pickup*), dropoff = adresse de la commande, distanceKm (Haversine), agencyCost et deliveryFee via
computeDeliveryFee, insuredValue = somme des lineTotal du groupe, insurancePolicyNumber figé depuis l'agence ;
renseigne OrderItem.deliveryId. Si des livraisons existent déjà -> 409 (idempotence). Audit DELIVERIES_CREATED.
GET /api/staff/deliveries?status=&orderId= (paginé).
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

Crée src/controllers/driverDelivery.controller.js, src/routes/driver.routes.js (/api/driver, protect +
requireRole('DRIVER')) et src/services/delivery.state.js (PENDING -> ACCEPTED -> PICKED_UP -> IN_TRANSIT -> DELIVERED ;
FAILED depuis PICKED_UP ou IN_TRANSIT ; CANCELLED seulement par le staff).
- GET /api/driver/deliveries/available : livraisons PENDING sans livreur, de l'agence du livreur, paginées.
  DTO : adresses, nom et téléphone du destinataire, distance, nature de la marchandise. JAMAIS de prix ni de montant.
- GET /api/driver/deliveries/mine?status=.
- POST /api/driver/deliveries/:id/accept : refuse (409) si le livreur a une livraison ACCEPTED, PICKED_UP ou IN_TRANSIT ;
  acceptation ATOMIQUE : tx.delivery.updateMany({ where:{ id, status:'PENDING', driverId:null, agencyId }, data:{ driverId,
  status:'ACCEPTED', acceptedAt } }) ; count 0 -> 409 'Course déjà prise'.
- PATCH /api/driver/deliveries/:id/status { status, failureReason? } (propriétaire seulement ; failureReason obligatoire pour
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

### S6 — Correctifs argent et temps réel (après P5.3, AVANT P5.4)

Origine : revue de S5 à P5.3. Deux failles de cohérence de l'argent, un test fragile, des sockets non testés.

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : corriger les points relevés à la revue de S5 à P5.3.
Lis d'abord : src/services/payment.service.js, src/services/payout.service.js, src/services/order.service.js,
src/controllers/staffOrder.controller.js, src/controllers/staffDelivery.controller.js, src/sockets/chat.socket.js,
tests/integration/staff-payments.test.js, tests/integration/supplier-payouts.test.js, tests/integration/socket-chat.test.js,
tests/integration/forgot-password.test.js, tests/integration/staff-deliveries.test.js.

1. Clé d'idempotence liée à sa requête (payment.service.js). Aujourd'hui, rejouer une clé sur une AUTRE commande renvoie
   silencieusement le paiement de la première commande (200). Corrige le rejeu séquentiel ET le rejeu après P2002 : si le paiement
   existant n'a pas le même orderId, ou un montant différent, ou une méthode différente, réponds 409 code IDEMPOTENCY_KEY_CONFLICT
   'Clé d'idempotence déjà utilisée pour une autre opération'. Même clé + mêmes paramètres : comportement inchangé (200, même paiement).
2. Remboursement et reversements (payout.service.js, payment.service.js).
   a) refreshPayoutReadiness devient BIDIRECTIONNELLE : commande COMPLETED ET PAID -> ON_HOLD vers READY ; sinon READY -> ON_HOLD.
      Les reversements PAID ne sont jamais modifiés.
   b) refundPayment, dans sa transaction : (i) si un reversement de la commande est déjà PAID, réponds 409 code PAYOUT_ALREADY_PAID
      'Reversement déjà payé : à traiter manuellement', SAUF si l'utilisateur est ADMIN ou ROOT ET que le corps contient force: true
      (champ booléen optionnel ajouté au schéma Joi) ; dans ce cas l'audit PAYMENT_REFUNDED porte forcedAfterPayout: true ;
      (ii) après le recalcul de paymentStatus, appelle refreshPayoutReadiness ; (iii) si paymentStatus vaut REFUNDED (tout est remboursé),
      appelle cancelPayoutsForOrder.
3. Sockets de livraison : crée tests/integration/socket-delivery.test.js en suivant le modèle de socket-chat.test.js (vrai serveur
   Socket.io) : (a) à la création des livraisons, un livreur de l'agence reçoit delivery:available, un livreur d'une autre agence et
   l'acheteur ne le reçoivent PAS ; (b) à l'acceptation et aux changements de statut, delivery:status atteint le staff et l'acheteur
   concerné, jamais un autre acheteur, et son payload ne contient aucun prix ; (c) un livreur sans DriverProfile se connecte sans rejoindre
   de salle d'agence. Si un de ces comportements est faux, corrige le code et dis-le dans le commit.
4. Test fragile : tests/integration/forgot-password.test.js compare des durées sous charge (rapport > 0,25). Garde le MÊME rapport mais
   mesure chaque cas 5 fois et compare les MÉDIANES. N'abaisse aucun seuil.
5. Frais de livraison : la logique « origines + distance + frais » est dupliquée dans staffOrder.controller.js et staffDelivery.controller.js.
   Extrais-la dans src/services/delivery.pricing.js (fonctions pures ou prenant les données déjà chargées) utilisée par les deux
   contrôleurs, comportement strictement identique. Ajoute un test : pour une commande à deux origines, la somme des deliveryFee des
   livraisons créées égale le deliveryFee du devis.
Critères : npm test vert (lance-le deux fois) ; aucun comportement observable ne change hors points 1 et 2.
Tests (points 1 et 2) : même clé sur une autre commande -> 409 IDEMPOTENCY_KEY_CONFLICT ; même clé et même corps -> 200 inchangé ; remboursement
partiel d'une commande COMPLETED+PAID : reversement READY -> ON_HOLD, puis nouveau paiement -> READY ; remboursement total : reversements
CANCELLED ; remboursement avec reversement PAID -> 409 PAYOUT_ALREADY_PAID ; ADMIN avec force -> 200 et audit forcedAfterPayout ; AGENT avec
force -> ignoré (409).
Commit: fix(payments,delivery): scope idempotency keys, keep payouts consistent with refunds and test delivery sockets
```

### P5.4 — Reprise des livraisons bloquées

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : l'équipe peut reprendre une livraison qui ne se déroule pas comme prévu. Aujourd'hui une course acceptée par un livreur
absent, ou échouée, reste bloquée à vie.
Lis d'abord : src/services/delivery.state.js, src/controllers/staffDelivery.controller.js, src/controllers/driverDelivery.controller.js,
src/services/order.service.js, src/utils/audit.js, tests/integration/staff-deliveries.test.js, tests/integration/driver-deliveries.test.js.

Ajoute dans staffDelivery.controller.js et staff.routes.js (capability DISPATCH_COORDINATION ; ADMIN et ROOT toujours autorisés) :
- POST /api/v2/staff/deliveries/:id/release { reason? } : ACCEPTED -> PENDING (driverId et acceptedAt remis à nul) ; émet delivery:available
  vers la salle de l'agence ; audit DELIVERY_RELEASED.
- POST /api/v2/staff/deliveries/:id/redispatch : FAILED -> PENDING (driverId et acceptedAt remis à nul ; l'ancien failureReason est copié dans
  incidentNote avant d'être effacé) ; émet delivery:available ; audit DELIVERY_REDISPATCHED.
- POST /api/v2/staff/deliveries/:id/cancel { reason } (reason obligatoire) : PENDING, ACCEPTED ou FAILED -> CANCELLED ; si TOUTES les
  livraisons de la commande sont alors CANCELLED, remets OrderItem.deliveryId à nul pour ses lignes afin de pouvoir recréer les livraisons ;
  audit DELIVERY_CANCELLED.
- Complète delivery.state.js avec ces transitions (PICKED_UP et IN_TRANSIT ne sont PAS annulables : 409 INVALID_STATE_TRANSITION).
- POST /api/v2/staff/orders/:id/deliveries (P5.2) : le refus d'idempotence ne s'applique plus que s'il existe au moins une livraison NON annulée.
- Chaque action émet aussi delivery:status vers staff et l'acheteur (payload sans prix, comme en P5.3).
Tests : release d'une course ACCEPTED puis acceptation par un autre livreur ; redispatch d'une course FAILED ; cancel sans reason -> 400 ;
cancel d'une course IN_TRANSIT -> 409 ; après annulation de toutes les livraisons, nouvelle création possible ; une annulation partielle ne
libère pas les lignes ; AGENT sans DISPATCH_COORDINATION -> 403 ; audit écrit pour chaque action.
Commit: feat(delivery): let staff release, redispatch and cancel stuck deliveries
```

---

## PHASE 6 — Parrainage, indemnisation, tâches planifiées, tableau de bord

### P6.0 — Paramètres de la plateforme

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : permettre de lire et modifier PlatformSetting. Aujourd'hui rien ne le permet : la commission reste à 0 et les devis ne
génèrent aucun revenu.
Lis d'abord : src/services/pricing.service.js (getSettings), src/routes/admin.routes.js, src/utils/audit.js, src/validators/admin.validator.js,
src/middlewares/auth.middleware.js (requireRole), modèle PlatformSetting dans prisma/schema.prisma.

Routes (montées dans admin.routes.js) :
- GET /api/v2/admin/settings (ADMIN et plus) : la ligne unique id = 1.
- PATCH /api/v2/admin/settings (ROOT SEULEMENT, requireRole('ROOT')) : modification PARTIELLE, au moins un champ. Champs et bornes :
  supplierCommissionRate (0 à 0,5), buyerFeeType (NONE | FIXED | PERCENT), buyerFeeValue (>= 0 ; <= 1 si le type est PERCENT),
  transportMarkupRate (0 à 1), referralBuyerReward (>= 0), referralSupplierReward (>= 0), reservationHours (entier de 1 à 168),
  expiryCompensationRate (0 à 1). currency est en lecture seule : la fournir donne 400.
- Règle de cohérence : si buyerFeeType est NONE, buyerFeeValue doit valoir 0 (après fusion avec la valeur actuelle) ; sinon 400.
- Toutes les valeurs d'argent et de taux passent par Prisma.Decimal. Audit SETTINGS_UPDATED dans la même transaction, avec
  metadata { before, after } limité aux champs modifiés.
- getSettings continue de lire la base (aucun cache) : une modification est effective à la requête suivante. Elle ne touche JAMAIS les
  commandes existantes (taux figés sur chaque OrderItem) : ajoute un test qui le prouve.
Tests : lecture par ADMIN ; PATCH par ADMIN -> 403 ; PATCH par ROOT -> 200 ; bornes (commission 0,6 -> 400, reservationHours 0 -> 400,
currency -> 400, corps vide -> 400) ; incohérence NONE + valeur -> 400 ; audit avec before/after ; un devis créé APRÈS un changement de
commission utilise le nouveau taux, un devis créé AVANT garde l'ancien ; le seed ne réécrit pas une valeur modifiée.
Commit: feat(settings): let ROOT manage platform rates and fees with an audit trail
```

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
2. Utilisateur : GET /api/auth/me/referral -> { code, totals:{ pending, eligible, paid }, referrals:[{ status, kind,
   rewardAmount, createdAt, referredFirstname }] } (prénom seul du filleul, rien d'autre).
3. Admin (ADMIN et plus, requireHumanActor) : GET /api/admin/referrals?status= ; PATCH /api/admin/referrals/:id/pay
   { reference } (ELIGIBLE -> PAID, paidAt) ; PATCH /api/admin/referrals/:id/reject { reason } (PENDING ou ELIGIBLE -> REJECTED).
   Transitions invalides 409. Audit.
Tests : filleul vérifié + parrain vérifié -> ELIGIBLE avec le bon montant ; parrain non vérifié -> reste PENDING puis passe
ELIGIBLE quand il est vérifié ; paiement unique (double paiement 409) ; rejet motivé ; montant figé même si PlatformSetting change ensuite.
Commit: feat(referral): grant fixed-amount rewards when referred users are verified
```

### S7 — Références de paiement et transitions sûres en concurrence, AVANT P6.2

Origine : revue de S6 à P6.1 et arrêt de P6.2. P6.2 s'est arrêté à raison (règle 11) : `SupplierCompensation` n'a pas de colonne `reference`. `Referral` non plus, alors que P6.1 expose déjà `PATCH /admin/referrals/:id/pay { reference }`. `SupplierPayout` a déjà `reference`, `paidAt` et `paidById` : on aligne les deux autres tables sur ce modèle. Le schéma cible `docs/schema.v2.target.prisma` joint à ce plan contient déjà ces champs.

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : enregistrer, pour chaque récompense de parrainage et chaque indemnisation payées, la référence du paiement et
l'humain qui l'a effectué (comme SupplierPayout).
Lis d'abord : prisma/schema.prisma, docs/schema.v2.target.prisma, src/services/referral.service.js, src/services/payout.service.js
(payPayout), src/services/payment.service.js (refundPayment), les contrôleurs admin des parrainages (listReferrals,
payReferralController dans src/controllers/admin.controller.js), tests/integration/referral.test.js,
tests/integration/supplier-payouts.test.js, tests/integration/staff-payments.test.js.
Fichiers dont la MODIFICATION est autorisée en plus du schéma : referral.service.js, payout.service.js, payment.service.js,
admin.controller.js (uniquement les fonctions de parrainage), admin.validator.js (schéma de paiement d'un parrainage),
tests/integration/forgot-password.test.js.

Écarts ATTENDUS entre prisma/schema.prisma et docs/schema.v2.target.prisma (et SEULEMENT ceux-là) :
 a) Referral : ajout de reference (String?), paidById (Int?) et de la relation paidBy -> User nommée "ReferralPaidBy" ;
 b) SupplierCompensation : ajout de reference (String?), paidById (Int?) et de la relation paidBy -> User nommée
    "CompensationPaidBy" ; la relation existante approvedBy est renommée "CompensationApprovedBy" (obligatoire : deux relations
    vers User dans le même modèle) ;
 c) User : compensationsApproved reçoit @relation("CompensationApprovedBy") ; nouveaux champs compensationsPaid
    (relation "CompensationPaidBy") et referralsPaid (relation "ReferralPaidBy").
1. Vérifie avec `git diff --no-index prisma/schema.prisma docs/schema.v2.target.prisma` que les écarts sont exactement a, b, c.
   Tout autre écart : ARRÊTE-TOI.
2. Copie docs/schema.v2.target.prisma sur prisma/schema.prisma.
3. Migration `v2_payment_references` selon la règle 10 du préambule. SQL attendu : sur Referral et SupplierCompensation, ajout des
   colonnes reference (VARCHAR) et paidById (INT NULL) + index et clé étrangère vers User (ON DELETE SET NULL). Aucun DROP.
   Renommer une relation Prisma ne change pas la base : aucune instruction pour approvedById.
4. Code P6.1 : payReferral enregistre reference, paidById (utilisateur) et paidAt dans la ligne Referral, EN PLUS de l'audit
   (qui garde la référence dans sa metadata). Si, jusqu'ici, la référence n'était écrite que dans l'audit, dis-le dans le
   commit. reference est obligatoire (Joi, 1 à 100 caractères) ; elle est exposée dans la vue admin des parrainages.
   GET /api/v2/admin/referrals est aujourd'hui sans pagination et sans compte de paiement : rends-la paginée
   ({ items, page, limit, total }, comme les autres listes) et ajoute pour chaque parrainage le compte de paiement par défaut du
   parrain (numéro complet, comme la vue admin des reversements) : l'admin doit savoir où payer.
5. Transitions sûres en concurrence. payReferral, rejectReferral, payPayout et refundPayment lisent la ligne puis écrivent sans
   condition : deux clics simultanés réussissent tous les deux (deux audits, la référence du second écrase la première).
   Remplace chaque transition par tx.<modèle>.updateMany({ where: { id, status: <statut attendu> }, data }) ; si count vaut 0, relis
   la ligne et renvoie EXACTEMENT le 404 ou le 409 actuel. L'audit n'est écrit que par l'appel gagnant. Le reste de la logique de
   ces fonctions ne change pas.
6. Test fragile forgot-password : sur le test de timing de tests/integration/forgot-password.test.js, ajoute { retry: 3 } au test
   (options Vitest). N'abaisse AUCUN seuil, ne retire AUCUNE assertion. Si le test échoue encore, copie le message d'échec
   (les trois durées) dans ton résumé.
Tests : parrainage payé -> reference, paidById et paidAt renseignés en base ; reference absente -> 400 ; double paiement -> 409 ;
la vue admin est paginée et expose la référence et le compte de paiement du parrain ; un AGENT ne peut pas payer (403) ;
deux paiements SIMULTANÉS (Promise.all) du même parrainage ELIGIBLE -> un 200 et un 409, un seul audit, une seule référence ;
même test pour un reversement READY (payPayout) et pour un remboursement (un seul REFUNDED, un seul audit).
Critères : npm test vert (deux fois) ; migrate deploy sur base vierge OK ; diff vide entre prisma/schema.prisma et
docs/schema.v2.target.prisma ; npm run db:drift ne signale que la casse.
Commit: feat(payments): record payment references and make payment transitions race-safe
```

### P6.2 — Indemnisation des fournisseurs

```
Lis la section PRÉAMBULE de docs/PLAN_IMPLEMENTATION_V2.md et applique-la.

Objectif : indemniser les invendus ou pertes, avec validation humaine.
Lis d'abord : src/services/stock.service.js, src/services/pricing.service.js, src/middlewares/humanActor.middleware.js,
modèle SupplierCompensation. Prérequis : S7 terminé (colonnes reference et paidById).

1. Crée src/services/compensation.service.js :
   - createForLoss(tx, { lot, quantity, reason, deliveryId?, note? }) : amount = roundMoney(quantity x agreedUnitPrice x
     expiryCompensationRate) ; si le taux vaut 0, ne crée rien ; statut PENDING_APPROVAL ; rate figé.
2. Staff : POST /api/staff/compensations { lotId, reason, quantity, deliveryId?, note } (capability DISPUTE_HANDLING ; ADMIN
   toujours) ; quantité > quantité du lot -> 400.
3. Admin (ADMIN et plus, requireHumanActor) : GET /api/admin/compensations?status= ; PATCH /:id/approve ; PATCH /:id/reject
   { note } ; PATCH /:id/pay { reference } (reference obligatoire, 1 à 100 caractères) ; transitions PENDING_APPROVAL -> APPROVED |
   REJECTED, APPROVED -> PAID ; invalide -> 409 ; audit. Le paiement écrit reference, paidAt ET paidById (utilisateur) dans la
   ligne SupplierCompensation (colonnes ajoutées en S7). La vue admin affiche le compte de paiement par défaut du fournisseur
   (numéro complet, comme la vue admin des reversements).
4. Fournisseur : GET /api/supplier/compensations (paginé) : motif, quantité, montant, statut.
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
  libérées, audit avec acteur système. Réutilise order.service.js (cancelOrder) : MODIFICATION AUTORISÉE de ce fichier pour
  accepter un acteur système (sans utilisateur), sans changer le comportement existant ; ne réimplémente PAS le calcul de libération.
- expireLots(now) : lots dont expiresAt < now et quantityAvailable > 0, QUEL QUE SOIT LEUR STATUT (un lot déjà EXPIRED peut avoir
  récupéré du disponible après l'annulation d'une commande) -> expireAvailable, puis createForLoss (raison EXPIRED_UNSOLD).
  Le statut est calculé par computeLotStatus (S3), jamais forcé ici.
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

1. GET /api/admin/stats?from=&to= (ADMIN et plus) -> { usersByRole, lotsByStatus, ordersByStatus, deliveriesByStatus,
   stock:{ available, reserved, sold, lost }, receivables (montant total des commandes CONFIRMED non PAID), pendingPayouts
   (somme netAmount READY et ON_HOLD), pendingCompensations (nombre et montant), eligibleReferrals (nombre et montant),
   grossRevenue } avec grossRevenue = somme(commissionTotal + buyerFee + (deliveryFee - agencyCost)) des commandes COMPLETED
   sur la période. Calculs côté Prisma.Decimal.
2. GET /api/admin/audit-logs?entityType=&entityId=&actorUserId=&actorAgentId=&from=&to= (paginé, ordre antichronologique).
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
| `/api/v1/...`, `/auth/*`, `/me/*` | `/api/v2/...`, `/api/v2/auth/*`, `/api/v2/auth/me/*` |
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
| Documents d'identité exposés | Stockage disque privé hors `express.static`, lien signé 10 minutes lié au relecteur et journalisé dans l'audit, jamais d'URL dans les listes (P1.6) |
| Survente et double clic | Mise à jour conditionnelle + tests de concurrence (P2.3, P5.3) |
| Double paiement | `Idempotency-Key` + contrainte unique (P4.1) |
| Fuite d'identité acheteur / fournisseur | DTO par rôle + `assertNoLeak` partout + revue finale (P7.1) |
| Textes juridiques provisoires | Marqués comme tels dans la base ; **à faire relire par un juriste avant le lancement** |
| Écart entre prix public et prix convenu (C8) | À trancher avant la production ; les deux prix sont figés par ligne de commande et tout changement de prix d'annonce est tracé dans l'audit |
| Garantie de prix = risque d'invendu porté par AgriConnect | Taux d'indemnisation configurable (`expiryCompensationRate`), approbation humaine obligatoire |
| MySQL : `prisma migrate dev` exige le droit de créer une base fantôme | L'utilisateur MySQL de développement doit avoir ce droit (déjà le cas pour la base de test) |

---

## 8. Phase U — correctif upload et vérification de profil

Cette phase est décrite **en détail et phase par phase** dans un document
dédié : [`PLAN_CORRECTIF_UPLOAD.md`](PLAN_CORRECTIF_UPLOAD.md). Les
constats, les décisions à trancher (D1 à D4) et un prompt autonome par phase
y figurent ; s'y reporter plutôt que de dupliquer ici le détail.

Ce que la phase U change par rapport aux phases 1 à 6 :

| Point | Avant | Après |
|---|---|---|
| Stockage des médias | Service externe, via un shim qui gardait le vocabulaire et le contrat de retour hérités | **Local** : `src/services/storage.service.js`, retour unique `{ url, publicId, isPrivate, size }`, écritures asynchrones, `UPLOADS_DIR` configurable, garde anti-remontée de chemin |
| Erreurs d'upload | `MulterError` non interceptée → **HTTP 500** avec un message anglais | 400/413 typés : `UNEXPECTED_FILE_FIELD` (+ `expectedField`), `INVALID_MULTIPART`, `UNSUPPORTED_MEDIA_TYPE`, `FILE_REQUIRED`, `FILE_CONTENT_MISMATCH`, `FILE_TOO_LARGE` |
| Fichiers orphelins | Aucun nettoyage | Compensation si la transaction échoue, suppression après suppression d'entité, `npm run uploads:cleanup` |
| Jeton de fichier privé | Secret des jetons d'accès en repli, chemin disque dans le jeton, non lié au relecteur, **non audité** | `SECRET_FILE_TOKEN` (obligatoire en production, distinct de `JWT_SECRET`), `{ purpose, mediaId, sub }`, réponse `no-store` + `nosniff`, audit `PROFILE_DOCUMENT_VIEWED` |
| File de revue | Tri antichronologique, pas de filtres, double décision concurrente possible, aucune notification | Filtres validés (`status`, `type`, `role`, `userId`, `page`, `limit`), tri FIFO sur `PENDING`, `updateMany` conditionnel (200 + 409), email de décision non bloquant |
| Contrôle d'accès du profil | `profileVerificationStatus` informatif | `requireVerifiedProfile` sur `POST /supplier/lots`, `PATCH /supplier/lots/:id`, `POST /supplier/lots/:id/withdraw`, `POST /orders/:id/confirm` → 403 `PROFILE_NOT_VERIFIED` |
| Documentation OpenAPI | `docs/openapi.yaml` non régénéré, test ne comparant que la liste des routes ; champ `type` des documents décrit comme un objet | `npm run docs:openapi` + test de cohérence sur le **contenu complet** ; flux de vérification et codes d'upload documentés |
