# AgriConnect — Backend (MVP)

API REST + WebSocket pour la marketplace agricole AgriConnect (agriculteurs / acheteurs / livreurs).

## Stack

- Node.js + Express
- PostgreSQL + Prisma (ORM)
- JWT (access token courte durée + refresh token)
- Socket.io (messagerie temps réel)
- Cloudinary (stockage des photos, upload direct via buffer)
- express-validator (validation d'entrée) + express-rate-limit (anti brute-force)

## Installation

```bash
npm install
cp .env.example .env
# -> renseigner DATABASE_URL, JWT_SECRET, et les identifiants Cloudinary

npm run prisma:migrate
npm run dev
```

Le serveur démarre sur `http://localhost:4000`. Vérification rapide : `GET /health`.

**Note** : `npm install` a été testé et validé dans l'environnement de build. La génération Prisma (`prisma generate` / `migrate`) nécessite un accès réseau vers `binaries.prisma.sh`, indisponible dans le sandbox de développement — à exécuter chez toi, où l'accès est normal.

## Structure du projet

```
src/
  config/        -> Prisma, Cloudinary
  controllers/    -> logique métier
  middlewares/    -> auth JWT, rôles, rate-limit, validation, upload, erreurs
  validators/     -> règles express-validator par ressource
  routes/         -> endpoints REST
  sockets/        -> messagerie temps réel
  utils/          -> JWT, refresh token, distance/Haversine, upload Cloudinary
prisma/
  schema.prisma
```

## Modèle de données

- **User** : `role` (`FARMER`\|`BUYER`\|`DRIVER`), `latitude`/`longitude`, `isAvailable`/`vehicleType` (livreur)
- **Listing** : `price`, `quantity` (stock réel, décrémenté à la commande), `latitude`/`longitude` (point de retrait), `status` (`ACTIVE`\|`SOLD`\|`INACTIVE`)
- **Conversation** / **Message** : chat libre entre acheteur et vendeur sur une annonce
- **Order** : `deliveryMode` (`PICKUP`\|`DELIVERY`), `status` (`PENDING`→`READY_FOR_PICKUP`\|`IN_DELIVERY`→`DELIVERED`\|`CANCELLED`)
- **Delivery** : créée automatiquement à la confirmation d'une commande en mode `DELIVERY`. `distanceKm`/`deliveryFee` calculés (Haversine + tarif de base + tarif/km)
- **RefreshToken** : token haché, `expiresAt`, `revoked` — permet un access token court sans reconnexion fréquente

### Flux commande → livraison

1. Acheteur commande (`POST /api/orders`) → le stock est décrémenté **immédiatement** (transaction), commande `PENDING`
2. Agriculteur confirme (`PATCH /api/orders/:id/confirm`) → `READY_FOR_PICKUP` (retrait) ou `IN_DELIVERY` + création atomique de la `Delivery` (livraison)
3. Un livreur **disponible, sans course active** consulte `GET /api/deliveries/available` (triées par distance) et accepte (`POST /api/deliveries/:id/accept`) — premier arrivé, premier servi ; il devient indisponible pendant la course
4. Progression : `ASSIGNED → PICKED_UP → IN_TRANSIT → DELIVERED`. À la livraison, la commande passe à `DELIVERED` et le livreur redevient disponible
5. Une annulation (`PATCH /api/orders/:id/cancel`) restitue le stock, réactive l'annonce si besoin, annule la livraison et libère le livreur assigné — tout est transactionnel

**Toujours volontairement absent** : assignation automatique par quota/zone (mode pull assumé tant qu'on n'a pas de données réelles de volume).

## Authentification

- `POST /api/auth/register` / `login` → `{ user, accessToken, refreshToken }`
- `POST /api/auth/refresh` → `{ refreshToken }` → nouvel `accessToken` (le refresh token n'est pas tourné, juste vérifié non expiré/non révoqué)
- `POST /api/auth/logout` → `{ refreshToken }` → révoque ce token (déconnexion de cet appareil)
- `JWT_EXPIRES_IN` par défaut à `1h` (avant : `7d` sans refresh — remplacé par ce mécanisme, plus sûr)

## Endpoints principaux

| Ressource | Routes clés |
|---|---|
| Auth | `POST /register`, `/login`, `/refresh`, `/logout` |
| Users | `GET/PATCH /me`, `PATCH /me/availability` (livreur) |
| Listings | `GET /`, `GET/PATCH/DELETE /:id`, `POST /`, `POST /:id/photos` |
| Conversations | `GET/POST /`, `GET/POST /:id/messages` |
| Orders | `POST /`, `GET /`, `GET/PATCH /:id/{confirm,cancel,complete}` |
| Deliveries (livreur) | `GET /available`, `GET /mine`, `POST /:id/accept`, `PATCH /:id/status` |

Toutes les routes protégées attendent `Authorization: Bearer <accessToken>`.

## Sécurité et robustesse ajoutées dans cette itération

- **Contrôle de stock** : commander plus que `listing.quantity` disponible est refusé ; le stock est décrémenté/restitué de façon transactionnelle (commande, confirmation, annulation)
- **Transactions Prisma** (`$transaction`) partout où plusieurs écritures doivent réussir ou échouer ensemble (commande+stock, confirmation+livraison, annulation+restitution+libération livreur)
- **Vérification de disponibilité livreur** avant d'accepter une course, et un livreur ne peut pas avoir deux courses actives simultanément
- **Validation d'entrée** (express-validator) sur l'inscription, la connexion, les annonces et les commandes — formats vérifiés, pas juste la présence des champs
- **Rate-limiting** : 10 tentatives/15 min sur les routes d'authentification, 300 req/15 min sur le reste de l'API
- **Refresh token** : access token court (1h) + refresh token longue durée (30 jours, révocable), au lieu d'un token unique de 7 jours sans révocation possible
- **Upload Cloudinary** : dépendance `multer-storage-cloudinary` retirée (jamais mise à jour pour Cloudinary v2, conflit de version qui cassait `npm install`) — upload direct via buffer + `upload_stream`, avec filtrage du type MIME
- **Multer 2.x** : la 1.x contient des failles connues, corrigées en 2.x (API compatible, aucun changement de code nécessaire côté appelant)

## Vulnérabilité connue (non corrigée)

`npm audit` signale une faille modérée dans `qs` (dépendance interne d'Express 4.x, liée au parsing de query strings). Aucun correctif non-breaking n'existe côté Express à ce jour — la résolution nécessiterait une migration vers Express 5, qui est un changement d'architecture à part entière (routing, middlewares) et mérite sa propre discussion plutôt qu'un correctif improvisé.

## Toujours hors MVP (choix de scope, pas des oublis)

- Tests automatisés
- Notifications push
- Système d'avis/notation
- Vérification du téléphone par OTP (nécessite un fournisseur SMS tiers)
- Pagination sur les listes
- Documentation API interactive (Swagger/OpenAPI)

## Messagerie temps réel (Socket.io)

```js
const socket = io('http://localhost:4000', { auth: { token: '<accessToken>' } });
```
Événements : `join_conversation`, `send_message` (`{ conversationId, content }`), `new_message` (reçu).
