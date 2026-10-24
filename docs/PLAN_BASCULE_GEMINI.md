# AgriConnect — Plan de bascule de l'Agent IA : Ollama/Granite (local) → Google Gemini (cloud)

> Base lue : dépôt `agriconnect-backend`, branche `feature/mobile-contract`, commits P00 (`5703063`) et P01 (`6910f02`).
> Non exécuté : rien n'a été lancé ni appelé (pas de clé Gemini, pas de réseau vers l'API). Les points « à vérifier »
> sont explicités ; les quotas viennent de sources qui **se contredisent** (voir §3).

---

## 1. Verdict

La bascule est **peu coûteuse et sans risque pour le flux**, parce que P01 a déjà posé le bon découpage :
`getProvider(agent)` est une fabrique, et tout le reste (garde de sortie, schémas, prompts, script d'évaluation,
routes `/admin/ai/*`) ne parle qu'à l'interface `AiProvider { ping, describeModel, generateStructured }`.
**On ajoute un second fournisseur, on ne remplace rien.** Ollama reste disponible (développement hors-ligne, repli).
Retour arrière = changer une variable d'environnement (`AI_PROVIDER=ollama`).

Trois corrections à connaître **avant** de coder :

| # | Constat vérifié | Conséquence |
|---|---|---|
| 1 | **`@google/generative-ai` est déprécié** (dépôt archivé « deprecated », fin de support annoncée en 2025). Le SDK actuel est **`@google/genai`** (`GoogleGenAI`, `ai.models.generateContent`). | `npm uninstall @google/generative-ai && npm install @google/genai`. De plus, la dépendance **n'est pas dans le `package.json` de la branche poussée** : elle n'existe que sur ta machine. |
| 2 | **Palier gratuit = tes données servent à Google.** Les conditions des services « non payants » disent que le contenu envoyé et les réponses servent à améliorer les produits Google (des relecteurs humains peuvent les lire) et demandent de **ne pas envoyer d'informations sensibles, confidentielles ou personnelles**. Activer la facturation Cloud bascule **toute** l'utilisation en régime « payant » (données non utilisées pour l'entraînement) même avec le quota gratuit. L'UE/UK/Suisse sont déjà traités comme « payant ». | AgriConnect manipule des messages d'acheteurs et de fournisseurs. **Gratuit + vraies conversations = non conforme à ces conditions.** Voir §4 (décision D1). |
| 3 | **Les quotas gratuits sont instables et mal documentés** : la page officielle renvoie au tableau de bord AI Studio (limites **par projet**, remise à zéro à minuit heure du Pacifique) ; des blogs donnent de 20 à 1 500 requêtes/jour selon le modèle et la date. | Ne **rien coder en dur** : modèle, budget quotidien et RPM sont des variables d'environnement ; gérer proprement le `429`. |

---

## 2. Ce qui change / ce qui ne change pas

| Élément | Sort | Détail |
|---|---|---|
| Interface `AiProvider`, `getProvider(agent)` | **Étendu** | `getProvider` choisit `agent.aiProvider ?? AI_PROVIDER` ; ajoute `'gemini'` |
| `ollama.provider.js` | **Inchangé** | reste le repli local |
| `gemini.provider.js` | **Nouveau** | `@google/genai`, sortie JSON structurée (`responseMimeType` + `responseJsonSchema`) |
| `ai.config.js` | **Étendu** | ajoute `AI_PROVIDER`, `GEMINI_*`, budget/RPM ; **aucune clé existante renommée** |
| `ai.guard`, `ai.schemas`, `ai.prompts` | **Inchangés** (Joi reste l'arbitre final de la sortie) | un test vérifiera que Gemini accepte le schéma actuel |
| `ai.controller.js` (`/admin/ai/status`, `/test`) | **Adapté** | réponse dépendante du fournisseur (`baseUrl` nul en cloud, + `quota`, `authenticated`) ; erreurs `429`/`AI_AUTH_FAILED` |
| `ai.throttle.js` | **Nouveau** | fenêtre RPM + budget quotidien en mémoire → évite de brûler le quota gratuit |
| `ai.redact.js` | **Nouveau** | masque e-mails/téléphones/URLs dans le texte client avant envoi cloud |
| P02 (suggestions, file, approbation) | **Ajusté** (prompt mis à jour) | auto-déclenchement **désactivé par défaut** ; `AI_RATE_LIMITED` ; redaction avant envoi |
| Contrat frontend P15 | **Ajusté légèrement** | `AiEngineStatus.baseUrl` nullable, `quota`, messages d'erreur ; sondage de secours 90 s au lieu de 3 min |
| Architecture asynchrone (202 + socket) | **Conservée** | même avec des réponses en 2–5 s, elle protège contre les `429`/pannes et garde le contrat stable |

Gain attendu : de plusieurs dizaines de secondes (Granite 3B sur CPU) à **quelques secondes**. Le chiffre réel sera
mesuré par `npm run ai:eval` (même script, même 15 cas) : compare p50/p95 et validité JSON **avant/après**.

---

## 3. Choix du modèle Gemini

- **Ne pas figer de nom.** Les modèles Gemini sont régulièrement retirés (ex. Gemini 2.0 Flash annoncé pour arrêt en juin 2026) et les noms changent (« preview », « latest »). `GEMINI_MODEL` est **obligatoire** quand le fournisseur est actif, sans valeur par défaut.
- **Famille recommandée : Flash-Lite** (la moins chère, souvent la plus généreuse en quota gratuit, largement suffisante pour classer une demande et rédiger 3–5 phrases) ; **Flash** si la qualité de français déçoit. Les modèles « Pro » ne sont pas faits pour ce besoin et sont, selon plusieurs sources, exclus du gratuit.
- Lis **le nom exact et tes limites réelles dans Google AI Studio** (tableau de bord des limites de ton projet). `/admin/ai/status` vérifiera que le modèle configuré existe encore (`ai.models.get`).
- Le français de Gemini est nettement meilleur que celui d'un Granite 3B : l'évaluation (`ai:eval`) doit le confirmer sur tes 15 cas.

---

## 4. Décisions à prendre (avec ma recommandation)

| # | Décision | Recommandation |
|---|---|---|
| **D1** | Données réelles et palier gratuit | **Palier gratuit = développement et démo avec les données du `seed:demo` uniquement.** Avant d'avoir de vrais utilisateurs : soit activer la facturation Cloud **avec un plafond de budget et des alertes** (le coût d'un modèle Flash-Lite pour du support texte est très faible, mais ce n'est pas zéro, et je ne peux pas te le chiffrer), soit laisser l'IA **désactivée** sur les vraies conversations. Dans tous les cas : mentionner l'usage d'un prestataire d'IA externe dans les CGU/politique de confidentialité. |
| **D2** | Auto-déclenchement à chaque message client | **Désactivé** (`AI_AUTO_SUGGEST_ENABLED=false`). Chaque message consommerait un appel du quota quotidien. Le bouton « Suggérer une réponse » (manuel) suffit au MVP. |
| **D3** | Repli automatique Gemini → Ollama | **Non.** Granite est trop lent pour servir de secours ; en cas de `429`/panne, la suggestion passe `FAILED` avec un message clair et le staff répond à la main. |
| **D4** | Minimisation des données envoyées | Déjà conçue (contexte rédigé : jamais de lot/fournisseur/téléphone pour un acheteur) + **nouvelle redaction** du texte client (e-mails, téléphones, URLs) avant l'envoi cloud. Ne jamais envoyer de noms de clients. |
| **D5** | Clé API | **Uniquement côté serveur** (`.env`, jamais dans l'app Flutter, jamais dans git). Une clé AI Studio est puissante par défaut : en créer une **dédiée à AgriConnect** et la révoquer en cas de fuite. |

---

## 5. Plan d'exécution (2 prompts backend + 2 ajustements)

| Étape | Dépôt | Contenu | Prompt |
|---|---|---|---|
| **0 — Préparation (toi, 5 min)** | backend | `npm uninstall @google/generative-ai && npm install @google/genai` ; créer une clé dans AI Studio ; `GEMINI_API_KEY=…` dans `.env` (vérifier `git check-ignore .env`) ; noter le nom du modèle affiché dans AI Studio | — |
| **1 — Fournisseur Gemini** | backend | config, `gemini.provider.js`, throttle, redaction, fabrique, statut/test adaptés, évaluation, tests **sans réseau** | **`P01b_backend_ia_provider_gemini.md`** (nouveau) |
| **2 — Suggestions & file** | backend | inchangé dans l'esprit, **prompt P02 mis à jour** (fournisseur agnostique, `AI_RATE_LIMITED`, auto-suggestion désactivée par défaut, redaction) | `P02_backend_ia_suggestions.md` (modifié) |
| **3 — Interfaces IA** | frontend | **prompt P15 mis à jour** (statut multi-fournisseur, erreurs de quota/clé, sondage 90 s) | `P15_front_interfaces_ia.md` (modifié) |

Ordre global : `P00 ✔ → P01 ✔ → **P01b** → (frontend P03…P14 comme prévu) → P02 → P15`. P01b peut se faire tout de suite :
il ne touche ni la base ni le frontend.

### Validation de la bascule (critères chiffrés)
Exécuter `npm run ai:eval -- --limit 15` avec `AI_PROVIDER=ollama` puis `gemini`, comparer :
latence p50/p95, % JSON valide, % intention correcte, nombres non vérifiés, injections résistées.
**Seuils d'acceptation Gemini** : JSON valide ≥ 95 %, intention correcte ≥ 80 %, 0 injection réussie, p95 sensiblement
inférieure à Granite. Si un seuil n'est pas atteint : essayer le modèle Flash (pas Flash-Lite) avant de conclure.
Attention : **15 cas = 15 requêtes** de ton quota du jour ; `--limit 5` pour les essais.

---

## 6. Risques

| Risque | Probabilité | Mitigation |
|---|---|---|
| Quota gratuit épuisé en cours de journée (`429`) | Haute si auto-suggestion active | Auto-suggestion désactivée ; budget quotidien + RPM en mémoire ; erreur `AI_RATE_LIMITED` explicite côté UI |
| Modèle retiré / renommé | Moyenne | `GEMINI_MODEL` en variable ; `/admin/ai/status` détecte « modèle introuvable » |
| Données personnelles envoyées au palier gratuit | Moyenne | D1 + D4 (contexte minimal, redaction, démo uniquement) ; décision de facturation avant la production |
| Schéma JSON refusé par l'API (mot-clé non supporté, ex. `additionalProperties`) | Moyenne | Test d'intégration du schéma ; filtre minimal `toGeminiJsonSchema` seulement si l'API répond 400 ; Joi reste la validation finale |
| Contenu bloqué par les filtres de sécurité | Faible | Traité comme `AI_INVALID_OUTPUT` → suggestion `FAILED`, humain répond |
| Clé exposée | Moyenne (débutant) | `.env` ignoré par git, clé dédiée, jamais dans le mobile, jamais dans les logs ni dans `/admin/ai/status` (test dédié) |
| Dépendance dépréciée restée en place | Certaine si on n'agit pas | Étape 0 |

---

## 7. Questions

- **Q-G1** — Politique de données (D1) : gratuit + démo seulement jusqu'à la production, puis facturation plafonnée ? *(oui, c'est ma recommandation)*
- **Q-G2** — Quel nom de modèle vois-tu dans AI Studio pour ta clé, et quelles limites (RPM / requêtes par jour) affiche le tableau de bord ? *(sert à régler `AI_MAX_RPM` et `AI_DAILY_BUDGET`)*
- **Q-G3** — Es-tu d'accord pour garder l'auto-suggestion désactivée (D2) ? *(oui)*
