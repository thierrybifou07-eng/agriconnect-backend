# Plan de remédiation — AgriConnect Backend

> Document de travail. 9 phases, chacune close par **un commit unique et décrit**.
> Les phases 1 à 9 sont **réalisées** ; le tableau récapitulatif et la liste des
> décisions reflètent l'état final. La phase **B5** (identifiants de route en
> chaîne) n'existait pas au départ : elle a été découverte par les tests de la
> phase `Decimal` et insérée en 5ᵉ position, ce qui a décalé les suivantes.
> Objectif final : remettre l'API en état de fonctionner **et** la protéger par
> des tests automatisés pour que ces bugs ne puissent pas revenir.

## Conventions

- **Branche** : `fix/stabilisation-mvp` (créée depuis `development`), 9 commits
  linéaires et reviewables. Chaque phase est indépendamment réversible via
  `git revert`.
- **DB de test** : base MySQL dédiée `agriconnect_test`, créée et migrée
  automatiquement. **Aucune donnée de développement n'est jamais touchée** par
  les tests.
- **Ordre_volontaire** : le socle de test arrive **en premier** (phase 1), avec
  des tests qui reproduisent les bugs B1/B2/B3 en **rouge**. Les phases
  suivantes ne font que les faire passer au vert. C'est la preuve que la
  couverture est réelle et pas décorative.

## Point de départ : travail non commité

`git status` montre 3 modifications non commitées, dont une migration email à
moitié faite :

| Fichier | Nature | Décision proposée |
|---|---|---|
| `src/controllers/auth.controller.js` | bascule email inachevée | **Conservée**, reprise en phase 5 |
| `.env.example` | valeurs Mailpit | **Conservée**, corrigée en phase 5 |
| `prisma/migrations/.../migration.sql` | reformatage SQL à la main, contenu sémantiquement identique | **Annuler** (`git checkout`) — une migration appliquée est immuable ; le diff est purement cosmétique |

> Cette dernière décision est la seule qui fasse perdre du travail. Le contenu
> SQL est équivalent ligne à ligne, mais je préfère le signaler explicitement
> plutôt que l'écarter en silence.

---

## Phase 1 — Socle de test (aucun bug corrigé)

**Objectif** : installer la protection qui manquait, et écrire les tests qui
**prouvent** que B1, B2 et B3 sont bien réels.

**Choix techniques** : Vitest (ESM natif, compatible `"type": "module"`, pas de
galère de config Jest) + Supertest pour les tests HTTP.

Fichiers à créer :
- `vitest.config.js` — deux projets : `unit` (aucune I/O) et `integration`
- `tests/setup/integration.js` — charge `.env.test`, crée la base de test,
  `prisma migrate deploy` (valide aussi que le SQL de migration est intact),
  exécute le seed des tables de référence
- `tests/helpers/db.js` — `resetDatabase()` : `SET FOREIGN_KEY_CHECKS=0` +
  `TRUNCATE` des tables métier, entre chaque test
- `tests/helpers/app.js` — importe `src/app.js` via Supertest
- `tests/setup/env.js` — surcharge `DATABASE_URL` vers `agriconnect_test` et
  `JWT_SECRET` de test. **Point d'attention** : `app.js` ne charge pas dotenv
  (seul `server.js` le fait), il faut donc le faire dans le setup

Fichiers modifiés : `package.json` (devDeps + scripts `test`, `test:watch`,
`test:unit`, `test:integration`), `.env.test.example`, `.gitignore`

Tests ajoutés :
- `tests/unit/distance.test.js` — haversine (distances de référence, propagation
  du `null`), `calculateDeliveryFee`
- `tests/unit/jwt.test.js` — signature, vérification, expiration, token altéré
- `tests/unit/refreshToken.test.js` — unicité, déterminisme du hash
- `tests/static/dependencies.test.js` — parcourt le graphe d'imports de `src/`
  et **échoue si un paquet importé n'est pas dans `dependencies`**.
  *C'est le test qui reproduit B3.*
- `tests/integration/health.test.js` — `/health` 200, route inconnue 404
- `tests/integration/auth.test.js` — inscription, liste blanche `PUBLIC_ROLES`
  (ADMIN/ROOT rejetés même si envoyés)
- `tests/integration/regression-listing-b1.test.js` — **ROUGE** :
  `GET /api/listings` doit répondre 200 (actuellement 500 `Unknown field fullName`)
- `tests/integration/regression-order-b2.test.js` — **ROUGE** :
  `POST /api/orders` avec un `listingId` entier doit répondre 201
  (actuellement 400 `must be a valid GUID`)

Critère de fin : `npm test` s'exécute, **2 tests rouges pour de bonnes
raisons**, le reste vert.

