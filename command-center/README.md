# Lease Lane — Command Center

Le Master Task Board vivant : les 67 tâches du lancement du 1<sup>er</sup> octobre 2026,
connectées aux comptes Google de l'équipe. Les courriels sont lus et triés, les documents
classés, les rendez-vous proposés — et les cinq personnes voient la même chose, en même temps.

**Projet à part entière.** Sa propre base Supabase, ses propres secrets, son propre pipeline
de déploiement. Il ne partage rien avec le Portail (l'application de gestion immobilière à la
racine du dépôt) à part le dépôt Git et le nom de domaine.

---

## Ce que ça fait

| | |
|---|---|
| **Le tableau** | 67 tâches (LL-001 → LL-067), 69 dépendances résolues, 8 portes de lancement, 12 décisions/risques, l'ordre du jour de la réunion du dimanche et 15 KPI — importés sans perte du fichier Excel. |
| **Temps réel** | Une modification chez quelqu'un apparaît chez les autres en moins d'une seconde, sans rafraîchir. |
| **Courriels** | Les 4 boîtes sont lues aux 5 minutes. Chaque message est classé (catégorie, urgence), résumé, et rattaché à la tâche qu'il concerne. |
| **Documents** | Les fichiers Drive modifiés sont résumés et classés sur la bonne tâche. |
| **Agenda** | Vue unifiée des 4 agendas. Recherche de créneau commun via la disponibilité réelle de Google, puis réservation avec invitation. |
| **Actions** | L'IA propose des actions typées ; une table décide si elles partent seules ou attendent un clic. |
| **Réunion** | Le dimanche matin, le dossier de la réunion de 45 min est préparé : état, risque principal, 3 priorités par personne, décisions à prendre. |

### La règle d'automatisation

Chaque type d'action a un mode réglable dans l'interface (onglet **Équipe & réglages**) :

- **Automatique** — l'IA agit seule. Réservé au réversible et à l'interne : rattacher un
  courriel à une tâche, ajouter une note, passer une tâche en « en cours », préparer un
  brouillon, bloquer un créneau interne.
- **Approbation** — l'IA propose, quelqu'un clique. Par défaut pour tout ce qui sort de
  l'entreprise (envoyer un courriel, fixer un rendez-vous avec un externe, déplacer le
  rendez-vous de quelqu'un) et pour ce qui engage le plan (créer une tâche, changer une
  échéance, clore une tâche).
- **Éteint** — l'IA n'y touche pas.

C'est la table `automation_policies` qui tranche, jamais le modèle. Un changement de
comportement du modèle ne peut donc pas transformer une proposition en courriel envoyé.
Deux garde-fous sont en dur, indépendamment du réglage : l'IA ne peut pas marquer une tâche
« terminée » par le chemin automatique, et approuver une proposition exécute l'action dans le
même appel — il n'existe pas d'état « approuvé mais jamais fait ».

---

## Mise en route

Environ 45 minutes, une seule fois. Les étapes 1 à 3 doivent être faites dans l'ordre.

### 1. Créer le projet Supabase

