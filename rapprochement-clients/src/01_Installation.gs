/**
 * 01_Installation.gs — Mise en route et entretien du classeur.
 *
 * C'est le fichier qu'on lance en premier, et qu'on peut relancer autant de fois
 * qu'on veut : il ne fait qu'AJOUTER ce qui manque.
 *
 *   installer()                          crée ou répare tous les onglets
 *   installerDeclencheurs()              met l'automatisation en marche
 *   supprimerDeclencheurs()              l'arrête
 *   reparerClasseur_()                   onglets, colonnes, formats, couleurs
 *   majTableauDeBord_()                  régénère la page de synthèse
 *
 * Trois promesses :
 *   1. Rien n'est effacé. Une colonne existante n'est jamais déplacée ni supprimée ;
 *      les colonnes manquantes sont ajoutées À LA FIN. Aucune ligne de données
 *      saisie par un humain n'est touchée.
 *   2. Relancer ne double rien : mêmes onglets, mêmes règles de couleur,
 *      mêmes déclencheurs (les anciens sont retirés avant d'en recréer).
 *   3. Une valeur déjà saisie dans l'onglet Paramètres n'est jamais écrasée.
 */

/** Fond des en-têtes des onglets que vous remplissez à la main. */
const INSTALLATION_FOND_ENTETE_ = '#1c4587';

/** Fond des en-têtes des onglets générés par le script (gris = ne rien y saisir). */
const INSTALLATION_FOND_ENTETE_GENERE_ = '#5b5b5b';

/** Couleur du texte des en-têtes. */
const INSTALLATION_TEXTE_ENTETE_ = '#ffffff';

/** Couleurs des mises en forme conditionnelles. */
const INSTALLATION_VERT_ = '#d9ead3';
const INSTALLATION_ORANGE_ = '#fff2cc';
const INSTALLATION_ROUGE_ = '#f4cccc';
const INSTALLATION_GRIS_ = '#efefef';
const INSTALLATION_ROUGE_TEXTE_ = '#cc0000';

/** Fond des lignes de titre du tableau de bord. */
const INSTALLATION_FOND_SECTION_ = '#e8eaed';

/** Fond des lignes ordinaires du tableau de bord. */
const INSTALLATION_FOND_NORMAL_ = '#ffffff';

/** Heure (0-23) du passage quotidien qui prépare les bilans. */
const INSTALLATION_HEURE_BILANS_ = 7;

/** Heure (0-23) du passage quotidien qui déclenche le rapprochement trimestriel. */
const INSTALLATION_HEURE_RAPPROCHEMENT_ = 8;

/** Largeur (en pixels) à partir de laquelle on rogne le texte au lieu de l'enrouler. */
const INSTALLATION_LARGEUR_TEXTE_LONG_ = 300;

// ---------------------------------------------------------------------------
// Point d'entrée : installer ou réparer le classeur
// ---------------------------------------------------------------------------

/**
 * Prépare le classeur de bout en bout : onglets, en-têtes, largeurs, formats,
 * listes déroulantes, couleurs, ordre des onglets, réglages par défaut et
 * tableau de bord. Peut être relancé à tout moment sans rien casser.
 * @return {string} Le récapitulatif affiché à l'utilisateur.
 */
function installer() {
  const nomFonction = 'installer';
  let message = '';
  try {
    journalInfo_(nomFonction, 'Mise en route du classeur.', '');
    const rapport = reparerClasseur_();
    const parametres = installationRemplirParametres_();
    const deplaces = installationOrdonnerOnglets_();
    majTableauDeBord_();
    message = installationRecapitulatif_(rapport, parametres, deplaces);
    journalInfo_(nomFonction, 'Classeur installé ou réparé.', message);
  } catch (e) {
    message = `L'installation s'est arrêtée sur une erreur :\n\n${e.message}\n\n` +
      `Le détail complet est dans l'onglet « ${CONFIG.ONGLETS.JOURNAL.nom} ».`;
    journalErreur_(nomFonction, "Échec de l'installation du classeur.",
      installationDetailErreur_(e));
  }
  viderTamponJournal_();
  installationAlerte_('Installation du classeur', message);
  return message;
}

/**
 * Crée les onglets manquants, complète les colonnes manquantes et applique toute
 * la mise en forme. Ne supprime ni ne déplace jamais une colonne existante.
 * @return {{crees: Array<string>, existants: Array<string>,
 *           colonnes: Array<{onglet: string, colonnes: Array<string>}>}} Ce qui a été fait.
 */
function reparerClasseur_() {
  const classeur = feuillesClasseur_();
  const rapport = { crees: [], existants: [], colonnes: [] };
  Object.keys(CONFIG.ONGLETS).forEach((cle) => {
    const schema = CONFIG.ONGLETS[cle];
    const existait = !!classeur.getSheetByName(schema.nom);
    const feuille = feuille_(schema.nom);
    if (existait) rapport.existants.push(schema.nom);
    else rapport.crees.push(schema.nom);

    const ajoutees = installationCompleterColonnes_(feuille, schema);
    if (ajoutees.length) rapport.colonnes.push({ onglet: schema.nom, colonnes: ajoutees });
    installationHabiller_(feuille, schema);
    installationMiseEnFormeConditionnelle_(feuille, schema);
  });
  journalInfo_('reparerClasseur_',
    `${rapport.crees.length} onglet(s) créé(s), ${rapport.existants.length} déjà présent(s).`,
    rapport.colonnes.map((a) => `${a.onglet} : ${a.colonnes.join(', ')}`).join(' | '));
  return rapport;
}

/**
 * Ajoute, à la fin de l'onglet, les colonnes prévues par le modèle qui manquent.
 * Les colonnes existantes gardent leur place et leur contenu.
 * @param {Sheet} feuille Onglet à compléter.
 * @param {Object} schema Entrée de CONFIG.ONGLETS décrivant l'onglet.
 * @return {Array<string>} Noms des colonnes ajoutées (vide si rien à faire).
 */
function installationCompleterColonnes_(feuille, schema) {
  const entetes = entetesTable_(feuille.getName());
  const manquantes = schema.colonnes
    .map((colonne) => colonne.nom)
    .filter((nom) => entetes.indexOf(nom) < 0);
  if (!manquantes.length) return [];

  const depart = Math.max(feuille.getLastColumn(), 0) + 1;
  const necessaires = depart + manquantes.length - 1;
  if (feuille.getMaxColumns() < necessaires) {
    feuille.insertColumnsAfter(feuille.getMaxColumns(), necessaires - feuille.getMaxColumns());
  }
  feuille.getRange(1, depart, 1, manquantes.length).setValues([manquantes]);
  invaliderCacheFeuille_(feuille.getName());
  journalInfo_('installationCompleterColonnes_',
    `Colonnes ajoutées à « ${schema.nom} ».`, manquantes.join(', '));
  return manquantes;
}