```
test(setup): add Vitest harness, isolated test DB and B1/B2/B3 regression tests

Introduce an automated test suite that was entirely missing from the project.

- Vitest + Supertest, ESM-native to match the project's "type": "module"
- Dedicated MySQL database (agriconnect_test) created and migrated at setup,
  truncated between tests, so development data is never touched
- Three regression tests that currently FAIL and document real defects:
  * B1: GET /api/listings returns 500 (Prisma "Unknown field fullName")
  * B2: POST /api/orders rejects integer listingId (Joi uuid rule vs Int id)
  * B3: static check that every runtime import lives in "dependencies"
    (nodemailer is currently a devDependency but is imported by app.js)
- Unit coverage for the pure helpers: distance, jwt, refreshToken
- npm scripts: test, test:watch, test:unit, test:integration

No production code is modified in this commit.
```

---

## Phase 2 — B2 : `listingId` validé en UUID sur un ID entier

**Objectif** : débloquer le flux commande, cœur du produit.

Correctif : `src/validators/order.validator.js` —
`Joi.string().uuid()` → `Joi.number().integer().positive()`.

C'est la seule ligne de code du correctif. Le reste de la phase est consacré
aux tests qui prouvent que le flux fonctionne enfin.

Tests ajoutés (`tests/integration/orders.test.js`) :
- création `PICKUP` et `DELIVERY` (201), décrément de stock, `SOLD` à 0
- rejets : annonce absente, inactive, propre annonce, stock insuffisant
- `DELIVERY` sans coordonnées → 400
- lecture de ses commandes, cloisonnement acheteur/agriculteur

```
fix(orders): validate listingId as integer instead of UUID

POST /api/orders was unusable: order.validator.js required listingId to be a
UUID while Listing.id is an Int autoincrement, so every order creation was
rejected with 400 "must be a valid GUID". The entire order-to-delivery flow
was dead.

- Replace Joi.string().uuid() with Joi.number().integer().positive()
- Add integration tests covering order creation, stock reservation and the
  ownership/availability guards

Closes the B2 regression test from the previous commit.
```

---

## Phase 3 — B1 : `fullName` inexistant dans le schéma

**Objectif** : réparer les 5 contrôleurs sur 6.

**Décision** : on aligne le code sur le schéma existant (`firstname` +
`lastname`) plutôt que l'inverse. Le schéma est déjà en base, et
`auth.controller.js`, `create-root.js` et `seed.js` sont déjà alignés — c'est
l'autre moitié du projet qui n'a pas suivi.

Fichiers : `admin`, `listing`, `order`, `delivery`, `conversation`,
`user.controller.js`, `validators/admin.validator.js`

Deux points à trancher à l'implémentation :
- `select` imbriqué → `firstname: true, lastname: true`. On renvoie les deux
  champs bruts plutôt qu'un `fullName` calculé, pour rester aligné sur le
  schéma (le client Flutter consommera les deux champs).
- `createAdmin` et `updateMe` doivent accepter `firstname`/`lastname` en
  entrée ; `userSafeSelect` est à revoir.

Tests ajoutés :
- `tests/integration/listings.test.js` — listage, filtres catégorie/prix/recherche,
  création, modification par le propriétaire, refus si non propriétaire
- `tests/integration/conversations.test.js` — création/upsert, messages,
  contrôle d'accès
- `tests/integration/deliveries.test.js` — disponibles, acceptation, machine
  à états `VALID_TRANSITIONS`, premier arrivé premier servi
- `tests/integration/admin.test.js` — listing utilisateurs, suspendre /
  réactiver, création d'admin par ROOT, stats
- `tests/integration/regression-listing-b1.test.js` — passe au vert

```
fix(models): replace non-existent User.fullName with firstname/lastname

Prisma schema defines User.firstname and User.lastname, but five controllers
selected a "fullName" field that does not exist, making them throw
PrismaClientValidationError (HTTP 500) on every call:

  GET /api/listings, GET /api/orders, GET /api/conversations,
  GET /api/deliveries/*, GET /api/admin/*, POST /api/listings, PATCH /api/users/me

auth.controller.js and create-root.js had already been migrated, which is what
made the mismatch visible. Align the remaining controllers on the schema rather
than the reverse: the columns are already live and the seed/CLI paths already
expect the split fields.

- Replace fullName selects with firstname/lastname across 6 controllers
- Update createAdmin and updateMe to accept the split input fields
- Add integration tests for listings, conversations, deliveries and admin

Closes the B1 regression test.
```

---

## Phase 4 — B3 : `nodemailer` en `devDependencies`

**Objectif** : rendre l'application déployable.

Correctif : déplacer `nodemailer` de `devDependencies` vers `dependencies`.
Le test statique de la phase 1 passe au vert.

Point à vérifier à l'implémentation : le README affirme que les dépendances de
la chaîne email ne sont pas installées en prod. C'est faux pour `nodemailer` ;
le texte sera corrigé en phase 7.

