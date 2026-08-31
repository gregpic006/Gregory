/**
 * 02_Menu.gs — Le menu « 📋 Automatisation » et tous les points d'entrée humains.
 *
 * Ce fichier ne contient AUCUNE logique métier. Il numérote les actions dans
 * l'ordre réel du travail, annonce ce qui va se passer (combien d'éléments,
 * mode Brouillon ou Direct), demande confirmation avant tout envoi de courriel
 * ou tout changement de statut en masse, puis délègue au module concerné.
 *
 * Tous les points d'entrée passent par executer_() : trace de début, exécution,
 * capture des erreurs (message ET pile dans l'onglet Journal, jamais à l'écran),
 * vidage du tampon du journal dans tous les cas, puis une alerte finale rédigée
 * pour quelqu'un qui n'est pas informaticien.
 */

/**
 * Colonnes lues par les compteurs du menu. Les noms viennent tous de CONFIG :
 * aucun en-tête n'est écrit en dur ici.
 */
const MENU_COL_ = {
  BILAN_STATUT: CONFIG.ONGLETS.BILANS.colonnes[8].nom,              // Statut
  BILAN_MONTANT: CONFIG.ONGLETS.BILANS.colonnes[6].nom,             // Montant du bilan
  FACTURE_ID: CONFIG.ONGLETS.FACTURES.colonnes[0].nom,              // ID facture
  FACTURE_CLIENT: CONFIG.ONGLETS.FACTURES.colonnes[1].nom,          // ID client
  FACTURE_VERIFICATION: CONFIG.ONGLETS.FACTURES.colonnes[10].nom,   // Statut vérification
  FACTURE_PAIEMENT: CONFIG.ONGLETS.FACTURES.colonnes[12].nom,       // Statut paiement
  FACTURE_TOTAL: CONFIG.ONGLETS.FACTURES.colonnes[8].nom,           // Montant total
  RAPPROCHEMENT_PERIODE: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[0].nom,
  RAPPROCHEMENT_VERDICT: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[6].nom,
};

// ---------------------------------------------------------------------------
// Construction du menu
// ---------------------------------------------------------------------------

/**
 * Ajoute le menu du classeur à chaque ouverture. Ne doit jamais échouer :
 * si le classeur n'est pas encore installé, le menu s'affiche quand même et
 * propose l'installation en premier.
 * @param {Object} [e] Événement d'ouverture fourni par Google (non utilisé).
 * @return {void}
 */
function onOpen(e) {
  try {
    const ui = SpreadsheetApp.getUi();
    menuConstruire_(ui).addToUi();
  } catch (erreur) {
    menuSecours_(erreur);
  }
}

/**
 * Construit le menu complet, dans l'ordre réel du travail.
 * @param {Object} ui Interface renvoyée par SpreadsheetApp.getUi().
 * @return {Object} Le menu, prêt à recevoir addToUi().
 */
function menuConstruire_(ui) {
  const menu = ui.createMenu(CONFIG.MENU);
  if (!menuClasseurInstalle_()) {
    menu.addItem('⚠️ Commencer ici : installer le classeur', 'menuInstaller');
    menu.addSeparator();
  }
  menu.addItem('1. Générer les bilans du mois', 'menuGenererBilans');
  menu.addItem('2. Envoyer les bilans', 'menuEnvoyerBilans');
  menu.addItem('3. Importer les factures reçues (Gmail)', 'menuImporterFactures');
  menu.addItem('4. Vérifier les factures', 'menuVerifierFactures');
  menu.addItem('5. Préparer le lot de paiements', 'menuPreparerLotPaiements');
  menu.addItem('6. Confirmer les paiements du lot', 'menuConfirmerLotPaiements');
  menu.addItem('Annuler le lot de paiements en cours', 'menuAnnulerLotPaiements');
  menu.addSeparator();
  menu.addItem('7. Rapprochement trimestriel', 'menuRapprochementTrimestriel');
  menu.addItem('8. Relancer les clients en écart', 'menuRelancerEcarts');
  menu.addSeparator();
  menu.addSubMenu(ui.createMenu('Configuration')
    .addItem('Installer ou réparer le classeur', 'menuInstaller')
    .addItem("Activer l'automatisation", 'menuActiverAutomatisation')
    .addItem("Désactiver l'automatisation", 'menuDesactiverAutomatisation')
    .addItem('Vider le journal', 'menuViderJournal'));
  menu.addSubMenu(ui.createMenu('Aide')
    .addItem("Mode d'emploi", 'afficherModeEmploi')
    .addItem('Lancer les tests', 'menuLancerTests'));
  return menu;
}

/**
 * Menu minimal, posé quand la construction normale a échoué : l'utilisateur
 * garde toujours de quoi installer le classeur et lire l'aide.
 * @param {*} erreur Erreur d'origine, tracée dans le journal d'exécution.
 * @return {void}
 */
function menuSecours_(erreur) {
  journalSecours_('onOpen', erreur);
  try {
    SpreadsheetApp.getUi().createMenu(CONFIG.MENU)
      .addItem('Installer ou réparer le classeur', 'menuInstaller')
      .addItem("Mode d'emploi", 'afficherModeEmploi')
      .addToUi();
  } catch (e) {
    journalSecours_('onOpen', e);
  }
}

/**
 * Dit si le classeur a déjà été installé, sans rien créer : on regarde
 * simplement si l'onglet Paramètres existe. (Seul endroit du module qui touche
 * SpreadsheetApp : toute lecture de données passe par 03_Feuilles.gs.)
 * @return {boolean} Vrai si le classeur semble installé.
 */
