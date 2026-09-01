# 04 — L'adresse @gmail.com dans ton Workspace

Tu viens de créer ton Google Workspace et tu vois ton ancienne adresse personnelle,
`greg.picard.2003@gmail.com`, apparaître un peu partout dans la console d'administration. C'est
troublant. Ce document explique **pourquoi elle est là**, **si c'est dangereux** (non), **où elle
se trouve exactement**, et **quoi faire** — dans le bon ordre, sans te barrer dehors de ton propre
compte.

> **Avant tout : ne lance pas `node src/cli.mjs detach` tout de suite.** Lis la section
> « Les précautions » plus bas. La trousse va d'ailleurs refuser d'agir tant que tu ne les auras
> pas faites — c'est volontaire.

---

## 1. Pourquoi elle est là

Quand tu t'inscris à Google Workspace, Google a besoin d'une adresse pour te rejoindre **avant même
que ton domaine existe**. C'est le problème de l'œuf et de la poule : `greg@portailgestion.ca`
n'était pas encore créée quand tu as rempli le formulaire d'inscription. Google a donc pris la seule
adresse que tu avais : ton Gmail personnel.

Cette adresse est ensuite restée accrochée au compte comme **adresse de contact et de secours**.
C'est exactement son rôle, et Google l'a même prévu ainsi.

## 2. Non, ce n'est pas un trou de sécurité

**Ton adresse `@gmail.com` n'a aucun accès à ton Google Workspace.** Elle ne peut pas :

- ❌ lire les courriels de `@portailgestion.ca` — elle n'a pas de boîte sur ton domaine ;
- ❌ ouvrir la console d'administration — Google exige une adresse **du domaine** pour ça, et refuse
  toute adresse finissant par `gmail.com` ;
- ❌ être un usager de ton Workspace — c'est **structurellement impossible**, pas une question de
  réglage ;
- ❌ voir tes documents, tes calendriers ou ton annuaire, sauf si quelqu'un les lui a partagés
  explicitement.

**Pourquoi c'est impossible et pas juste « pas configuré » ?** Parce qu'un compte `@gmail.com` est un
compte Google **grand public**, dans un espace de noms qui appartient à Google, pas à toi. Les
usagers de ton Workspace portent forcément ton domaine. Les deux mondes ne se touchent pas.

**Ce qu'elle est vraiment** : une adresse de contact. Google lui envoie des avis, elle peut servir à
reprendre la main si tu perds ton mot de passe, et elle est probablement propriétaire de ton profil
de paiement.

> **La bonne nouvelle** : il n'y a rien à « expulser » de ton annuaire. Il n'y a que des
> **références à réaiguiller**. C'est du ménage, pas une brèche.

Un dernier point qui inquiète souvent, et qui ne s'applique pas à toi : un « **compte en conflit** »,
c'est un compte Google personnel créé avec une adresse **de ton domaine** (par exemple si quelqu'un
avait ouvert un compte YouTube avec `greg@portailgestion.ca` avant l'inscription à Workspace). Ton
`@gmail.com` **n'est pas** un compte en conflit : adresse différente, monde différent. La commande
`detach` vérifie quand même s'il en existe, et te le dira.

---

## 3. Où elle se trouve — la liste complète

Treize endroits possibles. La colonne du milieu te dit qui s'en occupe.

### Ce que la trousse règle toute seule

| # | Où | Commande |
|---|-----|---------|
| 1 | **Adresse de récupération** du compte super-administrateur (`recoveryEmail`) | `detach` la remplace par ton adresse de secours |
| 2 | **Adresse secondaire** dans la fiche de contact des usagers (`emails[]`) | `detach` la retire |
| 3 | **Membre d'un groupe** Google du domaine | `detach` l'en retire |
| 4 | **Règle d'accès à un calendrier** partagé | `detach` la supprime |
| 5 | **Permission sur le Drive partagé** | `detach` la supprime |

Pour ces cinq points : `RECOVERY_EMAIL="secours@exemple.com" node src/cli.mjs detach --apply`

### Ce qui est manuel — aucune API n'existe

Ce n'est pas une limite de cette trousse : **Google n'offre aucune interface de programmation** pour
ces réglages. C'est manuel pour tout le monde, partout.

