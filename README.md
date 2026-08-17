# Portail — Gestion immobilière (Québec)

SaaS de gestion immobilière résidentielle, construit sur Supabase (Postgres + Auth + Storage + Edge Functions) avec des IA intégrées (Claude/Anthropic) pour l'automatisation opérationnelle. Ce document sert de point d'entrée pour un développeur qui reprend le projet.

## ⚠️ Le plus important à savoir avant de toucher au code

**Il n'y a AUCUN pipeline de déploiement.** Le code de ce repo n'est PAS automatiquement synchronisé avec Supabase :

- Les **fichiers `.html`** (les 5 portails + pages publiques) se déploient automatiquement via **GitHub Pages** dès qu'un push atteint `main` — ça, c'est automatique.
- Les **fichiers `edge-function-*.ts`** sont des copies locales tenues à jour manuellement. Le vrai code qui tourne est celui collé dans **Supabase Dashboard → Edge Functions**. Après avoir modifié `edge-function-ops-api.ts` par exemple, il faut aller coller le nouveau contenu dans la fonction `ops-api` sur Supabase et déployer — sinon rien ne change en production.
- Le fichier **`schema.sql`** n'est PAS exécuté automatiquement non plus. C'est un script cumulatif (conçu pour être rejoué du début à la fin sur une base vide, ou juste ses nouvelles sections collées à la suite sur une base existante) qu'on colle dans **Supabase Dashboard → SQL Editor**. Il est écrit pour être idempotent (`create table if not exists`, `add column if not exists`, etc.) donc le rejouer au complet ne casse rien.

Une des prochaines priorités techniques (voir section Roadmap plus bas) devrait être de mettre en place un vrai pipeline (Supabase CLI + GitHub Actions) pour éliminer ce copier-coller manuel, qui est la plus grosse source d'erreur humaine du projet actuellement.

## Architecture

**Base de données** : un seul schéma Postgres central. Chaîne de données : `owners → buildings → units → leases → tenants → payments/expenses → service_requests → work_orders → workers → documents → audit_log`. RLS (Row Level Security) activé sur toutes les tables sensibles.

**Convention RLS** : deux styles cohabitent.
- Tables consultées directement par le navigateur (`owners`, `buildings`, `units`, `tenants`, `leases`, `payments`, `work_orders`, etc.) : policies scopées via des fonctions `security definer` (`auth_owner_id()`, `auth_tenant_id()`, `owned_unit_ids()`, `tenant_unit_ids()`, `auth_is_admin()`, définies vers la ligne 555 de `schema.sql`).
- Tables sensibles (`prospects`, `job_offers`, `worker_ratings`, `financial_anomalies`, `public_submission_log`, `ai_run_log`...) : RLS activé avec **zéro policy** — verrouillées au `service_role` uniquement. Tout accès passe obligatoirement par une edge function.

**Backend** : 34 Supabase Edge Functions (Deno/TypeScript), chacune un fichier `edge-function-<nom>.ts` à la racine — le nom de la fonction déployée sur Supabase est `<nom>` (sans le préfixe `edge-function-` ni le `.ts`). Deux familles :
- Fonctions **admin/rôle-authentifiées** (`ops-api`, `onboarding-api`, `admin-api`, `crm-api`, `caller-api`, `worker-api`, `privacy-api`, `parse-expense-receipt`...) : décodent le JWT du header `Authorization` (base64, sans vérification de signature côté fonction — repose sur le réglage `verify_jwt` de Supabase), vérifient `users.is_admin` (ou l'équivalent propriétaire/locataire/travailleur) via une requête `service_role`, puis exécutent l'action demandée (`body.action`).
- Fonctions **publiques** (`handle-public-inquiry`, `handle-worker-registration`, `handle-mandat-inquiry`...) : pas de JWT requis, protégées par un honeypot (champ caché `website`) + limite de débit par IP (table `public_submission_log`).
- Fonctions **système/cron** (`handle-payment-reminder`, `handle-worker-job-assigned`, `generate-owner-report`, `send-onboarding-reminder`...) : déclenchées par des `cron.schedule(...)` définis dans `schema.sql` via `pg_net`.

**Frontend** : 12 fichiers HTML statiques (vanilla JS, aucun framework/bundler) à la racine :
- `portail-admin.html` — interne, accès complet
- `portail-proprietaire.html`, `portail-locataire.html`, `portail-cold-caller.html`, `portail-travailleur.html` — un portail par rôle, connectés via Supabase Auth (client JS direct + RLS pour la plupart des lectures/écritures)
- `index.html`, `pro.html`, `formulaires-gestion-immobiliere.html` — pages publiques
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

## État connu du projet (à la dernière session — 2026-08-14)

Un audit de sécurité/fonctionnel (2026-08-05) avait identifié plusieurs points, **tous corrigés et déployés depuis** :
- **Sécurité (corrigé)** : `flinks-api.ts` action `sync_all` protégée par un secret partagé (`FLINKS_SYNC_SECRET`, lu depuis Supabase Vault, jamais commité) ; les cascades automatiques de réassignation de travailleur (`process_worker_response_timeouts()` et `handle-worker-response.ts`) filtrent maintenant par `worker_verification_status` (RBQ/assurance/actif) ; policy RLS `workers` resserrée (un propriétaire ne voit que les travailleurs déjà assignés à ses unités) ; ajout d'un toggle actif/inactif par travailleur.
- **Fonctionnel (corrigé)** : `invoice_number` généré via un compteur atomique (`next_invoice_number()`, upsert avec verrou de ligne) — plus de risque de collision lors de la génération concurrente des factures mensuelles.
- **Non corrigé** : aucune fonction edge ne vérifie elle-même la signature JWT — repose sur le réglage "Verify JWT" de Supabase Dashboard (à confirmer manuellement pour chaque fonction admin) ; pas d'interface pour les actions admin destructrices (ex. `delete_owner_completely`).
- Fonctionnalités ajoutées depuis l'audit : Portail Copilot (Q&A financier), signature électronique des renouvellements de bail (`signer-bail.html` / `handle-lease-signature.ts`), fondation du moteur de règles Automations/Studio (`automation_rules`), SMS Portail Concierge via Twilio (`send-sms.ts`, avec repli automatique par courriel tant qu'aucun compte Twilio n'est branché).
- Le domaine d'envoi de courriels (DNS Namecheap/Resend) était en cours de finalisation.

## Conventions de code à respecter

- Toujours écrire le SQL de façon idempotente (`if not exists`, `on conflict do nothing`) — le fichier doit rester rejouable en entier sur une base vide.
- `CREATE OR REPLACE VIEW` échoue si l'ordre/nom des colonnes change (ex: `worker_verification_status`, redéfinie 3 fois dans `schema.sql`) — utiliser `DROP VIEW` + `CREATE VIEW` dans ce cas.
- Les tables à données sensibles/commerciales (prospects, offres de job, évaluations) restent verrouillées service_role uniquement — ne pas ouvrir de policy RLS pour "simplifier" un accès frontend, passer par une edge function.
- Toute action irréversible ou financière déclenchée par l'IA doit rester une proposition validée par un humain, jamais une exécution automatique silencieuse.