function menuClasseurInstalle_() {
  try {
    const classeur = SpreadsheetApp.getActiveSpreadsheet();
    if (!classeur) return false;
    return !!classeur.getSheetByName(CONFIG.ONGLETS.PARAMETRES.nom);
  } catch (e) {
    return false;
  }
}

/**
 * Interrompt une action avec un message clair si le classeur n'est pas installé.
 * @return {void}
 */
function menuExigerInstallation_() {
  if (menuClasseurInstalle_()) return;
  throw new Error("Le classeur n'est pas encore préparé. Ouvrez « " + CONFIG.MENU +
    " → Configuration → Installer ou réparer le classeur », puis recommencez cette action.");
}

// ---------------------------------------------------------------------------
// Enveloppe commune à tous les points d'entrée
// ---------------------------------------------------------------------------

/**
 * Exécute une action du menu de bout en bout : journalise le début, exécute,
 * attrape toute erreur (message + pile dans le Journal), vide le tampon du
 * journal dans tous les cas, puis affiche un résultat lisible.
 * @param {string} nom Nom de l'action, tel qu'il apparaît dans le menu.
 * @param {function():*} fn Traitement à exécuter. Peut renvoyer une chaîne ou
 *     un objet {titre, message} qui devient le contenu de l'alerte.
 * @return {*} Ce qu'a renvoyé fn, ou null en cas d'erreur.
 */
function executer_(nom, fn) {
  const debut = new Date();
  let resultat = null;
  let alerte = { titre: '✅ Terminé', message: 'Le traitement est terminé.' };
  try {
    journalInfo_(nom, 'Début du traitement.');
    resultat = fn();
    alerte = menuResultatAlerte_(resultat);
    journalInfo_(nom, `Traitement terminé en ${menuDuree_(debut)}.`, alerte.message);
  } catch (e) {
    const pile = (e && e.stack) ? `${e.message}\n${e.stack}` : e;
    journalErreur_(nom, `Échec : ${menuTexteCourt_(e && e.message ? e.message : e, 300)}`, pile);
    alerte = { titre: '❌ Cette action n\'a pas abouti', message: menuMessageErreur_(e) };
    resultat = null;
  } finally {
    try {
      viderTamponJournal_();
    } catch (eJournal) {
      journalSecours_(nom, eJournal);
    }
  }
  menuAlerte_(`${nom} — ${alerte.titre}`, alerte.message);
  return resultat;
}

/**
 * Traduit ce qu'a renvoyé un module en titre et message d'alerte.
 * @param {*} resultat Chaîne, objet {titre, message}, autre objet, ou rien.
 * @return {{titre: string, message: string}} Contenu de l'alerte.
 */
function menuResultatAlerte_(resultat) {
  const titreDefaut = '✅ Terminé';
  if (resultat === null || resultat === undefined || resultat === '') {
    return { titre: titreDefaut, message: 'Le traitement s\'est terminé sans anomalie.' };
  }
  if (typeof resultat === 'string') return { titre: titreDefaut, message: resultat };
  if (typeof resultat === 'object') {
    const titre = resultat.titre ? String(resultat.titre) : titreDefaut;
    if (resultat.message !== null && resultat.message !== undefined) {
      return { titre: titre, message: String(resultat.message) };
    }
    return { titre: titre, message: menuObjetEnTexte_(resultat) };
  }
  return { titre: titreDefaut, message: String(resultat) };
}

/**
 * Met en forme un objet de résultat en lignes « clé : valeur » lisibles.
 * @param {Object} objet Résultat renvoyé par un module.
 * @return {string} Texte affichable, ou un message générique.
 */
function menuObjetEnTexte_(objet) {
  const lignes = [];
  Object.keys(objet).forEach((cle) => {
    if (lignes.length >= 12 || cle.charAt(0) === '_') return;
    const valeur = objet[cle];
    if (valeur === null || valeur === undefined) return;
    if (Array.isArray(valeur)) {
      lignes.push(`${cle} : ${valeur.length}`);
    } else if (typeof valeur !== 'object' && typeof valeur !== 'function') {
      lignes.push(`${cle} : ${menuTexteCourt_(valeur, 120)}`);
    }
  });
  return lignes.length ? lignes.join('\n') : 'Le traitement s\'est terminé sans anomalie.';
}

/**
 * Compose le message affiché quand une action a échoué. Jamais de pile
 * d'exécution à l'écran : elle est dans le Journal.
 * @param {*} e Erreur attrapée.
 * @return {string} Message rassurant et actionnable.
 */
function menuMessageErreur_(e) {
  const brut = (e && e.message) ? String(e.message) : String(e || 'raison inconnue');
  const propre = brut.replace(/\s+/g, ' ').trim();
  return "Le traitement n'a pas pu aller jusqu'au bout.\n\nRaison : " +
    menuTexteCourt_(propre, 400) +
    "\n\nAucune donnée que vous avez saisie n'a été supprimée. Corrigez le point " +
    "signalé, puis relancez la même action : elle peut être relancée sans risque.";
}

/**
 * Durée écoulée depuis un instant donné, en texte court.
 * @param {Date} debut Instant de départ.
 * @return {string} Ex. « 3 s ».
 */
function menuDuree_(debut) {
  const secondes = Math.max(0, Math.round((new Date().getTime() - debut.getTime()) / 1000));
  return `${secondes} s`;
}