| # | Où | Chemin exact |
|---|-----|--------------|
| 6 | **Adresse e-mail secondaire du COMPTE** ⭐ *le plus important* | `admin.google.com` > **Compte** > **Paramètres du compte** > **Profil** > **Coordonnées** > **Adresse e-mail secondaire** |
| 7 | **Administrateur principal** | `admin.google.com` > **Compte** > **Paramètres du compte** > **Profil** > **Coordonnées** |
| 8 | **Contacts de facturation** ⭐ | `admin.google.com` > **Facturation** > **Comptes de paiement** > ⋮ **Plus** > **Afficher les paramètres de paiement** > **Contacts de paiement** |
| 9 | **Utilisateurs du profil de paiement** | `payments.google.com` > **Paramètres** > **Utilisateurs de paiement** |
| 10 | **Préférences de communication** | `admin.google.com` > **Compte** > **Paramètres du compte** > **Préférences** > **Préférences de communication** > **E-mail** |
| 11 | **Responsable de la protection des données** (Loi 25 / RGPD) | `admin.google.com` > **Compte** > **Paramètres du compte** > **Aspects juridiques et conformité** |
| 12 | **Propriétaire du projet Google Cloud** | `console.cloud.google.com` > **IAM et administration** > **Gérer les ressources** |
| 13 | **Google Search Console** *(si le domaine y a déjà été validé)* | `search.google.com/search-console` > **Paramètres** > **Utilisateurs et autorisations** |
| 14 | **Compte chez le registraire du domaine** *(hors Google)* | Le site où tu as acheté `portailgestion.ca` |

> Le point 6 est **techniquement** modifiable par API (le champ `alternateEmail`), mais ça exigerait
> d'ajouter une portée à ta liste de délégation — et une liste de portées qui ne correspond plus
> exactement casse **tout le reste** de la trousse. Le jeu n'en vaut pas la chandelle pour un champ
> qu'on remplit une fois dans sa vie. La trousse t'affiche le chemin et tu le fais en 30 secondes.

La commande `detach` **imprime cette feuille de route à la fin de son exécution**, avec les chemins,
dans l'ordre. Tu n'as pas à revenir lire ce document.

---

## 4. Les précautions — à faire AVANT de toucher à quoi que ce soit

### Le risque, en une phrase

**L'adresse `@gmail.com` est ta porte de secours.** Si tu la retires avant d'en avoir installé une
autre, et que tu perds ensuite ton mot de passe ou ton téléphone, **tu es barré dehors de ton propre
Workspace** — avec tes courriels, tes documents et ceux de ton équipe derrière la porte.

Reprendre la main sans porte de secours, ça veut dire :
- soit publier un enregistrement DNS spécial dans les **48 heures** (sinon la demande échoue et il
  faut tout recommencer) ;
- soit passer par le soutien de Google, qui exige des preuves de propriété du domaine, avec un
  délai que personne ne te garantit.

**Ce n'est pas théorique. C'est le scénario le plus fréquent de perte de compte Workspace.**

C'est pour ça que la commande `detach` fait des **vérifications bloquantes** — elles s'appliquent
**même avec `--apply`** — et refuse de continuer tant que les trois points suivants ne sont pas
réglés. Ce n'est pas une erreur du programme : c'est un refus motivé.

### Précaution 1 — Créer un deuxième super-administrateur

**C'est la plus importante.** Un deuxième super-admin peut réinitialiser le mot de passe du premier
depuis la console. Tant qu'il existe, tu ne peux pas être barré dehors pour de bon.

1. `admin.google.com` > **Annuaire** > **Utilisateurs** > **Ajouter un utilisateur**
2. Crée par exemple `admin@portailgestion.ca` — **avec un mot de passe différent du tien**.
3. Une fois créé : clique sur l'utilisateur > **Rôles et privilèges d'administrateur** >
   active **Super Admin** > **Enregistrer**.
4. Connecte-toi une fois avec ce compte pour accepter les conditions d'utilisation, active la
   **validation en deux étapes** dessus, et donne-lui ses propres infos de récupération.
5. **Ne l'utilise pas au quotidien.** C'est un extincteur : on le laisse au mur.

> Compte jusqu'à 24 h pour que le rôle d'administrateur se propage partout chez Google.