Nouveau projet (l'offre gratuite suffit pour démarrer), **distinct** de celui du Portail.
Nomme-le `leaselane-command-center` pour éviter toute confusion.

Note trois valeurs — Project Settings → API et Database :
- `Project URL` → `https://<ref>.supabase.co`
- clé `anon public`
- le mot de passe de la base choisi à la création

Puis **Database → Extensions** : active `pg_cron` et `pg_net`. Sans elles, rien ne se
synchronise (les migrations le signalent au lieu d'échouer, mais le système reste inerte).

### 2. Autoriser l'accès Google

**Google Cloud Console**, sur le projet lié au Workspace Lease Lane :

1. **APIs & Services → Library** : active **Gmail API**, **Google Calendar API**, **Google Drive API**.
2. **OAuth consent screen** : choisis **Internal**.
   > C'est le point important. Les autorisations demandées (lecture des courriels, agenda,
   > documents) sont classées sensibles par Google : une application **External** exige une
   > vérification qui prend des semaines. En **Internal**, l'application ne sert que les
   > comptes du Workspace Lease Lane — aucune vérification, disponible immédiatement.
   > Si les 4 comptes ne sont pas dans un Workspace mais sont des comptes Gmail personnels,
   > il faut passer en External + mode Test et ajouter les 4 adresses comme testeurs
   > (les jetons expirent alors tous les 7 jours — à savoir avant de choisir cette voie).
3. **Credentials → Create OAuth client ID → Web application**. Ajoute comme
   *Authorized redirect URI* : `https://<ref>.supabase.co/auth/v1/callback`.
4. Note le **Client ID** et le **Client secret**.

**Supabase → Authentication → Providers → Google** : active, colle le Client ID et le Client
secret, enregistre.

**Authentication → URL Configuration** : mets `https://portailgestion.ca` comme *Site URL*, et
ajoute `https://portailgestion.ca/command-center/` aux *Redirect URLs*.

### 3. Secrets des edge functions

Génère d'abord deux valeurs aléatoires :

```bash
openssl rand -base64 32   # → CC_TOKEN_KEY   (32 octets, sert à chiffrer les jetons Google)
openssl rand -hex 32      # → CC_CRON_SECRET (protège les fonctions déclenchées par cron)
```

**Supabase → Edge Functions → Secrets**, ajoute :

```
ANTHROPIC_API_KEY      la clé Anthropic (peut être la même que celle du Portail)
GOOGLE_CLIENT_ID       celui de l'étape 2
GOOGLE_CLIENT_SECRET   celui de l'étape 2
CC_TOKEN_KEY           la valeur base64 générée ci-dessus
CC_CRON_SECRET         la valeur hex générée ci-dessus
```

`SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont fournis automatiquement par Supabase.

> **`CC_TOKEN_KEY` n'est pas récupérable.** Elle chiffre les jetons Google. La perdre oblige
> les 4 personnes à reconnecter leur compte. Garde-la avec les autres secrets de l'entreprise.

### 4. Secrets GitHub (déploiement automatique)

Dépôt → Settings → Secrets and variables → Actions :

```
CC_SUPABASE_ACCESS_TOKEN   Supabase → compte (haut à droite) → Access Tokens
CC_SUPABASE_PROJECT_REF    la <ref> du projet Command Center
CC_SUPABASE_DB_PASSWORD    le mot de passe de la base (étape 1)
```

Tant que `CC_SUPABASE_PROJECT_REF` est absent, le workflow s'arrête proprement avec un
avertissement au lieu d'échouer en rouge à chaque push.

### 5. Brancher les tâches planifiées

Dans **SQL Editor** du projet Command Center :

```sql
select vault.create_secret('<ta valeur CC_CRON_SECRET>', 'cc_cron_secret');

insert into app_settings (key, value)
values ('functions_base_url', '"https://<ref>.supabase.co/functions/v1"')
on conflict (key) do update set value = excluded.value;
```

Ces deux valeurs sont relues à **chaque** exécution, pas au moment où la tâche est créée :
tu peux donc les poser après le déploiement, les tâches se mettront à fonctionner au tic
suivant. En revanche `pg_cron` et `pg_net` doivent exister **avant** le premier déploiement,
sinon aucune tâche n'est créée — dans ce cas, rejoue
`supabase/migrations/20260904120300_cron.sql` dans le SQL Editor.

Vérification : `select jobname, schedule from cron.job;` doit lister 4 tâches.

### 6. Configurer l'interface

Dans `command-center/config.js`, remplace les deux valeurs par le `Project URL` et la clé
`anon public` de l'étape 1. Pousse sur `main`.

L'interface est alors servie par GitHub Pages à
**https://portailgestion.ca/command-center/** — aucun hébergement supplémentaire.

### 7. Première connexion

Va sur l'adresse ci-dessus et clique **Continuer avec Google**. L'adresse
`greg.picard.2003@gmail.com` est déjà déclarée comme administrateur dans les données
initiales : c'est ce compte qui ouvre la porte aux autres.

Ensuite, onglet **Équipe & réglages** → « + adresse » pour chacun des 4 autres. Dès qu'une
adresse est déclarée, la personne clique sur le même bouton Google et son compte se rattache
tout seul. Elle n'a rien d'autre à faire — pas de mot de passe, pas d'invitation à accepter.

> Ajoute l'adresse **Lease Lane** de Greg en plus de son Gmail personnel : c'est le compte
> Lease Lane qui doit être connecté pour que ses courriels professionnels soient lus.

---

## Comment c'est fait

```
command-center/
  index.html  config.js  app.js        interface (JS natif, aucun cadriciel — comme le Portail)
  supabase/
    config.toml                        verify_jwt par fonction
    migrations/
      …120000_schema.sql               23 tables
      …120100_functions_rls.sql        fonctions d'accès, triggers, 5 vues, RLS, temps réel
      …120200_seed_board.sql           le contenu du fichier Excel
      …120300_cron.sql                 4 tâches planifiées
    functions/
      _shared/cc.ts                    CORS, jetons, chiffrement, Google, Anthropic
      _shared/google.ts                Gmail (MIME), Agenda, Drive
      _shared/actions.ts               exécution des actions + politique
      cc-board-api/                    session, équipe, réglages, déclencheurs
      cc-link-google/                  rattachement d'un compte Google
      cc-google-sync/                  cron 5 min — rapatrie
      cc-ai-triage/                    cron 10 min — lit, classe, agit
      cc-apply-suggestion/             le clic humain
      cc-agenda-api/                   créneaux et rendez-vous
      cc-digest/                       point du matin, dossier du dimanche
      cc-health/                       état, pour un moniteur externe
  tests/                               chiffrement, décodage Gmail, interface
```

### Accès et sécurité

- **Connexion Google uniquement.** Le même clic ouvre la session et accorde l'accès
  courriel/agenda/documents (`access_type=offline` + `prompt=consent`, sinon l'accès
  expirerait en une heure).
- **La porte est fermée par défaut.** Une adresse absente de `member_emails` obtient un jeton
  Supabase valide mais aucune ligne `members` — et le RLS ne lui montre rien. La tentative est
  journalisée.
- **Tout le monde voit tout et peut tout modifier** sur le tableau : c'est une équipe de cinq,
  pas un ERP. Seules les suppressions et la configuration sont réservées aux admins.
- **Les jetons Google ne sont jamais lisibles depuis un navigateur.** `google_accounts` a le
  RLS activé et **aucune** policy (verrouillée au `service_role`), et les jetons y sont en
  plus chiffrés en AES-GCM avec `CC_TOKEN_KEY` — un export de la base ne suffit pas.
- **Vérification du jeton en code** (`requireMember`), pas via le réglage plateforme
  `verify_jwt` — même bug ES256 que sur le Portail, même contournement.
- **Visibilité des boîtes courriel** réglable : `all` (défaut, ce qui a été demandé) ou `own`
  — dans ce cas chacun ne voit que sa boîte, mais les résumés IA restent partagés.

### Coût

Le tri utilise `claude-opus-5` par défaut. Pour un volume élevé de courriels, c'est le poste
de dépense principal. Deux leviers, sans toucher au code :

- **Modèle** : onglet Équipe & réglages → *Modèle IA*. `claude-sonnet-5` coûte nettement moins
  cher pour du tri de courriels ; le dossier du dimanche, lui, reste sur un raisonnement
  approfondi (`effort: high`) parce que c'est lui qui oriente la semaine de cinq personnes.
- **Volume** : `triage_batch_size` dans `app_settings` (8 courriels par passe par défaut).

Le contexte du tableau (les 67 tâches, l'équipe, l'agenda) est marqué en cache Anthropic : il
est identique d'un courriel à l'autre et n'est donc facturé plein tarif qu'une fois par passe.

### Ce qui n'est pas fait

- **PDF et documents scannés** : listés et nommés, mais non analysés. Le texte n'en est pas
  extrait (`ai_status = 'skipped'`) — mieux vaut un document non résumé qu'un résumé inventé
  à partir du nom de fichier.
- **Pièces jointes de courriels** : le fait qu'il y en ait est détecté, leur contenu n'est pas
  téléchargé. Seuls les fichiers Drive sont lus.
- **Historique courriel** : à la première connexion, seuls les 14 derniers jours sont
  rapatriés. Remonter plus loin coûterait des milliers d'appels pour du contexte périmé.
- **KPI hebdomadaires** : les 15 indicateurs sont définis et affichés, mais la saisie des
  valeurs semaine par semaine n'a pas d'écran dédié (la table `kpi_values` existe).
- **Préproduction** : comme pour le Portail, il n'y en a pas encore. Les migrations partent
  d'une base propre, donc `db push` est fiable ; mais un changement de schéma va directement
  en production.

---

## Tests

```bash
# Chiffrement des jetons et secret de cron
deno run --allow-env --allow-read --allow-net command-center/tests/crypto_test.ts

# Décodage des courriels Gmail (base64url, arbres MIME, accents, HTML)
deno run --allow-env --allow-read --allow-net command-center/tests/gmail_test.ts

# Interface : rendu des 9 vues, interactions, échappement HTML
npm install playwright && npx playwright install chromium
node command-center/tests/ui_test.mjs

# Heures ouvrables et fuseau horaire (à lancer sous un fuseau différent,
# c'est justement ce que le calcul doit encaisser)
TZ=Asia/Tokyo deno run command-center/tests/slots_test.ts

# Types des edge functions
cd command-center/supabase/functions && for f in cc-*/index.ts; do deno check "$f"; done
```

Les migrations ont été validées sur PostgreSQL 16 : application sur base vierge, puis rejeu
complet sans doublon ni erreur, et vérification que les compteurs correspondent exactement au
fichier Excel d'origine (Greg 13/15, Xav 7/7, Andy 8/11, Eliot 14/14, Steven 19/20).

## Dépannage

| Symptôme | Cause probable |
|---|---|
| « Ce compte Google n'est rattaché à aucun membre » | L'adresse n'est pas dans `member_emails`. Un admin l'ajoute dans Équipe & réglages. |
| Compte marqué `needs_reauth` | Google a révoqué l'accès, ou des autorisations ont été refusées. La personne se reconnecte. |
| Aucun courriel n'arrive | Vérifie `select jobname from cron.job;` (étape 5), puis `select * from sync_state;` pour l'erreur exacte. |
| Rien ne se met à jour en temps réel | La publication `supabase_realtime` doit contenir les tables — c'est fait par la migration RLS ; vérifie que celle-ci a bien été appliquée. |
| Les propositions s'accumulent | Normal si tout est en mode « Approbation ». Ajuste dans Équipe & réglages. |
| `cc-health` répond 503 | Ouvre `https://<ref>.supabase.co/functions/v1/cc-health` : la réponse nomme le contrôle en échec. |