// ---------------------------------------------------------------------------
// Dialogues (alerte, confirmation)
// ---------------------------------------------------------------------------

/**
 * Renvoie l'interface du classeur, ou null quand il n'y en a pas (exécution
 * déclenchée automatiquement, ou lancée depuis l'éditeur de script).
 * @return {Object|null} L'objet Ui, ou null.
 */
function menuUi_() {
  try {
    return SpreadsheetApp.getUi();
  } catch (e) {
    return null;
  }
}

/**
 * Affiche le résultat d'une action. Sans interface, le message part dans le
 * journal d'exécution plutôt que de faire échouer le traitement.
 * @param {string} titre Titre de la fenêtre.
 * @param {string} message Message déjà rédigé en français clair.
 * @return {void}
 */
function menuAlerte_(titre, message) {
  const texte = `${menuTexteCourt_(message, 1200)}\n\n` +
    'Le détail de ce qui a été fait est dans l\'onglet « ' + CONFIG.ONGLETS.JOURNAL.nom + ' ».';
  const ui = menuUi_();
  if (!ui) {
    journalSecours_(titre, texte);
    return;
  }
  try {
    ui.alert(menuTexteCourt_(titre, 120), texte, ui.ButtonSet.OK);
  } catch (e) {
    journalSecours_(titre, e);
  }
}

/**
 * Pose une question Oui/Non avant une action qui envoie des courriels ou qui
 * modifie des statuts en masse. Sans interface, on répond Non (on ne lance
 * jamais un envoi que personne n'a validé).
 * @param {string} titre Titre de la fenêtre.
 * @param {string} question Texte annonçant précisément ce qui va se passer.
 * @return {boolean} Vrai si l'utilisateur a répondu Oui.
 */
function menuConfirmer_(titre, question) {
  const ui = menuUi_();
  if (!ui) {
    journalAvert_('menuConfirmer_', 'Aucune interface disponible : action annulée par sécurité.', titre);
    return false;
  }
  const reponse = ui.alert(menuTexteCourt_(titre, 120), question, ui.ButtonSet.YES_NO);
  return reponse === ui.Button.YES;
}

/**
 * Raccourcit un texte pour l'affichage.
 * @param {*} texte Texte d'origine.
 * @param {number} max Longueur maximale.
 * @return {string} Texte, tronqué avec « … » si nécessaire.
 */
function menuTexteCourt_(texte, max) {
  const brut = (texte === null || texte === undefined) ? '' : String(texte);
  const limite = Number(max) || 500;
  return brut.length > limite ? `${brut.slice(0, limite - 1)}…` : brut;
}

// ---------------------------------------------------------------------------
// Lecture des compteurs annoncés dans les confirmations
// ---------------------------------------------------------------------------

/**
 * Appelle une fonction métier définie dans un autre fichier du projet.
 * Si le fichier n'a pas été copié dans l'éditeur, le message reste
 * compréhensible au lieu d'être une erreur technique.
 * @param {string} nomFonction Nom de la fonction globale à exécuter.
 * @return {*} Ce que renvoie la fonction métier.
 */
function menuAppeler_(nomFonction) {
  const portee = (typeof globalThis !== 'undefined') ? globalThis : this;
  const fn = portee ? portee[nomFonction] : null;
  if (typeof fn !== 'function') {
    throw new Error(`L'action « ${nomFonction} » n'est pas disponible dans ce classeur : ` +
      'le fichier du module correspondant n\'a pas été copié dans l\'éditeur Apps Script. ' +
      'Recopiez tous les fichiers du dossier src, enregistrez, puis rechargez le classeur.');
  }
  return fn();
}

/**
 * Lit un onglet et ne garde que les lignes correspondant à tous les critères.
 * @param {string} nomOnglet Nom de l'onglet (via CONFIG).
 * @param {Array<{colonne: string, valeurs: Array<string>}>} criteres Filtres.
 * @return {Array<Object>} Lignes retenues.
 */
function menuLignesFiltrees_(nomOnglet, criteres) {
  const attendus = (criteres || []).map((critere) => ({
    colonne: critere.colonne,
    valeurs: (critere.valeurs || []).map((valeur) => texteNormalise_(valeur)),
  }));
  return lireTable_(nomOnglet).filter((ligne) => attendus.every(
    (critere) => critere.valeurs.indexOf(texteNormalise_(ligne[critere.colonne])) >= 0));
}

/**
 * Factures que la vérification va réellement traiter. On délègue à
 * facturesAVerifier_ (05_Factures.gs) pour que le compteur annoncé à
 * l'utilisateur ne puisse jamais diverger de ce que fait le moteur. Si le
 * module des factures n'a pas été copié, on retombe sur le filtre par statut.
 * @return {Array<Object>} Les factures à vérifier.
 */
function menuFacturesAVerifier_() {
  const factures = lireTable_(CONFIG.ONGLETS.FACTURES.nom);
  if (typeof facturesAVerifier_ === 'function') return facturesAVerifier_(factures);
  const acceptes = ['', STATUT_VERIF.A_VERIFIER, STATUT_VERIF.SANS_BILAN,
    STATUT_VERIF.ECART, STATUT_VERIF.DOUBLON].map((valeur) => texteNormalise_(valeur));
  return factures.filter((ligne) => {
    if (!String(ligne[MENU_COL_.FACTURE_ID] || '').trim() &&
        !String(ligne[MENU_COL_.FACTURE_CLIENT] || '').trim()) return false;
    return acceptes.indexOf(texteNormalise_(ligne[MENU_COL_.FACTURE_VERIFICATION])) >= 0;
  });
}

