# Plan — Sessions, mot de passe oublié, vérification d'email

> Document de travail. 11 phases, chacune close par **un commit unique et
> décrit**. Le code est dans `src/`, les tests dans `tests/`.
> Toutes les décisions ci-dessous ont été validées avant implémentation.

## Décisions validées

| Sujet | Choix |
|---|---|
| Sessions | Table `Session` **1-N** `RefreshToken` (les deux tables) |
| Cycle de vie | Nouvelle session à chaque login, **plafond 5**, ROOT sans exception |
| Rotation | Rotation + **détection de réutilisation**, fenêtre de tolérance **30 s** |
| Reset de mot de passe | Invalide **toutes** les sessions |
| Vérification d'email | Dans ce plan, **non bloquante** |
| Statut du compte | **La base est la référence**, le jeton informe le client |
| Profil | Les 4 routes `/api/users/*` sont **supprimées** et déplacées sous `/api/auth/*` |
| Changement d'email | Reset de la vérification + renvoi |
| Colonne `verified` | Renommée **`emailVerified`** |
| Tables de jetons | **Deux tables séparées** (`PasswordResetToken`, `EmailVerificationToken`) |
| Suspension | Sessions **et** websockets détruits |
| Liens d'email | `GET` affiche un formulaire EJS **sans consommer le jeton**, `POST` applique |
| Durées | reset 15 min · vérification 24 h · refresh 30 jours |
| Limites | forgot-password 5/15 min · resend cooldown 5 min |
| Contrat register/login | `{user, accessToken, refreshToken}` **figé** (adapté plus tard par la refonte) |
| Données existantes | RefreshToken **révoqués**, pas de migration de contenu |
| Plafond ROOT | 5 sessions comme tout le monde, **aucun cas particulier** |
| Alerte « mot de passe modifié » | **Incluse** (hors périmètre si demandé) |

## Paramètres retenus

```
SESSION_MAX_PER_USER = 5
REFRESH_REUSE_GRACE_SECONDS = 30
PASSWORD_RESET_TTL_MINUTES = 15
EMAIL_VERIFICATION_TTL_HOURS = 24
RESEND_VERIFICATION_COOLDOWN_MINUTES = 5
FORGOT_PASSWORD_LIMIT = 5 / 15 min / IP
REFRESH_TOKEN_TTL_DAYS = 30
```

Tous exposés en variables d'environnement avec ces valeurs par défaut.

---

## Phase 0 — Socle de configuration

**Objectif** : rendre l'email réellement joignable et corriger une régression
CORS bloquante. Rien d'autre n'est possible avant.

**Contenu**

- `.env` et `.env.example` : `SMTP_HOST=127.0.0.1`, **`SMTP_PORT=1025`**,
  `SMTP_SECURE=false`, `EMAIL_SENDER` en forme complète
  (`"AgriConnect <no-reply@agriconnect.local>"` — une adresse nue est refusée
  par les serveurs SMTP), et `APP_URL` pour construire les liens.
- `src/app.js` et `src/server.js` : parsing de `CORS_IO` corrigé. La valeur `'*'`
  doit signifier « toutes origines » et produire l'en-tête
  `Access-Control-Allow-Origin` ; une liste explicite doit être respectée.
- Extraction du parsing CORS dans un utilitaire partagé par HTTP et Socket.io,
  pour que les deux ne puissent pas diverger.

**Correction du plan initial — le port SMTP est 1025, pas 1080.** Le plan
partait de l'indication « le bac à mail tourne sur le port 1080 ». Sonde faite :
le port **1080 répond en HTTP** (`404`, `access-control-allow-credentials`) —
c'est l'interface web de MailDev. Le serveur SMTP est sur **1025**
(`220 THIERRY-PC ESMTP`, `EHLO` accepté). La cause de la confusion est dans le
`.env` lui-même, qui portait `SMTP_HOST=http://localhost:1080/` en commentaire :
une URL d'interface web dans une variable d'hôte SMTP. Configurer 1080 aurait
garanti qu'aucun email ne part, silencieusement. Envoi de bout en bout vérifié :
`SMTP 1025` accepte et le message remonte sur `http://localhost:1080/api/email`.

