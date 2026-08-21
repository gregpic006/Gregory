# Portail — Gestion immobilière (Québec)

SaaS de gestion immobilière résidentielle, construit sur Supabase (Postgres + Auth + Storage + Edge Functions) avec des IA intégrées (Claude/Anthropic) pour l'automatisation opérationnelle. Ce document sert de point d'entrée pour un développeur qui reprend le projet.

## ⚠️ Le plus important à savoir avant de toucher au code

- Les **fichiers `.html`** (les 5 portails + pages publiques) se déploient automatiquement via **GitHub Pages** dès qu'un push atteint `main`.
- Les **fichiers `edge-function-*.ts`** se déploient maintenant automatiquement aussi, via `.github/workflows/deploy.yml` (voir section CI/CD ci-dessous) — un push sur `main` qui touche un fichier `edge-function-*.ts` les redéploie tous vers Supabase en quelques secondes. **Configuration à faire une seule fois** avant que ça fonctionne (secrets GitHub) — voir CI/CD.
- Le fichier **`schema.sql`** n'est PAS automatisé et ne le sera pas tel quel : c'est un historique cumulatif (beaucoup de `create table`/`create policy` SANS garde `if not exists`), donc le rejouer en entier sur une base déjà provisionnée échoue. Il reste la référence de ce qui a déjà été appliqué. **Toute NOUVELLE modification de schéma doit désormais aller dans `supabase/migrations/`** (un fichier par changement, jamais dans schema.sql) — voir CI/CD pour la procédure.

## Architecture

**Base de données** : un seul schéma Postgres central. Chaîne de données : `owners → buildings → units → leases → tenants → payments/expenses → service_requests → work_orders → workers → documents → audit_log`. RLS (Row Level Security) activé sur toutes les tables sensibles.

**Convention RLS** : deux styles cohabitent.
- Tables consultées directement par le navigateur (`owners`, `buildings`, `units`, `tenants`, `leases`, `payments`, `work_orders`, etc.) : policies scopées via des fonctions `security definer` (`auth_owner_id()`, `auth_tenant_id()`, `owned_unit_ids()`, `tenant_unit_ids()`, `auth_is_admin()`, définies vers la ligne 555 de `schema.sql`).
- Tables sensibles (`prospects`, `job_offers`, `worker_ratings`, `financial_anomalies`, `public_submission_log`, `ai_run_log`...) : RLS activé avec **zéro policy** — verrouillées au `service_role` uniquement. Tout accès passe obligatoirement par une edge function.

