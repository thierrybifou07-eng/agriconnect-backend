# AGENTS.md — AgriConnect (backend Node.js)

> À placer à la racine du dépôt **backend** sous le nom `AGENTS.md` (renommer ce fichier). Lu par OpenCode à chaque session.

## Stack et conventions réelles du dépôt (vérifiées)
Node.js (ESM) · Express 5 · Prisma 6 + **MySQL** · Joi · Socket.io · Vitest (`npm test`, `test:unit`, `test:integration`).
- Routes : `src/routes/<x>.routes.js` montées dans `src/routes/router.js` sous `/api/v2`. Gardes : `protect`, `requireRole(...codes)` (**ne laisse pas passer ADMIN/ROOT implicitement : les lister**), `requireMinLevel(n)`, `requireCapability(...codes)`, `requireHumanActor`.
- Contrôleurs : `src/controllers/**` (minces) ; logique dans `src/services/**` ; DTO de sortie dans `src/utils/dto/**` ; validation Joi dans `src/validators/**` (`validate(schema, 'body'|'query')`).
- Audit : `src/utils/audit.js` (champs `actorUserId` / `actorAgentId`, `action`, `entityType`, `entityId`, `metadata`).
- Montants : Decimal Prisma → nombre JSON par `decimal-json.middleware.js`. IDs entiers (`coerceIdParam`).
- Erreurs : `{ error: "message FR", code?: "MAJUSCULES" }` ; validation → 400 `{error:'Données invalides', details:[{field,message}]}`.
- Documentation : fragments `openapi/*.openapi.js` → `npm run docs:openapi` écrit `docs/openapi.yaml`. **Toute route nouvelle ou modifiée met à jour son fragment.**
- Migrations : `npx prisma migrate dev --name <nom>` ; ne jamais éditer une migration déjà appliquée ; `npm run db:drift` doit rester propre.

## Règles
1. **Compatibilité ascendante** : n'ajouter que des champs/routes/codes ; ne renommer ni supprimer aucun champ existant.
2. Chaque route a : garde de rôle/capacité, validation Joi, test d'intégration (cas nominal + 401 + 403 + 400/409 pertinents), fragment OpenAPI.
3. Aucune donnée sensible dans les logs (pas de contenu de message, pas de jeton, pas de numéro de compte).
4. Les agents IA ne déplacent jamais d'argent (`requireHumanActor`), ne valident ni lot ni document, n'émettent pas de devis.
5. Variables d'environnement nouvelles → `.env.example` commenté + validation au démarrage.
6. Après chaque tâche : `npm test` vert, `npm run docs:openapi` sans diff inattendu, `npm run db:drift` propre.
7. **Une phase = un commit** (Conventional Commits + description détaillée). Ne pas `git push`. Après 2 échecs sur un même problème : arrêter et rapporter.
8. Ne jamais inventer : si une information manque, la chercher dans le code (`grep`) ; si elle n'y est pas, le dire.
