# Trousse Google Workspace — Portail

Cette trousse monte ton Google Workspace au complet, toute seule : le **groupe d'équipe**, les
**calendriers partagés** et le **Drive partagé** avec son arborescence de dossiers et son mode
d'emploi. Elle est **idempotente** : tu peux la relancer dix fois, elle ne créera jamais de doublon,
elle vérifie toujours avant de créer.

**Ce qu'elle ne fait JAMAIS** : elle ne touche pas à ton « Mon Drive » personnel. Elle ne lit pas,
ne liste pas, ne déplace pas et ne partage pas tes documents existants. Une garde dans le code refuse
d'agir sur tout fichier qui n'est pas dans le Drive partagé qu'elle vient de créer. Elle ne supprime
rien non plus, et **par défaut elle ne modifie rien du tout** : il faut ajouter `--apply` pour que
quoi que ce soit parte chez Google.

---

## Ce que tu as à faire, toi

C'est la section importante. Voici **tout** le travail manuel qui reste, sans rien cacher.
Le reste — créer le groupe, les calendriers, le Drive, les dossiers, les accès — c'est la trousse
qui le fait.

### Une seule fois, avant de partir la machine

| # | À faire | Où | Temps |
|---|---------|-----|-------|
| 1 | Créer un projet Google Cloud | console.cloud.google.com | 5 min |
| 2 | Activer 4 API (4 clics sur 4 liens directs fournis) | console.cloud.google.com | 5 min |
| 3 | Configurer l'écran de consentement en « Interne » et créer un client OAuth « Application de bureau », puis télécharger le fichier `oauth-client.json` | console.cloud.google.com | 10-15 min |
| 4 | Installer Node.js si ce n'est pas déjà fait | nodejs.org | 5-10 min |
| 5 | Remplir `config.json` (noms, adresses, dossiers) | ton éditeur de texte | 10-15 min |
| 6 | Te connecter **une fois** dans le navigateur quand la trousse te le demande | ton navigateur | 2 min |

**Sous-total : de 40 minutes à 1 heure.** Une seule fois dans la vie du compte.

> Tout ça est détaillé clic par clic dans **[docs/01-preparation.md](docs/01-preparation.md)** et
> **[docs/02-execution.md](docs/02-execution.md)**. Tu n'as rien à deviner.

### Ensuite, à chaque lancement

| # | À faire | Temps |
|---|---------|-------|
| 7 | Lancer les commandes (voir « Le chemin rapide » ci-dessous) | 10 min |
| 8 | Lire le plan affiché en simulation, et dire oui | 5 min |

### Le travail que Google ne laisse à personne d'autre que toi

Ces points-là, **aucune API n'y donne accès** : ni cette trousse, ni aucun autre logiciel. C'est
manuel chez tout le monde, et c'est normal.

