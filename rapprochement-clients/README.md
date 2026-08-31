# Rapprochement clients — automatisation du cycle bilan → facture → paiement

Outil Google Sheets + Apps Script qui automatise ce cycle :

```
1. Vous envoyez un bilan au client          ──►  automatisé (courriel)
2. Le client renvoie sa facture             ──►  importée automatiquement de Gmail
3. Vous vérifiez la facture                 ──►  vérifiée automatiquement contre le bilan
4. Vous payez                               ──►  lot de paiements préparé (CSV pour la banque)
5. Chaque trimestre, vous vérifiez que tous
   vos paiements ont été déduits du solde   ──►  AUTOMATISÉ + le script explique CHAQUE écart
   du client (devrait être à 0)
```

**L'étape 5 est la raison d'être de l'outil.** Il ne se contente pas de dire « ça ne balance
pas » : il vous dit *pourquoi*, avec les pièces exactes en cause.

> Exemple de ce que le script écrit tout seul dans l'onglet `Rapprochement` :
>
> | Client | Solde théorique | Solde déclaré | Écart | Verdict | Diagnostic |
> |---|---|---|---|---|---|
> | Béton Rive-Sud | 0,00 $ | 3 450,00 $ | −3 450,00 $ | ⚠️ Écart expliqué | 2 paiements non déduits : P-000118 du 2026-05-12 (1 200,00 $, réf. VIR-8891) et P-000131 du 2026-06-03 (2 250,00 $, réf. VIR-9042) |
>
> Vous n'avez plus qu'à envoyer la relance déjà rédigée.

---

## Installation (15 minutes, une seule fois)

Vous n'avez rien à installer sur votre ordinateur. Tout se passe dans Google.

### 1. Créer le classeur

Allez sur [sheets.new](https://sheets.new) et nommez le classeur, par exemple
**« Facturation clients »**.

### 2. Ouvrir l'éditeur de script

Dans le classeur : menu **Extensions → Apps Script**. Un nouvel onglet s'ouvre.

### 3. Coller le code

1. Dans l'éditeur, supprimez tout le contenu du fichier `Code.gs` (il contient un
   `function myFunction() {}` vide).
2. Ouvrez le fichier **[`dist/Code.gs`](dist/Code.gs)** de ce dossier, copiez **tout** son
   contenu, et collez-le à la place.
3. Cliquez sur l'icône **💾 Enregistrer**.

> C'est un seul fichier, exprès : rien d'autre à copier.

### 4. Déclarer les autorisations

1. Toujours dans l'éditeur, cliquez sur **⚙️ Paramètres du projet** (à gauche).
2. Cochez **« Afficher le fichier manifeste appsscript.json dans l'éditeur »**.
3. Retournez dans **< > Éditeur**, ouvrez le fichier `appsscript.json` qui vient d'apparaître,
   remplacez son contenu par celui de **[`appsscript.json`](appsscript.json)** de ce dossier,
   et enregistrez.

Ce fichier déclare ce que le script a le droit de faire : lire et écrire *votre* classeur,
envoyer des courriels en *votre* nom, lire l'étiquette Gmail de vos factures, et déposer les
pièces jointes dans *votre* Drive. Rien d'autre. Aucune donnée ne sort de votre compte Google.

### 5. Préparer le classeur

1. Revenez sur le classeur et **rechargez la page** (F5).
2. Un menu **📋 Automatisation** apparaît dans la barre de menus.
3. Cliquez sur **📋 Automatisation → Configuration → Installer ou réparer le classeur**.
4. Google demande une autorisation la première fois :
   *Autoriser → choisissez votre compte → « Paramètres avancés » → « Accéder à … » → Autoriser*.
   L'avertissement « application non validée » est normal : l'application, c'est **votre propre
   script**, dans **votre** compte. Il n'est pas publié, donc Google ne l'a pas vérifié.
5. Le script crée tous les onglets nécessaires.

### 6. Activer l'automatisation

**📋 Automatisation → Configuration → Activer l'automatisation.**

À partir de là, tournent tout seuls :

| Quand | Ce qui se passe |
|---|---|
| Toutes les heures | les nouvelles factures de l'étiquette Gmail sont importées |
| Le jour choisi, chaque mois | les bilans sont générés et préparés |
| Le 1er jour de chaque trimestre | le rapprochement complet est exécuté |