// ---------------------------------------------------------------------------
// Mise en forme d'un onglet
// ---------------------------------------------------------------------------

/**
 * Applique largeurs, formats de nombre et de date, listes déroulantes, en-tête
 * en gras sur fond coloré, note d'aide sur A1 et figeage de la ligne 1.
 * @param {Sheet} feuille Onglet à habiller.
 * @param {Object} schema Entrée de CONFIG.ONGLETS décrivant l'onglet.
 * @return {void}
 */
function installationHabiller_(feuille, schema) {
  const entetes = entetesTable_(feuille.getName());
  const nbLignes = feuille.getMaxRows() - 1;
  schema.colonnes.forEach((colonne) => {
    const index = entetes.indexOf(colonne.nom) + 1;
    if (index < 1) return;
    if (colonne.largeur && feuille.getColumnWidth(index) !== colonne.largeur) {
      feuille.setColumnWidth(index, colonne.largeur);
    }
    if (nbLignes > 0) installationFormatColonne_(feuille, schema, colonne, index, nbLignes);
  });
  installationEntete_(feuille, schema, entetes.length);
  if (feuille.getFrozenRows() !== 1) feuille.setFrozenRows(1);
}

/**
 * Formate une colonne de données (de la ligne 2 au bas de l'onglet).
 * Les colonnes de texte passent en format « texte brut » : c'est ce qui empêche
 * Google de transformer une période « 2026-06 » en date.
 * @param {Sheet} feuille Onglet concerné.
 * @param {Object} schema Entrée de CONFIG.ONGLETS.
 * @param {Object} colonne Descripteur de colonne (nom, type, liste, largeur).
 * @param {number} index Numéro réel de la colonne dans l'onglet (1-indexé).
 * @param {number} nbLignes Nombre de lignes à formater sous l'en-tête.
 * @return {void}
 */
function installationFormatColonne_(feuille, schema, colonne, index, nbLignes) {
  const plage = feuille.getRange(2, index, nbLignes, 1);
  if (colonne.type === 'montant') {
    plage.setNumberFormat(CONFIG.FORMAT_MONTANT).setHorizontalAlignment('right');
  } else if (colonne.type === 'nombre') {
    plage.setNumberFormat('#,##0.##').setHorizontalAlignment('right');
  } else if (colonne.type === 'date') {
    plage.setNumberFormat(schema.nom === CONFIG.ONGLETS.JOURNAL.nom
      ? CONFIG.FORMAT_HORODATAGE
      : CONFIG.FORMAT_DATE);
  } else {
    plage.setNumberFormat('@');
  }
  if (Number(colonne.largeur) >= INSTALLATION_LARGEUR_TEXTE_LONG_) {
    plage.setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  }
  if (colonne.type === 'liste' && colonne.liste && colonne.liste.length) {
    plage.setDataValidation(installationValidation_(colonne));
  }
}

/**
 * Construit la liste déroulante d'une colonne. La saisie d'une autre valeur est
 * signalée mais pas bloquée : on n'empêche jamais l'utilisateur d'écrire.
 * @param {Object} colonne Descripteur de colonne, avec sa propriété `liste`.
 * @return {DataValidation} La règle de validation à poser.
 */
function installationValidation_(colonne) {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList(colonne.liste, true)
    .setAllowInvalid(true)
    .setHelpText(`Valeurs attendues dans « ${colonne.nom} » : ${colonne.liste.join(', ')}.`)
    .build();
}

/**
 * Met la ligne 1 en gras sur fond coloré et pose la note d'aide sur la cellule A1.
 * @param {Sheet} feuille Onglet concerné.
 * @param {Object} schema Entrée de CONFIG.ONGLETS.
 * @param {number} nbColonnes Nombre de colonnes à habiller.
 * @return {void}
 */
function installationEntete_(feuille, schema, nbColonnes) {
  const largeur = Math.max(Number(nbColonnes) || 0, 1);
  feuille.getRange(1, 1, 1, largeur)
    .setFontWeight('bold')
    .setFontColor(INSTALLATION_TEXTE_ENTETE_)
    .setBackground(schema.genere ? INSTALLATION_FOND_ENTETE_GENERE_ : INSTALLATION_FOND_ENTETE_)
    .setVerticalAlignment('middle')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  feuille.getRange(1, 1).setNote(installationNoteAide_(schema));
}

/**
 * Rédige la note d'aide affichée quand on survole la cellule A1 d'un onglet.
 * @param {Object} schema Entrée de CONFIG.ONGLETS.
 * @return {string} Le texte de la note.
 */
function installationNoteAide_(schema) {
  const lignes = [];
  if (schema.aide) lignes.push(schema.aide);
  lignes.push('');
  lignes.push(schema.genere
    ? "Onglet généré par le script : ne saisissez rien ici, il est réécrit automatiquement."
    : "Onglet que vous remplissez. Ne renommez pas les en-têtes de la ligne 1.");
  lignes.push('');
  lignes.push(`Colonnes attendues : ${schema.colonnes.map((c) => c.nom).join(' | ')}`);
  return lignes.join('\n');
}

// ---------------------------------------------------------------------------
// Mises en forme conditionnelles (les couleurs qui se mettent toutes seules)
// ---------------------------------------------------------------------------

/**
 * Applique les couleurs automatiques prévues pour l'onglet, s'il y en a.
 * @param {Sheet} feuille Onglet concerné.
 * @param {Object} schema Entrée de CONFIG.ONGLETS.
 * @return {number} Nombre de règles posées.
 */
function installationMiseEnFormeConditionnelle_(feuille, schema) {
  if (schema.nom === CONFIG.ONGLETS.FACTURES.nom) return installationReglesFactures_(feuille);
  if (schema.nom === CONFIG.ONGLETS.RAPPROCHEMENT.nom) {
    return installationReglesRapprochement_(feuille);
  }
  return 0;
}

/**
 * Colore la colonne « Statut vérification » de l'onglet Factures :
 * vert = conforme, orange = à regarder, rouge = à rejeter.
 * @param {Sheet} feuille Onglet Factures.
 * @return {number} Nombre de règles posées.
 */
function installationReglesFactures_(feuille) {
  const entetes = entetesTable_(feuille.getName());
  const index = entetes.indexOf(installationColonnes_().factureStatutVerif) + 1;
  const nbLignes = feuille.getMaxRows() - 1;
  if (index < 1 || nbLignes < 1) return 0;

  const plage = feuille.getRange(2, index, nbLignes, 1);
  const regles = [installationRegleTexte_(plage, STATUT_VERIF.CONFORME, INSTALLATION_VERT_)];
  [STATUT_VERIF.ECART, STATUT_VERIF.A_VERIFIER].forEach((valeur) => {
    regles.push(installationRegleTexte_(plage, valeur, INSTALLATION_ORANGE_));
  });
  [STATUT_VERIF.DOUBLON, STATUT_VERIF.SANS_BILAN, STATUT_VERIF.REJETEE].forEach((valeur) => {
    regles.push(installationRegleTexte_(plage, valeur, INSTALLATION_ROUGE_));
  });
  return installationRemplacerRegles_(feuille, [index], regles);
}

