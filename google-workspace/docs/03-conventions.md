# 03 — Comment on range nos affaires

**À faire lire à toute l'équipe. Ça prend cinq minutes.**

Un Drive partagé bien tenu, ça veut dire une chose : **n'importe qui trouve n'importe quel document
en moins de 30 secondes, sans demander à personne.** Un Drive mal tenu, c'est 1001 fichiers qui
n'ont pas d'affaires là, trois versions du même bail, et quelqu'un qui redemande la facture
d'Hydro pour la quatrième fois.

La différence entre les deux, ce n'est pas la bonne volonté. C'est d'avoir des règles courtes que
tout le monde applique pareil. Les voici.

> Une version courte de ces règles vit aussi **dans le Drive lui-même**, dans le document
> **« 000 — LISEZ-MOI — Comment on range nos affaires »**, à la racine. Ce document-ci est la
> version complète, avec les exemples.

---

## 1. Les dossiers, et à quoi ils servent

Huit dossiers à la racine. **Huit, pas neuf.** Les numéros ne sont pas décoratifs : ils forcent
l'ordre d'affichage, pour que le dossier soit toujours au même endroit à l'écran, pour tout le
monde.

### `00 — Administration`
La vie de l'entreprise elle-même.

- **Légal & incorporation** — statuts, Registraire des entreprises (NEQ), résolutions, convention
  entre actionnaires, procès-verbaux.
- **Assurances** — police responsabilité civile, assurance erreurs et omissions, réclamations.
- **Contrats fournisseurs** — le bail du bureau, le contrat du comptable, les abonnements
  logiciels.

*Exemples : `2026-01-15 — Police — Assurance responsabilité civile`,
`2026-03-02 — Contrat — Comptable Lévesque CPA`*

### `10 — Finance`
Tout ce qui touche à l'argent de Portail.

- **États financiers** — bilans, états des résultats, budgets.
- **Taxes TPS-TVQ** — déclarations trimestrielles, avis de cotisation, correspondance avec Revenu
  Québec et l'ARC. **Tout ce qui porte un numéro de TPS ou de TVQ atterrit ici**, pas dans le
  dossier du client.
- **Banque & rapprochements** — relevés mensuels, conciliations.
- **Paie** — talons, T4/Relevé 1, DAS.

*Exemples : `2026-04-30 — Déclaration — TPS-TVQ T1 2026`,
`2026-02-28 — Relevé bancaire — Desjardins compte opérations`*

### `20 — Produit & Tech`
Le produit Portail lui-même.

- **Specs & décisions** — ce qu'on construit et **pourquoi** on l'a décidé de même.
- **Design** — maquettes, logo, chartes graphiques.
- **Accès & environnements** — la carte de qui a accès à quoi.

> ⚠️ **Aucun mot de passe, aucune clé, aucun jeton dans le Drive.** Jamais, même dans un fichier
> nommé « privé ». Les mots de passe vivent dans un gestionnaire de mots de passe, un point.

*Exemples : `2026-05-12 — Spec — Module de quittance de loyer`,
`2026-01-08 — Décision — Choix de l'hébergeur`*

### `30 — Ventes & Marketing`
Ce qui sert à faire entrer des clients.

- **Matériel de vente** — présentations, grille de prix, argumentaire.
- **Prospection** — listes de gestionnaires et de propriétaires à contacter, suivis.
- **Contenu & blogue** — articles, infolettres, publications.

*Exemple : `2026-03-20 — Présentation — Démo Portail pour gestionnaires`*

### `40 — Clients & Mandats`
**Le dossier le plus important au quotidien.** Un sous-dossier par client, toujours nommé de la
même façon : le nom du client, tel qu'il apparaît sur la facture.

Dedans, tout ce qui concerne ce client : baux, rapports de propriétaire, correspondance, factures
qu'on lui envoie, états de compte.

Le sous-dossier **`_MODÈLE — Nouveau mandat`** contient la structure vierge d'un dossier client.
**Duplique-le** quand un nouveau client arrive, renomme la copie, et tu as la même structure que
tout le monde. Ne travaille jamais directement dans le modèle.

