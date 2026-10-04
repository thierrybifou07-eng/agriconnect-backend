# AgriConnect — Backend (MVP)

API REST + WebSocket pour la marketplace agricole AgriConnect (agriculteurs / acheteurs / livreurs / admin / root).

Ce document ne décrit que ce qui a été vérifié en exécutant le code. Les
affirmations de la version précédente qui ne tenaient pas à l'exécution ont été
retirées plutôt que reformulées.

## Stack

- Node.js (ESM natif, `"type": "module"`) + Express 5.2
- MySQL + Prisma **6.19.3** (ORM)
- JWT (access token courte durée + refresh token)
- Socket.io (messagerie temps réel)
- Cloudinary (stockage des médias, upload via buffer)
- Joi (validation d'entrée) + express-rate-limit (anti brute-force)
- bcrypt, ejs + juice + nodemailer (emails transactionnels)
- Vitest + Supertest (tests, voir « Tests »)

## Installation

```bash
npm install
cp .env.example .env
# -> renseigner DATABASE_URL (mysql://...), JWT_SECRET, identifiants Cloudinary

npm run prisma:generate   # si le client Prisma n'est pas déjà à jour
npm run prisma:migrate    # applique les migrations
npm run seed              # peuple les tables de référence
npm run create:root       # crée le compte ROOT en interactif - JAMAIS via l'API
npm run dev
```

## Tests

```bash
npm test                  # tout
npm run test:unit         # arithmétique, JWT, refresh tokens (aucune base)
npm run test:integration  # HTTP sur une base dédiée
```

La suite d'intégration utilise une base **`agriconnect_test`** dont le nom est
déduit de `DATABASE_URL` dans `.env` : les données de développement ne sont
jamais tronquées. `globalSetup` crée la base si elle n'existe pas, applique les
migrations avec `migrate deploy` et joue le seed. Chaque test repart de tables
métier vides ; les tables de référence sont conservées.

MySQL doit tourner. Les tests n'utilisent aucun SMTP (`SMTP_DISABLED`) et
l'anti-brute-force est neutralisé, sauf dans `rate-limit.test.js` qui le
réactive explicitement pour le vérifier.

## Points où le comportement peut surprendre

- **Les identifiants de route sont des entiers.** Express fournit
  `req.params` en chaîne ; les routeurs le convertissent via `router.param`.
  Sans cela, chaque route `/:id` répondait 500.
- **`price`, `unitPrice`, `totalPrice`, `deliveryFee`, `quantity` sont des
  `DECIMAL`.** Prisma renvoie un objet `Decimal`, l'arithmétique se fait avec
  `mul`/`minus`/`plus`, et `decimal-json.middleware.js` convertit en nombre au
  moment de la réponse JSON pour que le contrat de l'API reste « nombre ».
  Voir `src/utils/money.js`.
- **Le nom est en deux colonnes**, `firstname` et `lastname`. Il n'existe pas de
  colonne `fullName`.
- **Une annonce qui a des commandes ne peut pas être supprimée** : la route
  répond 409 et propose la désactivation. Les conversations et les photos de
  l'annonce partent avec elle ; une photo de profil ne part pas.
- **Les emails ne font jamais échouer une requête.** L'envoi part en
  arrière-plan et journalise son échec. `POST /api/auth/register` ne renvoie donc
  plus de champ `emailSent` : sans attendre l'envoi, il ne pouvait être ni vrai
  ni faux.
- **CORS est ouvert si `CORS_IO` est vide.** `cors()` sans option accepte toute
  origine ; il faut renseigner `CORS_IO` en production.

## Express 5

- Les erreurs (sync ou rejets de Promise) des contrôleurs remontent
  automatiquement au middleware d'erreur. Aucun wrapper `asyncHandler` n'est
  nécessaire, et le wrapper mort qui restait (écrit en CommonJS dans un projet
  ESM, il aurait planté à l'import) a été supprimé.
- Le parseur de query string par défaut change en v5, ce qui résout la
  vulnérabilité `qs` qui affectait Express 4.

## Validation avec Joi

`src/middlewares/validate.middleware.js` expose `validate(schema, property)`,
utilisé en middleware de route. Il s'appuie sur `schema.validateAsync()` pour
supporter aussi les règles `.external()` asynchrones (vérifier qu'une catégorie
existe bien avant de créer une annonce).

Ces règles signalent leurs échecs avec `helpers.error()` et non `throw` : une
`Error` ordinaire sort de `validateAsync` sans être une erreur Joi, le
middleware ne la reconnaît pas et répond 500 au lieu de 400.

## MySQL : différences avec PostgreSQL

- **Pas de `mode: 'insensitive'`** sur les filtres `contains`. La sensibilité à la
  casse dépend de la **collation** de la base.
- Champs texte longs passés en `@db.Text` explicitement (`Listing.description`,
  `Message.content`, `Order.deliveryAddress`) pour éviter la troncature à 191
  caractères.

## Emails transactionnels

- `src/config/email/transport.js` : transport SMTP construit **exclusivement
  depuis l'environnement**. Sans `SMTP_HOST`, aucun transport n'est créé et
  l'envoi devient un no-op journalisé.
- `src/config/email/sendMail.js` : rend un gabarit EJS puis inline le CSS avec
  `juice` (les clients email ignorent les feuilles de style externes), et envoie.
  `renderTemplate` est exporté pour pouvoir vérifier le rendu sans SMTP.
- Gabarits dans `views/emails/<nom>/email.ejs`, parties communes dans
  `views/emails/_shared/`. Résolus depuis la racine du projet, pas depuis le
  répertoire courant.
- Pages HTML servies par l'API (formulaires derrière les liens d'email) :
  `views/pages/formulaire.ejs` + `page.css`, rendues par `utils/renderPage.js`.
  Volontairement distinctes de la pile email : un email est rendu par le client
  de messagerie, une page par un navigateur.
- `EMAIL_SENDER` doit être une adresse complète (`"AgriConnect <no-reply@…>"`) :
  la plupart des serveurs SMTP refusent une adresse nue.
- `SMTP_HOST` est un **nom d'hôte**, jamais l'URL d'une interface web. Avec le
  piège à mail local (MailDev), le SMTP écoute sur **1025** et l'interface web
  sur **1080** : confondre les deux fait échouer chaque envoi sans message.

**Déclencheurs câblés** : inscription (bienvenue **et** vérification d'adresse),
création d'un compte ADMIN par ROOT, demande de réinitialisation, confirmation
de changement de mot de passe, renvoi de la vérification.

**Non câblé, à définir si besoin** : confirmation de commande, notification de
suspension. Un nouveau dossier de gabarit et un appel à `sendTemplateEmail`
suffisent.

## Authentification : sessions, statuts et récupération de compte

Voir `PLAN_AUTH.md` pour les décisions et leur justification. Ce qui compte en
pratique :

**Une session est un appareil connecté.** `Session` porte l'agent, l'IP, la
dernière activité et sa date de fermeture ; `RefreshToken` est son enfant. Une
connexion ouvre une session, plafonnée à **5 par compte** (`SESSION_MAX_PER_USER`),
la plus ancienne étant fermée au-delà. Sans ce modèle, « déconnecte cet
appareil » n'était pas exprimable et le logout ne révocait qu'un jeton parmi
ceux du compte.

**Le refresh token tourne, et sa réutilisation détruit la session.** Chaque
`POST /api/auth/refresh` remplace le jeton qu'il reçoit. Présenter un jeton déjà
remplacé est traité comme un vol et ferme toute la session — avec
`REFRESH_REUSE_GRACE_SECONDS` (30 s) de tolérance, car deux refreshs parallèles
d'une même application mobile sont ordinaires et seraient sinon pris pour une
attaque. La fenêtre se mesure depuis le **premier** remplacement : un rejeu en
boucle ne peut pas la repousser indéfiniment.

**La base fait foi, le jeton informe.** `protect` recharge l'utilisateur en base
à chaque requête. Les claims `userStatus`, `emailVerified` et `sessionId`
servent au client, jamais à autoriser : un jeton émis avant une suspension est
refusé, un jeton émis avant une vérification reste utilisable.

**La vérification d'adresse ne bloque rien.** `emailVerified` sert à
l'affichage. Changer d'adresse la remet à zéro et invalide le jeton en cours,
sinon on hériterait d'un `true` sur une adresse tierce.

**Récupération de compte.** `POST /api/auth/forgot-password` répond **de la même
façon** que l'adresse existe ou non : distinguer les deux permettrait d'énumérer les
comptes. Les jetons sont hachés, à usage unique, valables 15 minutes, et un
seul est actif par compte. `POST /api/auth/reset-password` **détruit toutes les
sessions** du compte et envoie une alerte de sécurité. Les liens ouvrent une page
de formulaire par `GET`, et seul le `POST` applique : les clients de messagerie
et les antivirus préchargent les liens, et un `GET` qui consomme le jeton
modifierait un mot de passe avant que son propriétaire ne l'ait vu.

**Suspension.** Suspendre un compte ferme ses sessions **et** déconnecte ses
websockets (`session_revoked`). Le contrôle se faisait en 3 points sur 4 avant :
le socket ne consultait pas le statut.

### Routes d'authentification

| Route | Effet |
|---|---|
| `POST /api/auth/register` | Inscription, ouvre une session |
| `POST /api/auth/login` | Connexion, ouvre une session (plafond 5) |
| `POST /api/auth/refresh` | Tourne le jeton dans la session |
| `POST /api/auth/logout` | Ferme la session de l'appareil |
| `GET /api/auth/sessions` | Sessions ouvertes, avec `isCurrent` |
| `DELETE /api/auth/sessions/:id` | Ferme une session |
| `POST /api/auth/logout-all` | Ferme toutes les sessions sauf la courante |
| `POST /api/auth/forgot-password` | Lien de réinitialisation (réponse identique) |
| `GET`/`POST /api/auth/reset-password` | Formulaire / application du nouveau mot de passe |
| `GET`/`POST /api/auth/verify-email` | Formulaire / application de la vérification |
| `POST /api/auth/resend-verification` | Renvoi du lien (cooldown 5 min) |
| `GET`/`PATCH /api/auth/me` | Profil |
| `POST /api/auth/me/avatar` | Avatar |
| `PATCH /api/auth/me/availability` | Disponibilité (DRIVER) |

`/api/users` a été **libéré** : il n'accueille plus que l'administration, à venir.

### Ce que le client Flutter doit savoir

- `role` et `userStatus` sont des **`{ code, label }`** partout, y compris sur
  l'inscription et la connexion. Auparavant `GET /api/users/me` renvoyait des
  lignes de base entières : deux formes pour un même champ.
- `POST /api/auth/refresh` renvoie **`accessToken` et `refreshToken`** : le second
  est nouveau à chaque appel, l'ancien étant révoqué. Un client qui réutilise le
  sien se fera refuser après 30 s.
- Les quatre routes profil ont changé de préfixe (`/api/users/me*` →
  `/api/auth/me*`). Aucun client n'existait, donc aucune compatibilité n'est
  fournie : les anciennes chemins répondent 404.
- L'email de vérification et le formulaire de réinitialisation sont servis par
  l'API. Une fois `APP_URL` renseignée pour l'application, les redirections
  post-action s'y font sans autre changement.

## Architecture des rôles et tables de référence

`Role` (hiérarchie `level` : 10 opérationnel / 50 ADMIN / 100 ROOT), `UserStatus`,
`ListingStatus`, `ListingCategory`, `DeliveryMode`, `MediaType`, `MimeType`
vivent en **tables**, extensibles sans déploiement. `OrderStatus` et
`DeliveryStatus` sont des **enums MySQL** : ce sont des machines à états déjà
câblées en code.

`ROOT` est créé uniquement via `npm run create:root`, jamais via l'API. Seul rôle
habilité à créer un `ADMIN` (`POST /api/admin/users`). Un compte suspendu est
bloqué à 4 niveaux : `protect`, `login`, `refresh` et la connexion Socket.io ;
la suspension ferme en outre ses sessions et déconnecte ses websockets.

## Système de médias

La table **`Media`** (`ownerUserId` **ou** `ownerListingId`, plus `mediaType` et
`mimeType`) remplace les champs `photos[]` et `avatarUrl`. Points d'entrée :
`POST /api/auth/me/avatar` et `POST /api/listings/:id/photos`.

**Côté client Flutter** : `listing.category` et `listing.status` sont des objets
`{code, label}`, `listing.photos` devient `listing.media`, `user.avatarUrl`
disparaît au profit du champ `media` de `GET /api/auth/me`.

## Endpoints principaux

| Ressource | Routes clés |
|---|---|
| Auth | inscription, connexion, sessions, récupération de compte — voir la table ci-dessus |
| Users | *aucune route* : préfixe libéré pour l'administration à venir |
| Listings | `GET /`, `GET/PATCH/DELETE /:id`, `POST /`, `POST /:id/photos` |
| Conversations | `GET/POST /`, `GET/POST /:id/messages` |
| Orders | `POST /`, `GET /`, `GET /:id`, `PATCH /:id/{confirm,cancel,complete}` |
| Deliveries (livreur) | `GET /available`, `GET /mine`, `POST /:id/accept`, `PATCH /:id/status` |
| Admin (niveau ≥ 50) | `GET /users`, `PATCH /users/:id/{suspend,reactivate}`, `POST /users` (ROOT), `GET /orders`, `GET /stats`, `PATCH /listings/:id/deactivate` |

## Flux commande → livraison

1. Commande créée → stock décrémenté immédiatement (transaction)
2. Confirmation agriculteur → `READY_FOR_PICKUP` ou `IN_DELIVERY` + création
   atomique de la `Delivery`
3. Livreur disponible, sans course active, accepte (premier arrivé, premier
   servi) → devient indisponible
4. `ASSIGNED → PICKED_UP → IN_TRANSIT → DELIVERED` → commande `DELIVERED`,
   livreur redisponible
5. Annulation : restitution du stock, réactivation de l'annonce si besoin,
   libération du livreur — le tout en transaction

Ce flux est couvert par `tests/integration/resource-routes.test.js`. Il était
inatteignable avant correction : la création de commande était rejetée par la
validation, et toutes les routes paramétrées répondaient 500.

**Volontairement absent** : dispatch automatique par quota (mode pull assumé).

## Vulnérabilités connues (`npm audit`)

6 signalements (3 modérés, 3 hauts) au dernier audit :

- `deepmerge-ts` (haut) et `@vitest/mocker` (modéré) : n'arrivent que par le CLI
  `prisma` et `vitest`, tous deux en `devDependencies`. Absents d'un déploiement
  `npm ci --omit=dev`.
- Les correctifs proposés passent chacun par une version majeure de `vitest` ou
  de `prisma`. Ils ne sont pas appliqués : le risque porte sur l'outillage, pas
  sur le serveur exposé.

`multer` a été relevé à `^2.4.0` pour corriger un déni de service (écritures
orphelines sur upload interrompu) qui le touchait **en production**.

## Toujours hors MVP

Notifications push, avis/notation, réinitialisation de mot de passe, pagination
des listes, Swagger/OpenAPI, OTP téléphone.
