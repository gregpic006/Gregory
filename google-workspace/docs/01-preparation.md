# 01 — La préparation (une seule fois)

Ce document couvre les manipulations que **Google oblige à faire à la main**, dans son interface
web. Elles ne se font qu'**une seule fois**. Une fois terminées, la trousse fait le reste toute
seule, autant de fois que tu veux.

Compte **de 40 minutes à 1 heure**, café inclus. Prends-les d'un coup : c'est plus court que de
revenir dedans trois fois.

**Ce qu'il te faut avant de commencer :**

- Ton compte super-administrateur du domaine (par exemple `greg@portailgestion.ca`).
  **Pas** ton adresse `@gmail.com` : elle ne peut pas ouvrir la console d'administration.
- Node.js version 20 ou plus récent. Pour vérifier : ouvre un terminal et tape `node --version`.
  Si ça répond `v20.x` ou mieux, c'est bon. Sinon, installe-le depuis <https://nodejs.org>
  (prends la version « LTS »).

---

## Étape 1 — Créer le projet Google Cloud

Un « projet » Google Cloud, c'est juste un contenant qui te donne le droit d'appeler les API de
Google par programme. Il est **gratuit** pour ce qu'on en fait ici — aucune carte de crédit n'est
demandée, aucune facturation n'est activée.

1. Va sur **<https://console.cloud.google.com/projectcreate>**
2. Connecte-toi avec ton compte **du domaine** (`greg@portailgestion.ca`), pas avec le `@gmail.com`.
   > Si Google t'ouvre le mauvais compte : clique sur ta photo en haut à droite >
   > **Ajouter un compte**, puis connecte-toi avec l'adresse du domaine.
3. **Nom du projet** : tape `Portail Workspace`
4. **Emplacement** : laisse la valeur proposée (ce sera ton organisation, `portailgestion.ca`).
5. Clique **Créer**.
6. Attends une dizaine de secondes, puis **vérifie en haut de l'écran, dans la barre bleue, que le
   sélecteur de projet affiche bien « Portail Workspace »**. S'il affiche autre chose, clique
   dessus et choisis ton nouveau projet.

> **Le piège classique** : activer les API dans le mauvais projet. Chaque fois que tu ouvres un
> lien de l'étape 2, vérifie le nom du projet dans la barre bleue en haut.

---

## Étape 2 — Activer les 4 API

Une API désactivée, c'est un mur : la trousse recevra une erreur `accessNotConfigured` et
s'arrêtera. Il en faut quatre.

Ouvre chacun de ces liens, **vérifie le projet dans la barre bleue**, puis clique le bouton bleu
**Activer** (ou **Enable**). Si le bouton affiche déjà **Gérer**, c'est que l'API est active :
passe à la suivante.

| # | API | Lien direct |
|---|-----|-------------|
| 1 | Admin SDK API | <https://console.cloud.google.com/apis/library/admin.googleapis.com> |
| 2 | Google Calendar API | <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com> |
| 3 | Google Drive API | <https://console.cloud.google.com/apis/library/drive.googleapis.com> |
| 4 | Groups Settings API | <https://console.cloud.google.com/apis/library/groupssettings.googleapis.com> |

> **À savoir** : le nom technique de l'API Agenda est bel et bien
> `calendar-json.googleapis.com`, avec le `-json`. Si tu cherches `calendar.googleapis.com` à la
> main dans la bibliothèque, tu ne trouveras rien. Utilise le lien du tableau.

Chaque activation prend de 10 à 30 secondes. Ne ferme pas l'onglet avant que le bouton ne se
change en **Gérer**.

---

## Étape 3 — Choisir ton chemin d'authentification

Il faut maintenant donner à la trousse le droit d'agir sur ton Workspace. Il y a deux façons.
**Lis cette section au complet avant de choisir** : revenir en arrière coûte 20 minutes.

### Ma recommandation, franchement : le chemin A (OAuth)

**Pour ton cas — une PME de 4 personnes, un propriétaire qui lance la trousse lui-même — prends le
chemin A.** Trois raisons :