| # | À faire | Temps |
|---|---------|-------|
| 9 | Créer un **deuxième super-administrateur** et générer les codes de secours (filet de sécurité obligatoire avant de toucher à l'adresse Gmail) | 15 min |
| 10 | Changer les **contacts de facturation** et les utilisateurs du profil de paiement | 15-20 min |
| 11 | Vérifier le champ **Administrateur principal** et les préférences de communication | 5 min |
| 12 | Si tu es en mode OAuth : chaque coéquipier clique **une fois** sur le courriel de partage du calendrier | 2 min par personne |

**Sous-total : de 35 à 40 minutes**, et c'est expliqué au complet dans
**[docs/04-adresse-gmail.md](docs/04-adresse-gmail.md)** — avec les précautions à prendre pour ne
pas te barrer dehors de ton propre Workspace.

### Total honnête

**Environ 1 h 30 à 2 h**, étalées sur deux séances si tu veux. Après ça, la trousse se relance en
30 secondes chaque fois que tu ajoutes quelqu'un dans l'équipe ou un dossier dans le Drive.

---

## Le chemin rapide

Dans l'ordre, une commande à la fois. Tu es dans le dossier `google-workspace`.

```bash
# 0. Une seule fois : installer les dépendances
npm install

# 1. Une seule fois : créer ta configuration à partir du modèle
cp config.example.json config.json
#    puis ouvre config.json et remplace les valeurs d'exemple par les vraies

# 2. Est-ce que Google me laisse entrer ? (ne modifie rien)
node src/cli.mjs doctor

# 3. Qu'est-ce qui existe déjà dans mon domaine ? (ne modifie rien)
node src/cli.mjs audit

# 4. SIMULATION : qu'est-ce que la trousse ferait ? (ne modifie toujours rien)
node src/cli.mjs setup

# 5. Pour de vrai, une fois que le plan de l'étape 4 te convient
node src/cli.mjs setup --apply

# 6. Tout est-il bien en place ? (relit tout chez Google, ne modifie rien)
node src/cli.mjs verify
```

**Ne saute pas l'étape 4.** C'est elle qui te montre exactement ce qui va être créé, avant que
quoi que ce soit ne parte chez Google. Sans `--apply`, la trousse est en simulation : elle affiche
son plan, préfixé `[PLAN]`, et n'écrit rien.

Raccourcis équivalents : `npm run doctor`, `npm run audit`, `npm run setup`,
`npm run setup:apply`, `npm run verify`.

---

## Les commandes

| Commande | Ce qu'elle fait | Écrit chez Google ? |
|----------|-----------------|---------------------|
| `doctor` | Diagnostic en 5 contrôles : configuration, identifiants, jeton, API activées, droits d'admin. **À lancer en premier quand ça bloque.** | Jamais |
| `audit` | Inventaire de ce qui existe déjà : usagers, groupes, calendriers, Drive partagés, et où traîne l'adresse personnelle. | Jamais |
| `setup` | Fait tout, dans l'ordre : `group`, puis `calendar`, puis `drive`. | Avec `--apply` |
| `group` | Crée le groupe d'équipe, verrouille ses réglages, synchronise ses membres. | Avec `--apply` |
| `calendar` | Crée les calendriers partagés et accorde les accès à l'équipe. | Avec `--apply` |
| `drive` | Crée le Drive partagé, applique les restrictions, bâtit l'arborescence, dépose le mode d'emploi. | Avec `--apply` |
| `detach` | Retire l'adresse Gmail personnelle de partout où l'API le permet, après des vérifications de sécurité bloquantes. | Avec `--apply` |
| `verify` | Relit tout chez Google et rend un verdict. | Jamais |

`doctor`, `audit` et `verify` sont en **lecture seule** : même avec `--apply`, elles ne modifient
rien. C'est volontaire.

### Options

| Option | Effet |
|--------|-------|
| `--apply` | Exécute pour de vrai. **Sans cette option : simulation.** |
| `--config <chemin>` | Utilise un autre fichier de configuration (défaut : `./config.json`). |
| `--no-color` | Enlève les couleurs, pratique pour copier-coller dans un courriel. |
| `-h`, `--help` | Affiche l'aide. |
| `-v`, `--version` | Affiche la version. |

---

## Si ça plante

**Lance `node src/cli.mjs doctor`.** C'est fait pour ça.

Le diagnostic passe cinq contrôles dans l'ordre et s'arrête au premier qui échoue, en te disant
**quoi corriger et où** — pas juste « erreur ». Il te donne les liens directs à cliquer et le texte
exact à copier-coller dans la console Google.

Si tu veux la trace technique complète pour la transmettre à quelqu'un :

```bash
PORTAIL_DEBUG=1 node src/cli.mjs <commande>
```

Les erreurs les plus fréquentes, avec leur message exact et le correctif, sont dans
**[docs/02-execution.md](docs/02-execution.md#depannage)**.

---

## La documentation

| Document | À lire quand |
|----------|--------------|
| **[docs/01-preparation.md](docs/01-preparation.md)** | Avant tout. Les manipulations Google Cloud à faire une seule fois. |
| **[docs/02-execution.md](docs/02-execution.md)** | Pour remplir `config.json` et lancer la trousse. Contient le dépannage. |
| **[docs/03-conventions.md](docs/03-conventions.md)** | À faire lire à toute l'équipe. Les règles de classement, pour ne pas se ramasser avec 1001 documents qui n'ont pas d'affaires là. |
| **[docs/04-adresse-gmail.md](docs/04-adresse-gmail.md)** | Pour comprendre et détacher l'adresse `@gmail.com` personnelle. **Lis les précautions avant d'agir.** |
| **[docs/00-reference-api.md](docs/00-reference-api.md)** | Référence technique. Seulement si tu touches au code. |

---

## Sécurité

- **Aucun secret n'est versionné.** `service-account.json`, `oauth-client.json`, `.tokens.json`,
  `config.json` et `.state.json` sont tous dans le `.gitignore`.
- **Une seule dépendance** : `googleapis`, la bibliothèque officielle de Google. Rien d'autre.
- **Le fichier `.state.json`** n'est qu'un cache pour aller plus vite. Tu peux l'effacer sans rien
  perdre : la trousse redécouvre tout via l'API.
- **Node.js 20 ou plus récent** est exigé.
