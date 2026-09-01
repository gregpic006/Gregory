# 02 — L'exécution

La préparation ([01-preparation.md](01-preparation.md)) est faite et `doctor` passe ses cinq
contrôles ? Parfait. Cette étape-ci prend **20 minutes**, et c'est la dernière avant que ton
Workspace soit monté.

Le principe à retenir, un seul : **la trousse ne modifie rien tant que tu n'écris pas `--apply`.**
Tu peux tout lancer sans crainte, lire ce qu'elle propose, et décider après.

---

## Étape 1 — Créer ton `config.json`

```bash
cd google-workspace
cp config.example.json config.json
```

Ouvre `config.json` dans ton éditeur de texte. C'est le seul fichier que tu as à remplir.

> `config.json` est **gitignoré** : il contient tes vraies adresses, il ne partira jamais dans un
> dépôt. Le modèle `config.example.json`, lui, ne contient que des exemples.

### Les champs, un par un

#### `domain` — ton nom de domaine

```json
"domain": "portailgestion.ca"
```

Juste le domaine, sans `@`, sans `https://`, sans `www`. **Toutes** les adresses du fichier devront
finir par ce domaine — la trousse refuse de démarrer sinon, pour éviter que tu montes le Workspace
du voisin par accident.

#### `adminEmail` — le compte qui fait le travail

```json
"adminEmail": "greg@portailgestion.ca"
```

L'adresse **super-administratrice** au nom de laquelle la trousse agit. En mode OAuth, c'est le
compte avec lequel tu te connectes dans le navigateur. En mode compte de service, c'est l'identité
que le compte de service emprunte.

Ce doit être une adresse **de ton domaine** — jamais une `@gmail.com`, qui ne peut pas ouvrir la
console d'administration.

#### `personalEmail` — ton adresse personnelle à détacher

```json
"personalEmail": "greg.picard.2003@gmail.com"
```

L'adresse `@gmail.com` que Google a accrochée au compte lors de l'inscription. Elle sert
uniquement à la commande `detach` et aux rapports de `audit` et `verify` : la trousse te dira où
elle traîne encore.

Mets `null` si tu n'as pas ce cas de figure. **Lis [04-adresse-gmail.md](04-adresse-gmail.md) avant
de lancer `detach`** — il y a de vraies précautions à prendre.

#### `timeZone` — le fuseau horaire

```json
"timeZone": "America/Toronto"
```

**Utilise `America/Toronto`.** Oui, même au Québec. C'est le nom officiel du fuseau de l'Est
canadien dans la base de données mondiale des fuseaux horaires. `America/Montreal` fonctionne
aussi, mais Google le remplacera silencieusement par `America/Toronto` — mêmes heures, même
changement d'heure, exactement le même fuseau. Autant écrire tout de suite celui que Google va
garder. `America/Quebec` **n'existe pas** et sera refusé.

#### `team` — les personnes

```json
"team": [
  { "email": "greg@portailgestion.ca",   "name": "Greg Picard",   "role": "organizer" },
  { "email": "marie@portailgestion.ca",  "name": "Marie Tremblay", "role": "member" },
  { "email": "samuel@portailgestion.ca", "name": "Samuel Roy",     "role": "member" },
  { "email": "julie@portailgestion.ca",  "name": "Julie Gagnon",   "role": "member" }
]
```

| Champ | Ce que c'est |
|-------|--------------|
| `email` | L'adresse de la personne, sur ton domaine. |
| `name` | Son nom complet, tel qu'il apparaîtra dans le groupe. |
| `role` | `organizer` ou `member`. **Rien d'autre.** |

**La différence entre les deux rôles :** un `organizer` peut gérer le Drive partagé — ajouter et
retirer des membres, déplacer et supprimer des dossiers, changer les réglages. Un `member` travaille
dedans normalement : il crée, modifie et classe des documents, mais ne peut pas défaire la
structure.

Mets **au moins un `organizer`** (la trousse refuse de continuer sinon) et garde-les rares : deux,
c'est bien — toi et une personne de confiance, pour ne pas être bloqué si tu es en vacances.

#### `group` — le groupe d'équipe

```json
"group": {
  "email": "equipe@portailgestion.ca",
  "name": "Équipe Portail",
  "description": "Toute l'équipe. Les accès passent par ce groupe."
}
```