```
fix(deps): move nodemailer from devDependencies to dependencies

nodemailer is imported by src/config/mailer.js, reached from app.js through
routes/index.js -> admin.routes.js -> admin.controller.js -> utils/sendMail.js.
Because ESM resolves the whole import graph at load time, a production install
with "npm ci --omit=dev" would abort the whole app with ERR_MODULE_NOT_FOUND.

The static import-graph test added in phase 1 now passes.
```

---

## Phase 5 — Montants en `Decimal` (au lieu de `Float`)

**Objectif** : supprimer le risque d'arrondi sur l'argent.

Décision retenue : **basculer en `Decimal`**. C'est une migration de schéma, donc
elle arrive après les correctifs de logique et avant le reste.

Périmètre — uniquement l'argent, pas la géométrie :
- `Listing.price`, `Order.unitPrice`, `Order.totalPrice`,
  `Delivery.deliveryFee` → `@db.Decimal(10, 2)`
- `latitude`, `longitude`, `distanceKm`, `quantity` **restent en `Float`** :
  ce ne sont pas des montants et le calcul de distance est déjà arrondi à 2
  décimales par `haversineDistanceKm`.

Côté JS, pas de bibliothèque décimale : on conserve l'arithmétique native et on
**arrondit explicitement à 2 décimales avant écriture** (helper `roundMoney`),
ce qui est la pratique pragmatique standard et évite d'ajouter une dépendance.

Tests : le total d'une commande est exact sur une quantité décimale (le bug
classique `0.1 + 0.2`), les frais de livraison sont arrondis, et la migration
s'applique proprement sur une base déjà peuplée.

```
feat(db): store monetary amounts as Decimal instead of Float

price, unitPrice, totalPrice and deliveryFee were Float, so MySQL stored an
approximation and totals could drift from the arithmetic that produced them.

- Migrate the four monetary columns to Decimal(10,2) via Prisma
- Round explicitly to 2 decimals before writing, keeping native JS arithmetic
  rather than adding a decimal dependency
- Leave coordinates, distanceKm and quantity as Float: they are not monetary
- Add tests covering fractional quantities and delivery fee rounding
```

---

## Phase 6 — Consolidation de la pile email

**Objectif** : supprimer le projet étranger de l'API et rendre l'envoi
configurable par l'environnement.

**Décision retenue : on garde l'arborescence `views/emails/` et on réécrit les
templates pour AgriConnect.** La pile `src/config/email/*` (celle qu'utilise
déjà `auth.controller.js`) est conservée ; l'ancienne pile
`src/utils/sendMail.js` + `src/config/mailer.js` + `src/utils/renderEmail.js`
+ `src/emails/templates/` est supprimée.

Travail à faire :
1. Réécrire les templates `views/emails/` réellement utilisés par AgriConnect
   (`welcome`, et les déclencheurs à câbler : commande, suspension). Les
   17 templates restants (announcement*, subscription*, congratulation…),
   sans rapport avec le produit, sont supprimés.
2. Basculer `admin.controller.js` sur la même fonction que
   `auth.controller.js` — sinon le même email aurait deux moteurs de rendu et
   deux conventions de données.
3. Rétablir l'envoi **non bloquant** (`.catch()` côté appelant), conformément
   au commentaire qui l'annonce déjà.
4. Variables d'environnement : `SMTP_HOST` réel (et non l'URL web de Mailpit),
   `EMAIL_SENDER` ajouté à `.env.example`, `CORS_IO` documenté.

Tests : rendu d'un template **sans aucune occurrence de « RentHub »**, code de
vérification factice `00000` supprimé, configuration du transport depuis
l'environnement, inscription qui aboutit même si le SMTP est injoignable.

```
refactor(email): rewrite email templates for AgriConnect and unify the stack

The email migration was left half-done: auth.controller.js used the new
config/email stack while admin.controller.js still used the old utils/sendMail
stack. The views/emails/ tree held 17 templates from an unrelated project
("RentHub", a rental platform) with zero AgriConnect references, so users
registering today received an email titled "Bienvenue sur RentHub" containing a
hardcoded verification code 00000 with no verification feature behind it.

- Rewrite the templates actually used by AgriConnect in views/emails/ and
  delete the unrelated ones
- Keep the config/email stack; delete utils/sendMail.js, config/mailer.js,
  utils/renderEmail.js and src/emails/templates/
- Move admin.controller.js onto the same helper so one email has one renderer
- Restore the non-blocking send (fire-and-forget with .catch)
- Configure SMTP from environment variables instead of the hardcoded
  127.0.0.1:1025 with rejectUnauthorized: false
- Document EMAIL_SENDER and CORS_IO in .env.example
```

---

## Phase 7 — Sécurité et robustesse

Correctifs, cette fois tous couverts par un test :

