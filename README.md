# AgriConnect — Backend (v2, consignation)

API REST + WebSocket pour la plateforme agricole AgriConnect.
Trois couches : le promoteur (**SUPPLIER**) déclare des **lots** (`StockLot`,
interne : prix convenu, quantités, qualité), l'équipe (**AGENT** / **ADMIN**) publie
des **annonces** (`Listing`, prix public figé par l'équipe) et l'acheteur
(**BUYER**) ne voit que les annonces. `ListingLot` relie une annonce à son lot ;
une ligne de commande (`OrderItem`) reprend les deux identifiants et les prix au
moment de la vente.

La spécification complète de l'API est **générée depuis le code** : les fragments
Joi par domaine vivent dans [`openapi/`](openapi) (`openapi.config.js` assemble le
document, `openapi.helpers.js` convertit les schémas Joi 18 en JSON Schema), et le
serveur les expose sur **`http://localhost:${PORT}/agriconnect-openapi`** (interface
Scalar, OpenAPI 3.0). [`docs/openapi.yaml`](docs/openapi.yaml) en est l'export
statique : il se régénère avec `npm run docs:openapi`, ne s'édite pas à la main,
et un test compare son contenu **entier** au document généré (une dérive échoue
avec le rappel de cette commande). Une route de `src/routes` = une entrée.
Historique v1 → v2 : [`docs/CHANGELOG_V2.md`](docs/CHANGELOG_V2.md).
Plan d'implémentation : [`docs/PLAN_IMPLEMENTATION_V2.md`](docs/PLAN_IMPLEMENTATION_V2.md).
Correctif upload et vérification de profil :
[`docs/PLAN_CORRECTIF_UPLOAD.md`](docs/PLAN_CORRECTIF_UPLOAD.md).

## Stack

- Node.js (ESM natif, `"type": "module"`) + Express 5.2
- MySQL + Prisma **6.x** (ORM, migrations)
- JWT (access token courte durée + refresh token à rotation)
- Socket.io (messagerie temps réel, salle `user:{id}`)
- Stockage **local** des fichiers (multer + disque local ; voir « Stockage des fichiers »)
- Joi (validation d'entrée) + express-rate-limit (anti brute-force)
- OpenAPI généré depuis Joi : `openapi-merge` (assemblage des fragments) +
  `@scalar/express-api-reference` (interface servie par l'API)
- bcrypt, ejs + juice + nodemailer (emails transactionnels)
- Vitest + Supertest (tests, voir « Tests »)

## Installation

```bash
npm install
cp .env.example .env
# -> renseigner DATABASE_URL (mysql://...), JWT_SECRET et SECRET_FILE_TOKEN

npm run prisma:generate   # si le client Prisma n'est pas déjà à jour
npm run prisma:migrate    # applique les migrations
npm run seed              # OBLIGATOIRE sur une base neuve : référentiels + CGU + settings
npm run seed:demo         # données et comptes de démonstration (développement uniquement)
npm run create:root       # crée le compte ROOT en interactif - JAMAIS via l'API
npm run dev
```

Sur une base neuve, `npm run seed` est obligatoire : il crée les référentiels
(rôles, unités, catégories, capacités d'agent…), les CGU en FR/EN et le singleton
`PlatformSetting`. Sans lui, aucune inscription ne passe (les CGU PUBLISHED
manquent) et la commission vaut 0.

## Données de démo

Après `npm run seed`, exécutez `npm run seed:demo` sur une base de développement
pour charger les comptes, produits, zone, hub, agence, lot, annonce et conversation
de démonstration. La commande est idempotente et refuse `NODE_ENV=production`.
Les comptes et leur mot de passe commun sont listés dans
[`docs/DEMO_ACCOUNTS.md`](docs/DEMO_ACCOUNTS.md). Le compte ROOT reste séparé et
se crée avec `npm run create:root`.

## Variables d'environnement

Voir `.env.example` (copie commentée). Les principales :

| Variable | Défaut | Rôle |
|---|---|---|
| `DATABASE_URL` | — | MySQL, obligatoire |
| `JWT_SECRET` | — | Signature des JWT, obligatoire en production |
| `SECRET_FILE_TOKEN` | — | Signature des jetons d'accès aux fichiers privés, **obligatoire en production** et **distinct de `JWT_SECRET`** (le serveur refuse de démarrer sinon) |
| `UPLOADS_DIR` | `<racine>/uploads` | Dossier racine des fichiers téléversés (voir « Stockage des fichiers ») |
| `JWT_EXPIRES_IN` | `1h` | Durée de l'access token |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Durée de vie d'un refresh token |
| `SESSION_MAX_PER_USER` | `5` | Sessions simultanées par compte (appareils) |
| `REFRESH_REUSE_GRACE_SECONDS` | `30` | Tolérance de réutilisation après rotation |
| `PASSWORD_RESET_TTL_MINUTES` | `15` | Validité du lien de réinitialisation |
| `EMAIL_VERIFICATION_TTL_HOURS` | `24` | Validité du lien de vérification d'adresse |
| `RESEND_VERIFICATION_COOLDOWN_MINUTES` | `5` | Anti-renvoi du lien de vérification |
| `DISABLE_JOBS` | `false` | `true` = n démarre pas les tâches planifiées (voir « Exploitation ») |
| `PORT` | `4000` | Port HTTP |
| `CORS_IO` | — | Origines CORS séparées par des virgules ; vide = ouvert à tout |
| `APP_URL` | — | Adresse publique du front (liens d'email) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASSWORD` | — | Emails ; sans `SMTP_HOST`, envoi no-op journalisé |
| `EMAIL_SENDER` | — | Adresse d'expédition (forme `"Nom <adresse@domaine>"`) |
| `SHADOW_DATABASE_URL` | — | Base vide dédiée au contrôle de dérive (`npm run db:drift`) |

## Scripts npm

```bash
npm run dev              # node --watch src/server.js
npm run start            # node src/server.js
npm run prisma:generate  # régénère le client Prisma
npm run prisma:migrate   # migrate dev (interactif) ; en production : prisma migrate deploy
npm run prisma:studio    # inspecte la base
npm run seed             # référentiels + CGU + settings (idempotent)
npm run seed:dev         # + zone pilote, agence pilote, hub (développement seulement)
npm run seed:demo        # comptes, catalogue, zone, agence et conversation de démonstration
npm run create:root      # compte ROOT en interactif (jamais via l'API)
npm run backfill:profiles # PROFILE_MISSING : crée les profils manquants
npm run db:drift         # contrôle de schéma (base shadow dédiée)
npm run docs:openapi     # régénère docs/openapi.yaml depuis openapi/openapi.config.js
npm run uploads:cleanup  # fichiers orphelins dans uploads/ (dry-run ; --apply pour supprimer)
npm test                 # tout (vitest run)
npm run test:watch       # vitest en mode watch
npm run test:unit        # tests purs, aucune base
npm run test:integration # HTTP sur une base dédiée
```

## Tests

La suite d'intégration utilise une base **`agriconnect_test`** dont le nom est
déduit de `DATABASE_URL` dans `.env` : les données de développement ne sont
jamais tronquées. `globalSetup` crée la base si elle n'existe pas, applique les
migrations avec `migrate deploy` et joue le seed. Chaque test repart de tables
métier vides ; les tables de référence sont conservées.

`tests/static` vérifie le code sans base : dépendances, champs Prisma,
`prisma/schema.prisma` identique à `docs/schema.v2.target.prisma`, et
**couverture OpenAPI** (`tests/unit/openapi-routes.test.js` : toute route de
`src/routes` figure dans le document généré `openapi/openapi.config.js`, et
inversement ; `docs/openapi.yaml` doit être **rigoureusement identique** à ce
document — liste des routes ET contenu complet. Après toute modification d'un
fragment `openapi/*.openapi.js`, lancer `npm run docs:openapi`).

MySQL doit tourner. Les tests n'utilisent aucun SMTP (`SMTP_DISABLED`) et
l'anti-brute-force est neutralisé, sauf dans `rate-limit.test.js` qui le
réactive explicitement pour le vérifier.

## Routes par rôle

Toutes sous `/api/v2`. `protect` = JWT requis. Le tableau complet (paramètres
de requête, schémas de corps Joi, codes d'erreur) est dans l'interface
`/agriconnect-openapi` et dans `docs/openapi.yaml`.

### Public (sans compte)

`POST /auth/register` · `POST /auth/login` · `POST /auth/refresh` ·
`POST /auth/logout` · `POST /auth/forgot-password` · `GET/POST /auth/reset-password` ·
`GET/POST /auth/verify-email` · `GET /legal` · `GET /legal/:code`

### Tout compte connecté

`GET/PATCH /auth/me` · `POST /auth/me/avatar` · `POST /auth/resend-verification` ·
`GET /auth/sessions` · `DELETE /auth/sessions/:id` · `POST /auth/logout-all` ·
`GET /auth/me/referral` · `POST/GET /conversations` · `GET/POST /conversations/:id/messages`

### SUPPLIER (promoteur)

`POST/GET /supplier/lots` · `GET/PATCH/DELETE /supplier/lots/:id` ·
`POST /supplier/lots/:id/withdraw` · `GET /supplier/payouts` ·
`GET /supplier/compensations` · `PATCH /auth/me/profile` · payout-accounts · documents

### BUYER (acheteur)

`GET /catalog/categories` · `GET /catalog/listings` · `GET /catalog/listings/:id` ·
`GET /orders` · `GET /orders/:id` · `POST /orders/:id/confirm` ·
`POST /orders/:id/cancel` · `PATCH /auth/me/profile` · payout-accounts · documents

### DRIVER (livreur)

`GET /driver/deliveries/available` · `GET /driver/deliveries/mine` ·
`POST /driver/deliveries/:id/accept` · `PATCH /driver/deliveries/:id/status` ·
`PATCH /auth/me/profile`

### AGENT (niveau 30, par capacité)

| Capacité | Routes |
|---|---|
| `STOCK_VALIDATION` | `POST /staff/lots`, `GET /staff/lots[/:id]`, `POST /staff/lots/:id/{validate,reject,return}`, `POST/GET /staff/lots/:id/quality-checks`, `GET /staff/stock-movements` |
| `LISTING_MANAGEMENT` | `POST /staff/listings`, `GET /staff/listings[/:id]`, `PATCH /staff/listings/:id`, `POST /staff/listings/:id/{publish,unpublish}` |
| `BUYER_SUPPORT` / `SUPPLIER_SUPPORT` | `GET /staff/conversations[/:id]`, `GET/POST /staff/conversations/:id/messages`, `POST /staff/conversations/:id/{assign,escalate,close}` |
| `ORDER_PROCESSING` | `POST /staff/orders`, `GET /staff/orders[/:id]`, `PATCH /staff/orders/:id/status`, `POST /staff/orders/:id/{confirm,cancel}` |
| `PAYMENT_FOLLOWUP` | `POST/GET /staff/orders/:id/payments` |
| `DISPATCH_COORDINATION` | `POST /staff/orders/:id/deliveries`, `GET /staff/deliveries`, `POST /staff/deliveries/:id/{release,redispatch,cancel}` |
| `DISPUTE_HANDLING` | `POST /staff/compensations` |
| `USER_VERIFICATION` | `GET /admin/verifications[/:id]`, `PATCH /admin/verifications/:id`, `GET /admin/files/:token` (voir « Vérification de profil ») |

`ADMIN` et `ROOT` (niveau ≥ 50) passent toujours, capability ou non.

### ADMIN (niveau 50)

`GET /admin/users` · `PATCH /admin/users/:id/{suspend,reactivate}` ·
`POST /admin/users` (AGENT/DRIVER ; ADMIN seulement par ROOT) ·
`GET/PATCH /admin/settings` · `GET/POST /admin/{categories,units,products,zones,hubs}` ·
`PATCH /admin/{categories,units,products,zones,hubs}/:id` ·
`GET/POST /admin/agencies` · `PATCH /admin/agencies/:id` ·
`PUT/DELETE /admin/agencies/:id/zones/:zoneId` · `GET /admin/agencies/:id/drivers` ·
`GET/PATCH /admin/agents[/:id]` · `POST /admin/agents/ai` ·
`GET /admin/payouts` · `PATCH /admin/payouts/:id/pay` ·
`GET /admin/referrals` · `PATCH /admin/referrals/:id/{pay,reject}` ·
`GET /admin/compensations` · `PATCH /admin/compensations/:id/{approve,reject,pay}` ·
`GET /admin/stats` · `GET /admin/audit-logs` · `POST /admin/legal/:code/versions` ·
`PATCH /admin/legal/versions/:id/publish`

### ROOT (niveau 100)

`PATCH /admin/settings` (seul) · création de comptes `ADMIN` (dans `POST /admin/users`).

## Tâches planifiées

Les tâches tournent **dans le processus du serveur** (`node-cron`, démarées par
`startJobs()` dans `src/server.js`) :

| Tâche | Période | Effet |
|---|---|---|
| `releaseExpiredReservations` | toutes les 5 min | Libère les réservations de devis expirés (QUOTED) |
| `expireLots` | toutes les heures | Passe les lots AVAILABLE expirés en EXPIRED, mouvement EXPIRED |
| `expiryAlerts` | chaque jour à 7 h | Alertes d'expiration proches (io pour le socket) |

Chaque fonction est idempotente et écrit dans ses propres transactions : un échec
ponctuel laisse la base cohérente, le travail est repris au passage suivant.

**Plusieurs instances : une seule doit exécuter les tâches.** Les jobs lisent et
écrivent la même base — deux serveurs doubleraient chaque traitement. Mettre
`DISABLE_JOBS=true` sur toutes les instances sauf une (`NODE_ENV=test` les neutralise aussi).

## Exploitation

### Migrations

- **Développement :** `npm run prisma:migrate` (= `prisma migrate dev`, interactif).
- **Production :** `npx prisma migrate deploy` — non interactif, idempotent, sans
  régénération de client.
- `prisma migrate dev` échoue sans terminal : ne jamais l'utiliser en CI ou en production.

### Contrôle de dérive

```bash
npm run db:drift   # scripts/check-drift.js
```

Compare le schéma Prisma à la base. Utilise une **base shadow dédiée**
(`SHADOW_DATABASE_URL`, vide) : Prisma la crée, y applique l'historique des
migrations et compare. L'utilisateur MySQL doit avoir les droits `CREATE` et `DROP`
sur cette base. Un écart qui ne concerne que la casse des noms de tables
(artefact Windows, `lower_case_table_names=1`) se signale mais ne bloque pas.

### Sauvegarde

**Sauvegardez la base avant toute migration.** Une migration v2 est un `ALTER`
sur des tables qui contiennent déjà des données (C4 : les tables marketplace v1
sont vidées avant recréation). `mysqldump` avant `migrate deploy` est le filet de
sécurité minimal ; sans lui, un `DROP` erroné est irréversible.

### Base neuve

`npm run seed` est **obligatoire** après `migrate deploy` sur une base vide :
référentiels (rôles, statuts, capacités, unités, catégories…), CGU FR/EN en
version `1.0` PUBLISHED, modes de livraison, `PlatformSetting` (id=1) avec les
valeurs par défaut du schéma. Sans seed : pas d'inscription (CGU manquantes), pas
de catalogue, aucune référence.

Le seed est idempotent (upsert par code) : il peut relancer sans risque après un
ajout de référentiel.

### Commission et réglages (PlatformSetting)

Le singleton `PlatformSetting` (id=1) porte la commission fournisseur, les frais
acheteur, le majorateur transport, les montants de parrainage, la durée de
réservation et le taux d'indemnisation. **La commission vaut 0 tant que ROOT ne
l'a pas fixée** : aucun reversement fournisseur n'est correctement calculé avant
ça. Seul `PATCH /admin/settings` (ROOT) les modifie ; la lecture est ADMIN+.

### Jobs

Voir « Tâches planifiées » : `DISABLE_JOBS=true` sur toutes les instances sauf une.

## Authentification : sessions, statuts et récupération de compte

Une **session est un appareil connecté.** `Session` porte l'agent, l'IP, la
dernière activité et sa date de fermeture ; `RefreshToken` est son enfant. Une
connexion ouvre une session, plafonnée à 5 par compte (`SESSION_MAX_PER_USER`),
la plus ancienne étant fermée au-delà.

**Le refresh token tourne, et sa réutilisation détruit la session.** Chaque
`POST /auth/refresh` remplace le jeton qu'il reçoit. Présenter un jeton déjà
remplacé est traité comme un vol et ferme toute la session — avec
`REFRESH_REUSE_GRACE_SECONDS` (30 s) de tolérance, car deux refreshs parallèles
d'une même application mobile sont ordinaires.

**La base fait foi, le jeton informe.** `protect` recharge l'utilisateur en base
à chaque requête. Les claims `userStatus`, `emailVerified` et `sessionId` servent
au client, jamais à autoriser : un jeton émis avant une suspension est refusé.

**La vérification d'adresse ne bloque rien** — elle sert à l'affichage.
`profileVerificationStatus` est **distinct** : c'est la vérification du profil
par l'équipe (documents), indépendante de l'email — voir
« Vérification de profil ».

**Récupération de compte.** `POST /auth/forgot-password` répond de la même façon
que l'adresse existe ou non (anti-énumération). Jetons hachés, usage unique,
15 minutes, un seul actif par compte. `POST /auth/reset-password` détruit toutes
les sessions. Les liens ouvrent une page de formulaire par `GET`, et seul le
`POST` applique : les clients de messagerie préchargent les liens.

**Suspension.** Suspendre un compte ferme ses sessions **et** déconnecte ses
websockets (`session_revoked`).

## Règles de confidentialité

- **Comptes de paiement** : le numéro complet n'est jamais renvoyé par l'API
  (création mise à jour, liste). Seul le masque `accountNumberMasked`
  («••••1234») sort. La vue admin des reversements et des indemnisations est
  l'exception (numéro complet, ADMIN humain).
- **Documents de vérification** : écrits sur le disque local dans un dossier
  **privé**, jamais monté en statique (voir « Stockage des fichiers »). La liste
  `GET /auth/me/documents` ne renvoie jamais d'URL ; seul le staff autorisé
  obtient un **lien signé de 10 minutes**, lié à son propre compte et journalisé
  dans l'audit, via `GET /admin/verifications/:id` puis
  `GET /admin/files/:token`.
- **Parrainage** : le parrain ne voit que le **prénom** de ses filleuls.
- **Mots de passe** : `password` n'est jamais sélectionné dans `protect` (select
  explicite) ; le hash ne sort de nulle part.
- **Lots et prix** : le DTO fournisseur n'expose jamais de donnée acheteur ; le
  DTO acheteur (catalogue) n'expose jamais le lot ni le prix convenu. Le lot ne
  devient public que par l'annonce, avec le prix public fixé par l'équipe.
- **isInternal** : les messages internes d'une conversation ne sont visibles que
  par l'équipe.
- **Réversibilité des paiements** : un remboursement administrateur avec `force`
  n'annule pas le reversement fournisseur déjà payé — il devient un traitement
  manuel tracé.

## Points où le comportement peut surprendre

- **Les identifiants de route sont des entiers.** Express fournit `req.params`
  en chaîne ; les routeurs le convertissent via `router.param`. Sans cela, chaque
  route `/:id` répondait 500.
- **Les listes sont paginées** : `{ items, page, limit, total }`.
- **`unitPrice`, `quantity`, montants sont des `DECIMAL`.** Prisma renvoie un
  objet `Decimal`, l'arithmétique se fait avec `mul`/`minus`/`plus`, et
  `decimal-json.middleware.js` convertit en nombre au moment de la réponse.
  Voir `src/utils/money.js`. Un DTO peut convertir en nombre pour l'AFFICHAGE
  seulement.
- **Le nom est en deux colonnes**, `firstname` et `lastname`. Il n'existe pas de
  colonne `fullName`.
- **Erreurs** : `{ error }`, ou `{ error, code }` quand l'erreur en porte un
  (`INSUFFICIENT_STOCK`, `INVALID_STATE_TRANSITION`, …). Codes d'erreur HTTP
  usuels : 400 (Joi, upload), 401 (token), 403 (rôle/capacité/suspension/profil
  non vérifié), 404, 409, 413 (upload). Voir « Client mobile » pour les codes
  d'upload.
- **Une annonce = un lot au MVP** (règle de code). `ListingLot` permet d'en
  agréger plusieurs plus tard sans migration.
- **Les emails ne font jamais échouer une requête** : envoi en arrière-plan,
  échec journalisé. Sans `SMTP_HOST`, l'envoi est un no-op.
- **CORS ouvert si `CORS_IO` est vide** : à renseigner en production.

## Express 5

- Les erreurs (sync ou rejets de Promise) des contrôleurs remontent
  automatiquement au middleware d'erreur. Aucun wrapper `asyncHandler`.
- Le parseur de query string par défaut change en v5 (fin de la vulnérabilité `qs`).

## Validation avec Joi

`src/middlewares/validate.middleware.js` expose `validate(schema, property)`.
Ces règles signalent leurs échecs avec `helpers.error()` et non `throw` : une
`Error` ordinaire sort de `validateAsync` sans être une erreur Joi, le middleware
ne la reconnaît pas et répond 500 au lieu de 400.

## MySQL : différences avec PostgreSQL

- **Pas de `mode: 'insensitive'`** sur les filtres `contains` : la sensibilité à
  la casse dépend de la collation.
- Codes de référentiels en MAJUSCULES_AVEC_UNDERSCORES (convention des lookups) :
  MySQL compare sans égard à la casse (`_ci`), donc autoriser les minuscules
  créerait des doublons invisibles sur l'index unique.
- Champs texte longs en `@db.Text` explicite pour éviter la troncature à 191
  caractères.

## Emails transactionnels

- Transport SMTP construit exclusivement depuis l'environnement ; sans
  `SMTP_HOST`, envoi no-op journalisé.
- Rendu EJS + inline CSS avec `juice` ; `renderTemplate` exporté pour vérifier
  le rendu sans SMTP. Gabarits dans `views/emails/<nom>/email.ejs`.
- Pages HTML (liens d'email) : `views/pages/formulaire.ejs`, rendues par
  `utils/renderPage.js`.
- `SMTP_HOST` est un **nom d'hôte**, jamais l'URL d'une interface web. Avec
  MailDev : SMTP sur **1025**, interface web sur **1080**.
- `EMAIL_SENDER` doit être une adresse complète (`"AgriConnect <no-reply@…>"`).

## Stockage des fichiers

Les avatars, photos de lots, photos d'annonces et documents de vérification sont
écrits sur le **disque local** par `src/services/storage.service.js` (multer ne
garde les fichiers qu'en mémoire). La racine est `UPLOADS_DIR`, ou
`<racine du projet>/uploads` si la variable est absente.

```
uploads/
├── AVATAR/                 # public  → servi sur /uploads/AVATAR
├── LOT_PHOTO/              # public  → servi sur /uploads/LOT_PHOTO
├── LISTING_PHOTO/          # public  → servi sur /uploads/LISTING_PHOTO
├── ID_CARD/                # PRIVÉ   ← jamais servi statiquement
├── BUSINESS_REGISTRATION/  # PRIVÉ
├── FARM_PROOF/             # PRIVÉ
└── OTHER/                  # PRIVÉ
```

- **Publics** : seuls `AVATAR`, `LOT_PHOTO` et `LISTING_PHOTO` sont montés par
  `express.static` dans `src/app.js` (source unique : `PUBLIC_KINDS`). L'API
  renvoie des URL **relatives** (`/uploads/AVATAR/…`) : le client préfixe avec
  son URL de base.
- **Privés** : un dossier par type de document (`ID_CARD`,
  `BUSINESS_REGISTRATION`, `FARM_PROOF`, `OTHER`). Aucun n'est servi
  statiquement — l'accès passe uniquement par
  `GET /api/v2/admin/files/:token` (jeton signé, 10 min, lié au compte du staff
  qui l'a demandé). Toute tentative de remonter un chemin (`../`) est refusée par
  le service.
- **Nom des fichiers** : `{AAAAMMJJ}T{HHMMSS}_{userId}_{8 caractères aléatoires}{extension}`,
  extension déduite du mimetype (`.jpg`, `.png`, `.webp`, `.pdf`). Un nom fixe ne
  rend donc pas le contenu accessible : c'est le nom, jamais le chemin, qui est
  stocké en base (`Media.publicId`).
- **Remplacement d'avatar** : l'ancien fichier est supprimé du disque une fois la
  transaction validée — sauf s'il est encore référencé par une autre ligne
  `Media` (une annonce peut partager la photo d'un lot). Un document de
  vérification n'est jamais touché par un changement d'avatar.
- **Nettoyage** : les écritures qui échouent et les suppressions d'entités
  déclenchent la suppression des fichiers devenus inutiles.
  `npm run uploads:cleanup` liste les orphelins et leur volume (dry-run par
  défaut) ; `--apply` les supprime, en ignorant tout fichier de moins de 24 h
  (un upload en cours serait pris pour un orphelin).
- **Format réellement livré** : au-delà du mimetype annoncé par le client, les
  octets de tête sont contrôlés (JPEG/PNG/WEBP/PDF) avant écriture —
  400 `FILE_CONTENT_MISMATCH` en cas d'écart.

> ⚠️ **Production : le dossier `uploads/` doit être un volume persistant, et
> sauvegardé.** Les fichiers vivent sur le disque de l'instance, pas dans MySQL.
> Sur une plateforme au système de fichiers éphémère (redéploiement, scale,
> conteneur jetable), un redéploiement suffit à perdre avatars, photos et
> documents de vérification. Il faut donc monter `UPLOADS_DIR` sur un volume
> persistant partagé par toutes les instances, l'inclure dans les sauvegardes
> (avec la base), et surveiller son espace disque.

## Médias

Table `Media` (`ownerUserId` avatar, `ownerListingId` photos d'annonce,
`ownerLotId` photos de lot, `ownerVerificationDocumentId` documents privés ;
plus `mediaType`, `mimeType`, `publicId`, `isPrivate`, `position`). Voir
« Stockage des fichiers » pour l'arborescence sur disque.

## Vérification de profil

`profileVerificationStatus` (`UNVERIFIED`, `PENDING`, `VERIFIED`, `REJECTED`)
décrit la vérification du **profil** par l'équipe. Elle est distincte de
`emailVerified`, qui ne porte que sur l'adresse et ne bloque rien.

### Séquence

1. **Inscription** → compte `UNVERIFIED`.
2. **Dépôt de documents** : `POST /auth/me/documents`, **un fichier par requête**
   dans le champ `file`, avec le champ texte `type`
   (`ID_CARD` | `BUSINESS_REGISTRATION` | `FARM_PROOF` | `OTHER`). Chaque dépôt
   crée un document `PENDING` et fait passer le compte de `UNVERIFIED` ou
   `REJECTED` à `PENDING` (un compte déjà `VERIFIED` n'est pas dévérifié).
   `GET /auth/me/documents` liste les siens — **sans URL**.
3. **Revue staff** : la file est filtrée et triée, le dossier est ouvert, le
   relecteur consulte la pièce, puis tranche `APPROVE` ou `REJECT` (note
   obligatoire en cas de rejet). L'utilisateur reçoit un email après la décision.
4. **Effets** : `VERIFIED` débloque la validation de ses lots par l'équipe
   (`POST /staff/lots/:id/validate` refuse sinon avec 409 `NOT_VERIFIED`) et le
   parrainage (`Referral` → `ELIGIBLE`). Les actions réservées aux profils
   vérifiés deviennent accessibles ; `REJECTED` laisse redéposer.

### Qui peut appeler quoi

| Route | Qui | Objet |
|---|---|---|
| `POST /auth/me/documents` | SUPPLIER, BUYER | Déposer une pièce (1 fichier / requête) |
| `GET /auth/me/documents` | SUPPLIER, BUYER | Ses dossiers, sans URL |
| `GET /admin/verifications` | ADMIN, ROOT · AGENT avec `USER_VERIFICATION` | File de revue paginée et filtrable (voir les paramètres dans l'OpenAPI) |
| `GET /admin/verifications/:id` | idem | Détail du dossier + **lien signé de 10 min** |
| `PATCH /admin/verifications/:id` | idem | Décision `APPROVE` / `REJECT` (`{ decision, note }`) |
| `GET /admin/files/:token` | idem, **porteur du jeton** | Lire la pièce privée elle-même |

`ADMIN` et `ROOT` passent toujours ; un `AGENT` doit porter la capacité
`USER_VERIFICATION`. Le jeton de fichier est signé avec `SECRET_FILE_TOKEN` :
un jeton d'accès ordinaire ne fonctionne pas (401), un jeton émis pour un autre
compte non plus (403). **Chaque consultation est tracée** dans l'audit
(`PROFILE_DOCUMENT_VIEWED`) — c'est l'émission du lien qui est journalisée,
donc une lecture sans lien ne laisse pas de trace.

### Règle de calcul du statut du compte

Elle porte sur **tous** les dépôts du compte, pas sur le seul document examiné :

| Décision | Document | Compte |
|---|---|---|
| `APPROVE` | `VERIFIED` | `VERIFIED` s'il a ≥ 1 document `VERIFIED` **et** 0 `PENDING` ; sinon inchangé (il reste en attente) |
| `REJECT` | `REJECTED` | `REJECTED` s'il n'a **aucun** document `VERIFIED` ; sinon inchangé |

La décision est atomique (`updateMany` conditionnel sur `PENDING`) : deux
relecteurs simultanés obtiennent un `200` et un `409` « Ce document a déjà été
examiné ». Un compte ne peut pas non plus empiler plus de **5 documents
`PENDING`** : le dépôt suivant est refusé en `409 TOO_MANY_PENDING_DOCUMENTS`.

### Routes protégées par `PROFILE_NOT_VERIFIED`

Tant que `profileVerificationStatus ≠ VERIFIED`, ces routes répondent **403**
`PROFILE_NOT_VERIFIED` avec le statut courant dans le corps (le client affiche
« en attente » ou « rejetez, redéposez ») :

- `POST /supplier/lots`
- `PATCH /supplier/lots/:id`
- `POST /supplier/lots/:id/withdraw`
- `POST /orders/:id/confirm`

Le catalogue, la messagerie, le profil, les comptes de paiement et le dépôt de
documents restent accessibles à un compte non vérifié : sans cela il ne pourrait
jamais le devenir. Les comptes d'équipe (`ADMIN`, `ROOT`, `AGENT`) ne sont
jamais concernés.

## Client mobile (Flutter) : envois de fichiers

Toutes les routes d'upload sont en `multipart/form-data`. Le nom du champ
fichier est **strict** : un mauvais nom de champ est refusé en `400`, et le
corps de la réponse rappelle le champ attendu (`expectedField`).

| Route | Champ fichier | Nombre | Formats | Taille max / fichier |
|---|---|---|---|---|
| `POST /auth/me/avatar` | `avatar` | 1 | jpeg, png, webp | 5 Mo |
| `POST /auth/me/documents` | `file` | 1 | jpeg, png, webp, pdf | 8 Mo |
| `POST /supplier/lots` | `images` | 5 | jpeg, png, webp | 5 Mo |
| `POST /staff/lots` | `images` | 5 | jpeg, png, webp | 5 Mo |
| `POST /staff/listings` | `images` | 5 | jpeg, png, webp | 5 Mo |

- **Un seul fichier par requête** pour un document : recto et verso sont **deux
  requêtes**. C'est volontaire — c'est plus fiable sur un réseau mobile instable
  que de poser plusieurs pièces jointes en une seule requête.
- Le champ texte qui accompagne l'upload est `type` pour les documents
  (`ID_CARD` | `BUSINESS_REGISTRATION` | `FARM_PROOF` | `OTHER`) ; les lots et
  annonces portent leurs champs habituels dans la même requête multipart.
- Les URL d'images reçues sont **relatives** (`/uploads/…`) : le client les
  préfixe avec l'URL de base de l'API.

### Codes d'erreur d'upload

| Statut | `code` | Signification |
|---|---|---|
| 400 | `UNEXPECTED_FILE_FIELD` | Mauvais nom de champ, ou plus de fichiers que la limite. `expectedField` donne le champ attendu |
| 400 | `INVALID_MULTIPART` | Requête multipart mal formée |
| 400 | `UNSUPPORTED_MEDIA_TYPE` | Format non accepté |
| 400 | `FILE_REQUIRED` | Aucun fichier reçu |
| 400 | `FILE_CONTENT_MISMATCH` | Les octets ne correspondent pas au format annoncé |
| 403 | `PROFILE_NOT_VERIFIED` | Compte non vérifié (`profileVerificationStatus` dans le corps) |
| 409 | `TOO_MANY_PENDING_DOCUMENTS` | 5 documents `PENDING` déjà déposés |
| 413 | `FILE_TOO_LARGE` | Fichier au-delà de la taille maximale du champ |

## Architecture des rôles et tables de référence

`Role` (niveaux : 10 / 30 / 50 / 100), `UserStatus`, `ListingStatus`,
`DeliveryMode`, `MediaType`, `MimeType`, `ProductCategory`, `Unit`,
`AgentCapability` vivent en **tables**, extensibles sans déploiement.
`ROOT` est créé uniquement via `npm run create:root`. Seul ROOT crée un `ADMIN`.
Un compte suspendu est bloqué à 4 niveaux : `protect`, `login`, `refresh` et la
connexion Socket.io.

## Vulnérabilités connues (`npm audit`)

Les signalements connus portent sur l'outillage (`prisma`, `vitest` en
`devDependencies`), absents d'un déploiement `npm ci --omit=dev`. Les correctifs
proposés passent par des versions majeures : non appliqués, le risque porte sur
l'outillage, pas sur le serveur exposé. `multer` est relevé à `^2.4.0` (correctif
DoS en production).

## Hors MVP

Notifications push, avis/notation, OTP téléphone, dispatch automatique par quota
(mode pull assumé), agrégation de plusieurs lots par annonce (plus tard, via
`ListingLot` sans migration).