1. **Google bloque de plus en plus la création de clés de compte de service.** Sur les
   organisations créées récemment, une règle de sécurité activée par défaut
   (`iam.managed.disableServiceAccountKeyCreation`) empêche carrément de télécharger le fichier de
   clé du chemin B. La désactiver affaiblit tout ton domaine. Ça ne vaut pas la peine.
2. **Aucune clé privée ne traîne sur ton disque.** Une clé de compte de service, c'est un
   passe-partout de ton domaine en clair dans un fichier, sans deuxième facteur possible. Si elle
   fuit, tout le domaine fuit. Le chemin A n'en crée aucune.
3. **C'est moins d'étapes.** Pas de délégation à configurer, pas d'identifiant à 21 chiffres à
   coller, pas de liste de portées à faire correspondre caractère par caractère.

**Ce que le chemin A coûte, dit franchement :** en OAuth, la trousse agit **en ton nom**, et ne
peut donc pas agir au nom des autres. Conséquence concrète et unique : elle ne peut pas glisser le
calendrier d'équipe directement dans le Google Agenda de tes trois coéquipiers. Ils recevront un
**courriel de partage** et devront cliquer **une fois** dessus. C'est tout. Une minute par
personne, une seule fois.

Si ce clic te dérange vraiment, ou si tu veux un jour faire tourner la trousse automatiquement la
nuit sans humain devant l'écran, prends le chemin B.

| | Chemin A — OAuth | Chemin B — Compte de service |
|---|---|---|
| Clé privée sur le disque | Non | Oui |
| Temps de mise en place | 10-15 min | 25-35 min |
| Peut être bloqué par Google | Non | Oui (nouvelles organisations) |
| Ajoute le calendrier tout seul chez les coéquipiers | Non (1 clic chacun) | Oui |
| Peut tourner sans humain | Non | Oui |

---

## Chemin A — OAuth « Application de bureau » (recommandé)

### A.1 — Configurer l'écran de consentement en « Interne »

1. Va sur **<https://console.cloud.google.com/auth/overview>**
   (chemin manuel : menu ☰ > **API et services** > **Écran de consentement OAuth**)
2. Vérifie le projet dans la barre bleue.
3. Clique **Commencer** (ou **Get started**).
4. **Nom de l'application** : `Trousse Portail`
5. **Adresse e-mail d'assistance** : choisis ton adresse du domaine dans la liste déroulante.
6. Clique **Suivant**.
7. **Public cible** (Audience) : coche **Interne** (*Internal*). **C'est le réglage décisif.**
8. Clique **Suivant**.
9. **Coordonnées** : remets ton adresse du domaine. **Suivant**.
10. Coche la case d'acceptation des règles, puis **Créer**.

> **Pourquoi « Interne » et pas « Externe » ?** Deux raisons qui comptent :
> - Aucune vérification de Google à subir, même pour les accès sensibles à Drive et à l'annuaire.
> - **Ton jeton n'expire jamais.** Une application « Externe » laissée en mode test voit son accès
>   expirer au bout de **7 jours** : tu devrais te reconnecter chaque semaine. C'est l'erreur la
>   plus fréquente, et la plus fatigante.
>
> Si l'option « Interne » est grisée, c'est que tu es connecté avec ton `@gmail.com` et non avec
> l'adresse du domaine. Reprends à l'étape 2 avec le bon compte.

### A.2 — Créer le client OAuth

1. Va sur **<https://console.cloud.google.com/auth/clients>**
   (chemin manuel : menu ☰ > **API et services** > **Identifiants**)
2. Clique **+ Créer un client** (ou **+ Create credentials** > **ID client OAuth**).
3. **Type d'application** : choisis **Application de bureau** (*Desktop app*).
4. **Nom** : `Trousse Portail`
5. Clique **Créer**.

> **Aucune URL de redirection à saisir.** C'est normal, et c'est même l'avantage du type
> « Application de bureau » : Google accepte automatiquement `http://127.0.0.1` sur n'importe quel
> port. Si l'interface te réclame une URL de redirection, c'est que tu as choisi « Application
> Web » par erreur — recommence en choisissant « Application de bureau ».

### A.3 — Télécharger le fichier et le mettre à la bonne place