**Défaut corrigé** : `CORS_IO='*'` est aujourd'hui interprété comme une origine
 littérale nommée `'*'`, qui ne correspond à aucune origine réelle. Vérifié :
`Access-Control-Allow-Origin` est **absent** pour `http://localhost:3000` comme
pour `https://agriconnect.ma`. Le navigateur refuse donc tout appel
cross-origin. C'est une régression introduite en phase 7 de la série
précédente.

Précision sur le correctif : avec `'*'`, HTTP renvoie `origin: true` et non
`origin: '*'`. Un navigateur refuse l'en-tête wildcard dès que les
identifiants sont autorisés, et ils le sont toujours ici ; refléter l'origine
de la requête est la seule façon de satisfaire les deux contraintes.

**Tests** : `CORS_IO='*'` émet l'en-tête ; une liste restreint bien ; un mélange
valide/invalide est géré ; `APP_URL` a une valeur par défaut ; le transport SMTP
est construit depuis les variables.

```
fix(config): point SMTP at the real mail port and fix the CORS wildcard regression

CORS_IO='*' was interpreted as one literal origin named "*", which matches no
real origin, so Access-Control-Allow-Origin was never emitted and the browser
rejected every cross-origin request. '*' now means "all origins" — reflected as
origin: true, because a browser refuses the wildcard header once credentials
are allowed — and an explicit list is still honoured, with the parsing shared
between HTTP and Socket.io so the two cannot drift apart.

Also: SMTP_HOST was absent from .env, so every send was a logged no-op, and
EMAIL_SENDER held a bare address that SMTP servers reject. Both are configured
for the local mail catcher, and APP_URL is added to build the verification and
reset links.

The catcher listens for SMTP on 1025 and serves its web interface on 1080;
.env had SMTP_HOST set to the interface URL, which is the mistake this fixes.
A regression test rejects a URL in SMTP_HOST so it cannot come back.
```

---

## Phase 1 — Table `Session`

**Objectif** : le modèle de données qui rend le reste possible.

**Schéma**

- `Session { id, userId, userAgent?, ip?, createdAt, lastActivityAt, expiresAt, revokedAt? }`
- `RefreshToken` gagne `sessionId` et `rotatedAt` (nécessaire à la fenêtre de 30 s)
- `User.verified` → `User.emailVerified`

**Migration** : crée `Session`, crée une session par utilisateur possédant des
tokens actifs, **révoque** tous les RefreshToken existants (un jeton sans
antériorité de session ne peut pas être rattaché honnêtement), pose `sessionId`
et le renommage de colonne.

**Tests** : migration appliquée sur une base peuplée ; tables créées, tokens
révoqués, index présents ; le test statique `prisma-fields.test.js` valide
automatiquement les `select` des contrôleurs contre le schéma.

```
feat(db): add the Session model and attach RefreshToken to a session

A session is what makes "log out on this device only" expressible, and what
lets a reset-password cut every access at once. RefreshToken becomes a child of
Session rather than a flat bag of tokens per user.

Existing refresh tokens are revoked rather than migrated: they carry no session
ancestry, and this database only holds experimental data. The verified column is
renamed to emailVerified, because "verified" alone does not say what is being
verified and the flag is about to be exposed in the access token.
```

---

## Phase 2 — Login, refresh, logout sur sessions

**Contenu**

- `POST /api/auth/login` : crée une session et un refresh token ; plafond de 5,
  la plus ancienne est révoquée au-delà
