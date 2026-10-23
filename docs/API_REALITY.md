# AgriConnect — API_REALITY (vérité terrain du backend)

---

## 0. Corrélation spec ↔ backend (mise à jour — vérifiée par script)

| Contrôle | Résultat |
|---|---|
| `agriconnect-api__1_.yaml` (fichier projet) vs `docs/openapi.yaml` du dépôt backend | **0 différence de contenu** (comparaison YAML profonde, espaces ignorés ; seule la mise en forme diffère). Les 133 opérations et tous les schémas sont identiques |
| Routes du code (`src/routes/*.routes.js`, montées dans `router.js`) vs spec | **133 / 133 identiques** (méthode + chemin). Aucune route fantôme, aucune route non documentée |
| Schémas de **requête** (corps, chemins, validation Joi) | Fiables : la spec est générée depuis les schémas Joi (notes « Conditionnel — si … ») |
| Schémas de **réponse** | **Non fiables** : la spec laisse souvent `type: object` / `Paginated.items: object`, et plusieurs formes, enums et paramètres de requête diffèrent du code (§4) |
| Agent IA | Le backend ne contient **que** la fiche `Agent` (CRUD + garde-fous). **Aucun runtime IA, aucun client Ollama/LLM** (§5, B4) |

**Conclusion** : la spec est exacte sur *quelles routes existent* et sur *ce qu'on peut envoyer* ; elle est
inexacte sur *ce qui revient* et sur certains filtres. Pour tout modèle Dart, ce document (§4, §6) prime.

## 1. Transport

| Élément | Valeur |
|---|---|
| Préfixe REST | `/api/v2` |
| Port dev | `4000` |
| URL dev Android émulateur | `http://10.0.2.2:4000/api/v2` |
| URL dev appareil réel | `http://<IP-LAN-du-PC>:4000/api/v2` |
| Socket.io | **racine de l'origine** (`http://10.0.2.2:4000`), PAS `/api/v2`. Auth : `io(url, {auth:{token: accessToken}})` |
| Médias publics | l'API renvoie une URL **relative** `/uploads/<dossier>/<fichier>` → préfixer par l'origine (sans `/api/v2`) |
| Documents de vérification | privés, jamais servis statiquement (voir §8.6) |
| Santé | `GET /health` (hors préfixe) → `{status:'ok'}` |
| Docs interactives | `GET /agriconnect-openapi` |
| Rate limit | `/auth/register` + `/auth/login` : 10 / 15 min / IP ; `/auth/refresh` : 60 ; `/auth/forgot-password` : 5. Réponse **429** `{error}` sans `code` |

Android : en `http://` clair (dev), Android ≥ 9 bloque le trafic non chiffré → `usesCleartextTraffic`
ou `network_security_config` **en debug uniquement**. La permission `INTERNET` doit être dans le
manifest **principal** (elle n'est aujourd'hui que dans `debug/`).

## 2. Enveloppes

**Erreur** (toujours) :
```json
{ "error": "Message en français", "code": "MAJUSCULES_OPTIONNEL" }
```
**Erreur de validation Joi (400)** — la spec ne le dit pas :
```json
{ "error": "Données invalides", "details": [ { "field": "email", "message": "..." } ] }
```
`PROFILE_NOT_VERIFIED` (403) ajoute `profileVerificationStatus`.
`UNEXPECTED_FILE_FIELD` (400) ajoute `expectedField`.