**C'est le champ qui te fera économiser le plus de temps à long terme.** Au lieu de donner les
accès à quatre adresses une par une, on les donne **au groupe**. Quand quelqu'un arrive, tu
l'ajoutes au groupe et il hérite instantanément du calendrier et du Drive. Quand quelqu'un part, tu
le retires du groupe et tous ses accès tombent d'un coup. Tu ne fais **jamais** le tour des
ressources à la main.

Mets `null` si tu préfères accorder les accès directement aux quatre adresses. Ça marche aussi,
c'est juste plus de ménage plus tard.

#### `calendars` — les calendriers partagés

```json
"calendars": [
  {
    "key": "equipe",
    "summary": "Portail — Équipe",
    "description": "Visites, rendez-vous, échéances et rappels de l'équipe.",
    "timeZone": "America/Toronto",
    "role": "writer"
  }
]
```

| Champ | Ce que c'est |
|-------|--------------|
| `key` | Un identifiant court, à toi, qui ne change jamais (`equipe`, `visites`, `echeances`). Il sert de repère interne à la trousse pour retrouver le calendrier d'un lancement à l'autre. **Ne le change pas après coup** : la trousse croirait à un nouveau calendrier et en créerait un deuxième. |
| `summary` | Le nom affiché dans Google Agenda. Celui-là, tu peux le changer quand tu veux. |
| `description` | À quoi sert ce calendrier. S'affiche dans les réglages de l'agenda. |
| `timeZone` | `America/Toronto`. |
| `role` | L'accès donné à l'équipe : `none`, `freeBusyReader`, `reader`, `writer` ou `owner`. |

**Quel `role` choisir ?** `writer` dans presque tous les cas : chacun peut ajouter et modifier des
événements. `reader` si le calendrier est tenu par une seule personne et que les autres ne font que
consulter. `freeBusyReader` montre seulement « occupé / libre » sans les détails.

#### `sharedDrive` — le Drive partagé

```json
"sharedDrive": {
  "name": "Portail — Espace d'équipe",
  "restrictions": {
    "domainUsersOnly": true,
    "driveMembersOnly": true,
    "copyRequiresWriterPermission": true,
    "sharingFoldersRequiresOrganizerPermission": true
  },
  "folders": [ ... ],
  "createReadme": true
}
```

**Les quatre restrictions, en français :**

| Restriction | Ce qu'elle empêche |
|-------------|--------------------|
| `domainUsersOnly` | Personne d'extérieur à `portailgestion.ca` ne peut accéder au Drive. |
| `driveMembersOnly` | Même à l'intérieur du domaine, il faut être membre du Drive. Un employé non membre ne voit rien. |
| `copyRequiresWriterPermission` | Ceux qui ont un accès en lecture seule ne peuvent ni copier, ni imprimer, ni télécharger. |
| `sharingFoldersRequiresOrganizerPermission` | Seuls les `organizer` peuvent partager un dossier vers l'extérieur. |

**Garde les quatre à `true`.** Pour de la gestion immobilière — des baux, des dossiers de
locataires, des renseignements personnels couverts par la Loi 25 — c'est le minimum raisonnable.

`folders` décrit l'arborescence. Chaque dossier a un `name`, et peut avoir des `children` (des
sous-dossiers), eux-mêmes avec des `children`. Le modèle livré contient déjà une structure pensée
pour une PME immobilière québécoise ; elle est expliquée dossier par dossier dans
**[03-conventions.md](03-conventions.md)**.

> Les noms de dossier ne peuvent pas être vides ni contenir de barre oblique `/`.

`createReadme` à `true` dépose à la racine du Drive un Google Doc intitulé
**« 000 — LISEZ-MOI — Comment on range nos affaires »**, généré à partir de ta propre configuration :
il décrit tes vrais dossiers, pas des dossiers d'exemple. **La trousse ne l'écrase jamais** une fois
qu'il existe — tu peux le retoucher à ta main sans crainte.

#### `auth` — l'authentification

```json
"auth": {
  "mode": "oauth",
  "oauthClientFile": "./oauth-client.json",
  "tokenFile": "./.tokens.json"
}
```

`"oauth"` si tu as suivi le chemin A, `"service-account"` si tu as suivi le chemin B.