/**
 * Additionne une colonne de montants, en cents entiers.
 * @param {Array<Object>} lignes Lignes lues par lireTable_.
 * @param {string} colonne Nom de la colonne de montants.
 * @return {number} Total en cents.
 */
function menuTotalCents_(lignes, colonne) {
  return (lignes || []).reduce((total, ligne) => total + enCents_(ligne[colonne]), 0);
}

/**
 * Décrit le mode d'envoi courant, pour l'annoncer avant tout courriel.
 * @return {string} Phrase prête à afficher.
 */
function menuTexteMode_() {
  const params = lireParametres_();
  const direct = texteNormalise_(params.MODE_ENVOI) === 'DIRECT';
  return direct
    ? 'Mode d\'envoi : DIRECT — les courriels partiront tout de suite chez vos clients.'
    : 'Mode d\'envoi : BROUILLON — les courriels seront seulement préparés dans Gmail, ' +
      'vous les relirez avant de les envoyer vous-même.';
}

/**
 * Devise à utiliser pour l'affichage des montants dans les fenêtres du menu.
 * @return {string} Code de devise (CAD par défaut).
 */
function menuDevise_() {
  return lireParametres_().DEVISE || CONFIG.PARAMETRES_DEFAUT.DEVISE;
}

/**
 * Lignes du dernier rapprochement qui présentent un écart (expliqué ou non).
 * @return {{periode: string, lignes: Array<Object>}} Période la plus récente
 *     présente dans l'onglet Rapprochement, et ses lignes en écart.
 */
function menuEcartsDernierePeriode_() {
  const lignes = lireTable_(CONFIG.ONGLETS.RAPPROCHEMENT.nom);
  const periodes = lignes
    .map((ligne) => String(ligne[MENU_COL_.RAPPROCHEMENT_PERIODE] || '').trim())
    .filter((periode) => periode !== '')
    .sort();
  const derniere = periodes.length ? periodes[periodes.length - 1] : '';
  const enEcart = [VERDICT.EXPLIQUE, VERDICT.INEXPLIQUE].map((v) => texteNormalise_(v));
  const retenues = lignes.filter((ligne) =>
    String(ligne[MENU_COL_.RAPPROCHEMENT_PERIODE] || '').trim() === derniere &&
    enEcart.indexOf(texteNormalise_(ligne[MENU_COL_.RAPPROCHEMENT_VERDICT])) >= 0);
  return { periode: derniere, lignes: retenues };
}

// ---------------------------------------------------------------------------
// 1 à 6 — le cycle mensuel
// ---------------------------------------------------------------------------

/**
 * 1. Génère les bilans du mois à partir de l'onglet Lignes_bilan.
 * @return {void}
 */
function menuGenererBilans() {
  executer_('1. Générer les bilans du mois', () => {
    menuExigerInstallation_();
    return menuAppeler_('genererBilans');
  });
}

/**
 * 2. Envoie (ou prépare en brouillon) les bilans encore au statut Brouillon.
 * @return {void}
 */
function menuEnvoyerBilans() {
  executer_('2. Envoyer les bilans', () => {
    menuExigerInstallation_();
    const bilans = menuLignesFiltrees_(CONFIG.ONGLETS.BILANS.nom, [
      { colonne: MENU_COL_.BILAN_STATUT, valeurs: [STATUT_BILAN.BROUILLON] },
    ]);
    if (!bilans.length) {
      return 'Aucun bilan au statut « ' + STATUT_BILAN.BROUILLON + ' » : il n\'y a rien à envoyer. ' +
        'Lancez d\'abord « 1. Générer les bilans du mois ».';
    }
    const total = formaterMontant_(menuTotalCents_(bilans, MENU_COL_.BILAN_MONTANT), menuDevise_());
    const question = `${bilans.length} bilan(s) sont prêts, pour un total de ${total}.\n\n` +
      `${menuTexteMode_()}\n\nUn courriel sera préparé par client, et chaque bilan passera au ` +
      `statut « ${STATUT_BILAN.ENVOYE} ».\n\nVoulez-vous continuer ?`;
    if (!menuConfirmer_('Envoyer les bilans', question)) {
      return 'Envoi annulé : aucun courriel n\'a été préparé, aucun statut n\'a changé.';
    }
    return menuAppeler_('envoyerBilans');
  });
}

/**
 * 3. Importe les factures reçues depuis l'étiquette Gmail configurée.
 * @return {void}
 */
function menuImporterFactures() {
  executer_('3. Importer les factures reçues (Gmail)', () => {
    menuExigerInstallation_();
    return menuAppeler_('importerFacturesGmail');
  });
}

/**
 * 4. Vérifie les factures « À vérifier » et les compare à leur bilan.
 * @return {void}
 */