1. Dans la fenêtre qui s'ouvre, clique **Télécharger le fichier JSON**.
   (Si tu as fermé la fenêtre : dans la liste des clients, clique l'icône de téléchargement ⭳ au
   bout de la ligne.)
2. Le fichier s'appelle quelque chose comme `client_secret_1234-abcd.apps.googleusercontent.com.json`.
3. **Renomme-le `oauth-client.json`** et dépose-le **à la racine du dossier `google-workspace`**,
   juste à côté de `package.json`.

Ton dossier doit ressembler à ça :

```
google-workspace/
├── oauth-client.json      <- le fichier que tu viens de déposer
├── config.json            <- tu le créeras à l'étape suivante
├── package.json
└── src/
```

4. Dans `config.json`, la section `auth` doit se lire :

```json
"auth": {
  "mode": "oauth",
  "oauthClientFile": "./oauth-client.json",
  "tokenFile": "./.tokens.json"
}
```

> Le modèle `config.example.json` est livré avec `"mode": "service-account"`.
> **Si tu suis le chemin A, change-le pour `"oauth"`.** C'est l'oubli numéro un.

### A.4 — La connexion, une seule fois

Au premier lancement de `node src/cli.mjs doctor`, la trousse ouvre ton navigateur. Tu te connectes
avec ton compte du domaine, tu acceptes, et c'est fini. Le jeton est enregistré dans `.tokens.json`
(gitignoré, permissions `600`). **Les fois suivantes, il n'y a plus rien à faire.**

Le chemin A est terminé. Saute la section suivante et va directement à l'**étape 4**.

---

## Chemin B — Compte de service + délégation à l'échelle du domaine

À ne suivre que si tu veux que la trousse puisse tourner sans humain, ou qu'elle ajoute le
calendrier directement dans l'Agenda de chaque coéquipier.

### B.1 — Créer le compte de service

1. Va sur **<https://console.cloud.google.com/iam-admin/serviceaccounts>**
2. Vérifie le projet dans la barre bleue.
3. Clique **+ Créer un compte de service**.
4. **Nom** : `trousse-portail`. L'identifiant se remplit tout seul.
5. Clique **Créer et continuer**.
6. **Accorder à ce compte de service l'accès au projet** : **ne mets rien**, clique **Continuer**.
   > Ce n'est pas un oubli. Un compte de service n'a besoin d'**aucun rôle** pour ces API-là :
   > les rôles servent aux ressources Google Cloud, pas à Workspace. Son seul pouvoir viendra de
   > la délégation de l'étape B.3.
7. Clique **OK** (ou **Terminé**).

### B.2 — Créer la clé JSON

1. Dans la liste, clique sur le compte de service `trousse-portail` que tu viens de créer.
2. Onglet **Clés** (*Keys*).
3. **Ajouter une clé** > **Créer une clé**.
4. Type : **JSON**. Clique **Créer**.
5. Le fichier se télécharge tout seul. **Renomme-le `service-account.json`** et dépose-le à la
   racine du dossier `google-workspace`.

> **Si Google refuse et affiche une erreur du genre « La création de clés de compte de service est
> désactivée » ou « constraints/iam.managed.disableServiceAccountKeyCreation » :** c'est la
> protection dont je parlais plus haut. **Ne la désactive pas.** Reviens au chemin A, il est fait
> pour ce cas exact.

### B.3 — Récupérer l'identifiant client (21 chiffres)

1. Toujours sur la page du compte de service, onglet **Détails**.
2. Repère le champ **ID unique** (*Unique ID*) : un nombre à **21 chiffres**, du genre
   `109876543210987654321`.
3. Copie-le.

> **Le piège numéro un de toute cette procédure** : coller
> `trousse-portail@...iam.gserviceaccount.com` (le courriel) au lieu du nombre à 21 chiffres.
> La console d'administration **n'accepte que le nombre**. Le courriel donnera un refus
> `unauthorized_client` sans autre explication.
>
> Tu retrouves aussi ce nombre dans le fichier `service-account.json`, au champ `"client_id"`.

### B.4 — Autoriser la délégation à l'échelle du domaine

C'est ici qu'on donne réellement les pouvoirs. Ça se passe dans la **console d'administration
Workspace** (`admin.google.com`), pas dans Google Cloud.