*Exemples : `40 — Clients & Mandats/Immeubles Laflamme/2026-01-31 — Bail — 245 rue Principale, logement 3`,
`40 — Clients & Mandats/Immeubles Laflamme/2026-04-05 — Rapport de propriétaire — Mars 2026`*

### `50 — Légal & Conformité`
Ce qui nous garde du bon côté de la loi.

- **Loi 25** — politique de confidentialité, registre des incidents de confidentialité,
  consentements, inventaire des renseignements personnels détenus, coordonnées du responsable de la
  protection des renseignements personnels. **Tout ce qui touche aux renseignements personnels des
  locataires atterrit ici.**
- **Baux types** — les gabarits de bail, y compris le formulaire obligatoire du Tribunal
  administratif du logement.
- **Politiques internes** — télétravail, dépenses, code de conduite.

*Exemples : `2026-02-01 — Politique — Protection des renseignements personnels (Loi 25)`,
`2026-06-15 — Registre — Incident de confidentialité 2026-003`*

### `90 — Archives`
Ce qui ne sert plus au quotidien, **et tout document dont personne ne sait où le mettre**.
Rien ne se perd : on le ressort le jour où on en a besoin.

### `_MODÈLES`
Les gabarits vierges de toute l'entreprise : lettres types, chiffriers de base, contrats types.
Le tiret bas les garde en bas de la liste. **On les duplique, on ne travaille jamais dedans.**

---

## 2. Comment on nomme un fichier

Toujours la même forme, sans exception :

> ## `AAAA-MM-JJ — Type — Sujet`

| Morceau | Ce que c'est |
|---------|--------------|
| **AAAA-MM-JJ** | La date **du document**, pas celle où tu l'as classé. Année, mois, jour, avec des tirets. |
| **Type** | Un mot : Facture, Bail, Contrat, Rapport, Déclaration, Politique, Procès-verbal, Devis, Soumission, Avis, Relevé. |
| **Sujet** | De qui ou de quoi il s'agit, en clair, en français. |

Les séparateurs sont des **tirets cadratins** ` — ` avec une espace de chaque bord. Copie-colle-en
un si ton clavier n'en fait pas : c'est ce qui rend la lecture nette d'un coup d'œil.

**Pourquoi la date en premier ?** Parce que `2026-04-30` se classe tout seul après `2026-03-14`.
Trie par nom, et tu as l'ordre chronologique gratuitement, pour toujours.

### Cinq exemples, tirés de notre vraie affaire

```
2026-03-14 — Facture — Hydro-Québec 245 rue Principale
2026-01-31 — Bail — 245 rue Principale, logement 3
2026-04-30 — Déclaration — TPS-TVQ T1 2026
2026-04-05 — Rapport de propriétaire — Immeubles Laflamme, mars 2026
2026-02-08 — Procès-verbal — Réunion d'équipe
```

### Trois contre-exemples, et pourquoi

| ❌ Le nom | Le problème |
|-----------|-------------|
| `bail final v2 VRAIMENT FINAL.pdf` | Pas de date, donc impossible à classer. Et surtout : **le « v2 » n'a aucune raison d'exister.** Google Drive garde tout l'historique des versions d'un fichier. Un seul fichier, toujours. |
| `Facture 14 mars.pdf` | La date n'est pas triable — `14 mars` se classe avant `2 avril` en ordre alphabétique. Et de quelle année ? Écris `2026-03-14`. |
| `Scan_20260314_0001.pdf` | Le nom par défaut du numériseur. Personne ne sait ce qu'il y a dedans sans l'ouvrir. **Renomme-le en le déposant**, ça prend quatre secondes. |

**Et jamais** : « final », « v2 », « copie de », « nouveau », « à jour », « temp », « untitled »,
ni tes initiales à la fin.

---

## 3. Où je range ça ? Trois questions

Dans l'ordre. Arrête-toi à la première qui donne une réponse.

**1. Est-ce que ça concerne UN client en particulier ?**
→ Oui : `40 — Clients & Mandats` > le dossier du client. **Fini.**
Un bail, un rapport de propriétaire, une facture envoyée à ce client : c'est chez lui, même si
c'est aussi une facture.