> **L'oubli numéro un** : le modèle est livré avec `"service-account"`. Si tu as suivi le chemin A
> (le recommandé), **change-le pour `"oauth"`**.

### Si tu te trompes quelque part

La trousse valide le fichier au complet **avant** de contacter Google et te dit **quel champ**
corriger et **comment**. Exemple réel :

```
ERREUR config.json > team[1].role : « membre » n'est pas un rôle valide.
       Valeurs acceptées : organizer, member.
```

Elle repère aussi les fautes de frappe dans les noms de champs :

```
ATTENTION config.json : le champ « calendriers » n'est pas reconnu et sera ignoré.
          Champs acceptés : domain, adminEmail, personalEmail, timeZone, team,
          group, calendars, sharedDrive, auth.
```

**Lis les avertissements**, ne les saute pas : un champ ignoré, c'est un réglage qui ne s'applique
pas, en silence.

---

## Étape 2 — Regarder ce qui existe déjà

```bash
node src/cli.mjs audit
```

Ne modifie rien. Dresse l'inventaire de ton domaine : les usagers, les groupes, les calendriers, les
Drive partagés, et surtout **où traîne encore ton adresse personnelle**.

Utile si ton compte n'est pas tout neuf, ou si quelqu'un a déjà commencé à créer des affaires à la
main. Tu sauras sur quoi la trousse va tomber.

---

## Étape 3 — La simulation

```bash
node src/cli.mjs setup
```

**C'est l'étape à ne pas sauter.** Aucune écriture n'est envoyée à Google. La trousse affiche un
encadré jaune bien visible :

```
+================================================+
| MODE SIMULATION — rien ne sera modifié.        |
| Ajoute --apply pour exécuter pour de vrai.     |
+================================================+
```

puis son plan complet, ligne par ligne.

### Lire le plan

Chaque ligne commence par une étiquette :

| Étiquette | Ce que ça veut dire |
|-----------|---------------------|
| `[PLAN]` (jaune) | Ce qui **serait** fait. Rien n'est encore fait. |
| `[DÉJÀ OK]` (gris) | Existe déjà et est conforme. **Rien ne sera touché.** |
| `[OK]` (vert) | Fait pour de vrai (en mode `--apply` seulement). |
| `[ATTENTION]` (jaune) | Pas une erreur : quelque chose demande ton intervention manuelle. |
| `[ERREUR]` (rouge) | Ça a échoué. Le message dit quoi faire. |

Un plan typique de premier lancement :

```
[PLAN] À créer : groupe equipe@portailgestion.ca
[PLAN] À créer : membre marie@portailgestion.ca dans equipe@portailgestion.ca
[PLAN] À créer : calendrier « Portail — Équipe »
[PLAN] À créer : Drive partagé « Portail — Espace d'équipe »
[PLAN] À créer : dossier 00 — Administration
[PLAN] À créer : dossier 00 — Administration/Assurances
...
Total : 24 création(s), 0 ajustement(s), 0 déjà conforme(s), 0 avertissement(s) — en 3,1 s
```

**Relis la liste. Est-ce bien ce que tu veux ?** C'est le moment de corriger `config.json` et de
relancer la simulation. Autant de fois que tu veux : ça ne coûte rien.

---

## Étape 4 — Pour de vrai

```bash
node src/cli.mjs setup --apply
```

La trousse fait, dans l'ordre : le **groupe**, puis les **calendriers**, puis le **Drive partagé**.
L'ordre compte — les calendriers et le Drive donnent leurs accès au groupe, il faut donc que le
groupe existe avant.

Compte **de 1 à 3 minutes**. Tu verras passer des lignes `[OK]`, et parfois :

```
[ATTENTION] Nouvel essai 1/5 dans 1,6 s — le groupe vient d'être créé et n'est pas
            encore visible partout chez Google.
```

**C'est normal, et ce n'est pas une erreur.** Un groupe fraîchement créé met quelques secondes à se
propager dans tous les services de Google. La trousse patiente et réessaie toute seule.

### Si ça s'arrête au milieu

Aucun problème : **relance la même commande**. La trousse est idempotente — elle repère ce qui
existe déjà, l'affiche en `[DÉJÀ OK]`, et ne fait que ce qui manque. Elle ne créera jamais un
deuxième groupe ni un deuxième Drive.