### Précaution 2 — Générer les codes de secours de la validation en deux étapes

Si tu as la validation en deux étapes (et tu devrais), **seule une adresse de récupération permet de
réinitialiser ton mot de passe** — un numéro de téléphone ne suffit pas. Les codes de secours sont
ton filet si tu perds ton téléphone.

- Pour toi-même : `myaccount.google.com` > **Sécurité** > **Validation en deux étapes** >
  **Codes de secours** > **Obtenir les codes**
- Pour quelqu'un d'autre : `admin.google.com` > **Annuaire** > **Utilisateurs** > la personne >
  **Sécurité** > **Validation en deux étapes** > **Obtenir les codes de secours**

**Imprime-les, ou écris-les sur papier, et range-les ailleurs que dans ton ordinateur.** Un code de
secours dans un fichier sur la machine que tu ne peux plus déverrouiller ne sert à rien.

> Seul un **super-administrateur** peut générer des codes de secours pour un autre administrateur.
> Encore une raison de faire la précaution 1 en premier.

### Précaution 3 — Choisir l'adresse de secours de remplacement

Il te faut une **nouvelle adresse externe**, qui remplacera le Gmail personnel.

**Elle doit être hors de `portailgestion.ca`.** Ce n'est pas un caprice : Google **refuse** une
adresse du domaine pour l'adresse secondaire du compte, et il a raison. Une porte de secours qui vit
dans la maison qu'elle est censée secourir ne sert à rien : si ton domaine, ton DNS ou ton Workspace
tombent, ton adresse de secours tombe avec.

**Ne cherche pas à avoir zéro adresse externe : c'est impossible, et ce serait dangereux.**
Cherche plutôt à remplacer une adresse *personnelle* par une adresse *d'entreprise, neutre et
durable* :

- ✅ une boîte chez un autre fournisseur (Proton, Fastmail, iCloud) réservée à l'administration ;
- ✅ un Gmail créé **au nom de l'entreprise** (`admin.portailgestion@gmail.com`), pas ton adresse
  personnelle de 2003 ;
- ❌ l'adresse personnelle d'un employé — il partira un jour ;
- ❌ une adresse que personne ne surveille — les avis critiques de Google partiraient dans le vide.

**Ajoute aussi un numéro de téléphone de récupération**, au format international :
`+15145551212`.

### Précaution bonus — Vérifier l'interrupteur de récupération

`admin.google.com` > **Sécurité** > **Authentification** > **Récupération du compte** >
**Récupération du compte super-administrateur**

**Sur plusieurs éditions — dont Business Plus — ce réglage est DÉSACTIVÉ par défaut.** S'il est à
« Désactivé », ton adresse de récupération ne servira à rien le jour où tu en auras besoin.
**Mets-le sur « Activé ».** C'est un clic, et c'est le clic le plus rentable de tout ce document.

---

## 5. Comment lancer le détachement

Une fois les trois précautions faites :

```bash
# 1. Voir ce que ça ferait — ne modifie rien
RECOVERY_EMAIL="admin.portailgestion@exemple.com" node src/cli.mjs detach

# 2. Pour de vrai
RECOVERY_EMAIL="admin.portailgestion@exemple.com" node src/cli.mjs detach --apply
```

> **Attention à la façon de passer l'adresse.** L'option `--recovery` **n'est pas acceptée** par
> cette version du programme, et le champ `"recoveryEmail"` dans `config.json` est **ignoré**.
> **La variable d'environnement `RECOVERY_EMAIL=` est le seul chemin qui fonctionne** — c'est celui
> ci-dessus.

La commande commence par afficher ses vérifications de sécurité. Si l'une d'elles échoue, elle
**refuse d'agir**, t'explique laquelle en français, et imprime quand même la feuille de route
manuelle — elle t'est utile pendant que tu débloques le reste.

Ensuite, la règle d'or, appliquée partout : **on ajoute, on vérifie, on promeut, et seulement après
on retire.** Jamais « on supprime, on remettra plus tard ».