/**
 * Colore la colonne « Verdict » de l'onglet Rapprochement et met en rouge tout
 * écart différent de zéro.
 * @param {Sheet} feuille Onglet Rapprochement.
 * @return {number} Nombre de règles posées.
 */
function installationReglesRapprochement_(feuille) {
  const colonnesConfig = installationColonnes_();
  const entetes = entetesTable_(feuille.getName());
  const nbLignes = feuille.getMaxRows() - 1;
  if (nbLignes < 1) return 0;

  const iVerdict = entetes.indexOf(colonnesConfig.rapprochementVerdict) + 1;
  const iEcart = entetes.indexOf(colonnesConfig.rapprochementEcart) + 1;
  const colonnes = [];
  const regles = [];
  if (iVerdict > 0) {
    const plage = feuille.getRange(2, iVerdict, nbLignes, 1);
    colonnes.push(iVerdict);
    regles.push(installationRegleTexte_(plage, VERDICT.BALANCE, INSTALLATION_VERT_));
    regles.push(installationRegleTexte_(plage, VERDICT.EXPLIQUE, INSTALLATION_ORANGE_));
    regles.push(installationRegleTexte_(plage, VERDICT.INEXPLIQUE, INSTALLATION_ROUGE_));
    regles.push(installationRegleTexte_(plage, VERDICT.NON_DECLARE, INSTALLATION_GRIS_));
  }
  if (iEcart > 0) {
    colonnes.push(iEcart);
    regles.push(installationRegleEcartNonNul_(feuille, iEcart, nbLignes));
  }
  return colonnes.length ? installationRemplacerRegles_(feuille, colonnes, regles) : 0;
}

/**
 * Règle « cette cellule vaut exactement ce texte → ce fond ».
 * @param {Range} plage Plage sur laquelle la règle s'applique.
 * @param {string} valeur Texte recherché.
 * @param {string} fond Couleur de fond (hexadécimal).
 * @return {ConditionalFormatRule} La règle prête à poser.
 */
function installationRegleTexte_(plage, valeur, fond) {
  return SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(valeur)
    .setBackground(fond)
    .setRanges([plage])
    .build();
}

/**
 * Règle « écart non vide et différent de zéro → rouge gras ». La formule évite
 * de colorer les cellules encore vides.
 * @param {Sheet} feuille Onglet concerné.
 * @param {number} index Numéro de la colonne d'écart (1-indexé).
 * @param {number} nbLignes Nombre de lignes couvertes.
 * @return {ConditionalFormatRule} La règle prête à poser.
 */
function installationRegleEcartNonNul_(feuille, index, nbLignes) {
  const lettre = installationLettreColonne_(index);
  return SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=AND($${lettre}2<>"",$${lettre}2<>0)`)
    .setFontColor(INSTALLATION_ROUGE_TEXTE_)
    .setBold(true)
    .setRanges([feuille.getRange(2, index, nbLignes, 1)])
    .build();
}

/**
 * Remplace les règles de couleur portant sur certaines colonnes, en laissant
 * intactes celles que l'utilisateur a posées ailleurs. C'est ce qui rend
 * l'installation ré-exécutable sans empiler les règles.
 * @param {Sheet} feuille Onglet concerné.
 * @param {Array<number>} colonnes Numéros de colonnes gérés par le script.
 * @param {Array<ConditionalFormatRule>} nouvelles Règles à poser.
 * @return {number} Nombre de règles posées.
 */
function installationRemplacerRegles_(feuille, colonnes, nouvelles) {
  const conservees = feuille.getConditionalFormatRules()
    .filter((regle) => !installationRegleTouche_(regle, colonnes));
  feuille.setConditionalFormatRules(conservees.concat(nouvelles));
  return nouvelles.length;
}

/**
 * Vrai si une règle existante couvre au moins une des colonnes visées.
 * @param {ConditionalFormatRule} regle Règle à examiner.
 * @param {Array<number>} colonnes Numéros de colonnes (1-indexés).
 * @return {boolean}
 */
function installationRegleTouche_(regle, colonnes) {
  const plages = regle.getRanges();
  for (let i = 0; i < plages.length; i++) {
    const debut = plages[i].getColumn();
    const fin = plages[i].getLastColumn();
    for (let j = 0; j < colonnes.length; j++) {
      if (colonnes[j] >= debut && colonnes[j] <= fin) return true;
    }
  }
  return false;
}

/**
 * Convertit un numéro de colonne en lettre ('A', 'B', ... 'AA').
 * @param {number} index Numéro de colonne (1-indexé).
 * @return {string} La lettre de colonne.
 */
function installationLettreColonne_(index) {
  let reste = Math.max(1, Math.round(Number(index) || 1));
  let lettre = '';
  while (reste > 0) {
    const modulo = (reste - 1) % 26;
    lettre = String.fromCharCode(65 + modulo) + lettre;
    reste = Math.floor((reste - 1) / 26);
  }
  return lettre;
}

// ---------------------------------------------------------------------------
// Réglages et ordre des onglets
// ---------------------------------------------------------------------------

/**
 * Garnit l'onglet Paramètres : ajoute les réglages absents avec leur valeur par
 * défaut et leur description. Une valeur déjà saisie n'est JAMAIS écrasée ;
 * une description n'est complétée que si la cellule est vide.
 * @return {{ajoutes: Array<string>, completes: number}} Ce qui a été ajouté ou complété.
 */
function installationRemplirParametres_() {
  const colonnes = installationColonnes_();
  const nom = CONFIG.ONGLETS.PARAMETRES.nom;
  const index = new Map();
  lireTable_(nom).forEach((ligne) => {
    const cle = String(ligne[colonnes.parametreCle] || '').trim();
    if (cle && !index.has(cle)) index.set(cle, ligne);
  });

  const ajouts = [];
  const majs = [];
  Object.keys(CONFIG.PARAMETRES_DEFAUT).forEach((cle) => {
    const defaut = CONFIG.PARAMETRES_DEFAUT[cle];
    const description = CONFIG.DESCRIPTIONS_PARAMETRES[cle] || '';
    const ligne = index.get(cle);
    if (!ligne) {
      const nouvelle = {};
      nouvelle[colonnes.parametreCle] = cle;
      nouvelle[colonnes.parametreValeur] = defaut;
      nouvelle[colonnes.parametreDescription] = description;
      ajouts.push(nouvelle);
      return;
    }
    const patch = {};
    if (installationEstVide_(ligne[colonnes.parametreValeur]) && defaut !== '') {
      patch[colonnes.parametreValeur] = defaut;
    }
    if (installationEstVide_(ligne[colonnes.parametreDescription]) && description) {
      patch[colonnes.parametreDescription] = description;
    }
    if (Object.keys(patch).length) majs.push({ ligne: ligne._ligne, patch: patch });
  });

  if (majs.length) majLignes_(nom, majs);
  if (ajouts.length) ajouterLignes_(nom, ajouts);
  return { ajoutes: ajouts.map((o) => o[colonnes.parametreCle]), completes: majs.length };
}

/**
 * Remet les onglets dans l'ordre défini par ORDRE_ONGLETS. Les onglets que vous
 * avez ajoutés vous-même restent à la suite, sans être touchés.
 * @return {number} Nombre d'onglets déplacés.
 */
function installationOrdonnerOnglets_() {
  const classeur = feuillesClasseur_();
  const actif = classeur.getActiveSheet();
  let deplaces = 0;
  ORDRE_ONGLETS.forEach((nom, position) => {
    const feuille = classeur.getSheetByName(nom);
    if (!feuille || feuille.getIndex() === position + 1) return;
    classeur.setActiveSheet(feuille);
    classeur.moveActiveSheet(position + 1);
    deplaces++;
  });
  if (actif) classeur.setActiveSheet(actif);
  return deplaces;
}

/**
 * Rédige le récapitulatif affiché à la fin de l'installation.
 * @param {Object} rapport Résultat de reparerClasseur_().
 * @param {Object} parametres Résultat de installationRemplirParametres_().
 * @param {number} deplaces Nombre d'onglets remis dans l'ordre.
 * @return {string} Texte lisible, prêt pour l'alerte.
 */
function installationRecapitulatif_(rapport, parametres, deplaces) {
  const lignes = ['Le classeur est prêt.', ''];
  lignes.push(rapport.crees.length
    ? `Onglets créés (${rapport.crees.length}) : ${rapport.crees.join(', ')}`
    : 'Onglets créés : aucun, tout était déjà en place.');
  lignes.push(rapport.existants.length
    ? `Onglets déjà présents (${rapport.existants.length}) : ${rapport.existants.join(', ')}`
    : 'Onglets déjà présents : aucun.');
  if (rapport.colonnes.length) {
    lignes.push('');
    lignes.push("Colonnes ajoutées (aucune donnée existante n'a été touchée) :");
    rapport.colonnes.forEach((ajout) => {
      lignes.push(`   • ${ajout.onglet} : ${ajout.colonnes.join(', ')}`);
    });
  }
  lignes.push('');
  lignes.push(parametres.ajoutes.length
    ? `Réglages ajoutés (${parametres.ajoutes.length}) : ${parametres.ajoutes.join(', ')}`
    : 'Réglages : tous déjà présents, vos valeurs ont été conservées.');
  if (parametres.completes) {
    lignes.push(`Réglages complétés (valeur ou description vide) : ${parametres.completes}.`);
  }
  if (deplaces) lignes.push(`Onglets remis dans l'ordre : ${deplaces}.`);
  lignes.push('');
  lignes.push("Vous pouvez relancer cette commande autant de fois que vous voulez : " +
    "elle n'ajoute que ce qui manque et n'efface jamais rien.");
  return lignes.join('\n');
}