### Lancer une seule étape

```bash
node src/cli.mjs group --apply      # le groupe seulement
node src/cli.mjs calendar --apply   # les calendriers seulement
node src/cli.mjs drive --apply      # le Drive partagé seulement
```

---

## Étape 5 — Vérifier

```bash
node src/cli.mjs verify
```

Ne modifie rien. Relit **tout** chez Google — sans faire confiance au cache local — et rend un
verdict : les usagers, le groupe et ses membres, les calendriers et leurs accès, l'agenda de chaque
personne, le Drive partagé, ses restrictions, ses dossiers, le mode d'emploi, et l'adresse
personnelle.

C'est ta preuve que le travail est fait. Relance-la n'importe quand, dans six mois, pour vérifier
que personne n'a défait la structure.

---

## Étape 6 — Ce qui reste

1. **En mode OAuth** : tes trois coéquipiers reçoivent un courriel de partage du calendrier. Ils
   cliquent une fois dessus, le calendrier apparaît dans leur Google Agenda. Préviens-les, sinon le
   courriel dort dans leur boîte.
2. **Fais lire [03-conventions.md](03-conventions.md) à toute l'équipe.** C'est ça qui empêche le
   Drive de redevenir un grenier en trois mois.
3. **L'adresse `@gmail.com`** : lis [04-adresse-gmail.md](04-adresse-gmail.md). Ne lance pas
   `detach` avant.

---

<a id="depannage"></a>
## Dépannage

**Réflexe numéro un : `node src/cli.mjs doctor`.** Il isole le problème en cinq contrôles et te
donne le correctif exact. Ce qui suit couvre les cas les plus fréquents.

### 1. `Fichier de configuration introuvable`

```
ERREUR Fichier de configuration introuvable : /home/greg/google-workspace/config.json
```

**Cause** : tu n'as pas encore créé ton `config.json`, ou tu lances la commande depuis un autre
dossier.

**Correctif** :
```bash
cd google-workspace
cp config.example.json config.json
```
Si ton fichier est ailleurs : `node src/cli.mjs setup --config /chemin/vers/config.json`

---

### 2. `unauthorized_client` (chemin B seulement)

```
Client is unauthorized to retrieve access tokens using this method
```

**Ce que ça veut dire** : Google n'a **même pas émis** de jeton. Le problème est dans la délégation,
pas dans ton code. Trois causes, par ordre de fréquence :