Codes rencontrés dans le code : `INVALID_STATE_TRANSITION`, `INSUFFICIENT_STOCK`,
`PRICE_BELOW_SUPPLIER`, `ZONE_NOT_COVERED`, `PROFILE_NOT_VERIFIED`, `NOT_VERIFIED`,
`LOT_ALREADY_LINKED`, `LOT_NOT_AVAILABLE`, `TOO_MANY_PENDING_DOCUMENTS`, `INVALID_AMOUNT`,
`COMPENSATION_RATE_ZERO`, `DELIVERY_ALREADY_TAKEN`, `DELIVERY_ALREADY_ACTIVE`,
`DELIVERY_NOT_FOUND`, `NOT_DELIVERY_OWNER`, `DELIVERIES_ALREADY_CREATED`,
`INVALID_DELIVERY_MODE`, `INVALID_ORDER_STATUS`, `ORDER_NOT_FOUND`, `FILE_TOO_LARGE`,
`FILE_REQUIRED`, `FILE_CONTENT_MISMATCH`, `UNSUPPORTED_MEDIA_TYPE`, `INVALID_MULTIPART`,
`UNEXPECTED_FILE_FIELD`, `FILE_MISSING`, `PROFILE_MISSING`.
**Beaucoup d'erreurs n'ont pas de `code`** (401 « Token invalide ou expiré », 403 « Capacité requise »,
403 « Accès refusé pour ce rôle », 403 « Ce compte a été suspendu », 429) : le client doit prévoir
un repli sur le statut HTTP + message.

**Pagination** : `{ items: [...], page, limit, total }`, `page ≥ 1`, `1 ≤ limit ≤ 100`, défaut 20.

**Nombres** : montants à 2 décimales, quantités à 3 décimales, renvoyés en **nombre JSON**
(jamais string). → modèles Dart en `double`/`num`, **pas `int`**. Devise plateforme : `XAF`
(lecture seule). **Identifiants : entiers** (`int`), partout, y compris `:id` de chemin.

## 3. Authentification et sessions

- `POST /auth/login {email,password}` → `200 {user, accessToken, refreshToken}`. Pas de champ rôle
  dans la requête : le **client** ne peut pas « choisir un rôle » ; il lit `user.role.code`.
  403 compte suspendu ; 401 identifiants ; 429 trop de tentatives.
- `POST /auth/register` → `201 {user, accessToken, refreshToken}`. **Rôles publics : SUPPLIER ou
  BUYER uniquement.** Un DRIVER est créé par un ADMIN (`POST /admin/users`), jamais en auto-inscription.
  Champs : `firstname`(≥2) `lastname`(≥2) `phone`(`^\+?[0-9]{8,15}$`) `email` `password`
  `role` `acceptTerms`(**true obligatoire**) ; optionnels `location`, `referralCode`(≤20),
  `farmName`(2–120, SUPPLIER), `buyerType`(RETAILER|FARMER|WHOLESALER|OTHER), `businessName`(≤120).
  Mot de passe : `^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])(?!.*(.)\1\1\1)[A-Za-z\d@$!%*?&]{8,}$`
  (⚠ seuls `@$!%*?&` sont acceptés comme spéciaux ; 4 caractères identiques d'affilée interdits).
  409 email ou téléphone déjà pris (codes distincts).
- **Access token** : JWT, durée `JWT_EXPIRES_IN` (défaut **1 h**), porte `id`, `sessionId`, statut,
  `emailVerified`, `exp`. **Refresh token** : opaque (64 car.), durée 30 j, **rotation** à chaque
  refresh ; réutilisation d'un jeton déjà remplacé = vol → session détruite (grâce 30 s pour deux
  refresh parallèles). Max 5 sessions/compte (la plus ancienne est fermée).
- `POST /auth/refresh {refreshToken}` → `200 {accessToken, refreshToken}` (**pas de `user`**).
- `POST /auth/logout {refreshToken}` (public) ferme la session de l'appareil.
- `POST /auth/logout-all` ferme toutes les sessions **sauf la courante**.
- `GET /auth/sessions` → **`{ sessions: [ {id, userAgent, ip, createdAt, lastActivityAt, expiresAt, isCurrent} ] }`**
  (objet, pas tableau ; noms de champs ≠ spec).
- `DELETE /auth/sessions/:id` ferme une session du compte.
- `POST /auth/forgot-password {email}` → 200 identique dans tous les cas. Le lien envoyé par email
  ouvre une **page HTML servie par le backend** (`GET /auth/reset-password?token=`), qui redirige
  vers `APP_URL` ensuite. Le mobile n'a **pas** à implémenter l'écran de reset en MVP.