1. **Fuite du hash de mot de passe** — `GET /api/users/me` renvoie `req.user`
   complet, `password` inclus, car `protect` le charge sans sélection de
   champs. Le `sanitize` ne masque que ce que le contrôleur choisit
   d'exclure. → sélection explicite, plus une sélection de colonnes au niveau
   du middleware. *Test de non-régression sur la présence de `password`.*
2. **Suppression d'annonce** — ni `onDelete` en cascade ni garde : supprimer
   une annonce ayant des commandes lève une erreur Prisma brute.
3. **Rate limit sur `/refresh`** — 10 requêtes / 15 min partagées par IP,
   appliquées aussi au rafraîchissement de jeton. Sortir `/refresh` du
   `authLimiter` ou relever le plafond et documenter le comportement derrière
   un NAT.
4. **Forme des statistiques** — `count: r._count` renvoie un objet là où le
   client attend un nombre (`_count._all`).
5. ~~**Frais et montants**~~ — traité en phase 5 (bascule en `Decimal`).

```
fix(security): stop leaking password hash, harden listing deletion and stats

- GET /api/users/me returned the full Prisma user object loaded by the protect
  middleware, which includes the bcrypt hash; select fields explicitly instead
  of relying on the controller-level sanitize
- DELETE /api/listings/:id fails with a raw Prisma error when the listing has
  related orders, conversations or media: add an explicit guard
- /refresh was subject to the same 10-per-15-minutes brute-force limit as login,
  which is wrong for a token refresh endpoint and breaks every client behind a
  shared NAT address
- GET /api/admin/stats returned an object where the client expects a count
- Add regression tests for each of the above
```

---

## Phase 8 — Nettoyage et documentation

- Supprimer `src/utils/asyncHandler.js` : code mort, et il exporte en CommonJS
  (`module.exports`) dans un projet ESM — il planterait s'il était importé.
- `git checkout` du `migration.sql` reformaté (fait en phase 0).
- **Réécrire le README** : 6 affirmations sont fausses aujourd'hui (version
  Prisma, `asyncHandler` "supprimé", sécurité des dépendances en prod,
  infrastructure email "testée en exécution réelle", système de médias, flux
  commande→livraison). Le README ne doit décrire que ce qui a été vérifié.
- Documenter la procédure de test dans le README.

```
chore: remove dead asyncHandler, restore migration file and rewrite README

- Delete src/utils/asyncHandler.js: unused, and it uses module.exports in an
  ESM project, so importing it would throw
- Restore the hand-reformatted migration.sql; applied migrations are immutable
  and the diff was purely cosmetic
- Rewrite the README: six claims no longer match the code (Prisma version,
  asyncHandler removal, production dependency safety, the "tested in real
  execution" email claim, the media system, the order-to-delivery flow)
- Document the test suite and the isolated test database
```

---

## Récapitulatif

| Phase | Contenu | Fichiers | Test | Commit |
|---|---|---|---|---|
| 1 | Socle Vitest + DB de test isolée | 6 créés | 🔴 2 rouges volontaires | `test(setup)` |
| 2 | B2 — `listingId` entier | 1 modifié + tests | 🟢 | `fix(orders)` |
| 3 | B1 — `firstname`/`lastname` | 7 modifiés + tests | 🟢 | `fix(models)` |
| 4 | B3 — `nodemailer` en prod | 1 modifié | 🟢 | `fix(deps)` |
| 5 | **B5 — `:id` en chaîne sur un ID entier** | 1 créé + 5 routes | 🟢 | `fix(routes)` |
| 6 | Montants `Decimal` (migration schéma) | 3 + migration | 🟢 | `feat(db)` |
| 7 | Pile email unifiée, templates AgriConnect | ~12 | 🟢 | `refactor(email)` |
| 8 | Sécurité et robustesse | ~5 | 🟢 | `fix(security)` |
| 9 | Nettoyage + README | ~4 | 🟢 | `chore` |

**Ordre retenu** : chaque phase ne dépend que de la précédente. Le coût
dominant est la phase 3 (7 fichiers) et la phase 6 (réécriture des templates).

**Décisions prises le 30/09/2026** :
- `migration.sql` reformaté → annulé ; `auth.controller.js` et `.env.example`
  conservés (repris en phase 6)
- Pile email → on **conserve `views/emails/`** et on réécrit les templates
  AgriConnect dedans, plutôt que de tout supprimer au profit de `src/emails/`
- Montants → **bascule en `Decimal`** (phase 5), pas un simple ajout de note
  dans le README

**Ce que le plan ne couvre pas** : pagination (déjà hors MVP et le
`getListings` n'a pas de limite — à noter), notifications push, avis/notation,
réinitialisation de mot de passe. Ces sujets restent hors périmètre comme
annoncé dans le README actuel.