1. **Une portée ne correspond pas exactement.** C'est la cause numéro un. Retourne sur
   <https://admin.google.com/ac/owl/domainwidedelegation>, supprime l'entrée, recrée-la en
   **copiant-collant** la liste de portées de [01-preparation.md](01-preparation.md#b4--autoriser-la-délégation-à-léchelle-du-domaine).
   Ne la retape pas à la main.
2. **Tu as collé le courriel du compte de service** au lieu du nombre à 21 chiffres. Le champ
   « ID client » n'accepte que le nombre.
3. **La propagation n'est pas finie.** Attends 10 minutes et relance.

Et si ton ajout reste marqué « en attente » : il faut l'approbation d'un **deuxième
super-administrateur**. Ce n'est pas un bogue.

---

### 3. `invalid_grant`

**Ce que ça veut dire** : le fourre-tout de Google. Quatre causes réelles :

| Cause | Correctif |
|-------|-----------|
| L'horloge de ta machine est décalée de plus de 5 minutes | Active la synchronisation automatique de l'heure dans les réglages de ton système. Fréquent sur une machine virtuelle mise en veille. |
| `adminEmail` ne s'est **jamais connecté** à Google | Ouvre une fenêtre privée, connecte-toi une fois avec cette adresse, accepte les conditions. Un compte jamais ouvert ne peut pas être emprunté. |
| Le fichier `service-account.json` est corrompu ou la clé a été supprimée | Recrée une clé (étape B.2). |
| **En mode OAuth** : ton jeton a été révoqué, ou ton écran de consentement est en « Externe / test » (expiration à 7 jours) | Efface `.tokens.json` et relance `doctor`. Si ça revient chaque semaine, repasse l'écran de consentement en **Interne**. |

---

### 4. `accessNotConfigured` — une API n'est pas activée

```
Admin SDK API has not been used in project 123456 before or it is disabled
```

**Cause** : une des quatre API de l'étape 2 n'est pas activée, ou tu l'as activée dans le **mauvais
projet**.

**Correctif** : le message d'erreur contient un lien direct d'activation — clique-le. Sinon,
reprends le tableau des 4 API dans [01-preparation.md](01-preparation.md#étape-2--activer-les-4-api)
et **vérifie le nom du projet dans la barre bleue** à chaque fois.

Rappel : l'API Agenda, c'est `calendar-json.googleapis.com`, avec le `-json`.

---

### 5. `403 Not Authorized to access this resource/api`

**Ce que ça veut dire** : Google **a bien émis** le jeton (donc l'authentification fonctionne), mais
il refuse l'appel. C'est un problème de **droits**, pas de configuration.

**Correctif** : l'adresse dans `adminEmail` n'est pas super-administratrice. Vérifie-le :

> **admin.google.com** > **Annuaire** > **Utilisateurs** > clique la personne >
> **Rôles et privilèges d'administrateur**

Le contrôle 5 de `doctor` teste exactement ça.

---

### 6. `404` juste après la création du groupe

```
[ATTENTION] Nouvel essai 2/5 dans 3,2 s — ressource pas encore visible chez Google
```

**Ce n'est pas une erreur.** Un groupe fraîchement créé n'est pas immédiatement visible par les
services Agenda et Drive. C'est documenté chez Google. La trousse réessaie automatiquement avec des
délais qui s'allongent.

**Correctif** : laisse-la faire. Si elle abandonne après 5 essais, attends 2 minutes et relance la
commande — ce qui a été créé sera reconnu comme `[DÉJÀ OK]`.

---

### 7. `Option inconnue : « --xyz »`

**Cause** : la trousse n'accepte que `--apply`, `--config`, `--no-color`, `--help` et `--version`.
Toute autre option est refusée volontairement, pour éviter qu'une faute de frappe ne passe
inaperçue.

**Le cas à connaître** : la commande `detach` a besoin d'une adresse de récupération, et
**l'option `--recovery` n'est pas acceptée par cette version du programme**. Passe par la variable
d'environnement, qui fonctionne toujours :

```bash
RECOVERY_EMAIL="secours@exemple.com" node src/cli.mjs detach --apply
```

> Écrire `"recoveryEmail"` dans `config.json` **ne fonctionne pas non plus** : le champ n'est pas
> reconnu, la trousse t'avertit et l'ignore. Utilise la variable d'environnement.

---

### 8. `REFUS D'AGIR — le détachement est bloqué`

```
Vérification(s) non satisfaite(s) : pas de deuxième super-administrateur actif,
ni de validation en deux étapes ; adresse de récupération de remplacement manquante.
```

**Ce n'est pas un bogue : c'est la trousse qui te protège.** Elle refuse de retirer ta porte de
secours tant que tu n'en as pas installé une autre. Sans ça, un mot de passe oublié te barrerait
dehors de ton propre Workspace.

**Correctif** : va lire [04-adresse-gmail.md](04-adresse-gmail.md), fais les trois précautions
(deuxième super-administrateur, codes de secours, adresse de remplacement), puis relance.

---

### 9. `La création de clés de compte de service est désactivée`

**Cause** : une règle de sécurité de Google (`iam.managed.disableServiceAccountKeyCreation`), active
par défaut sur les organisations récentes.

**Correctif** : **ne désactive pas la règle.** Passe au chemin A (OAuth) de
[01-preparation.md](01-preparation.md#chemin-a--oauth--application-de-bureau--recommandé). C'est
15 minutes, et c'est plus sécuritaire de toute façon.

---

### 10. Rien de tout ça

```bash
PORTAIL_DEBUG=1 node src/cli.mjs <ta-commande>
```

Affiche la trace technique complète. Envoie-la à quelqu'un qui programme — elle contient tout ce
qu'il faut pour comprendre.

**Ce qui n'arrivera jamais**, même quand ça plante : la trousse ne touchera pas à tes documents
personnels. Toute opération Drive est bornée au Drive partagé qu'elle a créé, et une garde explicite
refuse d'agir sur un fichier qui n'y est pas.
