/**
 * 09_Journal.gs — Trace de tout ce que le script fait, dans l'onglet Journal.
 *
 * Les messages s'accumulent en mémoire pendant l'exécution ; ils sont écrits
 * d'un coup par viderTamponJournal_(), que chaque point d'entrée du menu appelle
 * à la fin (y compris en cas d'erreur). Journaliser ne doit JAMAIS faire échouer
 * un traitement : toutes les fonctions d'ici avalent leurs propres erreurs.
 */

/** Messages en attente d'écriture, pour l'exécution en cours. */
const JOURNAL_TAMPON_ = [];

/** Au-delà de ce nombre de messages en attente, on vide le tampon en route. */
const JOURNAL_TAMPON_MAX_ = 400;

/** Longueur maximale d'un message ou d'un détail écrit dans une cellule. */
const JOURNAL_TEXTE_MAX_ = 8000;

/**
 * Réduit n'importe quelle valeur à un texte court, lisible dans la feuille.
 * Un objet Error est rendu avec son message ET sa pile d'appels.
 * @param {*} valeur Détail à journaliser (texte, objet, Error...).
 * @return {string} Texte prêt à écrire.
 */
function journalTexte_(valeur) {
  let texte = '';
  try {
    if (valeur === null || valeur === undefined) return '';
    if (typeof valeur === 'string') {
      texte = valeur;
    } else if (valeur instanceof Error || (valeur && valeur.stack && valeur.message)) {
      texte = `${valeur.message}\n${valeur.stack}`;
    } else if (typeof valeur === 'object') {
      texte = JSON.stringify(valeur);
    } else {
      texte = String(valeur);
    }
  } catch (e) {
    texte = '(détail illisible)';
  }
  if (texte.length > JOURNAL_TEXTE_MAX_) {
    texte = texte.slice(0, JOURNAL_TEXTE_MAX_ - 1) + '…';
  }
  return texte;
}

/**
 * Écrit une trace de secours dans le journal d'exécution Apps Script, quand
 * l'écriture dans la feuille est elle-même impossible.
 * @param {string} fonction Nom de la fonction concernée.
 * @param {*} detail Message ou erreur.
 * @return {void}
 */
function journalSecours_(fonction, detail) {
  try {
    if (typeof Logger !== 'undefined' && Logger && Logger.log) {
      Logger.log(`[${fonction}] ${journalTexte_(detail)}`);
    }
  } catch (e) {
    // On ne peut plus rien faire : on n'interrompt surtout pas le traitement.
  }
}

/**
 * Ajoute un message au tampon du journal.
 * @param {string} fonction Nom de la fonction qui journalise.
 * @param {string} niveau Un des NIVEAU (INFO, AVERT, ERREUR).
 * @param {string} message Message court, en français, lisible par l'utilisateur.
 * @param {*} [detail] Complément : texte, objet ou objet Error.
 * @return {void}
 */
function journaliser_(fonction, niveau, message, detail) {
  try {
    JOURNAL_TAMPON_.push({
      horodatage: new Date(),
      fonction: journalTexte_(fonction),
      niveau: niveau || NIVEAU.INFO,
      message: journalTexte_(message),
      detail: journalTexte_(detail),
    });
    if (JOURNAL_TAMPON_.length >= JOURNAL_TAMPON_MAX_) viderTamponJournal_();
  } catch (e) {
    journalSecours_('journaliser_', e);
  }
}

/**
 * Journalise une information (déroulement normal).
 * @param {string} fonction Nom de la fonction qui journalise.
 * @param {string} message Message lisible.
 * @param {*} [detail] Complément facultatif.
 * @return {void}
 */
function journalInfo_(fonction, message, detail) {
  journaliser_(fonction, NIVEAU.INFO, message, detail);
}

/**
 * Journalise un avertissement (le traitement continue, mais il faut regarder).
 * @param {string} fonction Nom de la fonction qui journalise.
 * @param {string} message Message lisible.
 * @param {*} [detail] Complément facultatif.
 * @return {void}
 */
function journalAvert_(fonction, message, detail) {
  journaliser_(fonction, NIVEAU.AVERT, message, detail);
}

/**
 * Journalise une erreur. Ne lève jamais d'exception : un échec de
 * journalisation ne doit jamais casser le traitement en cours.
 * @param {string} fonction Nom de la fonction qui journalise.
 * @param {string} message Message lisible.
 * @param {*} [detail] Objet Error (message + pile) ou texte.
 * @return {void}
 */
function journalErreur_(fonction, message, detail) {
  try {
    journaliser_(fonction, NIVEAU.ERREUR, message, detail);
  } catch (e) {
    journalSecours_(fonction, e);
  }
}

/**
 * Écrit tout le tampon dans l'onglet Journal en une seule opération, puis purge
 * les lignes les plus anciennes si le plafond est dépassé.
 * À appeler à la fin de chaque point d'entrée du menu.
 * @return {number} Nombre de lignes écrites.
 */
function viderTamponJournal_() {
  if (!JOURNAL_TAMPON_.length) return 0;
  const lot = JOURNAL_TAMPON_.splice(0, JOURNAL_TAMPON_.length);
  try {
    const onglet = CONFIG.ONGLETS.JOURNAL;
    const colHorodatage = onglet.colonnes[0].nom;
    const colFonction = onglet.colonnes[1].nom;
    const colNiveau = onglet.colonnes[2].nom;
    const colMessage = onglet.colonnes[3].nom;
    const colDetail = onglet.colonnes[4].nom;
    const objets = lot.map((entree) => {
      const ligne = {};
      ligne[colHorodatage] = entree.horodatage;
      ligne[colFonction] = entree.fonction;
      ligne[colNiveau] = entree.niveau;
      ligne[colMessage] = entree.message;
      ligne[colDetail] = entree.detail;
      return ligne;
    });
    const ecrites = ajouterLignes_(onglet.nom, objets);
    purgerJournal_();
    return ecrites;
  } catch (e) {
    journalSecours_('viderTamponJournal_', e);
    lot.forEach((entree) => journalSecours_(entree.fonction, entree.message));
    return 0;
  }
}

/**
 * Supprime les lignes les plus anciennes du Journal au-delà de
 * CONFIG.JOURNAL_MAX_LIGNES. L'en-tête est toujours conservé.
 * @return {number} Nombre de lignes supprimées.
 */
function purgerJournal_() {
  try {
    const onglet = CONFIG.ONGLETS.JOURNAL;
    const feuille = feuille_(onglet.nom);
    const plafond = Number(CONFIG.JOURNAL_MAX_LIGNES) || 5000;
    const lignesDonnees = feuille.getLastRow() - 1;
    if (lignesDonnees <= plafond) return 0;
    const aSupprimer = lignesDonnees - plafond;
    feuille.deleteRows(2, aSupprimer);
    invaliderCacheFeuille_(onglet.nom);
    return aSupprimer;
  } catch (e) {
    journalSecours_('purgerJournal_', e);
    return 0;
  }
}