**Backend** : 39 Supabase Edge Functions (Deno/TypeScript), chacune un fichier `edge-function-<nom>.ts` à la racine — le nom de la fonction déployée sur Supabase est `<nom>` (sans le préfixe `edge-function-` ni le `.ts`). Trois familles :
- Fonctions **admin/rôle-authentifiées** (`ops-api`, `onboarding-api`, `admin-api`, `crm-api`, `caller-api`, `worker-api`, `owner-api`, `privacy-api`, `ask-documents`, `ask-finances`, `flinks-api`, `parse-expense-receipt`, `reconcile-bank-transactions`, `handle-lease-renewal-notice`) : vérifient le JWT en code via `verifySupabaseJwt()` (voir section Sécurité ci-dessous — pas le réglage plateforme `verify_jwt`), vérifient `users.is_admin` (ou l'équivalent propriétaire/locataire/travailleur) via une requête `service_role`, puis exécutent l'action demandée (`body.action`).
- Fonctions **publiques** (`handle-public-inquiry`, `handle-worker-registration`, `handle-mandat-inquiry`, `handle-public-faq`...) : pas de JWT requis, protégées par un honeypot (champ caché `website`) + limite de débit par IP (table `public_submission_log`).
- Fonctions **système/cron** (`handle-payment-reminder`, `handle-worker-job-assigned`, `generate-owner-report`, `send-onboarding-reminder`, `dispatch-work-order`...) : déclenchées par des `cron.schedule(...)` définis dans `schema.sql` via `pg_net`.

**Frontend** : 15 fichiers HTML statiques (vanilla JS, aucun framework/bundler) à la racine :
- `portail-admin.html` — interne, accès complet
- `portail-proprietaire.html`, `portail-locataire.html`, `portail-cold-caller.html`, `portail-travailleur.html` — un portail par rôle, connectés via Supabase Auth (client JS direct + RLS pour la plupart des lectures/écritures)
- `index.html`, `pro.html`, `formulaires-gestion-immobiliere.html`, `blog.html` — pages publiques
- `app.html` — point d'entrée unique de l'app mobile (Capacitor, voir `mobile/README.md`) : connexion puis redirection vers le bon portail selon le rôle (`edge-function-whoami.ts`)
- `confirmer-reparation.html`, `confirmer-visite.html`, `reponse-travailleur.html`, `signer-bail.html` — pages de confirmation/signature à token à usage unique (pas de compte requis)
- `politique-de-confidentialite.html`

**Stockage** : bucket Supabase Storage `documents` (baux, factures, preuves d'assurance, reçus) et `service-request-photos` (photos avant/après travaux). Accès signé via l'action `get_signed_url`.

**IA** : Claude (Anthropic API, modèle `claude-haiku-4-5-20251001`) pour la catégorisation des demandes, l'extraction de documents (baux, factures), les réponses publiques, l'analyse de satisfaction, etc. **Principe non négociable du projet : l'IA propose, un humain (ou une règle déterministe explicite) déclenche l'action finale** — particulièrement pour tout ce qui touche l'argent ou la sécurité (voir les règles d'urgence codées en dur dans `handle-service-request.ts`, jamais générées par l'IA).

## Domaine et hébergement

- Domaine : `portailgestion.ca`, configuré via le fichier `CNAME` à la racine + GitHub Pages.
- DNS géré chez Namecheap (courriel transactionnel via Resend, domaine expéditeur `mail.portailgestion.ca`).
- Sauvegardes de la base de données : voir [`BACKUPS.md`](./BACKUPS.md).

## Secrets requis (configurés dans Supabase → Edge Functions → Secrets, jamais commités dans ce repo)

```
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
RESEND_API_KEY
ANTHROPIC_API_KEY
FLINKS_API_BASE_URL
FLINKS_API_KEY
FLINKS_SECRET_KEY
FLINKS_CUSTOMER_ID
FLINKS_IFRAME_BASE_URL
FLINKS_SYNC_SECRET
TWILIO_ACCOUNT_SID       (optionnel — SMS Portail Concierge, repli automatique par courriel tant qu'absent)
TWILIO_AUTH_TOKEN        (optionnel — idem)
TWILIO_FROM_NUMBER       (optionnel — idem)
HEALTH_ALERT_SECRET      (requis pour le monitoring — voir section Monitoring ci-dessous)
```

La clé publique `SUPABASE_ANON_KEY` (préfixe `sb_publishable_...`) apparaît en clair dans le code client HTML — c'est normal et voulu, elle est conçue pour être publique. La clé `SUPABASE_SERVICE_ROLE_KEY`, elle, ne doit **jamais** apparaître côté client.

## Monitoring minimum

`check_system_health()` (SQL) vérifie 4 signaux déterministes : tâches cron sans exécution réussie depuis 26h, connexions bancaires Flinks désynchronisées depuis 48h, taux d'erreur IA anormal (>10/24h), demandes de confidentialité (Loi 25) approchant le délai légal de 30 jours.

- `trigger_health_check_alert()` tourne aux 15 minutes (`pg_cron`) et envoie un courriel aux admins via `send-health-alert.ts` si un problème est détecté — au maximum un courriel toutes les 2h par incident continu (pas de spam).
- `health-check.ts` est un endpoint public en lecture seule (aucune donnée sensible), fait pour être branché sur un moniteur externe gratuit comme [UptimeRobot](https://uptimerobot.com) : configure-le pour pinger `https://<ton-projet>.supabase.co/functions/v1/health-check` toutes les 5 minutes, avec le header `apikey: <SUPABASE_ANON_KEY>`. Il répond `200` si tout va bien, `503` sinon.
- Le tableau de bord admin affiche aussi ce statut en haut de page (bandeau vert/rouge).

**Configuration requise pour activer les alertes par courriel** — génère un secret aléatoire (ex: `openssl rand -hex 32`) et exécute dans Supabase SQL Editor : `select vault.create_secret('<ta-valeur-générée>', 'health_alert_secret');`, puis ajoute la même valeur comme secret d'edge function `HEALTH_ALERT_SECRET`.

Ce monitoring reste volontairement minimal (checks applicatifs de base, pas d'observabilité/tracing complet) — voir la roadmap 🟡 pour la suite quand le volume de portes le justifiera.

## Sécurité — vérification JWT

Chaque fonction admin-authentifiée vérifie le JWT en appelant `GET {SUPABASE_URL}/auth/v1/user` avec le token — `verifySupabaseJwt()`, inlinée dans chaque fichier (pas de module partagé tant que le déploiement reste manuel par copier-coller, voir CI/CD ci-dessous). Un token invalide, expiré ou forgé fait échouer cet appel (Supabase répond autre chose que 200), donc la fonction refuse la requête (401).

**Ce n'est PAS une vérification de signature locale (pas de HS256/`SUPABASE_JWT_SECRET`)** — c'est délibéré : la passerelle Edge Functions a un bug connu qui rejette à tort les JWT signés en ES256 (le mode par défaut du projet, clés asymétriques) quand le réglage plateforme `verify_jwt=true` est actif (github.com/supabase/supabase/issues/42244). Le contournement officiel Supabase est `verify_jwt=false` partout (voir `supabase/config.toml`) + vérification manuelle dans le code via l'API Auth elle-même, qui gère ES256 correctement. Cette vérification réseau est donc la SEULE protection pour ces fonctions — pas une deuxième couche par-dessus un réglage plateforme. Repasser `verify_jwt` à `true` pour ces fonctions seulement après confirmation que le bug Supabase ci-dessus est réglé côté plateforme.

**Aucune configuration de secret requise** pour ce mécanisme — `verifySupabaseJwt()` réutilise `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY`, déjà nécessaires par ailleurs.

Fonctions concernées : `admin-api`, `ask-documents`, `ask-finances`, `caller-api`, `crm-api`, `flinks-api`, `handle-lease-renewal-notice`, `onboarding-api`, `ops-api`, `owner-api`, `parse-expense-receipt`, `privacy-api`, `reconcile-bank-transactions`, `worker-api`.

## Tests d'étanchéité

`scripts/security-check.mjs` tente en conditions réelles (contre la prod) des accès qui doivent échouer : JWT forgé contre les 14 fonctions admin, requêtes sans authentification, `flinks-api sync_all` sans le secret partagé, lecture des tables verrouillées (`prospects`, `automation_rules`, etc.) avec la seule clé anon. Aucune action destructive ni coûteuse.

À lancer depuis l'onglet **Actions** du repo → "Tests d'étanchéité" → "Run workflow" (déclenchement manuel volontairement — pas de cron automatique contre la prod). Ou en local : `node scripts/security-check.mjs` (aucun secret requis, tout est en lecture/rejet).

## CI/CD et préproduction

**Fonctions edge — automatisé.** `.github/workflows/deploy.yml` déploie toutes les fonctions vers Supabase à chaque push sur `main` qui touche un fichier `edge-function-*.ts`. Les fichiers source restent à la racine (convention inchangée) ; le workflow les copie dans `supabase/functions/<nom>/index.ts` (structure attendue par la CLI Supabase) uniquement le temps du déploiement, jamais commité sous cette forme.

**Configuration requise (une seule fois)** — 2 secrets GitHub (repo → Settings → Secrets and variables → Actions) :
- `SUPABASE_ACCESS_TOKEN` — Supabase Dashboard → ton compte (icône en haut à droite) → Access Tokens → génère-en un nouveau (accès complet à tous tes projets, à garder secret).
- `SUPABASE_PROJECT_REF` — l'identifiant du projet, visible dans l'URL du dashboard (`kdmwfbcziokygfcmjxeq` pour ce projet — déjà public dans le code client, mais gardé en secret ici par cohérence).

`supabase/config.toml` déclare le réglage `verify_jwt` de chaque fonction — actuellement `false` pour TOUTES les fonctions (voir section Sécurité ci-dessus : bug de plateforme sur les JWT ES256, contournement officiel Supabase) — **important** : sans ce fichier, un déploiement automatisé réinitialiserait ce réglage à sa valeur par défaut et casserait potentiellement les fonctions publiques.

**Schéma SQL — semi-automatisé, en transition.** `schema.sql` reste l'historique figé (référence de lecture, ne plus y ajouter). Toute nouvelle modification de schéma va dans un nouveau fichier sous `supabase/migrations/` (nommage `YYYYMMDDHHMMSS_description.sql`, généré par `supabase migration new <description>` en local). Il n'y a pas encore de workflow automatique pour ces migrations — **étape manuelle unique restante** pour l'activer : quelqu'un avec la CLI Supabase installée en local doit faire un `supabase link --project-ref <ref>` puis `supabase db pull` une fois, pour établir la base "déjà appliquée" avant de brancher `supabase db push` en CI. Tant que ce n'est pas fait, applique les fichiers de `supabase/migrations/` manuellement dans le SQL Editor, comme avant.

**Préproduction.** Pas encore créée — crée un deuxième projet Supabase (gratuit) dédié aux tests, et un deuxième jeu de secrets GitHub (`SUPABASE_ACCESS_TOKEN_PREPROD` peut réutiliser le même token, `SUPABASE_PROJECT_REF_PREPROD` pointe vers ce nouveau projet). Une fois créé, dupliquer `deploy.yml` en `deploy-preprod.yml` déclenché sur push vers une branche `preprod` plutôt que `main` — le même principe de copie `edge-function-*.ts → supabase/functions/` s'applique tel quel.

## État connu du projet (à la dernière session — 2026-08-17)

Un audit de sécurité/fonctionnel (2026-08-05) avait identifié plusieurs points, **tous corrigés et déployés depuis** :
- **Sécurité (corrigé)** : `flinks-api.ts` action `sync_all` protégée par un secret partagé (`FLINKS_SYNC_SECRET`, lu depuis Supabase Vault, jamais commité) ; les cascades automatiques de réassignation de travailleur (`process_worker_response_timeouts()` et `handle-worker-response.ts`) filtrent maintenant par `worker_verification_status` (RBQ/assurance/actif) ; policy RLS `workers` resserrée (un propriétaire ne voit que les travailleurs déjà assignés à ses unités) ; ajout d'un toggle actif/inactif par travailleur ; **vérification de signature JWT réelle** dans les 13 fonctions admin-authentifiées (voir section ci-dessus, ne dépend plus uniquement du réglage plateforme).
- **Fonctionnel (corrigé)** : `invoice_number` généré via un compteur atomique (`next_invoice_number()`, upsert avec verrou de ligne) — plus de risque de collision lors de la génération concurrente des factures mensuelles.
- **Non corrigé** : pas d'interface pour les actions admin destructrices (ex. `delete_owner_completely`) ; 2FA non implémentée pour les comptes admin ; CI/CD et préproduction pas encore en place (déploiement manuel par copier-coller — voir roadmap 🔴).
- Fonctionnalités ajoutées depuis l'audit : Portail Copilot (Q&A financier), signature électronique des renouvellements de bail (`signer-bail.html` / `handle-lease-signature.ts`), fondation du moteur de règles Automations/Studio (`automation_rules`), SMS Portail Concierge via Twilio (`send-sms.ts`), monitoring minimum (`check_system_health()`, `health-check.ts`), sauvegardes automatiques (voir `BACKUPS.md`).
- Le domaine d'envoi de courriels (DNS Namecheap/Resend) était en cours de finalisation.

## Conventions de code à respecter

- Toujours écrire le SQL de façon idempotente (`if not exists`, `on conflict do nothing`) — le fichier doit rester rejouable en entier sur une base vide.
- `CREATE OR REPLACE VIEW` échoue si l'ordre/nom des colonnes change (ex: `worker_verification_status`, redéfinie 3 fois dans `schema.sql`) — utiliser `DROP VIEW` + `CREATE VIEW` dans ce cas.
- Les tables à données sensibles/commerciales (prospects, offres de job, évaluations) restent verrouillées service_role uniquement — ne pas ouvrir de policy RLS pour "simplifier" un accès frontend, passer par une edge function.
- Toute action irréversible ou financière déclenchée par l'IA doit rester une proposition validée par un humain, jamais une exécution automatique silencieuse.