// ---------------------------------------------------------------------------
// Automatisation : les déclencheurs
// ---------------------------------------------------------------------------

/**
 * Met l'automatisation en marche. Les anciens déclencheurs sont d'abord retirés
 * pour éviter les doublons, puis quatre sont créés : le menu à l'ouverture,
 * l'import Gmail toutes les heures, la préparation des bilans une fois par mois
 * (déclencheur quotidien qui ne fait rien les autres jours) et le rapprochement
 * au premier jour de chaque trimestre (même principe).
 * @return {string} Le récapitulatif affiché à l'utilisateur.
 */
function installerDeclencheurs() {
  const nomFonction = 'installerDeclencheurs';
  let message = '';
  try {
    const supprimes = supprimerDeclencheurs();
    const jour = installationJourEnvoiBilan_(lireParametres_());
    ScriptApp.newTrigger('onOpen').forSpreadsheet(feuillesClasseur_()).onOpen().create();
    ScriptApp.newTrigger('importerFacturesGmail').timeBased().everyHours(1).create();
    ScriptApp.newTrigger('genererEtEnvoyerBilansAuto').timeBased().everyDays(1)
      .atHour(INSTALLATION_HEURE_BILANS_).inTimezone(CONFIG.FUSEAU).create();
    ScriptApp.newTrigger('rapprochementAutoSiDebutTrimestre').timeBased().everyDays(1)
      .atHour(INSTALLATION_HEURE_RAPPROCHEMENT_).inTimezone(CONFIG.FUSEAU).create();
    message = installationTexteAutomatisation_(jour, supprimes);
    journalInfo_(nomFonction, 'Automatisation activée (4 déclencheurs).', message);
  } catch (e) {
    message = `L'automatisation n'a pas pu être activée :\n\n${e.message}\n\n` +
      `Le détail est dans l'onglet « ${CONFIG.ONGLETS.JOURNAL.nom} ».`;
    journalErreur_(nomFonction, "Échec de l'activation de l'automatisation.",
      installationDetailErreur_(e));
  }
  viderTamponJournal_();
  installationAlerte_('Automatisation', message);
  return message;
}

/**
 * Rédige, en français clair, ce que l'automatisation fera désormais.
 * @param {number} jour Jour du mois où les bilans partent.
 * @param {number} supprimes Nombre d'anciens déclencheurs retirés.
 * @return {string} Texte lisible.
 */
function installationTexteAutomatisation_(jour, supprimes) {
  const heureBilans = `${INSTALLATION_HEURE_BILANS_} h`;
  const heureRapprochement = `${INSTALLATION_HEURE_RAPPROCHEMENT_} h`;
  return [
    "L'automatisation est active.",
    '',
    '• Toutes les heures : les nouvelles factures de votre étiquette Gmail sont importées.',
    `• Chaque jour vers ${heureBilans} : si on est le ${jour} du mois, les bilans sont ` +
      'générés puis préparés (en brouillon tant que MODE_ENVOI reste « Brouillon »).',
    `• Chaque jour vers ${heureRapprochement} : si on est le premier jour d'un trimestre, ` +
      'le rapprochement complet est lancé.',
    "• À chaque ouverture du classeur : le menu " + CONFIG.MENU + ' est ajouté.',
    '',
    supprimes
      ? `${supprimes} ancien(s) déclencheur(s) ont été retirés pour éviter les doublons.`
      : "Aucun ancien déclencheur à retirer.",
    '',
    "Pour tout arrêter : Configuration → Désactiver l'automatisation.",
  ].join('\n');
}

