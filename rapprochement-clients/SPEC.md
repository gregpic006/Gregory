# SPEC — Automatisation du cycle bilan → facture → paiement → rapprochement

> Projet **indépendant** du reste du dépôt. Aucune dépendance avec TWIM.

## 1. Contexte métier

Grégory **paie** ses clients. Le cycle actuel, manuel :

1. Il envoie un **bilan** à chaque client (ce qu'il lui doit pour la période).
2. Le client lui renvoie **sa facture**.
3. Il **vérifie** la facture (est-ce qu'elle correspond au bilan ?).
4. Il fait le **paiement**.
5. **Chaque trimestre**, il vérifie que tous les paiements qu'il a faits ont bien été
   déduits du **solde** que le client affiche. Ce solde devrait être à **0**.
   En pratique il ne l'est pas : les clients oublient de déduire un paiement,
   se trompent de montant, comptent une facture deux fois, etc.

**Le travail pénible et répétitif = l'étape 5.** C'est le cœur de l'outil : ne pas se
contenter de dire « ça ne balance pas », mais **expliquer pourquoi**, chiffres à l'appui.

Volume : **plus de 50 clients**. Données : **Google Sheets**. Solution : **Apps Script**.

## 2. Principes directeurs

- **Le classeur est la seule source de vérité.** Aucune base externe, aucun serveur.
- **Le script ne paie jamais tout seul.** Il prépare, vérifie, signale. L'humain décide.
- **Par défaut, les courriels partent en brouillon** (`MODE_ENVOI = Brouillon`), pour que
  Grégory relise avant d'envoyer. Basculer en `Direct` est un choix explicite dans `Paramètres`.
- **Rien n'est détruit.** Les onglets générés sont réécrits par période, jamais effacés en bloc.
- **Tout est journalisé** dans l'onglet `Journal`.
- **Idempotence** : relancer deux fois la même fonction sur la même période ne crée pas de doublons.
- **Argent en cents entiers** dans toute la logique interne (`Math.round(montant * 100)`),
  pour éliminer les erreurs de virgule flottante. On ne compare jamais deux flottants avec `===`.
- **Français** partout : noms de fonctions, variables, commentaires, interface.

## 3. Structure du classeur

Ligne 1 = en-têtes (figée). Données à partir de la ligne 2.
Les modules n'accèdent **jamais** aux colonnes par index codé en dur : ils passent par
la couche `Feuilles.gs` qui mappe les en-têtes vers des objets.

### 3.1 `Clients`
| En-tête | Type | Notes |
|---|---|---|
| ID client | texte | `C-001`. Clé primaire. |
| Nom | texte | |
| Courriel | texte | destinataire principal des bilans |
| Courriels en copie | texte | séparés par `,` ou `;` |
| Actif | liste `Oui`/`Non` | seuls les `Oui` reçoivent un bilan |
| Devise | texte | défaut `CAD` |
| Jour d'envoi | nombre 1-28 | vide = valeur de `Paramètres` |
| Notes | texte | |

### 3.2 `Lignes_bilan`
Ce que Grégory saisit (ou importe) : le détail de ce qu'il doit, par client et par période.
| En-tête | Type |
|---|---|
| ID ligne | texte (`L-000001`, auto) |
| ID client | texte |
| Période | texte `AAAA-MM` |
| Date | date |
| Description | texte |
| Quantité | nombre |
| Prix unitaire | nombre |
| Montant | nombre (= Quantité × Prix unitaire si vide) |
| ID bilan | texte (rempli à la génération) |

### 3.3 `Bilans`
| En-tête | Type | Notes |
|---|---|---|
| ID bilan | texte | `B-C001-2026-06` |
| ID client | texte | |
| Nom client | texte | dénormalisé, pour lecture humaine |
| Période | texte | `AAAA-MM` |
| Date de génération | date | |
| Date d'envoi | date | vide tant que non envoyé |
| Montant du bilan | nombre | somme des `Lignes_bilan` de la période |
| Nombre de lignes | nombre | |
| Statut | liste | `Brouillon`, `Envoyé`, `Facture reçue`, `Vérifié`, `Payé`, `Annulé` |
| ID facture | texte | facture rattachée |
| Notes | texte | |

### 3.4 `Factures`
| En-tête | Type | Notes |
|---|---|---|
| ID facture | texte | `F-000001` |
| ID client | texte | |
| Nom client | texte | |
| N° facture client | texte | numéro tel qu'écrit par le client |
| Date facture | date | |
| Période | texte | `AAAA-MM`, déduite du bilan rattaché |
| Montant avant taxes | nombre | |
| Taxes | nombre | |
| Montant total | nombre | **c'est ce montant qui fait foi** |
| ID bilan | texte | rattachement automatique |
| Statut vérification | liste | `À vérifier`, `Conforme`, `Écart de montant`, `Doublon`, `Sans bilan`, `Rejetée` |
| Écart vs bilan | nombre | `Montant total` − `Montant du bilan` |
| Statut paiement | liste | `Non payée`, `À payer`, `Payée`, `Annulée` |
| Lien courriel | texte (URL) | permalien Gmail |
| Lien pièce jointe | texte (URL) | fichier Drive |
| Notes | texte | commentaire automatique de la vérification |

### 3.5 `Paiements`
| En-tête | Type | Notes |
|---|---|---|
| ID paiement | texte | `P-000001` |
| ID client | texte | |
| Nom client | texte | |
| ID facture | texte | |
| Date paiement | date | |
| Montant | nombre | |
| Méthode | liste | `Virement`, `Chèque`, `Interac`, `Autre` |
| Référence | texte | n° de transaction / chèque |
| Déduit par le client | liste | `À confirmer`, `Oui`, `Non` |
| Confirmé au rapprochement | texte | période où il a été confirmé (`2026-T2`) |
| Notes | texte | |

### 3.6 `Soldes_declares`
Ce que le client dit devoir/être dû — recopié du fichier ou du courriel du client.
| En-tête | Type | Notes |
|---|---|---|
| ID | texte | `S-000001` |
| ID client | texte | |
| Nom client | texte | |
| Période | texte | `AAAA-TN` (ex. `2026-T2`) |
| Date du relevé | date | |
| Solde déclaré | nombre | **convention de signe : voir §4.1** |
| Source | liste | `Courriel`, `Fichier client`, `Téléphone`, `Autre` |
| Notes | texte | |

### 3.7 `Rapprochement` (généré)
Réécrit intégralement **pour la période traitée** à chaque exécution ; les autres périodes
sont conservées (historique).
| En-tête | Type |
|---|---|
| Période | texte |
| ID client | texte |
| Nom client | texte |
| Solde théorique | nombre |
| Solde déclaré | nombre |
| Écart | nombre |
| Verdict | texte (`✅ Balancé`, `⚠️ Écart expliqué`, `❌ Écart inexpliqué`, `❓ Solde non déclaré`) |
| Diagnostic | texte |
| Détail | texte |
| Action suggérée | texte |
| Relance | texte (`—`, `Brouillon créé`, `Envoyée`, `Échec`) |
| Exécuté le | date |

### 3.8 `Journal`
`Horodatage` | `Fonction` | `Niveau` (`INFO`/`AVERT`/`ERREUR`) | `Message` | `Détail`
Plafonné à `JOURNAL_MAX_LIGNES` (5000) : au-delà, les plus anciennes lignes sont purgées.

### 3.9 `Paramètres`
`Clé` | `Valeur` | `Description`. Voir `CONFIG.PARAMETRES_DEFAUT` dans `00_Config.gs`.

### 3.10 `Tableau de bord` (généré)
Synthèse lisible : compteurs par statut, montants en attente, derniers écarts non résolus.

## 4. Règles de gestion

### 4.1 Convention de signe du solde
`Solde déclaré` et `Solde théorique` expriment **ce que Grégory doit encore au client**,
en positif. `0` = tout est réglé. Un solde positif = le client attend encore de l'argent.
Un solde **négatif** = le client a été trop payé.

Beaucoup de clients envoient leur solde en négatif (vu de leur comptabilité, c'est une créance
qui s'éteint). `normaliserSolde_()` gère ça : si `Paramètres.SIGNE_SOLDE_CLIENT = Inversé`,
le montant saisi est multiplié par −1 à la lecture.

### 4.2 Solde théorique
Pour un client, à la fin de la période P :

    solde_théorique = Σ (Montant total des factures dont Statut vérification ∈ {Conforme, Écart de montant}
                         et Statut paiement ≠ Annulée, période ≤ P)
                    − Σ (Montant des paiements, date ≤ fin de P)

Les factures `Doublon`, `Sans bilan` et `Rejetée` sont **exclues** du solde théorique
(elles ne sont pas des dettes reconnues) mais sont listées dans le diagnostic si elles
peuvent expliquer un écart.

### 4.3 Vérification d'une facture
Dans l'ordre, premier verdict qui s'applique :
1. **`Doublon`** — même `ID client` + même `N° facture client` (normalisé : trim, majuscules,
   sans espaces ni tirets) qu'une facture déjà enregistrée. Ou même client + même montant total
   + même période qu'une facture existante non annulée.
2. **`Sans bilan`** — aucun bilan de ce client pour cette période, ou aucun bilan restant à
   rattacher. Rattachement : bilan du même client, même période, sans `ID facture`, statut ≠ `Annulé`.
   À défaut, bilan non rattaché le plus proche en montant (écart relatif < 2 %).
3. **`Conforme`** — `|Montant total − Montant du bilan| ≤ TOLERANCE_CENTS`.
4. **`Écart de montant`** — sinon. `Notes` explicite l'écart, et teste les explications
   courantes : écart == TPS (5 %), == TVQ (9,975 %), == TPS+TVQ, == taxes en trop/en moins,
   == montant d'une ligne du bilan (ligne oubliée ou ajoutée).

Une facture `Conforme` passe le bilan à `Vérifié`. Seules les factures `Conforme` sont
proposées au paiement. Une `Écart de montant` peut être forcée à `Conforme` à la main
(le script respecte une décision humaine : il ne réécrit jamais un statut passé
manuellement à `Conforme` ou `Rejetée`).

### 4.4 Moteur de diagnostic des écarts (le cœur)
Entrée : un client, une période, `écart = solde_théorique − solde_déclaré` (en cents).
Sortie : `{verdict, diagnostic, detail, action}`.

Hypothèses testées, dans cet ordre, la première qui explique **exactement** l'écart gagne :

**Convention de signe — à lire avant toute modification de ce module.**
`écart = solde_théorique − solde_déclaré`, les deux exprimant ce que Grégory doit encore
au client (§4.1). Il en découle mécaniquement :

- **écart < 0** → le solde du client est **trop haut** : il n'a pas retranché quelque chose
  (un paiement reçu), ou il compte une dette que Grégory ne reconnaît pas.
- **écart > 0** → le solde du client est **trop bas** : il a retranché de trop (paiement
  déduit deux fois), ou il n'a pas enregistré une facture qu'il vous a pourtant envoyée.

Chaque hypothèse impose donc un signe. Une hypothèse aveugle au signe produit un diagnostic
non seulement faux, mais **exactement inverse de la réalité** — le pire résultat possible ici,
puisque l'utilisateur va le recopier dans un courriel au client. Le signe attendu est
non négociable et testé.

| # | Hypothèse | Signe | Test |
|---|---|---|---|
| 0 | Rien à expliquer | — | `|écart| ≤ TOLERANCE_CENTS` → `✅ Balancé` |
| 1 | **Paiement(s) non déduit(s)** par le client | `écart < 0` | un sous-ensemble des paiements de la période somme exactement `−écart`. Priorité aux paiements `Déduit par le client ≠ Oui`. |
| 2 | **Facture non comptabilisée** par le client | `écart > 0` | un sous-ensemble des factures **reconnues** (celles qui composent le solde théorique) somme exactement `+écart` |
| 3 | **Paiement déduit deux fois** par le client | `écart > 0` | `écart` == le montant d'un paiement de la période (le client l'a retranché une fois de trop) |
| 4 | **Écart de facturation** | signé | `écart` == somme **signée** des `Écart vs bilan` des factures `Écart de montant` reconnues |
| 5 | **Facture écartée comptée par le client** | `écart < 0` | `−écart` == le montant d'une facture `Doublon` ou `Sans bilan` (le client compte une facture que vous avez écartée) |
| 6 | **Erreur de taxes** | — | `|écart|` == TPS (5 %), TVQ (9,975 %) ou TPS+TVQ d'un montant présent (facture ou bilan) |
| 7 | **Signe inversé** | — | `|solde_théorique + solde_déclaré| ≤ TOLERANCE_CENTS` : le client a inversé le signe de son relevé |
| 8 | **Décalage de période** | — | `|écart|` == le montant d'une facture ou d'un paiement du trimestre **précédent** ou **suivant**. Le texte doit dire dans quel sens. |
| 9 | **Inexpliqué** | — | aucune des précédentes → `❌ Écart inexpliqué`, avec les `CANDIDATS_INEXPLIQUE` montants les plus proches |

`✅ Balancé` pour le cas 0 ; `⚠️ Écart expliqué` pour 1-8 ; `❌ Écart inexpliqué` pour 9 ;
`❓ Solde non déclaré` si aucun `Soldes_declares` pour ce client et cette période.

**Les hypothèses ne raisonnent que sur les pièces qui composent réellement le solde théorique**
(§4.2) — sauf l'hypothèse 5, dont c'est justement l'objet d'examiner les factures exclues.
Accuser une facture `Annulée` d'expliquer un écart est une contradiction : le solde théorique
ne la compte pas.

**Pièces sans date.** Une facture ou un paiement dont la date est vide ou illisible est
**compté** dans le solde théorique (la pièce existe) et **rattaché au trimestre traité** pour
que les hypothèses puissent le nommer. Le rapport doit en plus signaler explicitement ces
lignes (« 2 pièce(s) sans date : lignes 14 et 27 de l'onglet Paiements — complétez la colonne
Date »). Ce qui est interdit, c'est d'utiliser une pièce dans le calcul tout en la rendant
invisible au diagnostic : l'écart serait déclaré inexpliqué alors que sa cause est dans le
classeur.

**Recherche de sous-ensemble (`trouverSousEnsemble_`)** — contrainte de performance et de
lisibilité :
- travailler en **cents entiers** ;
- **la recherche exhaustive des combinaisons de taille 1, 2 puis 3 a toujours lieu**, quel que
  soit le nombre de pièces : ce sont les seules explications qu'un humain accepte de vérifier à
  la main, et ce sont les plus fréquentes. Taille 1 en O(n), taille 2 en O(n) via table de
  hachage, taille 3 en O(n²) via table de hachage, plafonnée à `SOUS_ENSEMBLE_MAX_TAILLE3`
  (200) éléments ;
- **ensuite seulement**, si `n ≤ SOUS_ENSEMBLE_MAX_ELEMENTS` (25), programmation dynamique sur
  les cents avec reconstruction de la solution, plafonnée à `SOUS_ENSEMBLE_MAX_CIBLE` cents
  (5 000 000 = 50 000 $) pour borner la mémoire ; au-delà de ces bornes, abandonner
  proprement en renvoyant `null` ;
- ne jamais renvoyer un sous-ensemble vide, un indice en double, ni une somme approximative ;
- renvoyer des **indices**, pas des montants, pour pouvoir remonter aux pièces d'origine ;
- une cible nulle, une liste vide, ou une cible dépassant la somme des montants positifs
  sortent immédiatement en `null`.

### 4.5 Relance client
Pour chaque ligne `⚠️` ou `❌`, un courriel est préparé : il liste **précisément** ce qui
manque (date, montant, référence, n° de facture), pas un vague « merci de vérifier ».
Un seul courriel par client, même s'il a plusieurs anomalies.

## 5. Contrat des modules

Runtime **V8** (`let`/`const`/fonctions fléchées/gabarits de chaîne autorisés ;
pas de `import`/`export` — tous les fichiers partagent un même espace de noms global).
Suffixe `_` = fonction privée (non exposée au menu).

### `00_Config.gs` *(fourni)*
`CONFIG` : noms d'onglets, schémas de colonnes, statuts, paramètres par défaut, constantes.

### `03_Feuilles.gs` — couche d'accès aux données
```
feuille_(nom)                      -> Sheet (crée si absent via le schéma)
lireTable_(nom)                    -> [{_ligne, <En-tête>: valeur, ...}]
ajouterLignes_(nom, objets)        -> nombre de lignes ajoutées (écriture en un seul setValues)
majLigne_(nom, ligne, patch)       -> void
majLignes_(nom, [{ligne, patch}])  -> void  (regroupe les écritures par colonne)
remplacerPeriode_(nom, colPeriode, periode, objets) -> void (idempotence des onglets générés)
prochainId_(nom, colonne, prefixe, largeur) -> texte (ex. 'F-000042')
lireParametres_()                  -> {CLE: valeur} fusionné avec CONFIG.PARAMETRES_DEFAUT
ecrireParametre_(cle, valeur)      -> void
indexerPar_(objets, champ)         -> Map
```
Règles : une seule lecture `getValues()` par onglet et par exécution (cache mémoire),
écritures groupées, jamais de `setValue()` dans une boucle.

### `09_Journal.gs`
```
journaliser_(fonction, niveau, message, detail)
journalInfo_(fonction, message, detail)
journalAvert_(fonction, message, detail)
journalErreur_(fonction, message, detail)
purgerJournal_()
```
Les écritures du journal sont **tamponnées** en mémoire et vidées en une seule écriture
en fin d'exécution (`viderTamponJournal_()`), appelée par chaque point d'entrée du menu.

### `01_Installation.gs`
```
installer()            // point d'entrée menu : crée/répare tous les onglets, formats,
                       // validations de données, mises en forme conditionnelles, figeage
installerDeclencheurs()// triggers : onOpen, mensuel (bilans), horaire (Gmail), trimestriel
supprimerDeclencheurs()
reparerClasseur_()     // ajoute les colonnes manquantes sans toucher aux données existantes
```
**Non destructif** : si un onglet existe, on ne recrée que ce qui manque.

### `02_Menu.gs`
`onOpen(e)` construit le menu `📋 Automatisation`. Chaque entrée appelle un point d'entrée
qui : journalise le début, exécute, attrape les erreurs, vide le tampon du journal,
affiche un `SpreadsheetApp.getUi().alert()` de résultat lisible.
Helper : `executer_(nom, fn)` qui enveloppe tout ça.

### `04_Bilans.gs`
```
genererBilans()        // agrège Lignes_bilan de la période courante -> Bilans (Brouillon)
envoyerBilans()        // envoie/brouillonne les bilans 'Brouillon' -> 'Envoyé'
construireBilanHtml_(client, bilan, lignes) -> string
periodeCourante_()     -> 'AAAA-MM'
```
Respecte le quota courriel (`MailApp.getRemainingDailyQuota()`) : s'arrête proprement,
journalise ce qui reste à envoyer, et le prochain passage reprend là où il s'est arrêté.

### `05_Factures.gs`
```
importerFacturesGmail()   // étiquette Gmail -> lignes 'À vérifier' + PDF sur Drive
verifierFactures()        // applique §4.3 à toutes les factures 'À vérifier'
rattacherBilan_(facture, bilans) -> bilan|null
expliquerEcartFacture_(facture, bilan, lignes) -> string
```
L'import Gmail est **idempotent** : le `Message-ID` du courriel est stocké en `Notes`
(`[gmail:<id>]`) et un message déjà importé est ignoré. Les courriels traités reçoivent
l'étiquette `…/Traité`.

### `06_Paiements.gs`
```
preparerLotDePaiements()  // factures Conforme + Non payée -> 'À payer' + CSV sur Drive
confirmerLotDePaiements() // 'À payer' -> Paiements + facture 'Payée'
annulerLot()              // remet 'À payer' -> 'Non payée'
```
Le CSV contient : ID facture, Nom client, N° facture, Montant, Date, Référence suggérée.

### `07_Rapprochement.gs`
```
rapprochementTrimestriel()                    // point d'entrée menu, période courante
rapprocherPeriode_(periode)                   -> [lignes de rapprochement]
calculerSoldeTheorique_(clientId, finPeriode, donnees) -> cents
diagnostiquerEcart_(contexte)                 -> {verdict, diagnostic, detail, action}
trouverSousEnsemble_(montantsCents, cibleCents, maxElements) -> [indices] | null
periodeTrimestre_(date)                       -> 'AAAA-TN'
bornesTrimestre_(periode)                     -> {debut: Date, fin: Date}
```
**Aucun accès direct aux feuilles dans les fonctions de calcul** : elles reçoivent leurs
données en paramètre. C'est ce qui les rend testables hors de Google (§7).

### `08_Courriels.gs`
```
envoyerOuBrouillonner_(destinataire, sujet, html, options) -> 'Envoyé'|'Brouillon créé'|'Échec'
relancerClientsEnEcart()   // point d'entrée menu, à partir de l'onglet Rapprochement
construireRelanceHtml_(client, ligneRapprochement, details) -> string
quotaCourrielRestant_()    -> nombre
```

### `10_Tests.gs`
```
lancerTests()   // exécutable depuis le menu ET depuis Node (§7)
```
Tests unitaires sans dépendance Google sur : `trouverSousEnsemble_`, `diagnostiquerEcart_`
(les 10 cas du §4.4), `calculerSoldeTheorique_`, `normaliserSolde_`, `periodeTrimestre_`,
`bornesTrimestre_`, la normalisation des n° de facture, l'arithmétique en cents.
Retourne `{total, reussis, echecs: [...]}`.

## 6. Conventions de code
- Français, `camelCase`, `_` final pour le privé, `SCREAMING_SNAKE` pour les constantes.
- JSDoc sur chaque fonction publique.
- Aucun accès réseau autre que Gmail/Drive/Sheets.
- Aucune fonction ne dépasse ~60 lignes ; extraire des helpers sinon.
- Toute erreur attrapée est journalisée avec `e.message` **et** `e.stack`.
- Pas de `Utilities.sleep()` dans une boucle sur les clients.

## 7. Tests hors Google
`outils/build.mjs` concatène `src/*.gs` (ordre alphabétique) en `dist/Code.gs`.
`outils/test.mjs` charge `dist/Code.gs` dans un `vm` Node avec des doublures de
`SpreadsheetApp`, `GmailApp`, `MailApp`, `DriveApp`, `Logger`, `Utilities`,
`PropertiesService`, `ScriptApp`, puis exécute `lancerTests()` et sort en code ≠ 0
si un test échoue. `npm test` → `node outils/test.mjs`.