---

## Réglages

Onglet **`Paramètres`** — modifiez uniquement la colonne **Valeur**.

| Clé | À quoi ça sert |
|---|---|
| `COURRIEL_ALERTE` | l'adresse qui reçoit le résumé après chaque exécution automatique |
| `MODE_ENVOI` | **`Brouillon`** (défaut) : les courriels sont préparés dans Gmail, vous les relisez et vous envoyez. `Direct` : envoi immédiat. |
| `TOLERANCE_CENTS` | écart accepté avant de crier à l'erreur (`1` = un cent) |
| `SIGNE_SOLDE_CLIENT` | `Inversé` si vos clients vous envoient leur solde en négatif |
| `JOUR_ENVOI_BILAN` | jour du mois (1 à 28) où les bilans partent |
| `ETIQUETTE_GMAIL` | l'étiquette Gmail où vous classez les factures reçues |
| `DOSSIER_DRIVE` | le dossier Drive où les pièces jointes sont archivées |
| `SIGNATURE` | le texte ajouté au bas de vos courriels |
| `RELANCE_AUTO` | `Oui` pour que les relances d'écart partent sans validation |

> **Commencez en `Brouillon`.** Passez en `Direct` quand vous aurez vu quelques cycles et que
> vous ferez confiance aux courriels générés.

### Dans Gmail

Créez une étiquette **`Factures-clients`** et un filtre qui y range les factures de vos clients
(par exemple : `has:attachment` + expéditeurs concernés). Le script ne regarde que cette
étiquette, et applique `Factures-clients/Traité` à ce qu'il a déjà importé.

---

## Votre travail, une fois installé

### Une fois au départ — onglet `Clients`

Une ligne par client : `ID client` (`C-001`, `C-002`…), `Nom`, `Courriel`, `Actif = Oui`.
C'est le seul onglet vraiment obligatoire à remplir à la main.

### Chaque mois — onglet `Lignes_bilan`

Vous saisissez ce que vous devez : `ID client`, `Période` (`2026-06`), `Description`, `Montant`.
Une ligne par prestation. Puis :

**📋 Automatisation → 1. Générer les bilans du mois** → **2. Envoyer les bilans**

### Quand les factures arrivent

Rien à faire : elles sont importées automatiquement (ou **3. Importer les factures reçues**).
Puis **4. Vérifier les factures**. Le script classe chaque facture :

| Statut | Signification | Ce que vous faites |
|---|---|---|
| ✅ `Conforme` | correspond au bilan | rien — elle part au paiement |
| ⚠️ `Écart de montant` | le montant diffère du bilan | vous tranchez (le script vous dit de combien et propose une explication : TPS, TVQ, ligne oubliée…) |
| ⚠️ `À vérifier` | montant non détecté automatiquement | vous saisissez le montant |
| 🔴 `Doublon` | déjà reçue | vous vérifiez et rejetez |
| 🔴 `Sans bilan` | aucun bilan correspondant | vous vérifiez |

**Une décision que vous prenez à la main n'est jamais réécrite par le script.**

### Pour payer

**5. Préparer le lot de paiements** → un CSV est déposé sur votre Drive avec toutes les factures
conformes non payées. Vous faites vos virements. Puis **6. Confirmer les paiements du lot** : le
script enregistre les paiements et marque les factures comme payées.

### Chaque trimestre — le moment qui vous fait gagner du temps

1. Vos clients vous envoient leur solde. Recopiez-le dans l'onglet **`Soldes_declares`**
   (`ID client`, `Période` = `2026-T2`, `Solde déclaré`).
2. **📋 Automatisation → 7. Rapprochement trimestriel.**
3. Lisez l'onglet **`Rapprochement`** — trié par gravité :

| Verdict | Ce que ça veut dire |
|---|---|
| ✅ **Balancé** | rien à faire |
| ⚠️ **Écart expliqué** | le script a identifié la cause exacte et les pièces en jeu |
| ❌ **Écart inexpliqué** | aucune explication automatique — à investiguer (les 3 montants les plus proches sont listés) |
| ❓ **Solde non déclaré** | ce client ne vous a pas envoyé son solde |

4. **8. Relancer les clients en écart** → un courriel par client, déjà rédigé, listant
   précisément les pièces à vérifier. En mode `Brouillon`, vous les relisez dans Gmail avant
   d'envoyer.