/**
 * Retire tous les déclencheurs du projet. C'est ce qui garantit qu'on ne se
 * retrouve jamais avec deux fois le même traitement automatique.
 * @return {number} Nombre de déclencheurs supprimés.
 */
function supprimerDeclencheurs() {
  const nomFonction = 'supprimerDeclencheurs';
  let supprimes = 0;
  const noms = [];
  try {
    ScriptApp.getProjectTriggers().forEach((declencheur) => {
      noms.push(declencheur.getHandlerFunction());
      ScriptApp.deleteTrigger(declencheur);
      supprimes++;
    });
    journalInfo_(nomFonction, `${supprimes} déclencheur(s) supprimé(s).`, noms.join(', '));
  } catch (e) {
    journalErreur_(nomFonction, 'Impossible de supprimer les déclencheurs.',
      installationDetailErreur_(e));
  }
  return supprimes;
}

// ---------------------------------------------------------------------------
// Fonctions d'aiguillage appelées par les déclencheurs quotidiens
// ---------------------------------------------------------------------------

/**
 * Appelée tous les jours par un déclencheur. Elle ne fait quelque chose que le
 * jour du mois choisi dans le réglage JOUR_ENVOI_BILAN : Apps Script ne sait pas
 * planifier « le 5 de chaque mois », alors on vérifie la date et on ressort.
 * @return {string} Ce qui a été fait (ou pourquoi rien n'a été fait).
 */
function genererEtEnvoyerBilansAuto() {
  const nomFonction = 'genererEtEnvoyerBilansAuto';
  let message = '';
  try {
    const jourVoulu = installationJourEnvoiBilan_(lireParametres_());
    const aujourdhui = installationJourDuMois_(new Date());
    if (aujourdhui !== jourVoulu) {
      message = `Rien à faire aujourd'hui : les bilans partent le ${jourVoulu} du mois.`;
    } else {
      journalInfo_(nomFonction, `Jour d'envoi des bilans (${jourVoulu}) : lancement automatique.`, '');
      message = installationExecuterBilans_();
      journalInfo_(nomFonction, 'Passage mensuel terminé.', message);
    }
  } catch (e) {
    message = `Échec du passage automatique : ${e.message}`;
    journalErreur_(nomFonction, 'Échec du passage mensuel des bilans.',
      installationDetailErreur_(e));
  }
  viderTamponJournal_();
  return message;
}

/**
 * Enchaîne la génération puis l'envoi des bilans, en isolant les erreurs :
 * si la génération échoue, on le sait, et l'envoi est quand même tenté.
 * @return {string} Résumé des deux étapes.
 */
function installationExecuterBilans_() {
  const etapes = [];
  etapes.push(installationLancer_('genererBilans',
    typeof genererBilans === 'function' ? genererBilans : null));
  etapes.push(installationLancer_('envoyerBilans',
    typeof envoyerBilans === 'function' ? envoyerBilans : null));
  return etapes.join(' ; ');
}

/**
 * Appelée tous les jours par un déclencheur. Elle ne fait quelque chose que le
 * premier jour d'un trimestre (selon le réglage TRIMESTRE_DECALAGE_MOIS).
 * @return {string} Ce qui a été fait (ou pourquoi rien n'a été fait).
 */
function rapprochementAutoSiDebutTrimestre() {
  const nomFonction = 'rapprochementAutoSiDebutTrimestre';
  let message = '';
  try {
    const decalage = parametreNombre_(lireParametres_(), 'TRIMESTRE_DECALAGE_MOIS', 0);
    if (!installationEstDebutTrimestre_(new Date(), decalage)) {
      message = "Rien à faire aujourd'hui : le rapprochement est lancé le premier jour " +
        'de chaque trimestre.';
    } else {
      journalInfo_(nomFonction, "Premier jour du trimestre : rapprochement automatique.", '');
      message = installationLancer_('rapprochementTrimestriel',
        typeof rapprochementTrimestriel === 'function' ? rapprochementTrimestriel : null);
      journalInfo_(nomFonction, 'Rapprochement automatique terminé.', message);
    }
  } catch (e) {
    message = `Échec du rapprochement automatique : ${e.message}`;
    journalErreur_(nomFonction, 'Échec du rapprochement automatique.',
      installationDetailErreur_(e));
  }
  viderTamponJournal_();
  return message;
}

/**
 * Vrai si la date est le premier jour d'un trimestre.
 * @param {Date} date Date à tester.
 * @param {number} decalageMois Décalage de l'exercice, en mois (0 = année civile).
 * @return {boolean}
 */
function installationEstDebutTrimestre_(date, decalageMois) {
  if (installationJourDuMois_(date) !== 1) return false;
  const decalage = ((Math.round(Number(decalageMois) || 0) % 3) + 3) % 3;
  const mois = installationMoisDeLAnnee_(date);
  return ((((mois - 1 - decalage) % 3) + 3) % 3) === 0;
}

/**
 * Jour du mois, lu dans le fuseau horaire du projet.
 * @param {Date} date Date à lire.
 * @return {number} Jour de 1 à 31.
 */
function installationJourDuMois_(date) {
  try {
    return Number(Utilities.formatDate(date, CONFIG.FUSEAU, 'd'));
  } catch (e) {
    return date.getDate();
  }
}

/**
 * Mois de l'année, lu dans le fuseau horaire du projet.
 * @param {Date} date Date à lire.
 * @return {number} Mois de 1 à 12.
 */
function installationMoisDeLAnnee_(date) {
  try {
    return Number(Utilities.formatDate(date, CONFIG.FUSEAU, 'M'));
  } catch (e) {
    return date.getMonth() + 1;
  }
}

/**
 * Jour du mois choisi pour l'envoi des bilans, ramené entre 1 et 28.
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {number} Jour de 1 à 28.
 */
function installationJourEnvoiBilan_(params) {
  const jour = Math.round(parametreNombre_(params, 'JOUR_ENVOI_BILAN', 1));
  if (!jour || jour < 1) return 1;
  return jour > 28 ? 28 : jour;
}

// ---------------------------------------------------------------------------
// Tableau de bord
// ---------------------------------------------------------------------------

/**
 * Régénère entièrement l'onglet Tableau de bord : compteurs par statut, montants
 * en attente, écarts non résolus du dernier trimestre, date de dernière
 * exécution et quota de courriels restant.
 * @return {number} Nombre de lignes écrites.
 */