function menuVerifierFactures() {
  executer_('4. Vérifier les factures', () => {
    menuExigerInstallation_();
    // Exactement le même critère que le moteur (facturesAVerifier_ de
    // 05_Factures.gs) : une facture saisie à la main dont le statut de
    // vérification est resté vide doit être comptée, sinon le menu affirmerait
    // « tout est déjà vérifié » alors que le travail n'a pas été fait.
    const factures = menuFacturesAVerifier_();
    if (!factures.length) {
      return 'Aucune facture à vérifier : tout est déjà vérifié ou tranché à la main ' +
        `(« ${STATUT_VERIF.CONFORME} », « ${STATUT_VERIF.REJETEE} »).`;
    }
    const question = `${factures.length} facture(s) vont être comparées à leur bilan, et leur ` +
      'statut de vérification sera mis à jour automatiquement.\n\n' +
      'Vos décisions manuelles ne sont jamais réécrites : une facture que vous avez passée à ' +
      `« ${STATUT_VERIF.CONFORME} » ou « ${STATUT_VERIF.REJETEE} » reste telle quelle.\n\n` +
      'Aucun courriel n\'est envoyé. Voulez-vous continuer ?';
    if (!menuConfirmer_('Vérifier les factures', question)) {
      return 'Vérification annulée : aucun statut n\'a changé.';
    }
    return menuAppeler_('verifierFactures');
  });
}

/**
 * 5. Prépare le lot de paiements : factures conformes non payées + CSV sur Drive.
 * @return {void}
 */
function menuPreparerLotPaiements() {
  executer_('5. Préparer le lot de paiements', () => {
    menuExigerInstallation_();
    const factures = menuLignesFiltrees_(CONFIG.ONGLETS.FACTURES.nom, [
      { colonne: MENU_COL_.FACTURE_VERIFICATION, valeurs: [STATUT_VERIF.CONFORME] },
      { colonne: MENU_COL_.FACTURE_PAIEMENT, valeurs: [STATUT_PAIEMENT.NON_PAYEE] },
    ]);
    if (!factures.length) {
      return 'Aucune facture « ' + STATUT_VERIF.CONFORME + ' » et « ' + STATUT_PAIEMENT.NON_PAYEE +
        '» : il n\'y a rien à préparer pour le moment.';
    }
    const total = formaterMontant_(menuTotalCents_(factures, MENU_COL_.FACTURE_TOTAL), menuDevise_());
    const question = `${factures.length} facture(s) conformes et non payées, pour un total de ${total}.\n\n` +
      `Elles passeront au statut « ${STATUT_PAIEMENT.A_PAYER} » et un fichier CSV sera déposé ` +
      'dans votre Drive pour préparer vos virements.\n\n' +
      'Le script n\'envoie jamais d\'argent : c\'est vous qui payez depuis votre banque.\n\n' +
      'Voulez-vous continuer ?';
    if (!menuConfirmer_('Préparer le lot de paiements', question)) {
      return 'Préparation annulée : aucun statut n\'a changé, aucun fichier n\'a été créé.';
    }
    return menuAppeler_('preparerLotDePaiements');
  });
}

/**
 * 6. Confirme les paiements du lot : enregistre les paiements réellement faits.
 * @return {void}
 */
function menuConfirmerLotPaiements() {
  executer_('6. Confirmer les paiements du lot', () => {
    menuExigerInstallation_();
    const factures = menuLignesFiltrees_(CONFIG.ONGLETS.FACTURES.nom, [
      { colonne: MENU_COL_.FACTURE_PAIEMENT, valeurs: [STATUT_PAIEMENT.A_PAYER] },
    ]);
    if (!factures.length) {
      return 'Aucune facture au statut « ' + STATUT_PAIEMENT.A_PAYER + ' » : lancez d\'abord ' +
        '« 5. Préparer le lot de paiements ».';
    }
    const total = formaterMontant_(menuTotalCents_(factures, MENU_COL_.FACTURE_TOTAL), menuDevise_());
    const question = `Confirmez-vous avoir réellement payé ${factures.length} facture(s), ` +
      `pour un total de ${total} ?\n\n` +
      `Un paiement sera enregistré pour chacune, et les factures passeront à ` +
      `« ${STATUT_PAIEMENT.PAYEE} ».\n\n` +
      'Répondez Non si les virements ne sont pas encore faits.';
    if (!menuConfirmer_('Confirmer les paiements du lot', question)) {
      return 'Confirmation annulée : aucun paiement n\'a été enregistré.';
    }
    return menuAppeler_('confirmerLotDePaiements');
  });
}

/**
 * Annule le lot de paiements en cours : les factures « À payer » qui n'ont pas
 * encore été réglées reviennent à « Non payée », de sorte qu'un lot préparé par
 * erreur puisse être défait sans passer par l'éditeur de script et sans
 * confirmer des virements qui n'ont pas eu lieu.
 * @return {void}
 */
function menuAnnulerLotPaiements() {
  executer_('Annuler le lot de paiements en cours', () => {
    menuExigerInstallation_();
    const factures = menuLignesFiltrees_(CONFIG.ONGLETS.FACTURES.nom, [
      { colonne: MENU_COL_.FACTURE_PAIEMENT, valeurs: [STATUT_PAIEMENT.A_PAYER] },
    ]);
    if (!factures.length) {
      return 'Aucun lot en cours : aucune facture n\'est au statut « ' +
        STATUT_PAIEMENT.A_PAYER + ' ». Il n\'y a rien à annuler.';
    }
    const total = formaterMontant_(menuTotalCents_(factures, MENU_COL_.FACTURE_TOTAL), menuDevise_());
    const question = `${factures.length} facture(s) sont actuellement au statut ` +
      `« ${STATUT_PAIEMENT.A_PAYER} », pour un total de ${total}.\n\n` +
      `Elles reviendront toutes au statut « ${STATUT_PAIEMENT.NON_PAYEE} », et vous pourrez ` +
      'préparer un nouveau lot.\n\n' +
      'Aucun paiement déjà enregistré n\'est supprimé, aucune facture déjà ' +
      `« ${STATUT_PAIEMENT.PAYEE} » n'est touchée, et aucun courriel n'est envoyé.\n\n` +
      'Répondez Non si vous avez déjà fait ces virements : dans ce cas, utilisez plutôt ' +
      '« 6. Confirmer les paiements du lot ».\n\nVoulez-vous annuler le lot ?';
    if (!menuConfirmer_('Annuler le lot de paiements en cours', question)) {
      return 'Annulation abandonnée : le lot reste en cours, aucun statut n\'a changé.';
    }
    return menuAppeler_('annulerLot');
  });
}

