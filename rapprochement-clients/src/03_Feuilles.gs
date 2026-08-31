/**
 * 03_Feuilles.gs — Couche d'accès aux données du classeur.
 *
 * Tous les autres modules passent par ici pour lire ou écrire : aucun d'eux ne
 * connaît un numéro de colonne. Les noms de colonnes viennent de CONFIG.ONGLETS.
 *
 * Trois garanties :
 *   1. Une seule lecture getDataRange().getValues() par onglet et par exécution
 *      (cache mémoire). Toute écriture invalide le cache de l'onglet touché.
 *   2. Les écritures sont groupées : jamais de setValue() dans une boucle.
 *   3. Rien n'est détruit : seul remplacerPeriode_ supprime des lignes, et
 *      uniquement celles de la période qu'il réécrit.
 *
 * La fin du fichier regroupe les utilitaires partagés d'argent, de dates et de
 * texte. Ces fonctions sont PURES (aucun appel à SpreadsheetApp) : elles sont
 * testables hors de Google.
 */

/** Cache mémoire, valable le temps d'une seule exécution du script. */
const FEUILLES_CACHE_ = {
  classeur: null,
  tables: {},
  parametres: null,
};

/** Longueur maximale écrite dans une cellule (limite Google Sheets : 50 000). */
const FEUILLES_MAX_CARACTERES_ = 45000;

// ---------------------------------------------------------------------------
// Accès au classeur et aux onglets
// ---------------------------------------------------------------------------

/**
 * Renvoie le classeur actif (mis en cache pour l'exécution).
 * @return {Spreadsheet} Le classeur Google Sheets actif.
 */
function feuillesClasseur_() {
  if (!FEUILLES_CACHE_.classeur) {
    FEUILLES_CACHE_.classeur = SpreadsheetApp.getActiveSpreadsheet();
  }
  return FEUILLES_CACHE_.classeur;
}

/**
 * Retrouve le schéma d'un onglet à partir de son nom.
 * @param {string} nom Nom de l'onglet tel qu'il apparaît dans le classeur.
 * @return {Object|null} L'entrée de CONFIG.ONGLETS, ou null si inconnue.
 */
function feuillesSchema_(nom) {
  const cles = Object.keys(CONFIG.ONGLETS);
  for (let i = 0; i < cles.length; i++) {
    const schema = CONFIG.ONGLETS[cles[i]];
    if (schema && schema.nom === nom) return schema;
  }
  return null;
}

/**
 * Renvoie l'onglet demandé. S'il n'existe pas, il est créé avec ses en-têtes
 * (et seulement ses en-têtes) d'après CONFIG.ONGLETS, plutôt que d'échouer.
 * @param {string} nom Nom de l'onglet.
 * @return {Sheet} L'onglet, garanti existant.
 */
function feuille_(nom) {
  const classeur = feuillesClasseur_();
  const existante = classeur.getSheetByName(nom);
  if (existante) return existante;

  const schema = feuillesSchema_(nom);
  if (!schema) {
    throw new Error(
      `L'onglet « ${nom} » est introuvable et aucun modèle ne le décrit dans la configuration.`);
  }
  const nouvelle = classeur.insertSheet(nom);
  const noms = schema.colonnes.map((c) => c.nom);
  const plage = nouvelle.getRange(1, 1, 1, noms.length);
  plage.setValues([noms]);
  plage.setFontWeight('bold');
  nouvelle.setFrozenRows(1);
  journalInfo_('feuille_', `Onglet « ${nom} » créé automatiquement.`, '');
  return nouvelle;
}

/**
 * Oublie le cache d'un onglet (à appeler après toute écriture directe).
 * @param {string} nom Nom de l'onglet, ou rien pour tout oublier.
 * @return {void}
 */