function majTableauDeBord_() {
  const nom = CONFIG.ONGLETS.TABLEAU_DE_BORD.nom;
  try {
    const colonnes = installationColonnes_();
    const lignes = []
      .concat(installationBlocSysteme_(colonnes))
      .concat(installationBlocClients_(colonnes))
      .concat(installationBlocBilans_(colonnes))
      .concat(installationBlocFactures_(colonnes))
      .concat(installationBlocPaiements_(colonnes))
      .concat(installationBlocRapprochement_(colonnes));
    installationViderTableauDeBord_(nom);
    ajouterLignes_(nom, lignes);
    installationHabillerTableauDeBord_(nom, lignes, colonnes);
    journalInfo_('majTableauDeBord_',
      `Tableau de bord régénéré (${lignes.length} lignes).`, '');
    return lignes.length;
  } catch (e) {
    journalErreur_('majTableauDeBord_', "Le tableau de bord n'a pas pu être régénéré.",
      installationDetailErreur_(e));
    return 0;
  }
}

/**
 * Efface le contenu du tableau de bord sous l'en-tête. C'est un onglet généré :
 * il ne contient aucune saisie humaine.
 * @param {string} nom Nom de l'onglet.
 * @return {void}
 */
function installationViderTableauDeBord_(nom) {
  const feuille = feuille_(nom);
  const derniere = feuille.getLastRow();
  if (derniere > 1) {
    const plage = feuille.getRange(2, 1, derniere - 1, Math.max(feuille.getLastColumn(), 1));
    plage.clearContent();
    plage.setFontWeight('normal').setBackground(null);
  }
  invaliderCacheFeuille_(nom);
}

/**
 * Met les lignes de titre du tableau de bord en gras sur fond gris, en deux
 * écritures groupées (jamais une cellule à la fois).
 * @param {string} nom Nom de l'onglet.
 * @param {Array<Object>} lignes Lignes qui viennent d'être écrites.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {void}
 */
function installationHabillerTableauDeBord_(nom, lignes, colonnes) {
  if (!lignes.length) return;
  const feuille = feuille_(nom);
  const nbColonnes = CONFIG.ONGLETS.TABLEAU_DE_BORD.colonnes.length;
  const poids = [];
  const fonds = [];
  lignes.forEach((ligne) => {
    const section = installationEstVide_(ligne[colonnes.tdbValeur]) &&
      String(ligne[colonnes.tdbIndicateur] || '').indexOf('—') === 0;
    const rangeePoids = [];
    const rangeeFonds = [];
    for (let i = 0; i < nbColonnes; i++) {
      rangeePoids.push(section ? 'bold' : 'normal');
      rangeeFonds.push(section ? INSTALLATION_FOND_SECTION_ : INSTALLATION_FOND_NORMAL_);
    }
    poids.push(rangeePoids);
    fonds.push(rangeeFonds);
  });
  const plage = feuille.getRange(2, 1, lignes.length, nbColonnes);
  plage.setFontWeights(poids);
  plage.setBackgrounds(fonds);
}

/**
 * Bloc « État du système » : dernière exécution, quota de courriels,
 * automatisation, mode d'envoi.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {Array<Object>} Lignes du tableau de bord.
 */
function installationBlocSysteme_(colonnes) {
  const params = lireParametres_();
  const quota = installationQuotaCourriel_();
  const declencheurs = installationCompterDeclencheurs_();
  return [
    installationSectionTdb_(colonnes, 'État du système'),
    installationLigneTdb_(colonnes, 'Dernière mise à jour', installationHorodatage_(new Date()),
      'Cette page est régénérée à chaque exécution du script.'),
    installationLigneTdb_(colonnes, "Courriels encore envoyables aujourd'hui",
      quota === null ? 'inconnu' : quota,
      'Quota quotidien de Google, remis à zéro chaque nuit.'),
    installationLigneTdb_(colonnes, 'Automatisation',
      declencheurs === null ? 'inconnue' : (declencheurs > 0 ? 'Active' : 'Inactive'),
      declencheurs ? `${declencheurs} déclencheur(s) installé(s).`
        : `Menu ${CONFIG.MENU} → Configuration → Activer l'automatisation.`),
    installationLigneTdb_(colonnes, "Mode d'envoi des courriels", params.MODE_ENVOI,
      CONFIG.DESCRIPTIONS_PARAMETRES.MODE_ENVOI),
  ];
}

/**
 * Bloc « Clients » : combien de clients reçoivent un bilan.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {Array<Object>} Lignes du tableau de bord.
 */
function installationBlocClients_(colonnes) {
  const clients = lireTable_(CONFIG.ONGLETS.CLIENTS.nom);
  const parActif = installationCompterPar_(clients, colonnes.clientActif, '');
  const actifs = installationEntree_(parActif, colonnes.clientActifOui).n;
  return [
    installationSectionTdb_(colonnes, 'Vos clients'),
    installationLigneTdb_(colonnes, 'Clients actifs', actifs,
      `${clients.length} client(s) enregistré(s), dont ${clients.length - actifs} inactif(s).`),
  ];
}

/**
 * Bloc « Bilans » : un compteur et un montant par statut.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {Array<Object>} Lignes du tableau de bord.
 */
function installationBlocBilans_(colonnes) {
  const bilans = lireTable_(CONFIG.ONGLETS.BILANS.nom);
  const parStatut = installationCompterPar_(bilans, colonnes.bilanStatut, colonnes.bilanMontant);
  const lignes = [installationSectionTdb_(colonnes, 'Bilans envoyés aux clients')];
  Object.keys(STATUT_BILAN).forEach((cle) => {
    const statut = STATUT_BILAN[cle];
    const entree = installationEntree_(parStatut, statut);
    lignes.push(installationLigneTdb_(colonnes, `Bilans « ${statut} »`, entree.n,
      `Total : ${formaterMontant_(entree.cents)}`));
  });
  return lignes;
}

/**
 * Bloc « Factures » : compteurs par statut de vérification, montant en attente
 * de vérification et montant en attente de paiement.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {Array<Object>} Lignes du tableau de bord.
 */
function installationBlocFactures_(colonnes) {
  const factures = lireTable_(CONFIG.ONGLETS.FACTURES.nom);
  const parStatut = installationCompterPar_(factures, colonnes.factureStatutVerif,
    colonnes.factureMontant);
  const lignes = [installationSectionTdb_(colonnes, 'Factures reçues')];
  Object.keys(STATUT_VERIF).forEach((cle) => {
    const statut = STATUT_VERIF[cle];
    const entree = installationEntree_(parStatut, statut);
    lignes.push(installationLigneTdb_(colonnes, `Factures « ${statut} »`, entree.n,
      `Total : ${formaterMontant_(entree.cents)}`));
  });
  const aVerifier = installationEntree_(parStatut, STATUT_VERIF.A_VERIFIER);
  const aPayer = installationMontantsAPayer_(factures, colonnes);
  lignes.push(installationLigneTdb_(colonnes, 'Montant en attente de vérification',
    formaterMontant_(aVerifier.cents),
    `${aVerifier.n} facture(s) que le script n'a pas encore pu valider.`));
  lignes.push(installationLigneTdb_(colonnes, 'Montant en attente de paiement',
    formaterMontant_(aPayer.nonPayee.cents),
    `${aPayer.nonPayee.n} facture(s) conforme(s) pas encore payée(s).`));
  lignes.push(installationLigneTdb_(colonnes, 'Montant dans le lot de paiement en cours',
    formaterMontant_(aPayer.aPayer.cents),
    `${aPayer.aPayer.n} facture(s) marquée(s) « ${STATUT_PAIEMENT.A_PAYER} ».`));
  return lignes;
}

