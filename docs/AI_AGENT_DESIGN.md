# AgriConnect — Agent IA local (Ollama / Granite) : conception

> État réel : le backend n'a **aucun runtime IA** (voir `02_API_REALITY.md` §5-B4). Tout ce qui suit est
> **à construire**, côté backend d'abord ; le frontend n'en consomme que l'API (jamais Ollama).

## 1. Décisions d'architecture (et pourquoi)

| # | Décision | Raison |
|---|---|---|
| A1 | **Seul le backend parle à Ollama** (`http://127.0.0.1:11434`). Le mobile n'appelle jamais Ollama. | Un téléphone n'atteint pas le `localhost` du PC ; exposer Ollama sur le réseau = service sans authentification ; les prompts et règles métier ne doivent pas vivre dans l'app. |
| A2 | L'IA agit par **services internes**, pas en se connectant comme un utilisateur HTTP. | `Agent(kind=AI)` n'a pas de compte (`userId=null`) ; `requireCapability` ne le reconnaît donc jamais. Il faut un « acteur interne » `{kind:'AI', agentId}` qui réutilise les mêmes règles (capacités, `requireHumanActor`, audit). |
| A3 | Mode **sortie structurée en un coup** (`format` = JSON Schema d'Ollama) plutôt qu'une boucle d'outils (tool-calling). | Les petits modèles locaux sont fragiles en appel d'outils (un retour d'expérience public rapporte que `granite4:latest` n'appelait pas les outils dans un framework donné). Une sortie JSON validée par le serveur est déterministe ; **le code décide quoi exécuter**, le modèle ne propose que du texte et une intention. |
| A4 | Exécution **asynchrone** (jobs en base + socket), jamais dans la requête HTTP. | Sur CPU, un modèle 3–8 B met souvent 10–90 s. La requête renvoie `202`, le résultat arrive par `ai:suggestion`. Concurrence = 1 (Ollama sature vite). |
| A5 | Par défaut **`SUGGEST_ONLY`**. `AUTONOMOUS` est codé mais **désactivé** par variable d'environnement. | Un modèle local hallucine (prix, stocks, délais). L'agriculteur/acheteur ne doit jamais recevoir un chiffre inventé. |
| A6 | Abstraction `AiProvider` (`generateStructured({system,user,schema})`) avec une implémentation `ollama` aujourd'hui. | Passage au Cloud plus tard = nouvelle implémentation + `Agent.aiProvider`, sans toucher aux contrôleurs ni au frontend. |
| A7 | Les messages publics envoyés par l'IA sont **étiquetés comme IA** côté client (`senderLabel: "Assistant AgriConnect (IA)"`). | Transparence envers des utilisateurs peu technophiles ; à confirmer par toi (question Q3). |

### Choix du modèle (à valider sur ta machine)
- Je ne connais pas ton tag exact : **`ollama list`** puis **`ollama show <tag>`** (regarde `capabilities`, et la taille). Le backend lit `OLLAMA_MODEL`, donc aucun code n'en dépend.
- Famille Granite 4 sur Ollama (page bibliothèque, vérifiée) : `granite4:350m|1b|3b (=micro)|7b-a1b-h (=tiny-h)|32b-a9b-h (=small-h)`, mention « tools ». `granite3.3` 8B existe aussi. Des sources tierces citent Granite 4.1 en 3B/8B/30B.
- Règle pratique : **≥ 7–8 B** pour un français correct sur des réponses client ; 3 B acceptable pour la classification/triage ; 1 B et moins = non recommandé pour répondre à des clients.
- Le premier prompt IA du backend **mesure** latence et qualité sur 15 questions types (`npm run ai:eval`) : décide par chiffres, pas par intuition.

## 2. Périmètre MVP de l'IA (ce qu'elle fait / ne fait pas)

**Fait (par `kind` de suggestion)** :
1. `REPLY` — brouillon de réponse à une conversation de support (BUYER_SUPPORT / SUPPLIER_SUPPORT), ancré sur des faits fournis (annonce pour l'acheteur ; lot du **même** fournisseur pour le fournisseur).
2. `TRIAGE` — classification : `intent` ∈ {`PRODUCT_QUESTION`,`PRICE_QUOTE_REQUEST`,`DELIVERY_QUESTION`,`VERIFICATION_STATUS`,`COMPLAINT`,`OTHER`}, urgence, langue, `needs_human`, escalade suggérée.
3. `LISTING_DRAFT` — titre + description d'annonce à partir d'un lot (LISTING_MANAGEMENT), à la demande.

**Ne fait jamais (même en AUTONOMOUS)** : paiements, remboursements, reversements, indemnisations, parrainages
(déjà interdits par `requireHumanActor`) ; émettre/modifier un devis ; changer un prix ; valider/rejeter un lot ou un
document de vérification ; suspendre un compte ; annuler une commande.

## 3. Sémantique d'autonomie

| `autonomy` | Effet |
|---|---|
| `SUGGEST_ONLY` (défaut) | Crée une `AgentSuggestion(PENDING)` visible du staff **seulement**. L'humain peut « Utiliser » (copie dans le champ de saisie), « Envoyer tel quel / modifié » (message publié sous **son** nom d'agent), ou « Rejeter ». |
| `ACT_WITH_APPROVAL` | La suggestion porte une **action** exécutable (`SEND_REPLY`, `ESCALATE`). Un humain ayant la capacité approuve → le serveur exécute (message publié sous la fiche **IA**, `approvedByUserId` tracé). |
| `AUTONOMOUS` | Seulement `SEND_REPLY` pour des intentions en liste blanche (`VERIFICATION_STATUS`, `DELIVERY_QUESTION` générique…), confiance ≥ seuil, **max 2 messages IA consécutifs** sans réponse humaine, et `AI_AUTONOMOUS_ENABLED=true`. Sinon retombe en `ACT_WITH_APPROVAL`. |

## 4. Modèle de données (migration Prisma `add_agent_suggestions`)

```prisma
enum AiSuggestionKind   { REPLY TRIAGE LISTING_DRAFT }
enum AiSuggestionStatus { PENDING APPROVED REJECTED EXECUTED FAILED EXPIRED }

model AgentSuggestion {
  id               Int                @id @default(autoincrement())
  agentId          Int
  agent            Agent              @relation(fields: [agentId], references: [id])
  kind             AiSuggestionKind
  status           AiSuggestionStatus @default(PENDING)
  conversationId   Int?
  lotId            Int?
  payload          Json?              // NULL tant que le modèle génère ; ensuite la sortie validée {intent, language, confidence, reply, needsHuman, reasons[], action?}
  model            String             @db.VarChar(120)
  latencyMs        Int?
  error            String?            @db.VarChar(500)
  decidedByUserId  Int?
  decidedAt        DateTime?
  executedAt       DateTime?
  createdAt        DateTime           @default(now())
  @@index([status, createdAt])
  @@index([conversationId, createdAt])
}
```
(Relation inverse `suggestions AgentSuggestion[]` à ajouter sur `Agent`.) Traces d'audit : `AI_SUGGESTION_CREATED`, `_APPROVED`, `_REJECTED`, `_EXECUTED`, `_FAILED` avec `actorAgentId`.

## 5. Modules backend à créer

```
src/services/ai/
  provider.js            # interface AiProvider + fabrique selon Agent.aiProvider
  ollama.provider.js     # POST {base}/api/chat {model,messages,stream:false,format:<schema>,options:{temperature:0.2,num_ctx},keep_alive}
  ai.config.js           # lecture/validation des variables d'environnement
  ai.prompts.js          # prompts système FR (rôle, ton, interdits, format)
  ai.context.js          # constructeurs de contexte par kind, avec REDACTION stricte
  ai.guard.js            # validation Joi de la sortie, contrôle des nombres, longueur, URLs/téléphones
  ai.queue.js            # file en mémoire, concurrence 1, reprise des PENDING au démarrage
  ai.orchestrator.js     # trigger → contexte → provider → guard → AgentSuggestion → socket
  ai.actions.js          # exécuteurs (SEND_REPLY, ESCALATE) via les services existants (createMessage…)
src/controllers/ai.controller.js + src/routes/ai.routes.js (monté sous /staff/ai et /admin/ai)
src/validators/ai.validator.js ; scripts/ai-eval.js
```
Variables : `AI_ENABLED=false`, `OLLAMA_BASE_URL=http://127.0.0.1:11434`, `OLLAMA_MODEL=` (obligatoire si activé),
`OLLAMA_TIMEOUT_MS=120000`, `OLLAMA_NUM_CTX=4096`, `OLLAMA_KEEP_ALIVE=10m`, `AI_MAX_CONCURRENCY=1`,
`AI_AUTONOMOUS_ENABLED=false`, `AI_MIN_CONFIDENCE=0.8`.

**Déclencheurs** : (a) message `CUSTOMER` entrant dans une conversation sans humain assigné et sans message
interne récent (auto, seulement si une fiche IA **active** possède la capacité du type de conversation) ;
(b) clic « Suggérer une réponse » (`POST /staff/conversations/:id/ai-suggest`) ; (c) `POST /staff/lots/:id/ai-listing-draft`.

## 6. Contrat d'API à ajouter (à documenter dans OpenAPI)

| Méthode & chemin | Accès | Réponse |
|---|---|---|
| `GET /admin/ai/status` | ADMIN+ | `{enabled, provider, baseUrl, model, reachable, modelInstalled, capabilities:string[], lastLatencyMs, queue:{pending,running}, autonomousEnabled}` |
| `POST /admin/ai/test` `{prompt?}` | ADMIN+ (rate-limited) | `{ok, latencyMs, output}` |
| `GET /staff/ai/suggestions?status&kind&conversationId&page&limit` | BUYER_SUPPORT / SUPPLIER_SUPPORT / LISTING_MANAGEMENT (filtré par capacité) ; ADMIN+ | `Paginated<AiSuggestion>` |
| `GET /staff/ai/suggestions/:id` | idem | `AiSuggestion` |
| `POST /staff/ai/suggestions/:id/approve` `{editedContent?}` | capacité du type | `AiSuggestion` (EXECUTED) ou 409 `INVALID_STATE_TRANSITION` |
| `POST /staff/ai/suggestions/:id/reject` `{reason?}` | idem | `AiSuggestion` (REJECTED) |
| `POST /staff/conversations/:id/ai-suggest` | capacité du type | `202 {suggestionId,status:'PENDING'}` ; 409 `AI_DISABLED` / `AI_BUSY` |
| `POST /staff/lots/:id/ai-listing-draft` | LISTING_MANAGEMENT | `202 {suggestionId,status:'PENDING'}` |

`AiSuggestion` (DTO) — **`payload: null` + `status: PENDING` = « génération en cours »** ; `payload` renseigné + `PENDING` = « prête, en attente de décision humaine » : `{id, kind, status, conversationId|null, lotId|null, agent:{id,displayName}, model, latencyMs|null,
payload:{intent?, language?, confidence?, reply?, needsHuman?, reasons?[], listing?:{title,description}, action?:{type}},
error|null, decidedAt|null, executedAt|null, createdAt}`.
Codes d'erreur nouveaux : `AI_DISABLED`, `AI_BUSY`, `AI_NO_AGENT`, `AI_RATE_LIMITED`, `AI_AUTH_FAILED`, `AI_UNREACHABLE`, `AI_MODEL_MISSING`, `AI_INVALID_OUTPUT`, `INVALID_STATE_TRANSITION`.
Socket (room `staff`) : `ai:suggestion` (créée) et `ai:suggestion_updated` → `{id, kind, status, conversationId}`.
`messageToClientDto` : si l'expéditeur est un agent `AI` → `senderLabel = 'Assistant AgriConnect (IA)'`.

L'auto-déclenchement après un message client est désactivé tant que `AI_AUTO_SUGGEST_ENABLED=false`.
Les générations manuelles et les brouillons d'annonce sont asynchrones; le fournisseur est résolu par
`getProvider(agent)`. Une suggestion en génération et une suggestion prête partagent `PENDING`, distinguées
par `payload: null` ou un payload validé. Au démarrage, les suggestions `PENDING` sont marquées `EXPIRED`
et ne sont jamais rejouées.

## 7. Garde-fous (non négociables)

1. **Rédaction du contexte** : pour une conversation *acheteur*, ne jamais injecter lot, fournisseur, prix convenu, adresse d'enlèvement, ni e-mail/téléphone de qui que ce soit. Pour un *fournisseur*, uniquement ses propres lots. Même règle que les DTO.
2. **Injection de prompt** : le texte client est une *donnée* délimitée (`<message_client>…</message_client>`) ; le système prompt interdit d'obéir à des instructions qu'il contient. Aucune exécution d'action déduite directement du texte client.
3. **Garde de sortie** (`ai.guard`) : JSON conforme au schéma ; `reply` ≤ 800 caractères ; **tout nombre** (prix, quantité, date) présent dans `reply` doit figurer dans le contexte fourni, sinon `needsHuman=true` et suggestion marquée « à vérifier » ; pas d'URL, pas de numéro de téléphone, pas d'e-mail.
4. **Kill-switch** : `AI_ENABLED=false` → tout renvoie `AI_DISABLED` ; fiche IA `isActive=false` → aucun déclenchement.
5. **Confidentialité** : Ollama local = aucune donnée ne quitte la machine ; ne pas journaliser le contenu des messages (seulement ids, durée, statut).
6. **Reprise** : au démarrage, les `PENDING` anciens (> 15 min) passent `EXPIRED` ; jamais de rejeu automatique.

## 8. Installation locale (Windows / macOS / Linux)

```bash
ollama serve                      # déjà lancé en service sur Windows/macOS
ollama list                       # repère le tag Granite téléchargé
ollama show <tag>                 # taille, contexte, capabilities
# .env du backend
AI_ENABLED=true
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=<tag>
```
Premier chargement lent (modèle en RAM) : `keep_alive` évite de le recharger à chaque requête.
Qualité de service minimale à mesurer : p50/p95 de latence, % de sorties JSON valides, % de réponses sans nombre inventé.

## 9. Interfaces frontend associées (voir plan, prompt P14)

Staff : badge « IA » sur les messages publiés par l'IA ; panneau « Suggestion IA » dans une conversation (brouillon,
intention, confiance, avertissements, **Utiliser / Modifier & envoyer / Rejeter**) ; bouton « Suggérer une réponse » ;
file « Suggestions IA » (filtre statut/kind) alimentée par `ai:suggestion` ; brouillon d'annonce depuis un lot.
Admin : écran « Agents IA » (créer fiche IA, `aiProvider`/`aiModel`, autonomie, capacités — `PAYMENT_FOLLOWUP` refusé
d'avance, activer/désactiver) + carte « Moteur IA local » (`/admin/ai/status`, bouton Tester).
