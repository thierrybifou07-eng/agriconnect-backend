# Comptes de démonstration

Le jeu de données est créé avec `npm run seed:demo`. Le mot de passe commun est
`Demo@2026x`. Ce seed est réservé au développement et refuse de s'exécuter si
`NODE_ENV=production`.

| E-mail | Rôle | Usage | Capacités |
|---|---|---|---|
| `admin@demo.agriconnect.test` | ADMIN | Administration générale | Accès admin |
| `agent.complet@demo.agriconnect.test` | AGENT | Parcours complet de l'équipe | Les 9 capacités |
| `agent.support@demo.agriconnect.test` | AGENT | Support acheteur | `BUYER_SUPPORT` |
| Fiche `Assistant IA (local)` | Agent IA | Démonstration d'un agent IA local (sans compte de connexion) | `BUYER_SUPPORT`, `SUPPLIER_SUPPORT`, `LISTING_MANAGEMENT` |
| `livreur@demo.agriconnect.test` | DRIVER | Parcours livreur rattaché à l'agence démo | — |
| `fournisseur.verifie@demo.agriconnect.test` | SUPPLIER vérifié | Lot, annonce et conversation de démonstration | — |
| `fournisseur.nonverifie@demo.agriconnect.test` | SUPPLIER non vérifié | Vérification du blocage avant dépôt de lot | — |
| `acheteur.verifie@demo.agriconnect.test` | BUYER vérifié | Consultation catalogue et conversation démo | — |
| `acheteur.nonverifie@demo.agriconnect.test` | BUYER non vérifié | Parcours de vérification | — |

Le compte ROOT n'est pas créé par ce seed. Créez-le séparément avec
`npm run create:root`.