**2. Est-ce que c'est de l'argent, du légal, ou du produit ?**
→ Argent de Portail : `10 — Finance`.
→ Loi, conformité, Loi 25, baux types : `50 — Légal & Conformité`.
→ Le produit Portail : `20 — Produit & Tech`.
→ Vendre et se faire connaître : `30 — Ventes & Marketing`.
→ La vie de la compagnie : `00 — Administration`.

**3. Toujours pas sûr ?**
→ `90 — Archives`, avec un nom correct selon la convention.

**Ce n'est pas de la paresse, c'est la bonne réponse.** La recherche de Google Drive retrouve un
document par son **contenu**, pas seulement par son nom : un document bien nommé dans les Archives
se retrouve en trois secondes. Un document dans un dossier inventé sur un coup de tête, lui, est
perdu pour tout le monde sauf toi.

> **La règle qui garde le classeur propre : personne ne crée un dossier de premier niveau tout
> seul.** Si le même genre de document revient trois ou quatre fois dans les Archives, c'est le
> signe qu'il mérite son dossier — on en parle à l'équipe, et on l'ajoute pour de bon dans
> `config.json`. Un dossier créé sur un coup de tête, c'est exactement comme ça qu'un classeur
> devient un grenier.

**Dans le doute entre deux dossiers, prends le plus précis.** Un contrat d'assurance va dans
`00 — Administration/Assurances`, pas dans `00 — Administration`. Le dossier général est un
fourre-tout : plus il se remplit, moins il sert.

---

## 4. Le Drive partagé ou mon « Mon Drive » ?

La ligne est simple : **le Drive partagé appartient à l'entreprise. « Mon Drive » t'appartient.**

Si tu quittais Portail demain matin, tout ce qui est dans le Drive partagé reste, intact, accessible
à tout le monde. Tout ce qui est dans ton « Mon Drive » part avec toi.

### Va dans le Drive partagé

- Tout ce qui concerne un client, un immeuble, un locataire.
- Tout ce qui a une valeur légale, comptable ou fiscale.
- Tout ce que quelqu'un d'autre pourrait avoir besoin de retrouver, même dans deux ans.
- Tout ce qui a été payé par l'entreprise.

### Reste dans ton « Mon Drive »

- Tes brouillons, tes notes personnelles, tes essais.
- Tes affaires personnelles : impôts, relevés bancaires perso, photos de famille.
- Tes documents RH à toi (ton contrat, tes évaluations).

> **Cette trousse ne touche JAMAIS à ton « Mon Drive ».** Elle ne le lit pas, ne le liste pas, n'y
> déplace rien et n'en partage rien. C'est garanti dans le code : toute opération est bornée au
> Drive partagé, et une vérification refuse d'agir sur un fichier qui n'y est pas.

**Le réflexe qui règle tout** : quand tu crées un document de travail, crée-le **directement dans
le Drive partagé**. Un document créé dans « Mon Drive » puis « qu'on déplacera plus tard » ne se
déplace jamais.

---

## 5. Le calendrier d'équipe

Un seul calendrier partagé, `Portail — Équipe`. Il répond à une seule question : **qui est où, et
qu'est-ce qui s'en vient ?**

### Ce qui va dedans

- Les **visites d'immeubles** et les rendez-vous avec un client.
- Les **échéances** qui touchent l'équipe : remise TPS-TVQ, renouvellement d'assurance, fin de bail,
  déclarations.
- Les **absences** : vacances, congés, rendez-vous personnels (juste « Absent », les détails ne
  regardent personne).
- Les **réunions** d'équipe.

### Ce qui ne va PAS dedans

- Ton horaire personnel heure par heure — ça, c'est ton agenda à toi.
- Les tâches. Une tâche n'a pas d'heure de début et de fin : elle va dans ta liste de tâches, pas
  dans le calendrier de tout le monde.
- Les rappels privés.

### Comment nommer un événement

> ## `Type — Sujet — Lieu ou personne`

