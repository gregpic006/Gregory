# Plan de migration vers Next.js/TypeScript + refonte admin

## Pourquoi ceci est un document, pas du code

Cette partie du tier 🟡 est fondamentalement différente de tout ce qu'on a fait jusqu'ici. Le reste du projet (JWT, CI/CD, plafonds d'approbation, import massif, module comptable...) s'est ajouté par-dessus l'architecture existante — des fichiers HTML plats modifiés en place, sans rien casser de ce qui marchait. Une réécriture Next.js/TypeScript n'est pas un ajout : c'est un changement d'architecture complet, sur un projet qui tourne déjà en production avec de vrais clients. La commencer à la volée dans la même session que dix autres chantiers, sans plan écrit, sans étapes de validation, c'est le genre de décision qui peut laisser le projet dans un état à moitié migré — pire que de ne pas y toucher.

Ce document pose le plan. L'exécution se fait par étapes séparées, chacune validée avant la suivante.

## État actuel (référence pour mesurer l'ampleur du changement)

- 13 portails/pages en HTML statique avec JavaScript inline (`<script>` dans la page), aucune étape de build, aucun bundler, aucun système de types.
- `portail-admin.html` à lui seul fait 2930 lignes (le plus gros morceau — normal, c'est lui qui contient le plus d'actions).
- 38 fonctions edge Supabase (Deno, TypeScript déjà) — celles-ci n'ont **pas** besoin d'être réécrites en Next.js ; Next.js est un framework frontend/serveur web, pas un remplacement pour des edge functions Deno.
- Hébergement statique actuel (CNAME → `portailgestion.ca`), pas de serveur Node en production aujourd'hui.
- Aucun `package.json`, aucune dépendance npm dans le repo actuellement.
- Chaque portail appelle Supabase directement via le client JS (`@supabase/supabase-js` chargé par CDN), sans couche d'abstraction ni de types partagés.

## Recommandation : migration "strangler fig", pas une réécriture big-bang

Ne pas réécrire les 13 portails d'un coup. À la place :

1. **Un seul nouveau projet Next.js**, déployé à côté de l'existant (ex: sous-domaine `app.portailgestion.ca` ou un chemin distinct), qui ne remplace RIEN au départ.
2. **Migrer un portail à la fois**, en commençant par l'admin (`portail-admin.html`) puisque c'est explicitement "refonte admin" dans la roadmap, et que c'est le portail interne (pas client-facing) — le risque d'une régression y est moins grave qu'un bris du portail locataire ou propriétaire.
3. **Chaque portail migré reste optionnel/basculable** tant que la nouvelle version n'a pas prouvé sa fiabilité en usage réel — garder l'ancien fichier HTML accessible en secours pendant la transition, ne pas supprimer tant que la nouvelle version n'a pas tourné sans incident pendant au moins quelques semaines.
4. **Les edge functions ne changent pas.** Le frontend Next.js les appelle exactement comme le fait le HTML actuel aujourd'hui (`supabase.functions.invoke(...)`) — aucune migration de logique métier requise à cette étape.

## Étapes concrètes (dans l'ordre)

### Phase 0 — Fondations (pas de UI visible, zéro risque pour les utilisateurs)
- Créer le projet Next.js (App Router, TypeScript) dans un sous-dossier du repo (ex: `app-next/`), avec son propre `package.json` — cohabite avec les fichiers HTML actuels sans les toucher.
- Générer les types TypeScript depuis le schéma Supabase (`supabase gen types typescript`) — élimine une classe entière de bugs (noms de colonnes mal orthographiés, `any` partout) qu'on a vue apparaître plusieurs fois dans les fichiers HTML actuels.
- Mettre en place l'authentification Supabase côté Next.js (`@supabase/ssr`), avec les mêmes règles RLS déjà en place — aucun changement côté base de données.
- Choisir et documenter l'hébergement (Vercel est le chemin le plus simple pour Next.js ; sinon self-host avec le CI/CD GitHub Actions déjà en place).
- **Livrable de cette phase : un déploiement Next.js vide accessible, sans aucun impact sur les portails existants.**

### Phase 1 — Portail admin, section par section
Ne pas migrer les 2930 lignes de `portail-admin.html` d'un coup. Découper par section déjà existante (Onboarding, Travaux, Comptabilité, Observabilité, etc. — les sections qu'on vient de construire) et migrer une section à la fois, chacune déployée et testée avant la suivante. Commencer par une section peu utilisée à faible risque (ex: "Observabilité", qu'on vient de construire) pour valider tout le pipeline (auth, appel aux edge functions, déploiement) avant de toucher aux sections critiques (Travaux, Approbations).

### Phase 2 — Bascule progressive du trafic admin
Une fois toutes les sections migrées et validées, rediriger l'accès admin vers la nouvelle version. Garder `portail-admin.html` disponible (non lié dans la navigation, mais accessible directement) comme filet de sécurité pendant au moins 2-4 semaines d'usage réel avant suppression.

### Phase 3 — Portails suivants
Une fois le portail admin stable en Next.js, répéter pour les autres portails dans un ordre de risque croissant : cold-caller et travailleur (usage occasionnel, impact limité) → propriétaire → locataire (le plus sensible : c'est le contact direct avec les clients finaux des propriétaires).

## Ce qui NE change PAS dans ce plan

- Les 38 edge functions Deno restent telles quelles — Next.js les appelle, ne les remplace pas.
- Le schéma Supabase (`schema.sql` + `supabase/migrations/`) ne change pas à cause de cette migration.
- Les formulaires publics non authentifiés (`formulaires-gestion-immobiliere.html`, `confirmer-visite.html`, `signer-bail.html`, etc.) ne sont pas dans la portée immédiate — ce sont des pages simples, peu de logique, faible priorité de migration.

## Risques principaux et mitigation

| Risque | Mitigation |
|---|---|
| Régression silencieuse dans une section migrée | Un portail migré coexiste avec l'ancien tant qu'il n'a pas prouvé sa fiabilité — jamais de suppression immédiate |
| Dérive de types entre le schéma réel et les types générés | Régénérer les types à chaque migration SQL (`supabase gen types`), l'intégrer comme étape du CI/CD |
| Effort sous-estimé, chantier qui traîne indéfiniment | Découpage en sections livrables indépendamment (voir Phase 1) plutôt qu'un seul gros morceau "tout ou rien" |
| Nouvel hébergement (Vercel ou autre) mal configuré en prod | Phase 0 se termine par un déploiement vide validé avant qu'aucune vraie fonctionnalité n'y transite |

## Effort estimé (ordre de grandeur, pas un engagement précis)

- Phase 0 : quelques jours.
- Phase 1 (admin complet, section par section) : la phase la plus longue — plusieurs semaines, dépend du rythme de validation entre chaque section.
- Phases 2-3 : dépendent entièrement de la stabilité observée en Phase 1.

**Prochaine étape concrète, quand tu es prêt à démarrer pour de vrai** : je fais la Phase 0 (projet Next.js vide + types + auth, zéro risque) et je te montre le résultat avant d'aller plus loin.