// ---------------------------------------------------------------------------
// 7 et 8 — le cycle trimestriel
// ---------------------------------------------------------------------------

/**
 * 7. Rapprochement trimestriel : compare le solde théorique au solde déclaré
 * par chaque client et explique chaque écart.
 * @return {void}
 */
function menuRapprochementTrimestriel() {
  executer_('7. Rapprochement trimestriel', () => {
    menuExigerInstallation_();
    const relanceAuto = texteNormalise_(lireParametres_().RELANCE_AUTO) === 'OUI';
    if (relanceAuto) {
      const question = 'Le réglage RELANCE_AUTO est à « Oui » : après le calcul, un courriel de ' +
        'relance sera préparé pour chaque client en écart.\n\n' + menuTexteMode_() +
        '\n\nVoulez-vous lancer le rapprochement ?';
      if (!menuConfirmer_('Rapprochement trimestriel', question)) {
        return 'Rapprochement annulé : rien n\'a été calculé ni envoyé.';
      }
    }
    return menuAppeler_('rapprochementTrimestriel');
  });
}

/**
 * 8. Prépare un courriel de relance pour chaque client en écart au dernier
 * rapprochement.
 * @return {void}
 */
function menuRelancerEcarts() {
  executer_('8. Relancer les clients en écart', () => {
    menuExigerInstallation_();
    const ecarts = menuEcartsDernierePeriode_();
    if (!ecarts.lignes.length) {
      return 'Aucun client en écart à relancer. Si vous venez d\'ajouter des soldes déclarés, ' +
        'lancez d\'abord « 7. Rapprochement trimestriel ».';
    }
    const question = `${ecarts.lignes.length} client(s) présentent un écart pour la période ` +
      `${ecarts.periode || '(période la plus récente)'}.\n\n` +
      'Un seul courriel sera préparé par client, listant précisément les pièces à vérifier ' +
      '(dates, montants, références).\n\n' + menuTexteMode_() + '\n\nVoulez-vous continuer ?';
    if (!menuConfirmer_('Relancer les clients en écart', question)) {
      return 'Relance annulée : aucun courriel n\'a été préparé.';
    }
    return menuAppeler_('relancerClientsEnEcart');
  });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Crée ou répare tous les onglets du classeur, sans toucher aux données saisies.
 * @return {void}
 */
function menuInstaller() {
  executer_('Installer ou réparer le classeur', () => menuAppeler_('installer'));
}

/**
 * Met en place les exécutions automatiques (import Gmail, bilans, rapprochement).
 * @return {void}
 */
function menuActiverAutomatisation() {
  executer_("Activer l'automatisation", () => {
    menuExigerInstallation_();
    const params = lireParametres_();
    const question = 'Le script fonctionnera ensuite tout seul :\n' +
      '• toutes les heures : import des factures de l\'étiquette Gmail ;\n' +
      `• le ${params.JOUR_ENVOI_BILAN} de chaque mois : génération et envoi des bilans ;\n` +
      '• au début de chaque trimestre : rapprochement complet.\n\n' + menuTexteMode_() +
      '\n\nVoulez-vous activer l\'automatisation ?';
    if (!menuConfirmer_("Activer l'automatisation", question)) {
      return 'Activation annulée : rien n\'a été modifié.';
    }
    return menuAppeler_('installerDeclencheurs');
  });
}

/**
 * Supprime les exécutions automatiques : tout redevient manuel.
 * @return {void}
 */
function menuDesactiverAutomatisation() {
  executer_("Désactiver l'automatisation", () => {
    menuExigerInstallation_();
    const question = 'Plus rien ne se lancera tout seul : vous devrez utiliser le menu pour ' +
      'chaque étape. Vos données ne sont pas touchées.\n\nVoulez-vous désactiver l\'automatisation ?';
    if (!menuConfirmer_("Désactiver l'automatisation", question)) {
      return 'Désactivation annulée : l\'automatisation reste active.';
    }
    return menuAppeler_('supprimerDeclencheurs');
  });
}

/**
 * Vide l'onglet Journal (les onglets de données ne sont jamais touchés).
 * @return {void}
 */
function menuViderJournal() {
  executer_('Vider le journal', () => {
    menuExigerInstallation_();
    const nomOnglet = CONFIG.ONGLETS.JOURNAL.nom;
    const feuille = feuille_(nomOnglet);
    const nombre = feuille.getLastRow() - 1;
    if (nombre <= 0) return 'Le journal est déjà vide.';
    const question = `Le journal contient ${nombre} ligne(s) d'historique.\n\n` +
      'Elles seront effacées. Aucun client, bilan, facture ou paiement n\'est touché.\n\n' +
      'Voulez-vous vider le journal ?';
    if (!menuConfirmer_('Vider le journal', question)) return 'Le journal n\'a pas été vidé.';
    feuille.deleteRows(2, nombre);
    invaliderCacheFeuille_(nomOnglet);
    return `${nombre} ligne(s) d'historique ont été effacées.`;
  });
}

// ---------------------------------------------------------------------------
// Aide
// ---------------------------------------------------------------------------

/**
 * Exécute les tests internes et affiche un résumé compréhensible.
 * @return {void}
 */
function menuLancerTests() {
  executer_('Lancer les tests', () => menuResumeTests_(menuAppeler_('lancerTests')));
}

/**
 * Met en forme le résultat de lancerTests().
 * @param {Object} resultat Objet {total, reussis, echecs}.
 * @return {{titre: string, message: string}} Contenu de l'alerte.
 */
function menuResumeTests_(resultat) {
  if (!resultat || typeof resultat !== 'object') {
    return { titre: '✅ Tests terminés', message: 'Les tests ont été exécutés.' };
  }
  const total = Number(resultat.total) || 0;
  const reussis = Number(resultat.reussis) || 0;
  const echecs = Array.isArray(resultat.echecs) ? resultat.echecs : [];
  if (!echecs.length) {
    return {
      titre: '✅ Tests réussis',
      message: `${reussis} vérification(s) sur ${total} ont réussi. Les calculs internes ` +
        '(soldes, écarts, montants) se comportent comme prévu.',
    };
  }
  const liste = echecs.slice(0, 8).map((echec) => {
    const texte = (typeof echec === 'string') ? echec : (echec && (echec.nom || echec.message)) || '';
    return `• ${menuTexteCourt_(texte, 140)}`;
  }).join('\n');
  return {
    titre: '⚠️ Des vérifications ont échoué',
    message: `${reussis} réussite(s) sur ${total}.\n\n${liste}\n\n` +
      'Signalez ces lignes à la personne qui a installé le script.',
  };
}

/**
 * Affiche le mode d'emploi dans une fenêtre non bloquante : l'utilisateur peut
 * continuer à travailler dans le classeur pendant qu'elle est ouverte.
 * @return {void}
 */
function afficherModeEmploi() {
  try {
    const fenetre = HtmlService.createHtmlOutput(menuModeEmploiHtml_())
      .setWidth(600)
      .setHeight(640);
    SpreadsheetApp.getUi().showModelessDialog(fenetre, "Mode d'emploi");
  } catch (e) {
    const pile = (e && e.stack) ? `${e.message}\n${e.stack}` : e;
    journalErreur_("Mode d'emploi", "Le mode d'emploi n'a pas pu s'afficher.", pile);
    viderTamponJournal_();
    menuAlerte_("Mode d'emploi", "La fenêtre d'aide n'a pas pu s'ouvrir. Le mode d'emploi complet " +
      'se trouve aussi dans le fichier README du projet.');
  }
}

/**
 * Construit la page HTML du mode d'emploi.
 * @return {string} Page complète, prête pour HtmlService.
 */
function menuModeEmploiHtml_() {
  const etapes = menuEtapesMensuelles_().concat(menuEtapesTrimestrielles_());
  const blocs = etapes.map((etape) => `
    <div class="etape">
      <h3><span class="num">${etape.numero}</span> ${etape.titre}</h3>
      <p class="vous"><b>Vous :</b> ${etape.vous}</p>
      <p class="script"><b>Le script :</b> ${etape.script}</p>
    </div>`).join('');
  return `${menuModeEmploiStyle_()}
    <h2>Comment ça marche</h2>
    <p class="intro">Le cycle est toujours le même : vous annoncez ce que vous devez, le client
      vous facture, vous vérifiez, vous payez, et chaque trimestre on s'assure que le client a
      bien tout déduit. Les entrées du menu sont numérotées dans cet ordre : suivez les numéros.</p>
    <div class="avant">
      <b>Une fois pour toutes :</b> remplissez l'onglet <i>${CONFIG.ONGLETS.CLIENTS.nom}</i>
      (un client par ligne, <i>Actif = Oui</i>) et vérifiez l'onglet
      <i>${CONFIG.ONGLETS.PARAMETRES.nom}</i>. Tant que <i>MODE_ENVOI</i> vaut
      <i>Brouillon</i>, aucun courriel ne part sans que vous l'ayez relu dans Gmail.
    </div>
    ${blocs}
    ${menuModeEmploiFin_()}`;
}

/**
 * Les six étapes du cycle mensuel, décrites en français simple.
 * @return {Array<{numero: string, titre: string, vous: string, script: string}>}
 */
function menuEtapesMensuelles_() {
  const onglets = CONFIG.ONGLETS;
  return [
    { numero: '1', titre: 'Générer les bilans du mois',
      vous: `saisir dans l'onglet <i>${onglets.LIGNES_BILAN.nom}</i> ce que vous devez à chaque client (ID client, Période au format AAAA-MM, description, montant).`,
      script: `regroupe vos lignes par client et crée un bilan au statut « ${STATUT_BILAN.BROUILLON} » dans l'onglet <i>${onglets.BILANS.nom}</i>.` },
    { numero: '2', titre: 'Envoyer les bilans',
      vous: 'relire les courriels dans Gmail puis les envoyer (en mode Brouillon), ou ne rien faire (en mode Direct).',
      script: `prépare un courriel par client actif et passe le bilan à « ${STATUT_BILAN.ENVOYE} ». Il vous dit toujours combien de courriels sont concernés avant de commencer.` },
    { numero: '3', titre: 'Importer les factures reçues (Gmail)',
      vous: `classer les factures de vos clients sous l'étiquette Gmail indiquée dans <i>${onglets.PARAMETRES.nom}</i>.`,
      script: `crée une ligne par facture dans <i>${onglets.FACTURES.nom}</i>, range la pièce jointe dans votre Drive et ignore ce qui a déjà été importé.` },
    { numero: '4', titre: 'Vérifier les factures',
      vous: `trancher les cas douteux : « ${STATUT_VERIF.ECART} », « ${STATUT_VERIF.DOUBLON} », « ${STATUT_VERIF.SANS_BILAN} ». Ce que vous décidez à la main n'est jamais réécrit.`,
      script: `compare chaque facture à son bilan, explique l'écart quand il y en a un (TPS, TVQ, ligne oubliée) et marque « ${STATUT_VERIF.CONFORME} » ce qui correspond.` },
    { numero: '5', titre: 'Préparer le lot de paiements',
      vous: 'faire vos virements dans votre banque, à partir du fichier CSV déposé sur votre Drive.',
      script: `liste les factures conformes non payées, les passe à « ${STATUT_PAIEMENT.A_PAYER} » et prépare le CSV. Il ne déplace jamais d'argent.` },
    { numero: '6', titre: 'Confirmer les paiements du lot',
      vous: 'confirmer, une fois les virements réellement faits.',
      script: `enregistre un paiement par facture dans <i>${onglets.PAIEMENTS.nom}</i> et marque les factures « ${STATUT_PAIEMENT.PAYEE} ».` },
  ];
}

/**
 * Les deux étapes trimestrielles : le cœur de l'outil.
 * @return {Array<{numero: string, titre: string, vous: string, script: string}>}
 */
function menuEtapesTrimestrielles_() {
  const onglets = CONFIG.ONGLETS;
  return [
    { numero: '7', titre: 'Rapprochement trimestriel',
      vous: `recopier le solde que chaque client vous annonce dans l'onglet <i>${onglets.SOLDES_DECLARES.nom}</i> (Période au format AAAA-TN, par exemple 2026-T2).`,
      script: `calcule ce que vous devriez encore devoir, le compare au solde du client, et pour chaque écart cherche la cause exacte : paiement non déduit, facture oubliée, paiement compté deux fois, erreur de taxes, signe inversé… Le résultat est écrit dans l'onglet <i>${onglets.RAPPROCHEMENT.nom}</i>.` },
    { numero: '8', titre: 'Relancer les clients en écart',
      vous: 'relire les courriels et les envoyer.',
      script: `prépare un seul courriel par client, qui liste précisément les pièces à vérifier (date, montant, référence, n° de facture) au lieu d'un vague « merci de vérifier ».` },
  ];
}

/**
 * Bloc de fin du mode d'emploi : les repères utiles au quotidien.
 * @return {string} Fragment HTML.
 */
function menuModeEmploiFin_() {
  return `
    <h2>Bon à savoir</h2>
    <ul>
      <li>Vous pouvez relancer n'importe quelle étape autant de fois que vous voulez : elle ne
        crée pas de doublon.</li>
      <li>Le script ne paie jamais rien tout seul et ne supprime jamais ce que vous avez saisi.</li>
      <li>Vous avez préparé un lot de paiements par erreur ? <i>Annuler le lot de paiements en
        cours</i> remet les factures « ${STATUT_PAIEMENT.A_PAYER} » à
        « ${STATUT_PAIEMENT.NON_PAYEE} », sans toucher aux paiements déjà enregistrés.</li>
      <li>Avant tout envoi de courriel ou tout changement de statut en masse, une fenêtre vous
        annonce combien d'éléments sont concernés et si vous êtes en mode Brouillon ou Direct.</li>
      <li>Si quelque chose se passe mal, le message reste en français et le détail technique est
        écrit dans l'onglet <i>${CONFIG.ONGLETS.JOURNAL.nom}</i>.</li>
      <li>Le menu <i>Configuration</i> sert à installer ou réparer le classeur, à activer ou
        désactiver les exécutions automatiques, et à vider le journal.</li>
    </ul>
    <p class="fin">Un doute ? Commencez toujours par regarder l'onglet
      <i>${CONFIG.ONGLETS.RAPPROCHEMENT.nom}</i> : la colonne <i>Action suggérée</i> vous dit quoi
      faire, client par client.</p>`;
}

/**
 * Feuille de style du mode d'emploi.
 * @return {string} Balise <style> complète.
 */
function menuModeEmploiStyle_() {
  return `<style>
    body { font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #202124;
           margin: 0 14px 20px 14px; line-height: 1.45; }
    h2 { font-size: 16px; margin: 18px 0 8px 0; border-bottom: 1px solid #dadce0; padding-bottom: 4px; }
    h3 { font-size: 13px; margin: 0 0 6px 0; }
    p { margin: 4px 0; }
    .intro { color: #444; }
    .avant { background: #e8f0fe; border-left: 4px solid #1a73e8; padding: 8px 10px; margin: 12px 0; }
    .etape { border: 1px solid #dadce0; border-radius: 6px; padding: 10px 12px; margin: 10px 0; }
    .num { display: inline-block; background: #1a73e8; color: #fff; border-radius: 50%;
           width: 20px; height: 20px; line-height: 20px; text-align: center; margin-right: 6px; }
    .vous { color: #b06000; }
    .script { color: #137333; }
    ul { padding-left: 20px; }
    li { margin: 4px 0; }
    .fin { background: #f1f3f4; padding: 8px 10px; border-radius: 6px; }
  </style>`;
}