```
Visite — 245 rue Principale, logement 3 — M. Tremblay
Échéance — Remise TPS-TVQ T1
Rencontre — Immeubles Laflamme — bureau
Absent — Julie
Renouvellement — Assurance responsabilité civile
```

Pas de date dans le titre : le calendrier s'en occupe.

### Inviter, ou juste noter ?

C'est la question qui fait la différence entre un calendrier utile et un calendrier que tout le
monde finit par décocher.

**Invite les gens** (mets-les en participants) quand tu as besoin d'une **réponse** ou d'une
**présence** :
- une réunion où ils doivent être là ;
- une visite où quelqu'un t'accompagne ;
- un rendez-vous client qui bloque leur horaire.

L'invitation apparaît dans leur agenda personnel, avec un « Oui / Non / Peut-être ». Tu sais s'ils
seront là.

**Note simplement** (crée l'événement sans inviter personne) quand c'est une **information** :
- une échéance de remise de taxes ;
- un renouvellement d'assurance ;
- une absence ;
- une visite que tu fais tout seul.

Tout le monde le voit dans le calendrier partagé, personne ne reçoit de courriel, personne n'a à
répondre.

> **La règle d'or** : si la personne n'a rien à décider ni à faire à cette heure-là, **ne
> l'invite pas**. Trois invitations inutiles par semaine, et les gens arrêtent de regarder leurs
> invitations.

**Toujours mettre un lieu** quand il y en a un : l'adresse complète dans le champ « Lieu ». Ça
donne l'itinéraire d'un clic sur le téléphone, en chemin vers l'immeuble.

---

## 6. Le ménage

Un classeur qu'on ne vide jamais devient un grenier. Mais **on ne supprime pas** : on archive.

### La règle de base

> **On ne supprime rien. On déplace dans `90 — Archives`.**

Supprimer, c'est irréversible et ça brise les liens des autres. Archiver, ça coûte zéro : le
stockage du Drive partagé appartient au forfait de l'entreprise, et la recherche continue de
trouver le document.

### Quand archiver

| Quoi | Quand |
|------|-------|
| Dossier d'un client dont le mandat est terminé | 3 mois après la fin du mandat |
| Baux échus et non renouvelés | À la fin du bail |
| Déclarations TPS-TVQ et pièces comptables | Après la production des états financiers de l'année |
| Documents de prospection sur un client qui n'a pas signé | 6 mois après le dernier contact |
| Versions dépassées d'un gabarit dans `_MODÈLES` | Dès qu'un nouveau gabarit le remplace |
| Matériel de vente et présentations périmés | Dès qu'une nouvelle version existe |

> ⚠️ **Attention aux durées légales.** Les pièces comptables et fiscales doivent être conservées
> **six ans** après la fin de l'année d'imposition visée (Revenu Québec et ARC). Archiver, oui ;
> supprimer, **non**. C'est aussi pour ça que la règle est « on ne supprime rien ».

### Le ménage du trimestre — 20 minutes, 4 fois par an

Mets-le au calendrier d'équipe, une fois par trimestre :

1. Ouvre `40 — Clients & Mandats` : déplace dans `90 — Archives` les dossiers des mandats
   terminés depuis plus de 3 mois.
2. Ouvre `90 — Archives` : est-ce qu'un même **type** de document y revient souvent ? C'est qu'il
   mérite son propre dossier. Ajoute-le dans `config.json`, relance
   `node src/cli.mjs drive --apply`, et déplace les documents dedans.
3. Passe les noms de fichiers récents en revue. Un `Scan_2026...` qui traîne ? Renomme-le.
4. Lance `node src/cli.mjs verify` pour confirmer que la structure et les accès sont toujours
   corrects.

---

## Les cinq règles, en résumé

Si tu ne retiens que ça :

1. **`AAAA-MM-JJ — Type — Sujet`**, toujours, sans exception.
2. **Ça concerne un client ? Ça va dans son dossier.** Sinon, remonte les trois questions.
3. **Dans le doute : `90 — Archives`.** Jamais un nouveau dossier créé tout seul.
4. **Rien de personnel dans le Drive partagé. Rien d'entreprise dans ton « Mon Drive ».**
5. **On n'efface pas, on archive.**