- `GET /auth/verify-email?token=` idem (page HTML backend). `POST /auth/resend-verification`
  (auth requise, cooldown 5 min).
- **Toute requête protégée recharge l'utilisateur en base** : un compte suspendu reçoit **403
  « Ce compte a été suspendu »** (pas 401). 401 = jeton absent/invalide/expiré.
- Politique client : sur **401** d'une route protégée → un seul `refresh` (single-flight), rejouer la
  requête une fois ; si le refresh échoue (401/403) → déconnexion locale. Ne jamais boucler.

## 4. DÉRIVES spec ↔ code (corrigées par ce document)

| Endpoint | La spec dit | Le code fait |
|---|---|---|
| `GET /conversations` | tableau | `{items,page,limit,total}` |
| `GET /conversations/:id/messages` | tableau | paginé `{items,...}` (asc par `createdAt`) |
| `GET /staff/conversations/:id/messages` | tableau | paginé |
| `GET /driver/deliveries/available` et `/mine` | tableau | paginé |
| `GET /staff/stock-movements` | tableau | paginé |
| `GET /auth/sessions` | tableau, champs `lastActiveAt`,`closedAt` | `{sessions:[…]}`, champs `lastActivityAt`,`expiresAt`,`userAgent`,`ip` |
| `GET /auth/me/referral` | `{referralCode, referrals:[{id,kind,status∈PENDING\|APPROVED\|REJECTED,firstname}]}` | `{code, totals:{pending,eligible,paid}, referrals:[{status∈PENDING\|ELIGIBLE\|PAID\|REJECTED, kind, rewardAmount, createdAt, referredFirstname}]}` |
| `GET /auth/me` | `User + profile` | idem **+ `media: [ {id,url,isPrimary,position} ]`** (l'avatar y figure) |
| `PATCH /auth/me` | `firstname,lastname,location,latitude,longitude` | accepte `firstname,lastname,**email**,location` ; **latitude/longitude ignorés** ; pas de validation Joi sur cette route. Changer l'email remet `emailVerified` à false |
| `Conversation.type` | `BUYER\|SUPPLIER` | `BUYER_SUPPORT\|SUPPLIER_SUPPORT` |
| `Conversation.status` | `OPEN\|ASSIGNED\|ESCALATED\|CLOSED` | `OPEN\|WAITING_CUSTOMER\|CLOSED` (+ `escalatedAt` non nul = escaladée ; assignation via `assignedAgentId`) |
| `Compensation.status` | `PENDING` | `PENDING_APPROVAL\|APPROVED\|PAID\|REJECTED` |
| `GET /catalog/listings` params | `categoryId`, `productId` | **`categoryId`, `zoneId`, `q`, `sort`(`price`\|`expiry`, défaut récence)** ; `productId` est **ignoré** |
| `GET /admin/users` params | `profileVerificationStatus` | + `role`, `search`, `status` ; **non paginé** (tableau brut) |
| `POST /auth/me/avatar` | 200 | renvoie le Media `{id,url,isPrimary,position}` |
| `Error` | `{error,code}` | + `details[]` sur 400 Joi, + champs d'appoint (voir §2) |
| `GET /staff/conversations` params | `page`,`limit` | + **`status`, `unassigned`, `mine`, `escalated`** (filtres d'inbox) |
| `GET /admin/audit-logs` params | `page`,`limit` | + **`entityType`, `entityId`, `actorUserId`, `actorAgentId`, `from`, `to`** |
| `GET /admin/stats` params | aucun | + **`from`, `to`** (dates) |
| `GET /admin/payouts`, `/admin/compensations`, `/admin/referrals` params | aucun | + **`status`** (+ `page`,`limit`) |
| `GET /driver/deliveries/mine` params | aucun | + `status` |
| `GET /staff/deliveries` params | `page`,`limit` | + `status`, `orderId` |
| `User.agent` / capacités | absent | **absent aussi du code** → voir §5 |

## 5. TROUS DU CONTRAT (bloquants — à corriger côté backend, prompt P00)

1. **B1 — Capacités d'un AGENT invisibles du client.** `userToApi` ne renvoie ni `agent` ni
   `capabilities` ; ni `/auth/login`, ni `/auth/me`. Le seul endpoint qui les expose
   (`GET /admin/agents`) exige ADMIN. Un agent ne peut donc pas savoir quels onglets afficher.
   → Ajouter `agent: {id, displayName, kind, autonomy, capabilities: string[]}` (ou `null`) à
   `userToApi` pour les AGENT. Repli sans changement backend : afficher les onglets staff
   « optimistes » et traiter `403 "Capacité requise"` — dégradé, déconseillé.
2. **B2 — Aucun référentiel lisible par SUPPLIER/BUYER.** `GET /admin/products|zones|hubs|units|categories`
   sont `requireMinLevel(50)`. `/catalog/categories` exclut SUPPLIER. Un fournisseur **ne peut pas
   obtenir** `productId`, `zoneId`, `hubId` pour `POST /supplier/lots` ; un acheteur ne peut pas
   choisir sa `zoneId`. **Bloquant pour la déclaration de lot.**
   → Ajouter des lectures seules `GET /reference/{products|zones|hubs|units|categories}`
   (rôles SUPPLIER, BUYER, AGENT, ADMIN, ROOT ; éléments actifs ; paginées `limit ≤ 100`).
3. **B3 — Régénérer `docs/openapi.yaml`** une fois les dérives du §4 corrigées (source : fragments
   `openapi/*.openapi.js`, commande `npm run docs:openapi`).

4. **B4 — Agent IA : aucun runtime (nouveau, vérifié).** `Agent.kind='AI'` existe (champs `aiProvider`, `aiModel`,
   `aiConfig`, `autonomy`) et `POST /admin/agents/ai` crée la fiche, mais :
   - aucun code n'appelle un LLM (pas de client Ollama, pas de déclencheur, pas de file de travail) ;
   - un agent IA n'a **pas de compte** (`userId = null`) → il ne peut pas s'authentifier : `requireCapability`
     retrouve l'agent par `userId`, donc la branche `req.agent.kind === 'AI'` de `requireHumanActor` n'est
     **jamais atteinte via HTTP aujourd'hui** ;
   - aucune entité « suggestion / action en attente d'approbation » : `SUGGEST_ONLY` et `ACT_WITH_APPROVAL`
     n'ont aujourd'hui aucun effet ;
   - `Message.readAt` existe en base mais n'est exposé nulle part (pas de « non lu » serveur).
   → L'IA doit agir **côté backend, par appels de services internes**, jamais en simulant un utilisateur
   HTTP. Conception : `03_AI_AGENT_DESIGN.md`.

Autres manques **assumés par la conception** (ne pas les « corriger » côté client) :
- Aucun endpoint de commandes côté fournisseur (le fournisseur ne voit jamais l'acheteur).
- Aucun panier / checkout / création de commande par l'acheteur : **c'est l'équipe qui émet un devis**
  (`POST /staff/orders`) ; l'acheteur le confirme (`POST /orders/:id/confirm`) ou l'annule.
- Aucun endpoint de paiement côté acheteur : les paiements sont **saisis manuellement** par le staff.
- Aucun endpoint « notifications » ni push : seules des émissions Socket.io existent (§9).
- Aucun endpoint de livraison côté acheteur : il reçoit `delivery:status` par socket, et le statut
  de commande `OUT_FOR_DELIVERY` / `COMPLETED`.

## 6. Formes de réponse (vérifiées dans les DTO)

### 6.1 User (`userToApi`)
```
{ id:int, firstname, lastname, email, phone, location:string|null,
  role:{code,label}, userStatus:{code,label}, emailVerified:bool,
  profileVerificationStatus:'UNVERIFIED'|'PENDING'|'VERIFIED'|'REJECTED',
  referralCode:string|null, createdAt }
```
`role.code ∈ ROOT|ADMIN|AGENT|SUPPLIER|BUYER|DRIVER`. `GET /auth/me` ajoute `media[]` et `profile`.
Profils : SUPPLIER `{farmName, description|null, zoneId|null}` ; BUYER `{buyerType, businessName|null, zoneId|null}` ;
DRIVER `{vehicleType|null, plateNumber|null, agencyId}` ; staff → `profile: null`.
(`id` du profil **non exposé**, contrairement à la spec.)

### 6.2 Lot — vue fournisseur (`lotToSupplierDto`), vue staff = + champs ci-dessous
```
{ id, lotCode:'LOT-000123',
  product:{id,name,isPerishable,category:{code,label},unit:{code,label}},
  zone:{id,name}, storageType:'SUPPLIER_SITE'|'HUB',
  hub:{id,name,city}|null, pickupAddress, pickupLatitude, pickupLongitude,
  agreedUnitPrice, quantityInitial, quantityAvailable, quantityReserved, quantitySold, quantityLost,
  status:LotStatus, rejectionReason|null, packagingNote|null, qualityNote|null,
  images:[{url,position,isPrimary}], harvestedAt|null, expiresAt|null, createdAt, updatedAt }
staff = + supplier:{id,farmName,profileVerificationStatus}, validatedAt, validatedByAgentId, qualityGrade:'A'|'B'|'C'|null
```
Création : `multipart/form-data`, champ fichiers **`images`** (1–5, jpeg/png/webp, 5 Mo max chacun,
**au moins 1 requis**), `productId, zoneId, agreedUnitPrice, quantity, storageType` obligatoires ;
`hubId` si `HUB` ; `pickupAddress + pickupLatitude + pickupLongitude` si `SUPPLIER_SITE` ;
`expiresAt` obligatoire si `product.isPerishable` ; `harvestedAt, packagingNote(≤500), qualityNote(≤500)`.
**Exige `profileVerificationStatus == VERIFIED`** (sinon 403 `PROFILE_NOT_VERIFIED`, renvoyé *avant*
l'écriture des fichiers). Modification (`PATCH`) : uniquement en `PENDING_VALIDATION`
(`agreedUnitPrice, quantity, expiresAt, harvestedAt, packagingNote, qualityNote` — **pas** de photos,
**pas** de produit/zone/stockage). Suppression : `PENDING_VALIDATION` ou `REJECTED`. Retrait
(`POST /supplier/lots/:id/withdraw {reason}`) : `AVAILABLE` sans réservation.

### 6.3 Annonce
Vue **acheteur** (`CatalogListing`) — *aucun lot, aucun fournisseur, aucun prix convenu* :
```
{ id, reference:'ANN-000456', title, description|null,
  category:{code,label}, unit:{code,label}, unitPrice, quantityAvailable, expiresAt|null,
  zone:{id,name,city}, images:[string(url relative)], qualityGrade:'A'|'B'|'C'|null }
```
Vue **staff** : `{id, reference, title, description, unitPrice, status:'DRAFT'|'ACTIVE'|'SOLD'|'INACTIVE', publishedAt,
product:{id,name,category,unit}, zone:{id,name}, images:[{url,position,isPrimary}], lot:StaffLot|null,
createdByUserId, createdByAgentId, createdAt, updatedAt}`.
Création : `POST /staff/listings` multipart (`images` 1–5 **requis par la spec**), `lotIds` (UN seul au MVP), `title`(3–140), `unitPrice?`, `zoneId?`, `description?`.

### 6.4 Commande
Vue acheteur (`orderToBuyerDto`) :
```
{ id, orderNumber, status:OrderStatus, deliveryMode:'HUB_PICKUP'|'AGENCY_DELIVERY'|null,
  items:[{id,listingId,listingReference,listingTitle,quantity,unitPrice,lineTotal}],
  subtotal, buyerFee, deliveryFee, total,
  delivery:{zoneId,address,latitude,longitude}|null, pickup:{id,name,address,city}|null,
  notes|null, reservedUntil|null, confirmedAt|null, completedAt|null, cancelledAt|null,
  cancellationReason|null, createdAt }
```
Staff = + `items[].{lotId,supplierUnitPrice,commissionRate,commissionAmount,supplierNetAmount}`,
`commissionTotal`, `origins[]`, `buyer:{id,firstname,lastname}`, `handledByAgentId`, `conversationId`,
`paymentStatus:'UNPAID'|'PARTIALLY_PAID'|'PAID'|'REFUNDED'`.
Création du devis (staff) : `buyerId, items:[{listingId,quantity,unitPrice?}], deliveryMode, pickupHubId` (HUB_PICKUP)
**ou** `delivery:{zoneId,address,latitude,longitude}` (AGENCY_DELIVERY), `conversationId?, notes?, force?`.
`reservedUntil` = échéance du devis : après elle, un job libère la réservation → **afficher un compte à rebours**.
Confirmation acheteur exige profil `VERIFIED`.

### 6.5 Livraison
Livreur (`deliveryToDriverDto`) — **jamais de prix** :
```
{ id, status:DeliveryStatus, pickupAddress, pickupLatitude, pickupLongitude,
  dropoffAddress, dropoffLatitude, dropoffLongitude, distanceKm,
  buyer:{firstname,lastname,phone}|null, items:[{productName,categoryName,quantity}],
  acceptedAt, pickedUpAt, deliveredAt, failureReason }
```
Staff : `{id, orderId, agencyId, agencyName, status, pickupHubId, pickupAddress/Lat/Lng, dropoffAddress/Lat/Lng,
distanceKm, agencyCost, deliveryFee, insuredValue, insurancePolicyNumber, acceptedAt, pickedUpAt, deliveredAt, createdAt}`.
`/driver/deliveries/available` et `/mine` sont **paginés**.

### 6.6 Conversations / messages
Client : `{id, type, status, subject|null, listingId|null, escalatedAt, escalationReason|null, lastMessageAt, createdAt}` ;
message `{id, content, senderLabel:'Vous'|'Équipe AgriConnect', createdAt}` — **le client ne voit jamais l'identité
d'un agent ni d'un autre utilisateur** ; `lotId` jamais exposé au client.
Staff : `{id,type,status,subject,listingId,lotId,customer:{id,firstname,lastname},assignedAgentId,assignedAgent:{id,displayName},escalatedAt,escalationReason,lastMessageAt,createdAt}` ;
message `{id,conversationId,senderType:'CUSTOMER'|'AGENT'|'SYSTEM',senderUserId,senderAgentId,content,isInternal,createdAt}`.
Ouverture : `POST /conversations {listingId? | lotId?, content}` — **BUYER → `listingId`, SUPPLIER → `lotId`** ; envoyer les deux = 400.
Pas de compteur « non lu » côté serveur : à gérer localement (dernier message vu).

### 6.7 Paiement / reversement / indemnisation
Paiement `{id,orderId,amount,method,status:'PENDING'|'CONFIRMED'|'FAILED'|'REFUNDED',reference,idempotencyKey,paidAt,recordedById,createdAt}` — `POST` exige en-tête **`Idempotency-Key`**.
Reversement fournisseur `{id,orderId,grossAmount,commissionAmount,netAmount,status:'ON_HOLD'|'READY'|'PAID'|'CANCELLED',reference,payoutAccountId,paidAt,createdAt}` (paginé).
Indemnisation fournisseur `{id,lotId,deliveryId,reason,quantity,amount,status,note,reference,paidAt,createdAt}` (paginé) ; vue admin ajoute `supplierId,unitPrice,rate,approved*,paid*, supplier{farmName,…,payoutAccount{… accountNumber EN CLAIR}}`.

### 6.8 Vérification de profil
`POST /auth/me/documents` multipart, champ **`file`** (jpeg/png/webp/**pdf**, 8 Mo max) + `type` ∈ `ID_CARD|BUSINESS_REGISTRATION|FARM_PROOF|OTHER`.
Max 5 documents `PENDING` (409 `TOO_MANY_PENDING_DOCUMENTS`). `GET /auth/me/documents` → tableau `{id,type,status,note,createdAt}` **sans URL**.
Staff (`USER_VERIFICATION` ou ADMIN+) : `GET /admin/verifications` paginé (`status,type,role,userId`), `GET /admin/verifications/:id` → `{…, signedUrl}` (lien de 10 min **lié au compte du relecteur**), `PATCH` `{decision:'APPROVE'|'REJECT', note}` (note obligatoire si REJECT ; 409 si déjà examiné).
`GET /admin/files/:token` : exige **le header `Authorization` du même relecteur** → l'afficher via une requête Dio authentifiée (bytes) et non via `Image.network` nu.

### 6.9 Stats admin (`GET /admin/stats`)
`{usersByRole, lotsByStatus, ordersByStatus, deliveriesByStatus, stock:{available,reserved,sold,lost}, receivables, receivablesCount, pendingPayouts, pendingCompensations:{count,amount}, eligibleReferrals:{count,amount}, grossRevenue}`.
(Les maps `*ByStatus` : clés = code de statut → compte.)

### 6.10 Réglages plateforme (`GET/PATCH /admin/settings`, PATCH = ROOT seul)
`{id, supplierCommissionRate(0–0.5), buyerFeeType:'NONE'|'FIXED'|'PERCENT', buyerFeeValue, transportMarkupRate(0–1),
referralBuyerReward, referralSupplierReward, reservationHours(1–168), expiryCompensationRate(0–1), currency(lecture seule)}`.
**Aucun** des réglages démo du frontend actuel (`registrationsOpen`, `autoModeration`, `maintenanceMode`, `supportEmail`, `maxUploadMb`) n'existe.

## 7. Machines d'états (exactes)

- **Lot** : `PENDING_VALIDATION → AVAILABLE | REJECTED` ; `AVAILABLE → RETURNED | WITHDRAWN` ; `FULLY_RESERVED → RETURNED` ; `SOLD_OUT`, `EXPIRED`, `RETURNED`, `REJECTED`, `WITHDRAWN` terminaux. (`EXPIRED`, `FULLY_RESERVED`, `SOLD_OUT` sont posés par le système.)
- **Annonce** : `DRAFT|INACTIVE → ACTIVE` (publish, exige lot `AVAILABLE` avec stock) ; `ACTIVE → INACTIVE` (unpublish) ; `SOLD` posé par le système.
- **Commande** : `QUOTED → CONFIRMED | CANCELLED` ; `CONFIRMED → PREPARING (exige paiement) | CANCELLED` ; `PREPARING → READY_FOR_PICKUP (HUB_PICKUP) | OUT_FOR_DELIVERY (AGENCY_DELIVERY, posé par le flux livraison) | CANCELLED` ; `READY_FOR_PICKUP → COMPLETED` ; `OUT_FOR_DELIVERY → COMPLETED`.
- **Livraison** : `PENDING → ACCEPTED | CANCELLED` ; `ACCEPTED → PICKED_UP | PENDING(release) | CANCELLED` ; `PICKED_UP → IN_TRANSIT | FAILED` ; `IN_TRANSIT → DELIVERED | FAILED` ; `FAILED → PENDING(redispatch) | CANCELLED`. Le livreur ne peut pas annuler : seulement `FAILED` (avec `failureReason`).
- Toute transition interdite → **409 `INVALID_STATE_TRANSITION`**.

## 8. Rôles, capacités, accès

Niveaux : opérationnel(SUPPLIER/BUYER/DRIVER)=10, AGENT=30, ADMIN=50, ROOT=100.
**Capacités agent (9)** : `BUYER_SUPPORT, SUPPLIER_SUPPORT, LISTING_MANAGEMENT, ORDER_PROCESSING, STOCK_VALIDATION, PAYMENT_FOLLOWUP, DISPATCH_COORDINATION, USER_VERIFICATION, DISPUTE_HANDLING`.
ADMIN/ROOT passent toutes les capacités sans fiche. Un agent **IA** ne peut jamais avoir `PAYMENT_FOLLOWUP` et `requireHumanActor` lui interdit paiements, reversements, parrainages, indemnisations, remboursements.

| Zone d'API | Qui |
|---|---|
| `/supplier/*` | SUPPLIER (écritures : profil VERIFIED) |
| `/catalog/*` | BUYER, AGENT, ADMIN, ROOT |
| `/orders/*` | BUYER (confirm : profil VERIFIED) |
| `/conversations/*` | tout compte authentifié (client) |
| `/driver/*` | DRIVER |
| `/staff/lots*`, `/stock-movements` | STOCK_VALIDATION |
| `/staff/listings*` | LISTING_MANAGEMENT |
| `/staff/conversations*` | BUYER_SUPPORT ou SUPPLIER_SUPPORT (agit sur son type seulement) |
| `/staff/orders*` (hors paiements/livraisons) | ORDER_PROCESSING |
| `/staff/orders/:id/payments`, `/staff/payments/:id/refund` | PAYMENT_FOLLOWUP (humain) ; refund = ADMIN humain |
| `/staff/orders/:id/deliveries`, `/staff/deliveries*` | DISPATCH_COORDINATION |
| `/staff/compensations` | DISPUTE_HANDLING |
| `/admin/verifications*`, `/admin/files/:token` | USER_VERIFICATION (ou ADMIN+) |
| `/admin/*` (reste) | ADMIN, ROOT ; `PATCH /admin/settings` ROOT seul ; création d'un ADMIN : ROOT seul |

## 9. WebSocket (Socket.io)

Connexion : `io(origin, {auth:{token:<accessToken>}, transports:['websocket']})`. Refus : `connect_error` avec message (« Token invalide », « Ce compte a été suspendu »). Reconnexion → **reprendre un token frais** (le token d'un handshake expire en 1 h) et rejoindre à nouveau les conversations ouvertes.

Client → serveur :
- `join_conversation(id, ack({ok}))` — attendre l'ack avant d'émettre autre chose.
- `leave_conversation(id)`
- `send_message({conversationId, content})` — **préférer REST** `POST /conversations/:id/messages` pour l'envoi (retour synchrone, validation) et le socket pour la **réception**.

Serveur → client :
| Événement | Quand | Charge utile |
|---|---|---|
| `message:new` | nouveau message d'une conversation rejointe | `MessageClient` (ou `MessageStaff` pour la room staff) |
| `conversation:assigned`, `conversation:escalated` | staff uniquement | `ConversationStaff` |
| `delivery:available` | livreur de l'agence concernée | course disponible |
| `delivery:status` | acheteur concerné + staff | `{…}` (statut de livraison) |
| `alert:expiring` | staff | alerte de péremption de lot |
| `session_revoked` | suspension / fermeture de session | `{reason}` → **fermer le socket et déconnecter** |
| `error_message` | erreur de handler | `{error}` |

Rooms côté serveur (info) : `user:{id}`, `conversation:{id}`, `staff`, `agency:{id}`.
**Pas d'événement de changement de statut de commande** : rafraîchir par REST (pull-to-refresh) et sur `delivery:status`.

## 10. Règles métier à refléter dans l'UI

1. Lot ≠ annonce ≠ ligne de commande. L'acheteur ne voit **jamais** lot, fournisseur, prix convenu, adresse d'enlèvement.
2. Un fournisseur non `VERIFIED` : peut lire, ne peut ni déclarer, ni modifier, ni retirer un lot ; un acheteur non `VERIFIED` ne peut pas confirmer un devis → bannière + chemin vers le dépôt de documents (`PENDING` = « en cours d'examen », `REJECTED` = « redéposer »).
3. Le staff ne valide le lot que si le fournisseur est `VERIFIED` (409 `NOT_VERIFIED`).
4. Prix : `PRICE_BELOW_SUPPLIER` — le prix de vente ne peut pas être inférieur au prix convenu.
5. Un devis `QUOTED` expire (`reservedUntil`) ; l'annulation restitue le stock.
6. Frais de livraison / commission / frais acheteur : calculés par le serveur ; ne jamais les recalculer côté client.
7. Un agent IA n'a pas d'accès argent ; le client doit pourtant afficher proprement un `403` « humain requis ».