- `POST /api/auth/refresh` : rotation **dans la même session**, met à jour
  `lastActivityAt` ; le token précédent reste accepté **30 s** après sa rotation
  (sinon deux refreshs parallèles d'une app mobile détruisent la session) ; au-delà,
  un jeton déjà révoqué présenté est traité comme un vol et détruit toute la session
- `POST /api/auth/logout` : révoque la session et ses tokens

**Tests** : création de session ; rotation conservant la session ; tolérance
30 s ; réutilisation détectée et session détruite ; plafond et éviction ;
logout idempotent ; suspension bloquant toujours la connexion.

```
feat(auth): manage sessions on login, rotate refresh tokens and detect reuse

Each login now opens a session carrying its device and IP, capped at five per
account, the oldest being revoked beyond that. Refresh rotates the token inside
the same session instead of creating another one.

Reuse detection: presenting a token that was already rotated revokes the whole
session, on the assumption it was stolen. A 30 second grace window keeps that
from destroying sessions when a mobile client fires two refreshes in parallel,
which is common when several requests discover an expired token at once.
```

---

## Phase 3 — Gestion des sessions par le client

**Contenu** : `GET /api/auth/sessions` (avec un indicateur « est-ce la mienne »),
`DELETE /api/auth/sessions/:id`, `POST /api/auth/logout-all`. Les routes `:id`
réutilisent le `router.param('id', ...)` déjà en place.

**Tests** : liste avec le marqueur de session courante ; fermeture ciblée refusée
si elle appartient à autrui ; `logout-all` préserve la session courante ;
une session fermée ne refresh plus.

```
feat(auth): let users list and close their own sessions

Without this, a lost device can only be cut by changing the password. Listing
marks which session is the caller's own, and closing one revokes just that
device, which logout-all then extends to every other session.
```

---

## Phase 4 — Statut dans le jeton d'accès

**Contenu** : les claims deviennent `{id, role, userStatus, emailVerified,
sessionId}`. `protect` recharge déjà l'utilisateur en base à chaque requête : il
compare avec les claims et refuse en cas d'écart. La base reste la référence, le
jeton informe le client.

**Tests** : forme exacte des claims ; refus sur statut divergent ; un jeton
délivré avant une suspension est refusé ; un jeton antérieur à une vérification
reste utilisable (la base having caught up).

```
feat(auth): carry user status and email verification in the access token

The client needs the status to render without a second round trip, so it is
carried in the token. The database stays authoritative: protect already loads
the user on every request, and now rejects a request whose claims contradict it,
rather than trusting a token that was minted up to an hour ago.
```

---

## Phase 5 — Déplacement des routes profil

**Contenu** : `GET /api/auth/me`, `PATCH /api/auth/me`,
`POST /api/auth/me/avatar`, `PATCH /api/auth/me/availability`. `user.routes.js`
est **supprimé** (le client n'existe pas encore, pas besoin de filet de
compatibilité). La forme de réponse est alignée sur celle de register/login :
`role` et `userStatus` en `{code, label}` et non plus en lignes de base
entières ; `latitude`/`longitude` retirés de `me`.

**Tests** : les 4 routes répondent sous `/api/auth` ; `/api/users/*` répond 404 ;
forme exacte ; `password` toujours absent.

```
feat(auth): move the profile routes to /api/auth and unify the user shape

getMe returned role and userStatus as whole database rows, with id, level,
isActive and createdAt, while register and login returned plain labels. Two
representations of the same user in one API. Everything now returns the labelled
form, and the raw coordinates are no longer part of "who am I".

The four routes move under /api/auth so that self-service and authentication
live together, leaving /api/users/ free for the administrative endpoints planned
later. No deprecation shim: there is no client yet.
```

---

## Phase 6 — Vérification d'email

**Contenu** : `EmailVerificationToken` (empreinte SHA-256, `expiresAt`, `usedAt`) ;
`POST /api/auth/verify-email`, `POST /api/auth/resend-verification` (cooldown
5 min) ; `register` déclenche l'envoi ; un changement d'email via `PATCH /me`
remet `emailVerified` à faux, invalide le jeton en cours et renvoie un email ;
gabarit EJS `verify-email`.

Non bloquante : un compte non vérifié utilise l'API normalement, l'indicateur
sert à l'affichage.

**Tests** : vérification réussie ; usage unique ; jeton expiré ; cooldown de
resend ; reset sur changement d'email ; un compte non vérifié passe encore
`GET /api/auth/me`.

```
feat(auth): add non-blocking email verification

User.emailVerified existed since the initial migration and was never written or
read: there was no verification at all. It is now set by a single-use hashed
token sent by email, and exposed in the access token.

Non-blocking by design: an unverified account keeps full access to the API, so a
lost email never locks anyone out of the MVP. Changing the email address resets
the flag, otherwise inheriting verified=true from a previous address would be
trivial.
```

---

## Phase 7 — forgot-password

**Contenu** : `PasswordResetToken` (empreinte, `expiresAt`, `usedAt`) ;
`POST /api/auth/forgot-password` ; limite dédiée 5/15 min ; **réponse
identicale** que l'email existe ou non, pour ne pas révéler les comptes
enregistrés ; gabarit `forgot-password`.

**Tests** : réponse et statut identiques pour un email connu et inconnu ; token
créé seulement si le compte existe ; token à usage unique et expirant ; purge des
tokens dépassés.

```
feat(auth): add forgot-password with single-use hashed tokens

The endpoint answers the same way whether or not the address belongs to an
account, and only takes a different amount of time when it sends, so response
bodies and status cannot be used to enumerate users. Tokens are stored hashed,
expire in 15 minutes and are unusable once redeemed.
```

---

## Phase 8 — reset-password

**Contenu** : `GET /api/auth/reset-password?token=...` affiche le formulaire EJS
**sans consommer le jeton** ; `POST /api/auth/reset-password` l'applique, marque
le token utilisé et **détruit toutes les sessions** du compte ; gabarits
`reset-password-form`, `reset-password-done` et email d'alerte.

**Tests** : le `GET` ne consomme pas le jeton (un `GET` suivant fonctionne
encore) ; `POST` valide ; jeton inconnu, expiré, déjà joué refusés ; toutes les
sessions invalidées ; email d'alerte déclenché.

```
feat(auth): add reset-password that invalidates every session

The link only renders a form. This is deliberate: clients and mail scanners
prefetch links, and a GET that consumed the token could invalidate a password
reset before the user ever saw the page. The POST redeems it, and destroys
every session of the account so a stolen copy of the old credentials stops
working immediately.

A security alert email goes out on success: a password reset without one is the
commonest account-takeover scenario, and the alert is what lets the owner react.
```

---

## Phase 9 — Suspension : sessions et websockets

**Contenu** : `suspendUser` détruit sessions et tokens, et émet un événement ;
`chat.socket` rejoint une room `user:<id>` à la connexion, vérifie le statut, et
se déconnecte à la réception de l'événement.

Défaut actuel comblé : `chat.socket` ne lit que `decoded.id` et ne consulte
jamais le statut — un utilisateur suspendu garde ses websockets ouverts, alors que
`protect`, `login` et `refresh` le bloquent (3 points sur 4).

**Tests** : sessions et tokens détruits à la suspension ; room par utilisateur ;
statut vérifié à la connexion ; déconnexion sur l'événement.

```
fix(auth): destroy sessions and sockets when an account is suspended

Blocking a suspended account happened in three of four entry points: protect,
login and refresh. The fourth was the websocket, which only read the token id
and never looked at the status, so a suspended user kept a live socket and
could still send messages. Suspension now revokes every session and emits an
event that closes the connections.
```

---

## Phase 10 — Nettoyage et documentation

**Contenu** : suppression de `user.routes.js` si des imports subsistent ; README
des flux, durées et limites ; mise à jour de ce plan.

```
docs(auth): document the auth flow, token lifetimes and session rules
```

---

## Récapitulatif

| # | Phase | Fichiers | Test |
|---|---|---|---|
| 0 | Socle config | 4 | 🟢 |
| 1 | Table `Session` | schéma + migration | 🟢 |
| 2 | Login/refresh/logout sur sessions | 3 | 🟢 |
| 3 | Gestion des sessions | 2 | 🟢 |
| 4 | Claims de statut | 2 | 🟢 |
| 5 | Déplacement du profil | 3 | 🟢 |
| 6 | Vérification email | 5 | 🟢 |
| 7 | forgot-password | 4 | 🟢 |
| 8 | reset-password | 4 | 🟢 |
| 9 | Suspension et websockets | 2 | 🟢 |
| 10 | Nettoyage et docs | ~3 | 🟢 |

**Ordre** : le socle d'abord (aucun email ne part sans lui), le schéma avant le
code qui l'utilise, la forme utilisateur avant les endpoints qui la renvoient.

## Ce que le plan ne couvre pas

Refonte du flow register/login (contrat figé, à adapter), réinitialisation par
SMS/OTP, révoquer une session depuis l'interface d'administration, pagination,
notifications temps réel de la vérification d'email.