function invaliderCacheFeuille_(nom) {
  if (nom === undefined || nom === null || nom === '') {
    FEUILLES_CACHE_.tables = {};
    FEUILLES_CACHE_.parametres = null;
    return;
  }
  delete FEUILLES_CACHE_.tables[nom];
  if (nom === CONFIG.ONGLETS.PARAMETRES.nom) FEUILLES_CACHE_.parametres = null;
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/**
 * Lit la ligne 1 d'un onglet. Si elle est vide et qu'un modèle existe, les
 * en-têtes du modèle y sont écrits (réparation non destructive : l'onglet est vide).
 * @param {Sheet} feuille Onglet concerné.
 * @param {Array<Array<*>>} valeurs Contenu brut de getDataRange().
 * @return {Array<string>} Les noms d'en-tête, nettoyés.
 */
function feuillesEntetes_(feuille, valeurs) {
  const brut = valeurs.length ? valeurs[0] : [];
  const entetes = brut.map((v) => (v === null || v === undefined ? '' : String(v).trim()));
  if (entetes.some((e) => e !== '')) return entetes;

  const schema = feuillesSchema_(feuille.getName());
  if (!schema) return entetes;
  const noms = schema.colonnes.map((c) => c.nom);
  feuille.getRange(1, 1, 1, noms.length).setValues([noms]);
  feuille.getRange(1, 1, 1, noms.length).setFontWeight('bold');
  feuille.setFrozenRows(1);
  return noms;
}

/**
 * Vrai si toutes les cellules de la ligne sont vides.
 * @param {Array<*>} ligne Valeurs d'une ligne.
 * @return {boolean}
 */
function feuillesLigneVide_(ligne) {
  for (let i = 0; i < ligne.length; i++) {
    const v = ligne[i];
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return false;
  }
  return true;
}

/**
 * Lit un onglet en entier, une seule fois par exécution, et le met en cache.
 * @param {string} nom Nom de l'onglet.
 * @return {{entetes: Array<string>, objets: Array<Object>}}
 */
function feuillesTable_(nom) {
  const enCache = FEUILLES_CACHE_.tables[nom];
  if (enCache) return enCache;

  const feuille = feuille_(nom);
  const valeurs = feuille.getDataRange().getValues();
  const entetes = feuillesEntetes_(feuille, valeurs);
  const objets = [];
  for (let i = 1; i < valeurs.length; i++) {
    const ligne = valeurs[i];
    if (feuillesLigneVide_(ligne)) continue;
    const objet = { _ligne: i + 1 };
    for (let c = 0; c < entetes.length; c++) {
      if (!entetes[c]) continue;
      objet[entetes[c]] = ligne[c] === undefined ? '' : ligne[c];
    }
    objets.push(objet);
  }
  FEUILLES_CACHE_.tables[nom] = { entetes: entetes, objets: objets };
  return FEUILLES_CACHE_.tables[nom];
}

/**
 * Lit un onglet sous forme d'objets clés par le NOM d'en-tête lu en ligne 1.
 * Chaque objet porte en plus `_ligne`, le numéro de ligne réel dans la feuille.
 * Les lignes entièrement vides sont ignorées.
 * @param {string} nom Nom de l'onglet.
 * @return {Array<Object>} Les lignes de données.
 */
function lireTable_(nom) {
  return feuillesTable_(nom).objets;
}

/**
 * Renvoie les noms d'en-tête réels d'un onglet.
 * @param {string} nom Nom de l'onglet.
 * @return {Array<string>} Les en-têtes, dans l'ordre des colonnes.
 */
function entetesTable_(nom) {
  return feuillesTable_(nom).entetes.slice();
}

/**
 * Indexe une liste d'objets par la valeur d'un champ (le dernier gagne).
 * @param {Array<Object>} objets Lignes à indexer.
 * @param {string} champ Nom du champ servant de clé.
 * @return {Map<string, Object>} Clé (texte, nettoyée) vers objet.
 */
function indexerPar_(objets, champ) {
  const index = new Map();
  (objets || []).forEach((objet) => {
    if (!objet) return;
    const brut = objet[champ];
    if (brut === null || brut === undefined) return;
    const cle = String(brut).trim();
    if (cle === '') return;
    index.set(cle, objet);
  });
  return index;
}

/**
 * Regroupe une liste d'objets par la valeur d'un champ (utile pour les lignes
 * d'un même client ou d'une même période).
 * @param {Array<Object>} objets Lignes à regrouper.
 * @param {string} champ Nom du champ servant de clé.
 * @return {Map<string, Array<Object>>} Clé vers tableau d'objets.
 */
function indexerGroupesPar_(objets, champ) {
  const groupes = new Map();
  (objets || []).forEach((objet) => {
    if (!objet) return;
    const brut = objet[champ];
    if (brut === null || brut === undefined) return;
    const cle = String(brut).trim();
    if (cle === '') return;
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(objet);
  });
  return groupes;
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

/**
 * Prépare une valeur avant écriture dans une cellule.
 * @param {*} valeur Valeur brute.
 * @return {*} Valeur acceptée par setValues().
 */
function feuillesValeurSortie_(valeur) {
  if (valeur === null || valeur === undefined) return '';
  if (typeof valeur === 'string' && valeur.length > FEUILLES_MAX_CARACTERES_) {
    return valeur.slice(0, FEUILLES_MAX_CARACTERES_ - 1) + '…';
  }
  return valeur;
}

/**
 * Ajoute des lignes à la suite des données existantes, en UNE seule écriture.
 * Les clés des objets doivent être des noms d'en-tête ; les clés inconnues sont
 * ignorées et signalées au journal.
 * @param {string} nom Nom de l'onglet.
 * @param {Array<Object>} objets Lignes à ajouter.
 * @return {number} Nombre de lignes réellement ajoutées.
 */
function ajouterLignes_(nom, objets) {
  if (!objets || !objets.length) return 0;
  const feuille = feuille_(nom);
  const entetes = feuillesTable_(nom).entetes.filter((e) => e !== '');
  if (!entetes.length) {
    throw new Error(`L'onglet « ${nom} » n'a aucun en-tête : impossible d'y ajouter des lignes.`);
  }
  const inconnues = {};
  const matrice = objets.map((objet) => {
    Object.keys(objet || {}).forEach((cle) => {
      if (cle !== '_ligne' && entetes.indexOf(cle) < 0) inconnues[cle] = true;
    });
    return entetes.map((entete) => feuillesValeurSortie_((objet || {})[entete]));
  });
  const premiereLigne = Math.max(feuille.getLastRow(), 1) + 1;
  feuille.getRange(premiereLigne, 1, matrice.length, entetes.length).setValues(matrice);
  invaliderCacheFeuille_(nom);

  const listeInconnues = Object.keys(inconnues);
  if (listeInconnues.length) {
    journalAvert_('ajouterLignes_',
      `Colonnes inconnues ignorées dans l'onglet « ${nom} ».`, listeInconnues.join(', '));
  }
  return matrice.length;
}

/**
 * Met à jour une seule ligne.
 * @param {string} nom Nom de l'onglet.
 * @param {number} ligne Numéro de ligne réel dans la feuille (celui de `_ligne`).
 * @param {Object} patch Couples {nom d'en-tête: nouvelle valeur}.
 * @return {number} Nombre de cellules écrites.
 */
function majLigne_(nom, ligne, patch) {
  return majLignes_(nom, [{ ligne: ligne, patch: patch }]);
}

/**
 * Met à jour plusieurs lignes. Les écritures sont regroupées par colonne puis
 * par plages de lignes contiguës : quelques setValues() au lieu d'un par cellule.
 * @param {string} nom Nom de l'onglet.
 * @param {Array<{ligne: number, patch: Object}>} majs Mises à jour à appliquer.
 * @return {number} Nombre de cellules écrites.
 */
function majLignes_(nom, majs) {
  if (!majs || !majs.length) return 0;
  const feuille = feuille_(nom);
  const entetes = feuillesTable_(nom).entetes;
  const parColonne = new Map();
  const inconnues = {};

  majs.forEach((maj) => {
    if (!maj || !maj.patch) return;
    const ligne = Number(maj.ligne);
    if (!ligne || ligne < 2) return;
    Object.keys(maj.patch).forEach((cle) => {
      const colonne = entetes.indexOf(cle);
      if (colonne < 0) { inconnues[cle] = true; return; }
      if (!parColonne.has(colonne)) parColonne.set(colonne, new Map());
      parColonne.get(colonne).set(ligne, feuillesValeurSortie_(maj.patch[cle]));
    });
  });

  let cellules = 0;
  parColonne.forEach((valeursParLigne, colonne) => {
    cellules += feuillesEcrireColonne_(feuille, colonne + 1, valeursParLigne);
  });
  if (cellules) invaliderCacheFeuille_(nom);

  const listeInconnues = Object.keys(inconnues);
  if (listeInconnues.length) {
    journalAvert_('majLignes_',
      `Colonnes inconnues ignorées dans l'onglet « ${nom} ».`, listeInconnues.join(', '));
  }
  return cellules;
}

/**
 * Écrit une colonne par blocs de lignes contiguës.
 * @param {Sheet} feuille Onglet visé.
 * @param {number} colonne Numéro de colonne (1-indexé).
 * @param {Map<number, *>} valeursParLigne Numéro de ligne vers valeur.
 * @return {number} Nombre de cellules écrites.
 */
function feuillesEcrireColonne_(feuille, colonne, valeursParLigne) {
  const lignes = Array.from(valeursParLigne.keys()).sort((a, b) => a - b);
  let cellules = 0;
  let i = 0;
  while (i < lignes.length) {
    let j = i;
    while (j + 1 < lignes.length && lignes[j + 1] === lignes[j] + 1) j++;
    const bloc = [];
    for (let k = i; k <= j; k++) bloc.push([valeursParLigne.get(lignes[k])]);
    feuille.getRange(lignes[i], colonne, bloc.length, 1).setValues(bloc);
    cellules += bloc.length;
    i = j + 1;
  }
  return cellules;
}

/**
 * Réécrit un onglet généré pour UNE période : les lignes de cette période sont
 * supprimées puis remplacées, les autres périodes restent intactes. C'est ce qui
 * rend les onglets générés idempotents (relancer deux fois ne crée pas de doublon).
 * @param {string} nom Nom de l'onglet.
 * @param {string} colPeriode Nom de la colonne qui porte la période.
 * @param {string} periode Période à remplacer (ex. '2026-T2').
 * @param {Array<Object>} objets Nouvelles lignes de cette période.
 * @return {number} Nombre de lignes écrites.
 */
function remplacerPeriode_(nom, colPeriode, periode, objets) {
  const feuille = feuille_(nom);
  const table = feuillesTable_(nom);
  if (table.entetes.indexOf(colPeriode) < 0) {
    throw new Error(`La colonne « ${colPeriode} » n'existe pas dans l'onglet « ${nom} ».`);
  }
  const cible = String(periode === null || periode === undefined ? '' : periode).trim();
  const aSupprimer = table.objets
    .filter((o) => {
      const v = o[colPeriode];
      return String(v === null || v === undefined ? '' : v).trim() === cible;
    })
    .map((o) => o._ligne)
    .sort((a, b) => b - a);

  let i = 0;
  while (i < aSupprimer.length) {
    let j = i;
    while (j + 1 < aSupprimer.length && aSupprimer[j + 1] === aSupprimer[j] - 1) j++;
    feuille.deleteRows(aSupprimer[j], j - i + 1);
    i = j + 1;
  }
  if (aSupprimer.length) invaliderCacheFeuille_(nom);
  return ajouterLignes_(nom, objets || []);
}

/**
 * Calcule le prochain identifiant d'un onglet (ex. 'F-000042').
 * Le plus grand suffixe numérique existant est repris et incrémenté ; les
 * identifiants saisis à la main ou mal formés sont simplement ignorés.
 * @param {string} nom Nom de l'onglet.
 * @param {string} colonne Nom de la colonne d'identifiants.
 * @param {string} prefixe Préfixe des identifiants (ex. 'F-').
 * @param {number} largeur Nombre de chiffres, complétés par des zéros.
 * @return {string} Le prochain identifiant disponible.
 */
function prochainId_(nom, colonne, prefixe, largeur) {
  const chiffres = Math.max(1, Number(largeur) || 6);
  const prefixeTexte = String(prefixe === null || prefixe === undefined ? '' : prefixe);
  const prefixeHaut = prefixeTexte.toUpperCase();
  const table = feuillesTable_(nom);
  if (table.entetes.indexOf(colonne) < 0) {
    throw new Error(`La colonne « ${colonne} » n'existe pas dans l'onglet « ${nom} ».`);
  }
  let maximum = 0;
  table.objets.forEach((objet) => {
    const brut = objet[colonne];
    if (brut === null || brut === undefined) return;
    const texte = String(brut).trim();
    if (!texte) return;
    if (prefixeHaut && texte.toUpperCase().indexOf(prefixeHaut) !== 0) return;
    const trouve = /(\d+)\s*$/.exec(texte);
    if (!trouve) return;
    const numero = parseInt(trouve[1], 10);
    if (!isNaN(numero) && numero > maximum) maximum = numero;
  });
  let suffixe = String(maximum + 1);
  while (suffixe.length < chiffres) suffixe = '0' + suffixe;
  return prefixeTexte + suffixe;
}

// ---------------------------------------------------------------------------
// Paramètres
// ---------------------------------------------------------------------------

/**
 * Lit les réglages : CONFIG.PARAMETRES_DEFAUT complété par l'onglet Paramètres.
 * La valeur saisie dans la feuille l'emporte, sauf si elle est vide.
 * @return {Object} Dictionnaire {CLE: valeur}.
 */
function lireParametres_() {
  if (FEUILLES_CACHE_.parametres) return FEUILLES_CACHE_.parametres;
  const params = {};
  Object.keys(CONFIG.PARAMETRES_DEFAUT).forEach((cle) => {
    params[cle] = CONFIG.PARAMETRES_DEFAUT[cle];
  });
  const onglet = CONFIG.ONGLETS.PARAMETRES;
  const colCle = onglet.colonnes[0].nom;
  const colValeur = onglet.colonnes[1].nom;
  lireTable_(onglet.nom).forEach((ligne) => {
    const cle = String(ligne[colCle] === null || ligne[colCle] === undefined ? '' : ligne[colCle]).trim();
    if (!cle) return;
    const valeur = ligne[colValeur];
    if (valeur === null || valeur === undefined) return;
    if (typeof valeur === 'string' && valeur.trim() === '') return;
    params[cle] = typeof valeur === 'string' ? valeur.trim() : valeur;
  });
  FEUILLES_CACHE_.parametres = params;
  return params;
}

/**
 * Écrit un réglage dans l'onglet Paramètres (mise à jour ou ajout).
 * @param {string} cle Nom du réglage (ex. 'MODE_ENVOI').
 * @param {*} valeur Nouvelle valeur.
 * @return {void}
 */
function ecrireParametre_(cle, valeur) {
  const onglet = CONFIG.ONGLETS.PARAMETRES;
  const colCle = onglet.colonnes[0].nom;
  const colValeur = onglet.colonnes[1].nom;
  const colDescription = onglet.colonnes[2].nom;
  const cleTexte = String(cle).trim();
  const existante = lireTable_(onglet.nom).filter((ligne) => {
    const v = ligne[colCle];
    return String(v === null || v === undefined ? '' : v).trim() === cleTexte;
  })[0];

  const patch = {};
  patch[colValeur] = valeur;
  if (existante) {
    majLigne_(onglet.nom, existante._ligne, patch);
  } else {
    patch[colCle] = cleTexte;
    patch[colDescription] = CONFIG.DESCRIPTIONS_PARAMETRES[cleTexte] || '';
    ajouterLignes_(onglet.nom, [patch]);
  }
  FEUILLES_CACHE_.parametres = null;
}

/**
 * Lit un réglage comme un nombre (accepte '1 234,56' comme 1234.56).
 * @param {Object} params Résultat de lireParametres_().
 * @param {string} cle Nom du réglage.
 * @param {number} defaut Valeur de repli si le réglage est vide ou illisible.
 * @return {number}
 */
function parametreNombre_(params, cle, defaut) {
  const secours = (defaut === null || defaut === undefined) ? 0 : Number(defaut);
  const brut = params ? params[cle] : undefined;
  if (typeof brut === 'number') return isFinite(brut) ? brut : secours;
  if (brut === null || brut === undefined) return secours;
  const texte = String(brut).trim();
  if (!texte) return secours;
  const negatif = /^-/.test(texte) || /^\(.*\)$/.test(texte);
  const nombre = feuillesNombreDecimal_(texte.replace(/[^0-9.,]/g, ''));
  if (nombre === null) return secours;
  return negatif ? -nombre : nombre;
}

/**
 * Lit un réglage comme un oui/non. 'Oui' et 'Direct' valent vrai.
 * @param {Object} params Résultat de lireParametres_().
 * @param {string} cle Nom du réglage.
 * @return {boolean}
 */
function parametreBooleen_(params, cle) {
  const brut = params ? params[cle] : undefined;
  if (typeof brut === 'boolean') return brut;
  const texte = texteNormalise_(brut);
  return texte === 'OUI' || texte === 'DIRECT' || texte === 'VRAI' ||
         texte === 'TRUE' || texte === 'ACTIF' || texte === 'X' || texte === '1';
}

// ---------------------------------------------------------------------------
// Utilitaires partagés — argent, dates, texte (fonctions PURES, testables)
// ---------------------------------------------------------------------------

/**
 * Interprète une chaîne composée de chiffres, de points et de virgules.
 * Le dernier séparateur est décimal, sauf s'il sépare visiblement des milliers.
 * @param {string} texte Chaîne déjà débarrassée des symboles et des espaces.
 * @return {number|null} Le nombre lu, ou null si illisible.
 */
function feuillesNombreDecimal_(texte) {
  const points = (texte.match(/\./g) || []).length;
  const virgules = (texte.match(/,/g) || []).length;
  let entier = texte;
  let decimales = '';
  if (points + virgules > 0) {
    const position = Math.max(texte.lastIndexOf('.'), texte.lastIndexOf(','));
    const apres = texte.slice(position + 1);
    const avant = texte.slice(0, position);
    const memeSeparateur = (points === 0 || virgules === 0);
    const milliers = memeSeparateur && (
      (points + virgules) >= 2 ||
      (/^\d{3}$/.test(apres) && avant !== '' && avant !== '0'));
    if (milliers || !/^\d+$/.test(apres)) {
      entier = texte;
    } else {
      entier = avant;
      decimales = apres;
    }
  }
  entier = entier.replace(/[.,]/g, '');
  if (!/^\d*$/.test(entier)) return null;
  if (entier === '' && decimales === '') return null;
  const nombre = Number((entier || '0') + (decimales ? '.' + decimales : ''));
  return isFinite(nombre) ? nombre : null;
}

/**
 * Convertit un montant en cents entiers. C'est la seule façon de manipuler de
 * l'argent dans le projet : on ne compare jamais deux flottants.
 * Accepte un nombre, '1 234,56 $', '1,234.56', '-45,00', '(120,00)' (négatif).
 * @param {*} valeur Montant sous n'importe quelle forme.
 * @return {number} Montant en cents (entier), 0 si illisible.
 */
function enCents_(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return 0;
  if (typeof valeur === 'number') return isFinite(valeur) ? Math.round(valeur * 100) : 0;
  if (typeof valeur === 'boolean' || valeur instanceof Date) return 0;
  const brut = String(valeur).trim();
  if (!brut) return 0;
  const negatif = /^\(.*\)$/.test(brut) || /^-/.test(brut) || /-$/.test(brut);
  const nombre = feuillesNombreDecimal_(brut.replace(/[^0-9.,]/g, ''));
  if (nombre === null) return 0;
  const cents = Math.round(Math.abs(nombre) * 100);
  return negatif ? -cents : cents;
}

/**
 * Convertit des cents entiers en montant décimal, pour écriture dans la feuille.
 * @param {number} cents Montant en cents.
 * @return {number} Montant en dollars (2 décimales).
 */
function enDollars_(cents) {
  const entier = Math.round(Number(cents) || 0);
  return entier / 100;
}

/**
 * Symbole ou code affiché après un montant.
 * @param {string} devise Code de devise (CAD, USD, EUR...).
 * @return {string} Symbole à afficher.
 */
function feuillesSymboleDevise_(devise) {
  const code = String(devise === null || devise === undefined ? '' : devise).trim().toUpperCase();
  if (code === '' || code === 'CAD' || code === '$') return '$';
  if (code === 'USD') return '$ US';
  if (code === 'EUR') return '€';
  return code;
}

/**
 * Formate un montant en cents pour l'affichage humain : '1 234,56 $'.
 * @param {number} cents Montant en cents.
 * @param {string} [devise] Code de devise ; CAD par défaut.
 * @return {string} Montant lisible.
 */
function formaterMontant_(cents, devise) {
  const entier = Math.round(Number(cents) || 0);
  const negatif = entier < 0;
  const absolu = Math.abs(entier);
  const partieEntiere = String(Math.floor(absolu / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  let decimales = String(absolu % 100);
  while (decimales.length < 2) decimales = '0' + decimales;
  return `${negatif ? '-' : ''}${partieEntiere},${decimales} ${feuillesSymboleDevise_(devise)}`;
}

/**
 * Convertit une valeur en date, ou null si ce n'en est pas une.
 * Accepte un objet Date, un numéro de série Google Sheets, 'AAAA-MM-JJ',
 * 'AAAA/MM/JJ', 'JJ-MM-AAAA' et 'JJ/MM/AAAA'.
 * @param {*} valeur Valeur à convertir.
 * @return {Date|null} La date (à minuit, heure locale) ou null.
 */
function versDate_(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return null;
  if (valeur instanceof Date) return isNaN(valeur.getTime()) ? null : valeur;
  if (typeof valeur === 'number') {
    if (!isFinite(valeur)) return null;
    if (valeur > 100000000000) return new Date(valeur);
    if (valeur > 0 && valeur < 2958466) {
      const serie = new Date(1899, 11, 30);
      serie.setDate(serie.getDate() + Math.round(valeur));
      return serie;
    }
    return null;
  }
  const texte = String(valeur).trim();
  if (!texte) return null;
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(texte);
  if (iso) return feuillesDateValide_(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const fr = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(texte);
  if (fr) return feuillesDateValide_(Number(fr[3]), Number(fr[2]), Number(fr[1]));
  const analysee = new Date(texte);
  return isNaN(analysee.getTime()) ? null : analysee;
}

/**
 * Construit une date en vérifiant que les composantes existent vraiment.
 * @param {number} annee Année sur 4 chiffres.
 * @param {number} mois Mois de 1 à 12.
 * @param {number} jour Jour du mois.
 * @return {Date|null} La date, ou null si la combinaison n'existe pas.
 */
function feuillesDateValide_(annee, mois, jour) {
  if (!annee || !mois || !jour || mois < 1 || mois > 12 || jour < 1 || jour > 31) return null;
  const date = new Date(annee, mois - 1, jour);
  if (date.getFullYear() !== annee || date.getMonth() !== mois - 1 || date.getDate() !== jour) {
    return null;
  }
  return date;
}

/**
 * Formate une date en 'AAAA-MM-JJ'. Renvoie '' si la valeur n'est pas une date.
 * @param {*} date Date ou valeur convertible.
 * @return {string} Date lisible, ou chaîne vide.
 */
function formaterDate_(date) {
  const valeur = versDate_(date);
  if (!valeur) return '';
  const mois = String(valeur.getMonth() + 1);
  const jour = String(valeur.getDate());
  return `${valeur.getFullYear()}-${mois.length < 2 ? '0' + mois : mois}-${jour.length < 2 ? '0' + jour : jour}`;
}

/**
 * Remplace les accents sans dépendre de String.normalize (filet de sécurité).
 * @param {string} texte Texte en majuscules.
 * @return {string} Texte sans accents.
 */
function feuillesSansAccents_(texte) {
  const accents = 'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝŸ';
  const simples = 'AAAAAACEEEEIIIINOOOOOUUUUYY';
  let sortie = '';
  for (let i = 0; i < texte.length; i++) {
    const position = accents.indexOf(texte.charAt(i));
    sortie += position >= 0 ? simples.charAt(position) : texte.charAt(i);
  }
  return sortie;
}

/**
 * Normalise un texte pour la comparaison : sans espaces, sans ponctuation,
 * sans accents, en majuscules. Sert notamment à comparer deux n° de facture
 * (« INV 2026-001 » et « inv2026001 » sont alors identiques).
 * @param {*} texte Texte à normaliser.
 * @return {string} Texte comparable (A-Z et 0-9 seulement).
 */
function texteNormalise_(texte) {
  if (texte === null || texte === undefined) return '';
  let sortie = String(texte).trim().toUpperCase();
  try {
    sortie = sortie.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (e) {
    sortie = feuillesSansAccents_(sortie);
  }
  return sortie.replace(/[^A-Z0-9]/g, '');
}