**Pour la facturation, c'est particulièrement important** (point 8 du tableau) : le contact
principal d'un profil de paiement **ne se modifie pas**. Il faut *ajouter* un nouveau contact,
**cliquer le lien de vérification que Google t'envoie par courriel**, le promouvoir contact
principal, et *seulement ensuite* retirer l'ancien. Tant que le lien n'est pas cliqué, le contact
reste « En attente » et **ne reçoit aucun avis de facturation**. Un avis d'échec de paiement non
reçu, c'est un compte suspendu.

Et après : **attends 24 à 48 h**, puis relance `node src/cli.mjs audit` pour tout revalider. Les
changements dans la console Google mettent jusqu'à 24 h à se propager.

---

## 6. Ma recommandation franche

Tout n'a pas la même valeur. Voici où mettre ton énergie.

### 🔴 À changer, ça compte vraiment

| Quoi | Pourquoi |
|------|----------|
| **Adresse secondaire du compte** (point 6) | C'est là que Google envoie les avis de sécurité, de suspension et de facturation. Si elle pointe sur une boîte que tu ne surveilles plus, tu apprendras que ton compte est suspendu... trop tard. C'est le verrouillage lent, celui qu'on ne voit pas venir. |
| **Contacts de facturation** (points 8 et 9) | Si ton essai gratuit se termine et que la facturation casse, le compte est suspendu. Et si ton Gmail est le seul « Admin » du profil de paiement, tu ne pourras plus gérer tes moyens de paiement toi-même. |
| **Adresse de récupération du super-admin** (point 1) | Faite automatiquement par `detach`. C'est ta porte de secours : elle doit exister et être surveillée. |
| **Propriétaire du projet Google Cloud** (point 12) | Le projet qui héberge tes accès a probablement été créé avec ton Gmail. S'il reste sa propriété et que tu perds ce compte, tu perds l'accès aux API. |

### 🟡 À faire, mais sans urgence

- **Administrateur principal** (point 7) — vérifie juste qu'il pointe sur `greg@portailgestion.ca`
  et non sur un alias. Deux minutes.
- **Préférences de communication** (point 10) — cinq minutes de ménage.
- **Search Console** (point 13) — seulement si tu avais déjà validé le domaine avant. Sinon, il
  n'y a rien là.
- **Responsable de la protection des données** (point 11) — à remplir de toute façon pour la Loi 25,
  tant qu'à y être.

### 🟢 À laisser tranquille

**Le fait qu'une adresse hors domaine existe.** C'est **obligatoire** : Google refuse une adresse de
`portailgestion.ca` comme adresse secondaire du compte. Vise à remplacer une adresse *personnelle*
par une adresse *d'entreprise neutre*, pas à faire disparaître toute adresse externe. Ce serait
impossible, et dangereux.

**Le compte Gmail lui-même : ne le supprime pas.** Garde-le actif et accessible **au moins 30 jours
après** la bascule complète. Il est encore référencé à des endroits que tu n'as pas trouvés, et un
compte supprimé casse ces chaînes-là en silence, sans message d'erreur.

**Le registraire du domaine** (point 14) — si ton compte chez le registraire est ouvert sous ton
Gmail, ce n'est pas grave en soi. Mais **sache-le** : c'est la clé maîtresse. En récupération
assistée, Google exige une preuve de propriété du domaine, et ça passe par le DNS. Assure-toi
seulement de ne jamais perdre l'accès à ce compte-là.

**Tes documents personnels dans ton « Mon Drive »** — la trousse n'y touche jamais, par choix de
conception. Si tu veux vérifier qu'aucun document d'entreprise n'y traîne, c'est une vérification
que **toi seul** peux faire, à l'œil, dans `drive.google.com` > **Mon Drive**.

---

## En résumé

1. Ton `@gmail.com` **n'a aucun accès** à ton Workspace. Rien d'urgent, rien de dangereux.
2. **Avant de bouger** : deuxième super-admin, codes de secours, adresse de remplacement, et
   l'interrupteur de récupération à « Activé ».
3. `RECOVERY_EMAIL="..." node src/cli.mjs detach --apply` règle les cinq points automatisables.
4. Les points 6, 8 et 9 (adresse secondaire du compte, facturation) valent tes 30 minutes. Le reste
   est du ménage.
5. **On ajoute, on vérifie, on promeut, puis on retire.** Jamais l'inverse.
6. **Ne supprime pas le compte Gmail.**
