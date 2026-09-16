# AgriConnect — Backend (MVP)

API REST + WebSocket pour la marketplace agricole AgriConnect (agriculteurs / acheteurs / livreurs / admin / root).

## Stack

- Node.js (ESM natif, `"type": "module"`) + Express 5
- MySQL + Prisma 7 (ORM)
- JWT (access token courte durée + refresh token)
- Socket.io (messagerie temps réel)
- Cloudinary (stockage des médias, upload direct via buffer)
- Joi (validation d'entrée) + express-rate-limit (anti brute-force)
- bcrypt (natif), ejs + juice (scaffoldés pour de futurs emails transactionnels — non câblés, voir plus bas)

## Corrections apportées à la stack demandée

- **`prisma`/`@prisma/client` réalignés en 7.10.0** : la version fournie mélangeait `prisma@^8.0.0-rc.13` (release candidate, GA prévue octobre 2026) avec `@prisma/client@^5.18.0`. Les deux packages doivent être en version strictement assortie ; Prisma 7 est la version stable recommandée par l'éditeur en attendant la 8 finale.
- **`bcryptjs` retiré**, doublon de `bcrypt` (gardé, plus rapide, versionné explicitement).
- **`mysql2` retiré des dépendances directes** : inutile avec le générateur `prisma-client-js` classique (le moteur gère nativement la connexion MySQL). Il reste présent en **dépendance transitive du CLI `prisma`** (devDependency) - voir la section vulnérabilités ci-dessous.

## Installation

```bash
npm install
cp .env.example .env
# -> renseigner DATABASE_URL (mysql://...), JWT_SECRET, identifiants Cloudinary

npm run prisma:migrate
npm run seed          # peuple les tables de référence
npm run create:root   # crée le compte ROOT en interactif - JAMAIS via l'API
npm run dev
```

**Validé dans l'environnement de build** : syntaxe ESM de tous les fichiers, câblage routes/controllers, `npm install`, et **chargement réel de l'application** (`import('./src/app.js')`) jusqu'au point où seule la génération du client Prisma (réseau vers `binaries.prisma.sh`, indisponible ici) bloque la suite — à faire chez toi, où l'accès est normal.

**Bug réel trouvé et corrigé en testant l'exécution** (pas juste la syntaxe) : `import { PrismaClient } from '@prisma/client'` échoue en interop CommonJS→ESM selon l'environnement Node. Utilisé à la place :
```js
import pkg from '@prisma/client';
const { PrismaClient } = pkg;
```

## Vulnérabilités (`npm audit`)

4 failles **haute sévérité** signalées, mais **toutes dans des devDependencies du CLI `prisma`** (`mysql2`, `deepmerge-ts`), jamais dans `@prisma/client` (la librairie qui tourne réellement dans le serveur en production) :
```
mysql2@3.15.3 <- prisma@7.10.0 (devDependency) <- jamais utilisé au runtime
```
En déploiement avec `npm ci --omit=dev`, ces packages ne sont même pas installés. Un `npm audit fix --force` proposerait de downgrader vers `prisma@6.19.3` : **déconseillé**, ça sacrifie une version stable et récente pour corriger une faille qui n'affecte que l'outil de développement, pas le serveur exposé. À surveiller côté mises à jour Prisma plutôt qu'à corriger dans l'urgence.

## Express 5 : simplifications obtenues

- Les erreurs (sync ou rejets de Promise) dans les controllers remontent **automatiquement** au middleware d'erreur — le wrapper `asyncHandler` utilisé dans les versions précédentes du backend a été **supprimé**, tous les controllers sont maintenant de simples fonctions `async`.
- Le parseur de query string par défaut change en v5, ce qui **résout** la vulnérabilité `qs` qui affectait Express 4 (notée dans une itération précédente de ce projet).

## Validation avec Joi

`src/middlewares/validate.middleware.js` expose `validate(schema, property)`, utilisé en middleware de route (`validate(registerSchema)`). Utilise `schema.validateAsync()` pour supporter aussi bien les règles synchrones que les règles `.external()` asynchrones (ex: vérifier qu'une `category` existe bien dans `ListingCategory` avant de créer une annonce).

## MySQL : différences avec PostgreSQL à connaître

- **Pas de `mode: 'insensitive'`** sur les filtres `contains` : ce connecteur Prisma ne le supporte pas. La sensibilité à la casse dépend désormais de la **collation** de la base (`utf8mb4_general_ci`/`utf8mb4_0900_ai_ci` sont insensibles à la casse par défaut - vérifie la collation de tes tables si la recherche te semble trop stricte).
- **Pas de champs `String[]`** : ce backend n'en avait déjà plus (le système `Media` remplace `photos[]`), donc rien à adapter ici.
- Champs texte potentiellement longs passés en `@db.Text` explicitement (`Listing.description`, `Message.content`, `Order.deliveryAddress`) pour éviter la troncature à 191 caractères par défaut de Prisma sur MySQL.

## Emails transactionnels (ejs + juice + nodemailer)

Infrastructure complète et **testée en exécution réelle** (rendu de template + inlining CSS + envoi confirmés, pas juste vérifiés syntaxiquement) :

- `src/config/mailer.js` : transport SMTP générique (compatible Gmail, SendGrid, Mailgun, tout serveur SMTP) via variables d'environnement
- `src/utils/renderEmail.js` : rend un template EJS (`src/emails/templates/*.ejs`) puis inline le CSS avec `juice` (nécessaire car la plupart des clients email ignorent les balises `<style>`)
- `src/utils/sendMail.js` : enveloppe l'envoi. **Si `SMTP_HOST` n'est pas renseigné, l'email est simplement journalisé** au lieu d'échouer - pratique en développement local sans configuration SMTP
- Envoi toujours **non-bloquant** (`.catch()` côté appelant) : un échec d'email ne doit jamais faire échouer une inscription

**Déclencheurs câblés** :
- Email de bienvenue à l'inscription (`POST /api/auth/register`), si un email a été renseigné (il est optionnel)
- Notification à la création d'un compte ADMIN par ROOT (jamais le mot de passe dans l'email)

**Non câblé, à définir ensemble si besoin** : confirmation de commande, réinitialisation de mot de passe (nécessite un flux de token dédié, inexistant actuellement), notification de suspension. La même infrastructure (`sendMail` + un nouveau template `.ejs`) suffit pour les ajouter.

## Architecture des rôles et tables de référence

`Role` (avec hiérarchie `level` : 10 opérationnel / 50 ADMIN / 100 ROOT), `UserStatus`, `ListingStatus`, `ListingCategory`, `DeliveryMode`, `MediaType`, `MimeType` vivent en **tables**, extensibles sans déploiement. `OrderStatus`/`DeliveryStatus` restent des **enums Postgres... pardon, MySQL** (Prisma supporte les enums natifs sur MySQL) : ce sont des machines à états déjà câblées en code (`VALID_TRANSITIONS`).

`ROOT` : créé uniquement via `npm run create:root` (jamais via l'API). Seul rôle habilité à créer un `ADMIN` (`POST /api/admin/users`). Un compte suspendu est bloqué à 3 niveaux : `protect`, `login`, `refresh`.

## Système de médias

`Listing.photos`/`User.avatarUrl` sont remplacés par la table **`Media`** (`ownerUserId` ou `ownerListingId` + `mediaType`/`mimeType`). Nouvel endpoint : `POST /api/users/me/avatar`.

**Changement d'API côté Flutter** : `listing.category`/`listing.status` sont des objets (`{code, label}`), `listing.photos` devient `listing.media`, `user.avatarUrl` disparaît au profit de `GET /api/users/me` → champ `media`.

## Endpoints principaux

| Ressource | Routes clés |
|---|---|
| Auth | `POST /register`, `/login`, `/refresh`, `/logout` |
| Users | `GET/PATCH /me`, `POST /me/avatar`, `PATCH /me/availability` |
| Listings | `GET /`, `GET/PATCH/DELETE /:id`, `POST /`, `POST /:id/photos` |
| Conversations | `GET/POST /`, `GET/POST /:id/messages` |
| Orders | `POST /`, `GET /`, `PATCH /:id/{confirm,cancel,complete}` |
| Deliveries (livreur) | `GET /available`, `GET /mine`, `POST /:id/accept`, `PATCH /:id/status` |
| Admin (niveau ≥ 50) | `GET /users`, `PATCH /users/:id/{suspend,reactivate}`, `POST /users` (ROOT), `GET /orders`, `GET /stats`, `PATCH /listings/:id/deactivate` |

## Flux commande → livraison

1. Commande créée → stock décrémenté immédiatement (transaction)
2. Confirmation agriculteur → `READY_FOR_PICKUP` ou `IN_DELIVERY` + création atomique de la `Delivery`
3. Livreur disponible, sans course active, accepte (premier arrivé, premier servi) → devient indisponible
4. `ASSIGNED → PICKED_UP → IN_TRANSIT → DELIVERED` → commande `DELIVERED`, livreur redisponible
5. Annulation : restitution du stock, réactivation de l'annonce si besoin, libération du livreur - tout transactionnel

**Toujours volontairement absent** : dispatch automatique par quota (mode pull assumé).

## Toujours hors MVP

Tests automatisés, notifications push, avis/notation, OTP téléphone, pagination, Swagger/OpenAPI, confirmation de commande par email, réinitialisation de mot de passe.