/**
 * Additionne les factures conformes qui restent à payer, en cents entiers.
 * @param {Array<Object>} factures Lignes de l'onglet Factures.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {{nonPayee: {n: number, cents: number}, aPayer: {n: number, cents: number}}}
 */
function installationMontantsAPayer_(factures, colonnes) {
  const resultat = { nonPayee: { n: 0, cents: 0 }, aPayer: { n: 0, cents: 0 } };
  factures.forEach((facture) => {
    const verification = String(facture[colonnes.factureStatutVerif] || '').trim();
    if (verification !== STATUT_VERIF.CONFORME) return;
    const paiement = String(facture[colonnes.factureStatutPaiement] || '').trim();
    const cents = enCents_(facture[colonnes.factureMontant]);
    if (paiement === STATUT_PAIEMENT.A_PAYER) {
      resultat.aPayer.n++;
      resultat.aPayer.cents += cents;
    } else if (paiement !== STATUT_PAIEMENT.PAYEE && paiement !== STATUT_PAIEMENT.ANNULEE) {
      resultat.nonPayee.n++;
      resultat.nonPayee.cents += cents;
    }
  });
  return resultat;
}

/**
 * Bloc « Paiements » : ce qui a été payé, et ce que les clients n'ont pas encore
 * confirmé avoir déduit de leur solde.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {Array<Object>} Lignes du tableau de bord.
 */
function installationBlocPaiements_(colonnes) {
  const paiements = lireTable_(CONFIG.ONGLETS.PAIEMENTS.nom);
  const parDeduction = installationCompterPar_(paiements, colonnes.paiementDeduit,
    colonnes.paiementMontant);
  let total = 0;
  paiements.forEach((paiement) => { total += enCents_(paiement[colonnes.paiementMontant]); });
  const confirmes = installationEntree_(parDeduction, colonnes.paiementDeduitOui);
  const nonConfirmes = paiements.length - confirmes.n;
  return [
    installationSectionTdb_(colonnes, 'Paiements que vous avez faits'),
    installationLigneTdb_(colonnes, 'Paiements enregistrés', paiements.length,
      `Total : ${formaterMontant_(total)}`),
    installationLigneTdb_(colonnes, 'Paiements pas encore confirmés par le client', nonConfirmes,
      `Total non confirmé : ${formaterMontant_(total - confirmes.cents)}`),
  ];
}

/**
 * Bloc « Rapprochement » : l'état du dernier trimestre rapproché et le nombre
 * d'écarts qui restent à régler.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {Array<Object>} Lignes du tableau de bord.
 */
function installationBlocRapprochement_(colonnes) {
  const toutes = lireTable_(CONFIG.ONGLETS.RAPPROCHEMENT.nom);
  const periodes = toutes
    .map((ligne) => String(ligne[colonnes.rapprochementPeriode] || '').trim())
    .filter((periode) => periode !== '')
    .sort();
  const derniere = periodes.length ? periodes[periodes.length - 1] : '';
  const lignes = [installationSectionTdb_(colonnes, 'Rapprochement trimestriel')];
  if (!derniere) {
    lignes.push(installationLigneTdb_(colonnes, 'Dernier trimestre rapproché', 'aucun',
      `Lancez le rapprochement depuis le menu ${CONFIG.MENU}.`));
    return lignes;
  }
  const duTrimestre = toutes.filter((ligne) =>
    String(ligne[colonnes.rapprochementPeriode] || '').trim() === derniere);
  const parVerdict = installationCompterPar_(duTrimestre, colonnes.rapprochementVerdict, '');
  const nonResolus = duTrimestre.length -
    installationEntree_(parVerdict, VERDICT.BALANCE).n;
  lignes.push(installationLigneTdb_(colonnes, 'Dernier trimestre rapproché', derniere,
    `${duTrimestre.length} client(s) analysé(s), ` +
    `${installationEntree_(parVerdict, VERDICT.BALANCE).n} balancé(s).`));
  lignes.push(installationLigneTdb_(colonnes, 'Écarts non résolus', nonResolus,
    installationDetailVerdicts_(parVerdict)));
  return lignes;
}

/**
 * Détaille les verdicts autres que « balancé », pour la ligne des écarts.
 * @param {Map} parVerdict Comptage renvoyé par installationCompterPar_().
 * @return {string} Texte lisible.
 */
function installationDetailVerdicts_(parVerdict) {
  return [VERDICT.EXPLIQUE, VERDICT.INEXPLIQUE, VERDICT.NON_DECLARE]
    .map((verdict) => `${installationEntree_(parVerdict, verdict).n} × ${verdict}`)
    .join('   ');
}

// ---------------------------------------------------------------------------
// Petits utilitaires du module
// ---------------------------------------------------------------------------

/**
 * Noms de colonnes utilisés par ce module, lus une seule fois depuis CONFIG.
 * Les regrouper ici évite de disperser des positions dans tout le fichier :
 * si l'ordre des colonnes change dans 00_Config.gs, c'est le seul endroit à relire.
 * @return {Object} Dictionnaire de noms de colonnes.
 */
function installationColonnes_() {
  const onglets = CONFIG.ONGLETS;
  return {
    clientActif: onglets.CLIENTS.colonnes[4].nom,                 // Actif
    clientActifOui: onglets.CLIENTS.colonnes[4].liste[0],         // Oui
    bilanMontant: onglets.BILANS.colonnes[6].nom,                 // Montant du bilan
    bilanStatut: onglets.BILANS.colonnes[8].nom,                  // Statut
    factureMontant: onglets.FACTURES.colonnes[8].nom,             // Montant total
    factureStatutVerif: onglets.FACTURES.colonnes[10].nom,        // Statut vérification
    factureStatutPaiement: onglets.FACTURES.colonnes[12].nom,     // Statut paiement
    paiementMontant: onglets.PAIEMENTS.colonnes[5].nom,           // Montant
    paiementDeduit: onglets.PAIEMENTS.colonnes[8].nom,            // Déduit par le client
    paiementDeduitOui: onglets.PAIEMENTS.colonnes[8].liste[1],    // Oui
    rapprochementPeriode: onglets.RAPPROCHEMENT.colonnes[0].nom,  // Période
    rapprochementEcart: onglets.RAPPROCHEMENT.colonnes[5].nom,    // Écart
    rapprochementVerdict: onglets.RAPPROCHEMENT.colonnes[6].nom,  // Verdict
    parametreCle: onglets.PARAMETRES.colonnes[0].nom,             // Clé
    parametreValeur: onglets.PARAMETRES.colonnes[1].nom,          // Valeur
    parametreDescription: onglets.PARAMETRES.colonnes[2].nom,     // Description
    tdbIndicateur: onglets.TABLEAU_DE_BORD.colonnes[0].nom,       // Indicateur
    tdbValeur: onglets.TABLEAU_DE_BORD.colonnes[1].nom,           // Valeur
    tdbDetail: onglets.TABLEAU_DE_BORD.colonnes[2].nom,           // Détail
  };
}