### Ce que le script fait tout seul vs ce que vous décidez

| Le script fait | Vous décidez |
|---|---|
| envoie les bilans | ce que vous devez (`Lignes_bilan`) |
| importe et classe les factures | les factures en écart ou douteuses |
| calcule le solde théorique | quand payer et quoi payer |
| explique chaque écart | ce que vous répondez au client |
| prépare les courriels | quand ils partent (mode `Brouillon`) |

**Le script ne paie jamais rien tout seul et n'envoie jamais d'argent.** Il prépare un CSV ;
c'est vous qui faites les virements dans votre banque.

---

## Comment le solde est calculé

```
solde théorique = Σ factures reconnues (Conforme ou Écart de montant, jusqu'à la fin du trimestre)
                − Σ paiements effectués (jusqu'à la fin du trimestre)

écart = solde théorique − solde déclaré par le client
```

Convention : un solde **positif** = vous devez encore de l'argent au client. `0` = tout est
réglé. **Négatif** = le client a été trop payé.

Quand l'écart n'est pas nul, le script teste dans l'ordre les causes réelles, et retient la
**première qui explique l'écart au cent près** :

1. un ou plusieurs **paiements non déduits** par le client (la cause la plus fréquente) ;
2. une **facture que le client n'a pas comptabilisée** ;
3. un **paiement compté deux fois** ;
4. un **écart de facturation** (la facture ne correspondait pas au bilan) ;
5. une **facture doublon** comptée par le client ;
6. une **erreur de taxes** (TPS 5 %, TVQ 9,975 %, ou les deux) ;
7. un **signe inversé** dans le relevé du client ;
8. un **décalage de période** (pièce du trimestre voisin) ;
9. sinon : **inexpliqué**, avec les montants les plus proches pour vous orienter.

Le script ne devine pas : il ne retient une explication que si elle tombe **exactement** juste.
S'il ne trouve pas, il le dit plutôt que d'inventer.

---

## Dépannage

| Symptôme | Cause et solution |
|---|---|
| Le menu 📋 n'apparaît pas | rechargez la page (F5). Sinon, le code n'est pas enregistré : retournez dans Apps Script et cliquez sur 💾. |
| « Autorisation requise » | normal la première fois : *Autoriser → Paramètres avancés → Accéder à…* |
| Les bilans ne partent pas tous | quota Gmail atteint (100/jour en compte gratuit, 1 500 en Workspace). Le script s'arrête proprement et reprend au passage suivant. |
| Une facture reste « À vérifier » | le montant n'a pas pu être lu dans le courriel. Saisissez-le, puis relancez **4. Vérifier les factures**. |
| Un client apparaît « Solde non déclaré » | aucune ligne dans `Soldes_declares` pour ce client et ce trimestre. |
| Tous les soldes sont à l'envers | passez `SIGNE_SOLDE_CLIENT` à `Inversé` et relancez le rapprochement. |
| Quelque chose a échoué | onglet **`Journal`** : chaque exécution y laisse le détail, y compris les erreurs. |

Une erreur n'abîme jamais vos données : le script n'efface aucune ligne que vous avez saisie.
Vous pouvez relancer n'importe quelle étape autant de fois que vous voulez — les fonctions sont
conçues pour ne pas créer de doublon.

---

## Pour un développeur

```
rapprochement-clients/
├── README.md            ce fichier
├── SPEC.md              le contrat complet (règles de gestion, schéma, contrat des modules)
├── appsscript.json      manifeste Apps Script (scopes OAuth)
├── src/*.gs             les modules source
├── dist/Code.gs         le fichier unique à coller dans Apps Script (généré)
└── outils/
    ├── build.mjs        concatène src/*.gs → dist/Code.gs
    └── test.mjs         exécute la suite de tests hors Google (doublures des API)
```

```bash
npm run build   # régénère dist/Code.gs
npm test        # lance les tests du moteur de rapprochement (sans Google)
```

Le moteur de rapprochement (`src/07_Rapprochement.gs`) est volontairement **pur** : aucune de ses
fonctions de calcul ne touche à `SpreadsheetApp`. C'est ce qui permet de le tester réellement en
Node, hors de Google — et c'est la partie qu'il faut tester, puisque c'est elle qui produit les
diagnostics auxquels l'utilisateur va faire confiance.

Aucune dépendance npm.