**Lien direct : <https://admin.google.com/ac/owl/domainwidedelegation>**

Chemin manuel, si tu préfères naviguer :

> **admin.google.com** > menu ☰ > **Sécurité** > **Contrôle des accès et des données** >
> **Commandes des API** > volet **Délégation à l'échelle du domaine** >
> **Gérer la délégation à l'échelle du domaine** > **Ajouter**

> **Une précision, parce que la confusion est répandue :** on lit souvent que ce réglage « a été
> déplacé ». En réalité il est **toujours au même endroit** — celui ci-dessus, vérifié en 2026. Ce
> que Google a bel et bien retiré, en 2022, c'est une **autre** page qui s'appelait « Manage OAuth
> Client Access » (la liste blanche d'applications). C'est de là que vient le malentendu. Si un
> vieux tutoriel t'envoie ailleurs, ignore-le et prends le lien direct.

Une fois sur la page :

1. Clique **Ajouter**.
2. **ID client** : colle le nombre à **21 chiffres** de l'étape B.3.
3. **Champs d'application OAuth** : colle **exactement** cette ligne, d'un seul bloc :

```
https://www.googleapis.com/auth/admin.directory.user,https://www.googleapis.com/auth/admin.directory.group,https://www.googleapis.com/auth/admin.directory.group.member,https://www.googleapis.com/auth/apps.groups.settings,https://www.googleapis.com/auth/calendar,https://www.googleapis.com/auth/drive
```

4. Clique **Autoriser**.

> **Trois choses à savoir sur cette liste :**
>
> - **La correspondance est exacte, caractère par caractère.** Une portée en trop, une portée en
>   moins, ou une version `.readonly` à la place de la normale, et Google refuse **tout** avec
>   `unauthorized_client`. Copie-colle la ligne ci-dessus, ne la retape pas.
> - **Compte la ponctuation** : séparées par des virgules, **sans espace**, sur une seule ligne.
> - **Sur certains domaines, ton ajout restera « en attente »** tant qu'un **deuxième
>   super-administrateur** ne l'aura pas approuvé (c'est une protection de Google appelée
>   « approbation multipartite », active depuis 2024). Ce n'est pas un bogue.

5. **Attends de 1 à 10 minutes.** La délégation met du temps à se propager chez Google. Un échec
   dans les deux premières minutes est normal — reprends un café et relance `doctor`.

### B.5 — La configuration

Dans `config.json` :

```json
"auth": {
  "mode": "service-account",
  "keyFile": "./service-account.json"
}
```

Et vérifie que `adminEmail` contient bien une adresse **super-administratrice** de ton domaine :
c'est l'identité que le compte de service va emprunter.

> **Le compte emprunté doit s'être connecté au moins une fois** et avoir accepté les conditions
> d'utilisation de Google. Un compte tout neuf, jamais ouvert, ne peut pas être emprunté : tu
> recevrais une erreur `invalid_grant`.

---

## Étape 4 — Vérifier que tout est en place

C'est la récompense. Une seule commande te dit si les trois dernières étapes ont fonctionné :

```bash
npm install
node src/cli.mjs doctor
```

`doctor` passe **cinq contrôles** dans l'ordre et s'arrête au premier qui échoue :

| # | Contrôle | Ce qu'il attrape |
|---|----------|------------------|
| 1 | Le fichier de configuration | `config.json` absent, mal formé, champ oublié |
| 2 | Le fichier d'identifiants | `oauth-client.json` ou `service-account.json` absent ou illisible |
| 3 | L'obtention d'un jeton | Délégation mal configurée, portées qui ne correspondent pas, horloge décalée |
| 4 | Chaque API répond-elle vraiment ? | Une des 4 API de l'étape 2 pas activée |
| 5 | Le compte emprunté est-il super-administrateur ? | `adminEmail` sans les droits nécessaires |

Quand un contrôle échoue, `doctor` ne dit pas juste « erreur » : il te donne **le lien à cliquer et
le texte exact à coller**. Suis-le à la lettre, relance, et continue.

Quand les cinq contrôles passent, la préparation est finie **pour toujours**.

**➜ La suite : [02-execution.md](02-execution.md)**