/**
 * Compte les lignes par valeur d'une colonne, et additionne un montant en cents.
 * @param {Array<Object>} objets Lignes lues par lireTable_().
 * @param {string} champCle Colonne qui sert de clé de regroupement.
 * @param {string} [champMontant] Colonne de montant à additionner (facultatif).
 * @return {Map<string, {n: number, cents: number}>} Comptage par valeur.
 */
function installationCompterPar_(objets, champCle, champMontant) {
  const compte = new Map();
  (objets || []).forEach((objet) => {
    const brut = objet[champCle];
    const cle = String(brut === null || brut === undefined ? '' : brut).trim();
    const entree = compte.get(cle) || { n: 0, cents: 0 };
    entree.n += 1;
    if (champMontant) entree.cents += enCents_(objet[champMontant]);
    compte.set(cle, entree);
  });
  return compte;
}

/**
 * Lit une entrée du comptage, avec des zéros par défaut.
 * @param {Map<string, {n: number, cents: number}>} compte Comptage.
 * @param {string} cle Valeur cherchée.
 * @return {{n: number, cents: number}}
 */
function installationEntree_(compte, cle) {
  return compte.get(cle) || { n: 0, cents: 0 };
}

/**
 * Construit une ligne du tableau de bord.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @param {string} indicateur Libellé affiché.
 * @param {*} valeur Valeur affichée.
 * @param {string} [detail] Explication en clair.
 * @return {Object} Ligne prête pour ajouterLignes_().
 */
function installationLigneTdb_(colonnes, indicateur, valeur, detail) {
  const ligne = {};
  ligne[colonnes.tdbIndicateur] = indicateur;
  ligne[colonnes.tdbValeur] = (valeur === null || valeur === undefined) ? '' : valeur;
  ligne[colonnes.tdbDetail] = detail || '';
  return ligne;
}

/**
 * Construit une ligne de titre du tableau de bord.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @param {string} titre Titre de la section.
 * @return {Object} Ligne prête pour ajouterLignes_().
 */
function installationSectionTdb_(colonnes, titre) {
  return installationLigneTdb_(colonnes, `— ${titre} —`, '', '');
}

/**
 * Nombre de courriels que Google accepte encore d'envoyer aujourd'hui.
 * @return {number|null} Le quota restant, ou null s'il est illisible.
 */
function installationQuotaCourriel_() {
  try {
    if (typeof quotaCourrielRestant_ === 'function') return quotaCourrielRestant_();
    return MailApp.getRemainingDailyQuota();
  } catch (e) {
    journalAvert_('installationQuotaCourriel_', 'Quota de courriels illisible.',
      installationDetailErreur_(e));
    return null;
  }
}

/**
 * Nombre de déclencheurs installés sur le projet.
 * @return {number|null} Le nombre, ou null si l'information est inaccessible.
 */
function installationCompterDeclencheurs_() {
  try {
    return ScriptApp.getProjectTriggers().length;
  } catch (e) {
    return null;
  }
}

/**
 * Appelle une fonction d'un autre module en isolant ses erreurs : un échec ne
 * doit jamais empêcher la suite d'un traitement automatique.
 * @param {string} nom Nom de la fonction, pour le journal.
 * @param {Function|null} appel La fonction elle-même, ou null si absente.
 * @return {string} Ce qui s'est passé, en clair.
 */
function installationLancer_(nom, appel) {
  if (typeof appel !== 'function') {
    journalAvert_('installationLancer_', `La fonction ${nom} est absente : étape ignorée.`, '');
    return `${nom} : étape ignorée (fonction absente)`;
  }
  try {
    appel();
    return `${nom} : fait`;
  } catch (e) {
    journalErreur_('installationLancer_', `Échec de ${nom}.`, installationDetailErreur_(e));
    return `${nom} : échec (${e.message})`;
  }
}

/**
 * Met une erreur à plat pour le journal : message ET pile d'appels.
 * @param {*} e Erreur attrapée.
 * @return {string} Texte à journaliser.
 */
function installationDetailErreur_(e) {
  if (!e) return '';
  const message = e.message === undefined ? String(e) : e.message;
  const pile = e.stack === undefined ? '' : e.stack;
  return `${message}\n${pile}`.trim();
}

/**
 * Vrai si la valeur est vide (rien, chaîne vide ou seulement des espaces).
 * @param {*} valeur Valeur à tester.
 * @return {boolean}
 */
function installationEstVide_(valeur) {
  if (valeur === null || valeur === undefined) return true;
  return String(valeur).trim() === '';
}

/**
 * Horodatage lisible « AAAA-MM-JJ HH:MM », dans le fuseau du projet.
 * @param {Date} date Date à formater.
 * @return {string} Texte lisible.
 */
function installationHorodatage_(date) {
  try {
    return Utilities.formatDate(date, CONFIG.FUSEAU, 'yyyy-MM-dd HH:mm');
  } catch (e) {
    return formaterDate_(date);
  }
}

/**
 * Affiche un message à l'utilisateur, s'il y a bien quelqu'un devant l'écran.
 *
 * Deux cas où l'on n'ouvre pas de fenêtre, et ce n'est pas une erreur :
 *   - appelé par le menu, c'est executer_() (02_Menu.gs) qui affiche déjà le
 *     texte renvoyé : une deuxième fenêtre identique n'apporterait rien ;
 *   - appelé par un déclencheur, il n'y a tout simplement pas d'interface.
 * Dans les deux cas le récapitulatif reste renvoyé par la fonction et écrit
 * dans le Journal.
 * @param {string} titre Titre de la fenêtre.
 * @param {string} message Texte affiché.
 * @return {void}
 */
function installationAlerte_(titre, message) {
  if (typeof executer_ === 'function') return;
  try {
    const ui = SpreadsheetApp.getUi();
    ui.alert(titre, message, ui.ButtonSet.OK);
  } catch (e) {
    journalSecours_('installationAlerte_', `${titre}\n${message}`);
  }
}
