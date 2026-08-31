#!/usr/bin/env node
/**
 * outils/test.mjs — Exécute les tests du projet HORS de Google (§7 de SPEC.md).
 *
 * Principe : on reconstruit dist/Code.gs, on le charge dans un bac à sable Node
 * (node:vm) où l'on a installé des DOUBLURES des services Google (SpreadsheetApp,
 * GmailApp, MailApp, DriveApp, Logger, Utilities, PropertiesService, ScriptApp,
 * HtmlService, Session...), puis on appelle lancerTests().
 *
 * Le garde-fou : pendant l'exécution de lancerTests(), toute tentative d'appel à
 * un service Google lève une erreur explicite. C'est un test en soi — le moteur de
 * rapprochement doit être PUR : il reçoit ses données en paramètre et ne touche
 * jamais aux feuilles, à Gmail ou à Drive.
 *
 * Aucune dépendance externe. Utilisation :
 *     node outils/test.mjs                (ou : npm test)
 *     node outils/test.mjs --verbeux      détail des traces et des piles d'appels
 *     node outils/test.mjs --sans-garde-fou   désactive le blocage des appels Google
 */

import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { construire, formaterTaille } from './build.mjs';

// ----------------------------------------------------------------------------
// Options de la ligne de commande
// ----------------------------------------------------------------------------

const ARGUMENTS = process.argv.slice(2);
const OPTIONS = {
  verbeux: ARGUMENTS.includes('--verbeux') || ARGUMENTS.includes('-v'),
  sansGardeFou: ARGUMENTS.includes('--sans-garde-fou'),
};

// ----------------------------------------------------------------------------
// Affichage
// ----------------------------------------------------------------------------

const COULEURS = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

/**
 * Habille un texte d'un code couleur ANSI, si le terminal le permet.
 * @param {string} code Code ANSI (ex. '32' pour vert).
 * @param {string} texte Texte à colorer.
 * @return {string} Texte coloré ou inchangé.
 */
function couleur_(code, texte) {
  return COULEURS ? `\u001b[${code}m${texte}\u001b[0m` : texte;
}

const vert_ = (t) => couleur_('32', t);
const rouge_ = (t) => couleur_('31', t);
const jaune_ = (t) => couleur_('33', t);
const gris_ = (t) => couleur_('90', t);
const gras_ = (t) => couleur_('1', t);

const REGLE = '─'.repeat(72);

// ----------------------------------------------------------------------------
// Garde-fou : aucun accès Google pendant les tests
// ----------------------------------------------------------------------------

/** Services Google interdits pendant l'exécution des tests purs. */
const SERVICES_GOOGLE = [
  'SpreadsheetApp', 'GmailApp', 'MailApp', 'DriveApp', 'PropertiesService',
  'ScriptApp', 'HtmlService', 'Session', 'CacheService', 'LockService', 'UrlFetchApp',
];

/**
 * Fonctions d'infrastructure autorisées à tenter une écriture Google : le module
 * Journal avale ses propres erreurs et retombe sur Logger. On enregistre l'appel
 * (et on le bloque quand même), mais il ne fait pas échouer la campagne de tests.
 */
const FONCTIONS_TOLEREES = ['viderTamponJournal_', 'purgerJournal_', 'journalSecours_'];

/** État du garde-fou et appels observés. */
const GARDE = { actif: false, violations: [] };

/** Tous les appels aux doublures, dans l'ordre (diagnostic). */
const APPELS = [];

/** Traces produites par Logger.log() et console.log() dans le bac à sable. */
const TRACES = [];

/**
 * Enregistre un appel à une doublure Google et, si le garde-fou est actif,
 * refuse l'appel avec un message explicite.
 * @param {string} service Nom du service (ex. 'SpreadsheetApp').
 * @param {string} methode Nom de la méthode appelée.
 * @return {void}
 * @throws {Error} Si le garde-fou est actif.
 */
function noterAppel_(service, methode) {
  const appel = `${service}.${methode}`;
  APPELS.push(appel);
  if (!GARDE.actif) return;
  const pile = String(new Error().stack || '');
  const tolere = FONCTIONS_TOLEREES.some((nom) => pile.includes(nom));
  GARDE.violations.push({ appel, tolere, pile });
  throw new Error(
    `Appel Google interdit pendant les tests : ${appel}(). `
    + 'Les fonctions testées doivent être PURES : elles reçoivent leurs données en '
    + 'paramètre et ne touchent ni aux feuilles, ni à Gmail, ni à Drive '
    + '(voir §5 et §7 de SPEC.md). Passez les données en argument au lieu de les lire.'
  );
}

// ----------------------------------------------------------------------------
// Doublures génériques : objets Google enchaînables
// ----------------------------------------------------------------------------

/** Méthodes dont la doublure renvoie un tableau de tableaux (plage de cellules). */
const RETOURS_TABLEAU_2D = new Set([
  'getValues', 'getDisplayValues', 'getFormulas', 'getBackgrounds', 'getFontColors',
  'getFontWeights', 'getNumberFormats', 'getNotes', 'getRichTextValues', 'getWraps',
  'getHorizontalAlignments', 'getVerticalAlignments', 'getDataValidations',
]);

/** Méthodes dont la doublure renvoie un nombre. */
const RETOURS_NOMBRE = new Set([
  'getLastRow', 'getLastColumn', 'getMaxRows', 'getMaxColumns', 'getNumRows',
  'getNumColumns', 'getRow', 'getColumn', 'getRowIndex', 'getColumnIndex',
  'getIndex', 'getFrozenRows', 'getFrozenColumns', 'getSheetId', 'getWidth',
  'getHeight', 'getColumnWidth', 'getRowHeight', 'getSize',
]);

/** Méthodes dont la doublure renvoie un tableau vide. */
const RETOURS_LISTE = new Set([
  'getSheets', 'getThreads', 'getMessages', 'getMessagesForThreads', 'getAttachments',
  'getUserLabels', 'getDrafts', 'getProjectTriggers', 'search', 'getBytes',
  'getRangeList', 'getNamedRanges', 'getEditors', 'getViewers',
]);

/** Méthodes dont la doublure renvoie une chaîne. */
const RETOURS_TEXTE = new Set([
  'getName', 'getSheetName', 'getId', 'getUrl', 'getDataAsString', 'getContentType',
  'getSubject', 'getPlainBody', 'getBody', 'getFrom', 'getTo', 'getBlobSource',
  'getUniqueId', 'getHandlerFunction', 'getA1Notation', 'getDisplayValue',
]);

/**
 * Valeur rendue par défaut par une méthode de doublure, choisie d'après son nom.
 * @param {string} service Nom du service, pour les cas particuliers.
 * @param {string} methode Nom de la méthode appelée.
 * @return {*} Valeur plausible (nombre, texte, tableau, itérateur ou objet enchaînable).
 */
function valeurParDefaut_(service, methode) {
  if (methode === 'getRemainingDailyQuota') return 1500;
  if (methode === 'getEmail') return 'utilisateur@exemple.ca';
  if (methode === 'getScriptTimeZone') return 'America/Toronto';
  if (methode === 'getValue') return '';
  if (RETOURS_TABLEAU_2D.has(methode)) return [[]];
  if (RETOURS_NOMBRE.has(methode)) return 0;
  if (RETOURS_LISTE.has(methode)) return [];
  if (RETOURS_TEXTE.has(methode)) return `(${service} de test)`;
  if (/^(is|has|can)[A-Z]/.test(methode)) return false;
  if (/^(get|search)(Files|Folders)/.test(methode)) return creerIterateurVide_();
  return creerObjetGoogle_(service);
}

/**
 * Itérateur Drive vide, conforme à l'interface hasNext()/next().
 * @return {{hasNext: function(): boolean, next: function(): never}} Itérateur.
 */
function creerIterateurVide_() {
  return {
    hasNext: () => false,
    next: () => {
      throw new Error('Itérateur vide : la doublure Drive ne contient aucun fichier.');
    },
  };
}

/**
 * Crée un objet Google factice : n'importe quelle méthode appelée est acceptée,
 * enregistrée, et renvoie une valeur plausible (ou l'objet lui-même, ce qui
 * permet les enchaînements du style getRange(...).setValue(...).setNote(...)).
 * @param {string} service Nom du service d'origine (pour les messages).
 * @param {Object} [membres] Membres réels à exposer tels quels (énumérations...).
 * @return {Object} Doublure enchaînable.
 */
function creerObjetGoogle_(service, membres = {}) {
  return new Proxy(membres, {
    get(cible, propriete) {
      if (typeof propriete === 'symbol') return undefined;
      if (Object.prototype.hasOwnProperty.call(cible, propriete)) return cible[propriete];
      if (propriete === 'then') return undefined;
      if (['toString', 'valueOf', 'toJSON', 'inspect'].includes(propriete)) {
        return () => `[doublure ${service}]`;
      }
      return (...args) => {
        noterAppel_(service, propriete);
        void args;
        return valeurParDefaut_(service, propriete);
      };
    },
  });
}

// ----------------------------------------------------------------------------
// Doublure : Utilities (services de formatage, sans accès aux données)
// ----------------------------------------------------------------------------

/** Motif des jetons de format de date (sous-ensemble de SimpleDateFormat). */
const JETONS_DATE = /('(?:[^']|'')*')|(y{1,4}|M{1,4}|d{1,2}|E{1,4}|H{1,2}|h{1,2}|m{1,2}|s{1,2}|S{1,3}|a|z{1,3}|Z)/g;

/**
 * Décompose une date dans un fuseau donné, en champs textuels à deux chiffres.
 * @param {Date} date Date à décomposer.
 * @param {string} fuseau Fuseau horaire IANA (ex. 'America/Toronto').
 * @return {Object} Champs annee, mois, jour, heure, minute, seconde, ms, jourSemaine, moisLong.
 */
function champsDate_(date, fuseau) {
  const options = {
    timeZone: fuseau, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  };
  const parties = {};
  for (const p of new Intl.DateTimeFormat('en-CA', options).formatToParts(date)) {
    parties[p.type] = p.value;
  }
  const nommer = (opts) => new Intl.DateTimeFormat('fr-CA', { timeZone: fuseau, ...opts }).format(date);
  return {
    annee: parties.year, mois: parties.month, jour: parties.day,
    heure: parties.hour, minute: parties.minute, seconde: parties.second,
    ms: String(date.getMilliseconds()).padStart(3, '0'),
    jourSemaineLong: nommer({ weekday: 'long' }),
    jourSemaineCourt: nommer({ weekday: 'short' }),
    moisLong: nommer({ month: 'long' }),
    moisCourt: nommer({ month: 'short' }),
    zone: nommer({ timeZoneName: 'short' }).split(' ').pop(),
  };
}

/**
 * Rend un jeton de format de date à partir des champs décomposés.
 * @param {string} jeton Jeton reconnu (yyyy, MM, dd, HH...).
 * @param {Object} d Champs produits par champsDate_.
 * @return {string} Texte correspondant.
 */
function rendreJetonDate_(jeton, d) {
  const heure24 = Number(d.heure);
  const heure12 = heure24 % 12 === 0 ? 12 : heure24 % 12;
  const table = {
    yyyy: d.annee, yyy: d.annee, yy: d.annee.slice(-2), y: String(Number(d.annee)),
    MMMM: d.moisLong, MMM: d.moisCourt, MM: d.mois, M: String(Number(d.mois)),
    dd: d.jour, d: String(Number(d.jour)),
    EEEE: d.jourSemaineLong, EEE: d.jourSemaineCourt, EE: d.jourSemaineCourt, E: d.jourSemaineCourt,
    HH: d.heure, H: String(Number(d.heure)),
    hh: String(heure12).padStart(2, '0'), h: String(heure12),
    mm: d.minute, m: String(Number(d.minute)),
    ss: d.seconde, s: String(Number(d.seconde)),
    SSS: d.ms, SS: d.ms.slice(0, 2), S: d.ms.slice(0, 1),
    a: heure24 < 12 ? 'AM' : 'PM',
    zzz: d.zone, zz: d.zone, z: d.zone, Z: d.zone,
  };
  return table[jeton] !== undefined ? table[jeton] : jeton;
}

/**
 * Doublure de Utilities.formatDate : sous-ensemble utile de SimpleDateFormat.
 * @param {Date} date Date à formater.
 * @param {string} fuseau Fuseau horaire IANA.
 * @param {string} gabarit Format (ex. 'yyyy-MM-dd HH:mm').
 * @return {string} Date formatée.
 */
function formaterDateUtilities_(date, fuseau, gabarit) {
  const valeur = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(valeur.getTime())) {
    throw new Error('Utilities.formatDate : date invalide (doublure de test).');
  }
  const champs = champsDate_(valeur, fuseau || 'America/Toronto');
  return String(gabarit).replace(JETONS_DATE, (tout, litteral, jeton) => {
    if (litteral !== undefined) {
      return litteral === "''" ? "'" : litteral.slice(1, -1).replace(/''/g, "'");
    }
    return rendreJetonDate_(jeton, champs);
  });
}

/**
 * Doublure de Utilities.formatString : sous-ensemble de printf (%s, %d, %f, %%).
 * @param {string} gabarit Gabarit contenant les marqueurs.
 * @param {...*} valeurs Valeurs à insérer, dans l'ordre.
 * @return {string} Chaîne formatée.
 */
function formaterChaineUtilities_(gabarit, ...valeurs) {
  let rang = 0;
  return String(gabarit).replace(/%(%|(\d+)?(?:\.(\d+))?([sdifx]))/g,
    (tout, corps, largeur, precision, type) => {
      if (corps === '%') return '%';
      const valeur = valeurs[rang++];
      let texte;
      if (type === 's') texte = valeur === undefined ? 'undefined' : String(valeur);
      else if (type === 'd' || type === 'i') texte = String(Math.trunc(Number(valeur) || 0));
      else if (type === 'x') texte = (Math.trunc(Number(valeur) || 0)).toString(16);
      else texte = Number(valeur || 0).toFixed(precision === undefined ? 6 : Number(precision));
      if (type === 'f' && precision === undefined) texte = String(Number(valeur || 0));
      return largeur ? texte.padStart(Number(largeur), ' ') : texte;
    });
}

/**
 * Doublure de Utilities.parseCsv : analyse un texte CSV (guillemets compris).
 * @param {string} texte Contenu CSV.
 * @param {string} [separateur] Séparateur de colonnes, virgule par défaut.
 * @return {Array<string[]>} Lignes de cellules.
 */
function analyserCsvUtilities_(texte, separateur = ',') {
  const lignes = [];
  let cellules = [];
  let cellule = '';
  let entreGuillemets = false;
  const source = String(texte).replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (entreGuillemets) {
      if (c === '"' && source[i + 1] === '"') { cellule += '"'; i++; }
      else if (c === '"') entreGuillemets = false;
      else cellule += c;
    } else if (c === '"') entreGuillemets = true;
    else if (c === separateur) { cellules.push(cellule); cellule = ''; }
    else if (c === '\r') { /* ignoré : traité avec le \n suivant */ }
    else if (c === '\n') { cellules.push(cellule); lignes.push(cellules); cellules = []; cellule = ''; }
    else cellule += c;
  }
  if (cellule !== '' || cellules.length) { cellules.push(cellule); lignes.push(cellules); }
  return lignes;
}

/**
 * Doublure de Utilities.newBlob : objet minimal compatible avec l'API Blob.
 * @param {string|number[]} donnees Contenu du blob.
 * @param {string} [typeContenu] Type MIME.
 * @param {string} [nom] Nom du fichier.
 * @return {Object} Blob factice.
 */
function creerBlobUtilities_(donnees, typeContenu, nom) {
  const tampon = typeof donnees === 'string' ? Buffer.from(donnees, 'utf8') : Buffer.from(donnees || []);
  const blob = {
    getBytes: () => Array.from(tampon).map((o) => (o > 127 ? o - 256 : o)),
    getDataAsString: (jeu) => tampon.toString(jeu === 'UTF-8' || !jeu ? 'utf8' : 'latin1'),
    setDataFromString: (texte) => creerBlobUtilities_(texte, typeContenu, nom),
    getContentType: () => typeContenu || 'application/octet-stream',
    getName: () => nom || '',
    setName: (nouveau) => creerBlobUtilities_(donnees, typeContenu, nouveau),
    copyBlob: () => creerBlobUtilities_(donnees, typeContenu, nom),
    getAs: () => blob,
    getBlob: () => blob,
  };
  return blob;
}

/**
 * Construit la doublure du service Utilities. Les méthodes non implémentées
 * lèvent une erreur explicite plutôt que d'échouer en silence.
 * @return {Object} Doublure de Utilities.
 */
function creerUtilities_() {
  const reel = {
    formatDate: (date, fuseau, gabarit) => {
      APPELS.push('Utilities.formatDate');
      return formaterDateUtilities_(date, fuseau, gabarit);
    },
    formatString: (gabarit, ...valeurs) => {
      APPELS.push('Utilities.formatString');
      return formaterChaineUtilities_(gabarit, ...valeurs);
    },
    sleep: (ms) => { APPELS.push(`Utilities.sleep(${ms})`); },
    newBlob: (donnees, type, nom) => {
      APPELS.push('Utilities.newBlob');
      return creerBlobUtilities_(donnees, type, nom);
    },
    parseCsv: (texte, separateur) => {
      APPELS.push('Utilities.parseCsv');
      return analyserCsvUtilities_(texte, separateur);
    },
    getUuid: () => randomUUID(),
    base64Encode: (v) => Buffer.from(typeof v === 'string' ? v : Buffer.from(v)).toString('base64'),
    base64Decode: (v) => Array.from(Buffer.from(String(v), 'base64')),
    DigestAlgorithm: { MD5: 'MD5', SHA_1: 'SHA_1', SHA_256: 'SHA_256' },
    Charset: { US_ASCII: 'US_ASCII', UTF_8: 'UTF_8' },
  };
  return new Proxy(reel, {
    get(cible, propriete) {
      if (typeof propriete === 'symbol') return undefined;
      if (Object.prototype.hasOwnProperty.call(cible, propriete)) return cible[propriete];
      if (propriete === 'then') return undefined;
      return () => {
        throw new Error(
          `Utilities.${String(propriete)}() n'est pas fourni par la doublure de test. `
          + 'Ajoutez-le dans outils/test.mjs, ou évitez de vous en servir dans du code testé.'
        );
      };
    },
  });
}

// ----------------------------------------------------------------------------
// Assemblage du bac à sable
// ----------------------------------------------------------------------------

/**
 * Construit un service Google entièrement factice (toutes ses méthodes sont
 * interceptées) en lui greffant d'éventuelles énumérations réelles.
 * @param {string} nom Nom du service.
 * @param {Object} [enumerations] Énumérations exposées telles quelles.
 * @return {Object} Doublure du service.
 */
function creerService_(nom, enumerations = {}) {
  return creerObjetGoogle_(nom, enumerations);
}

/**
 * Doublure de PropertiesService : un vrai stockage clé/valeur en mémoire,
 * mais dont l'accès reste bloqué par le garde-fou pendant les tests.
 * @return {Object} Doublure de PropertiesService.
 */
function creerPropertiesService_() {
  const magasin = new Map();
  const proprietes = {
    getProperty: (cle) => (magasin.has(cle) ? magasin.get(cle) : null),
    setProperty: (cle, valeur) => { magasin.set(cle, String(valeur)); return proprietes; },
    deleteProperty: (cle) => { magasin.delete(cle); return proprietes; },
    getProperties: () => Object.fromEntries(magasin),
    setProperties: (objet) => {
      Object.entries(objet || {}).forEach(([c, v]) => magasin.set(c, String(v)));
      return proprietes;
    },
    deleteAllProperties: () => { magasin.clear(); return proprietes; },
    getKeys: () => Array.from(magasin.keys()),
  };
  const donner = (methode) => () => { noterAppel_('PropertiesService', methode); return proprietes; };
  return {
    getScriptProperties: donner('getScriptProperties'),
    getUserProperties: donner('getUserProperties'),
    getDocumentProperties: donner('getDocumentProperties'),
  };
}

/**
 * Énumérations réelles exposées par certains services : ce sont de simples
 * lectures de propriétés (pas des appels), donc elles restent disponibles même
 * quand le garde-fou est actif.
 */
const ENUMERATIONS_GOOGLE = {
  SpreadsheetApp: {
    WrapStrategy: { OVERFLOW: 'OVERFLOW', WRAP: 'WRAP', CLIP: 'CLIP' },
    DataValidationCriteria: {
      VALUE_IN_LIST: 'VALUE_IN_LIST', DATE_IS_VALID_DATE: 'DATE_IS_VALID_DATE',
      NUMBER_GREATER_THAN: 'NUMBER_GREATER_THAN', CUSTOM_FORMULA: 'CUSTOM_FORMULA',
    },
    BorderStyle: { SOLID: 'SOLID', SOLID_MEDIUM: 'SOLID_MEDIUM', DASHED: 'DASHED' },
    Direction: { UP: 'UP', DOWN: 'DOWN', PREVIOUS: 'PREVIOUS', NEXT: 'NEXT' },
    BooleanCriteria: { CUSTOM_FORMULA: 'CUSTOM_FORMULA', TEXT_CONTAINS: 'TEXT_CONTAINS' },
    InterpolationType: { NUMBER: 'NUMBER', PERCENT: 'PERCENT' },
    ProtectionType: { RANGE: 'RANGE', SHEET: 'SHEET' },
    SheetType: { GRID: 'GRID', OBJECT: 'OBJECT' },
  },
  DriveApp: {
    Access: { PRIVATE: 'PRIVATE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', DOMAIN: 'DOMAIN' },
    Permission: { VIEW: 'VIEW', EDIT: 'EDIT', NONE: 'NONE' },
  },
  ScriptApp: {
    WeekDay: {
      MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', WEDNESDAY: 'WEDNESDAY', THURSDAY: 'THURSDAY',
      FRIDAY: 'FRIDAY', SATURDAY: 'SATURDAY', SUNDAY: 'SUNDAY',
    },
    EventType: { CLOCK: 'CLOCK', ON_OPEN: 'ON_OPEN', ON_EDIT: 'ON_EDIT' },
    AuthMode: { NONE: 'NONE', CUSTOM_FUNCTION: 'CUSTOM_FUNCTION', LIMITED: 'LIMITED', FULL: 'FULL' },
    AuthorizationStatus: { REQUIRED: 'REQUIRED', NOT_REQUIRED: 'NOT_REQUIRED' },
  },
  HtmlService: {
    SandboxMode: { IFRAME: 'IFRAME' },
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
  },
};

/**
 * Construit la doublure de Logger (et de console), qui accumule les traces en
 * mémoire au lieu de les envoyer au journal d'exécution Apps Script.
 * @return {{Logger: Object, console: Object}} Doublures de trace.
 */
function creerTraceurs_() {
  const noter = (retour) => (...args) => {
    TRACES.push(args.length > 1 && typeof args[0] === 'string' && args[0].includes('%')
      ? formaterChaineUtilities_(args[0], ...args.slice(1))
      : args.map((a) => (typeof a === 'string' ? a : texte_(a))).join(' '));
    return retour;
  };
  const Logger = {};
  Object.assign(Logger, {
    log: noter(Logger),
    clear: () => { TRACES.length = 0; return Logger; },
    getLog: () => TRACES.join('\n'),
  });
  const trace = noter(undefined);
  return { Logger, console: { log: trace, info: trace, warn: trace, error: trace, debug: trace } };
}

/**
 * Rassemble toutes les doublures des services Google dans un objet global.
 * @return {Object} Objet à utiliser comme espace global du bac à sable.
 */
function creerGlobalesGoogle_() {
  const globales = {};
  SERVICES_GOOGLE.forEach((nom) => {
    globales[nom] = creerService_(nom, ENUMERATIONS_GOOGLE[nom] || {});
  });
  globales.PropertiesService = creerPropertiesService_();
  globales.Utilities = creerUtilities_();
  Object.assign(globales, creerTraceurs_());
  return globales;
}

// ----------------------------------------------------------------------------
// Chargement et exécution
// ----------------------------------------------------------------------------

/**
 * Crée le contexte node:vm et y évalue dist/Code.gs.
 * @param {string} code Contenu de dist/Code.gs.
 * @return {Object} Contexte prêt à l'emploi.
 */
function chargerCode_(code) {
  const globales = creerGlobalesGoogle_();
  const contexte = vm.createContext(globales, { name: 'Apps Script (doublures)' });
  const script = new vm.Script(code, { filename: 'dist/Code.gs', lineOffset: 0 });
  script.runInContext(contexte, { timeout: 30000 });
  return contexte;
}

/**
 * Réduit n'importe quelle valeur venue du bac à sable à un texte lisible.
 * @param {*} valeur Valeur à décrire.
 * @return {string} Texte court.
 */
function texte_(valeur) {
  if (valeur === null || valeur === undefined) return '';
  if (typeof valeur === 'string') return valeur;
  if (typeof valeur === 'number' || typeof valeur === 'boolean') return String(valeur);
  if (valeur && typeof valeur.message === 'string') return valeur.message;
  try { return JSON.stringify(valeur); } catch (e) { return String(valeur); }
}

/** Clés acceptées pour le libellé d'un test. */
const CLES_NOM = ['nom', 'titre', 'test', 'libelle', 'description', 'cas'];
/** Clés acceptées pour le verdict d'un test. */
const CLES_OK = ['ok', 'reussi', 'succes', 'passe', 'reussite'];
/** Clés acceptées pour le message d'un test. */
const CLES_MESSAGE = ['message', 'erreur', 'detail', 'raison', 'motif'];

/**
 * Cherche la première clé présente dans un objet et renvoie sa valeur.
 * @param {Object} objet Objet à inspecter.
 * @param {string[]} cles Clés candidates, par ordre de préférence.
 * @return {*} Valeur trouvée, ou undefined.
 */
function premiereCle_(objet, cles) {
  for (const cle of cles) {
    if (objet && objet[cle] !== undefined && objet[cle] !== null && objet[cle] !== '') return objet[cle];
  }
  return undefined;
}

/**
 * Normalise le détail par test renvoyé par lancerTests(), quelle que soit la
 * forme exacte du tableau (tests, details, resultats, cas).
 * @param {Object} brut Valeur renvoyée par lancerTests().
 * @return {Array<{nom: string, ok: boolean, message: string}>} Détail par test.
 */
function extraireDetails_(brut) {
  const source = ['details', 'tests', 'resultats', 'cas', 'lignes']
    .map((cle) => brut[cle]).find((v) => Array.isArray(v));
  if (!source) return [];
  return source.map((item, i) => {
    if (typeof item === 'string') return { nom: item, ok: true, message: '' };
    const message = texte_(premiereCle_(item, CLES_MESSAGE));
    let ok = premiereCle_(item, CLES_OK);
    if (ok === undefined) ok = !message && item.echec !== true;
    return {
      nom: texte_(premiereCle_(item, CLES_NOM)) || `test ${i + 1}`,
      ok: Boolean(ok),
      message,
    };
  });
}

/**
 * Normalise la liste des échecs renvoyée par lancerTests().
 * @param {Object} brut Valeur renvoyée par lancerTests().
 * @return {Array<{nom: string, message: string}>} Échecs lisibles.
 */
function extraireEchecs_(brut) {
  const source = ['echecs', 'echec', 'erreurs'].map((cle) => brut[cle]).find((v) => Array.isArray(v));
  if (!source) return [];
  return source.map((item, i) => {
    if (typeof item === 'string') return { nom: item, message: '' };
    const morceaux = [];
    if (item.attendu !== undefined) morceaux.push(`attendu : ${texte_(item.attendu)}`);
    if (item.obtenu !== undefined) morceaux.push(`obtenu : ${texte_(item.obtenu)}`);
    const message = [texte_(premiereCle_(item, CLES_MESSAGE)), ...morceaux].filter(Boolean).join(' — ');
    return { nom: texte_(premiereCle_(item, CLES_NOM)) || `échec ${i + 1}`, message };
  });
}

/**
 * Met le résultat de lancerTests() sous une forme unique, tolérante aux
 * variantes de nommage du module 10_Tests.gs.
 * @param {*} brut Valeur renvoyée par lancerTests().
 * @return {{total: number, reussis: number, echecs: Array, details: Array}} Résultat normalisé.
 */
function normaliserResultat_(brut) {
  if (!brut || typeof brut !== 'object') {
    return { total: 0, reussis: 0, echecs: [], details: [], douteux: true };
  }
  const details = extraireDetails_(brut);
  const echecs = extraireEchecs_(brut);
  let total = Number(brut.total);
  if (!Number.isFinite(total) || total < details.length) total = details.length || echecs.length;
  let reussis = Number(premiereCle_(brut, ['reussis', 'succes', 'ok']));
  if (!Number.isFinite(reussis)) {
    reussis = details.length ? details.filter((d) => d.ok).length : Math.max(0, total - echecs.length);
  }
  return { total, reussis, echecs, details, douteux: total === 0 };
}

// ----------------------------------------------------------------------------
// Rapport
// ----------------------------------------------------------------------------

/**
 * Affiche une ligne de test avec sa coche ou sa croix.
 * @param {boolean} ok Le test est-il passé ?
 * @param {string} nom Libellé du test.
 * @param {string} [message] Complément affiché en dessous.
 * @return {void}
 */
function ligneTest_(ok, nom, message) {
  console.log(`      ${ok ? vert_('✓') : rouge_('✗')} ${nom}`);
  if (message) console.log(gris_(`          ${String(message).split('\n').join('\n          ')}`));
}

/**
 * Affiche le détail des tests, ou à défaut la liste des échecs.
 * @param {{total: number, reussis: number, echecs: Array, details: Array}} resultat Résultat normalisé.
 * @return {void}
 */
function afficherTests_(resultat) {
  if (resultat.details.length) {
    resultat.details.forEach((d) => ligneTest_(d.ok, d.nom, d.ok ? '' : d.message));
    const orphelins = resultat.echecs.filter((e) => !resultat.details.some((d) => d.nom === e.nom));
    orphelins.forEach((e) => ligneTest_(false, e.nom, e.message));
    return;
  }
  if (resultat.reussis > 0) ligneTest_(true, `${resultat.reussis} test(s) réussi(s)`);
  resultat.echecs.forEach((e) => ligneTest_(false, e.nom, e.message));
  if (!resultat.reussis && !resultat.echecs.length) {
    ligneTest_(false, "lancerTests() n'a signalé aucun test.",
      'Vérifiez que src/10_Tests.gs renvoie bien {total, reussis, echecs}.');
  }
}

/**
 * Affiche le verdict d'étanchéité : aucune fonction pure ne doit toucher Google.
 * @param {Array<{appel: string, tolere: boolean, pile: string}>} violations Appels bloqués.
 * @return {number} Nombre de violations bloquantes.
 */
function afficherEtancheite_(violations) {
  if (OPTIONS.sansGardeFou) {
    console.log(`      ${jaune_('•')} Garde-fou désactivé (--sans-garde-fou) : contrôle non effectué.`);
    return 0;
  }
  const bloquantes = violations.filter((v) => !v.tolere);
  const tolerees = violations.filter((v) => v.tolere);
  if (!bloquantes.length) {
    ligneTest_(true, 'Aucune fonction testée n\'a tenté d\'accéder à Google '
      + '(feuilles, Gmail, Drive).');
  }
  const groupes = new Map();
  bloquantes.forEach((v) => groupes.set(v.appel, (groupes.get(v.appel) || 0) + 1));
  groupes.forEach((nombre, appel) => {
    ligneTest_(false, `Accès Google interdit : ${appel}() — ${nombre} fois`,
      'Cette fonction doit recevoir ses données en paramètre (§5 et §7 de SPEC.md).');
  });
  if (tolerees.length) {
    console.log(gris_(`      • ${tolerees.length} tentative(s) d'écriture du Journal ignorée(s) `
      + '(le module Journal retombe sur Logger hors de Google).'));
  }
  if (OPTIONS.verbeux) violations.forEach((v) => console.log(gris_(v.pile)));
  return groupes.size;
}

/**
 * Formate une durée en secondes, à la française.
 * @param {number} ms Durée en millisecondes.
 * @return {string} Ex. « 0,32 s ».
 */
function formaterDuree_(ms) {
  return `${(ms / 1000).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s`;
}

// ----------------------------------------------------------------------------
// Étapes
// ----------------------------------------------------------------------------

/**
 * Étape 1 : reconstruit dist/Code.gs.
 * @return {Promise<Object>} Résultat de construire().
 */
async function etapeConstruction_() {
  console.log(gras_('[1/4] Construction de dist/Code.gs'));
  const construction = await construire({ silencieux: true });
  ligneTest_(true, `${construction.modules.length} modules — `
    + `${construction.lignes.toLocaleString('fr-CA')} lignes — ${formaterTaille(construction.octets)}`);
  console.log(gris_(`          ${construction.modules.join(', ')}`));
  return construction;
}

/**
 * Étape 2 : charge le code dans le bac à sable.
 * @param {string} code Contenu de dist/Code.gs.
 * @return {Object} Contexte du bac à sable.
 */
function etapeChargement_(code) {
  console.log('');
  console.log(gras_('[2/4] Chargement dans un bac à sable Node (doublures Google)'));
  const contexte = chargerCode_(code);
  const appels = APPELS.length;
  ligneTest_(true, appels
    ? `Code chargé — ${appels} appel(s) Google pendant le chargement`
    : 'Code chargé sans erreur — aucun appel Google pendant le chargement');
  return contexte;
}

/**
 * Étape 3 : exécute lancerTests() avec le garde-fou actif.
 * @param {Object} contexte Contexte du bac à sable.
 * @return {{resultat: Object, duree: number}} Résultat normalisé et durée en ms.
 * @throws {Error} Si lancerTests() est absent ou lève une exception.
 */
function etapeTests_(contexte) {
  console.log('');
  console.log(gras_('[3/4] Exécution de lancerTests()'));
  const lancerTests = vm.runInContext('typeof lancerTests === "function" ? lancerTests : null', contexte);
  if (!lancerTests) {
    const absente = new Error('La fonction lancerTests() est introuvable dans dist/Code.gs. '
      + 'Vérifiez que le module src/10_Tests.gs existe et déclare bien : function lancerTests().');
    absente.sansPile = true;
    throw absente;
  }
  GARDE.actif = !OPTIONS.sansGardeFou;
  const depart = process.hrtime.bigint();
  try {
    const brut = lancerTests();
    return { resultat: normaliserResultat_(brut), duree: Number(process.hrtime.bigint() - depart) / 1e6 };
  } finally {
    GARDE.actif = false;
  }
}

/**
 * Affiche l'étape 4 (étanchéité) puis le bilan final.
 * @param {Object} resultat Résultat normalisé.
 * @param {number} duree Durée des tests, en ms.
 * @return {number} Code de sortie du processus.
 */
function etapeBilan_(resultat, duree) {
  console.log('');
  console.log(gras_('[4/4] Étanchéité : les fonctions testées ne touchent pas à Google'));
  const bloquantes = afficherEtancheite_(GARDE.violations);

  const echecs = Math.max(resultat.total - resultat.reussis, resultat.echecs.length);
  console.log('');
  console.log(REGLE);
  const bilan = `  Total : ${resultat.total} test(s) — ${resultat.reussis} réussi(s), `
    + `${echecs} échec(s) — durée ${formaterDuree_(duree)}`;
  console.log(echecs || bloquantes ? rouge_(gras_(bilan)) : vert_(gras_(bilan)));
  if (bloquantes) console.log(rouge_(`  ${bloquantes} accès Google interdit(s) détecté(s).`));
  console.log(REGLE);

  if (OPTIONS.verbeux && TRACES.length) {
    console.log('');
    console.log(gras_('Traces Logger.log :'));
    TRACES.forEach((t) => console.log(gris_(`  ${t}`)));
  }
  const enEchec = Boolean(echecs) || Boolean(bloquantes) || resultat.douteux;
  console.log('');
  console.log(enEchec
    ? rouge_('Résultat : des tests ont échoué. Corrigez les modules concernés dans src/.')
    : vert_('Résultat : tout est au vert. dist/Code.gs est prêt à être collé dans Apps Script.'));
  return enEchec ? 1 : 0;
}

/**
 * Point d'entrée : enchaîne construction, chargement, tests et bilan.
 * @return {Promise<void>}
 */
async function principal() {
  console.log('');
  console.log(gras_('Tests hors Google — rapprochement-clients'));
  console.log(REGLE);
  const construction = await etapeConstruction_();
  const contexte = etapeChargement_(construction.code);
  const { resultat, duree } = etapeTests_(contexte);
  afficherTests_(resultat);
  process.exitCode = etapeBilan_(resultat, duree);
}

principal().catch((e) => {
  console.log('');
  console.error(rouge_(`Échec : ${e.message}`));
  if (e.stack && !e.sansPile) console.error(gris_(e.stack));
  console.log('');
  console.error(rouge_("Résultat : les tests n'ont pas pu aller au bout."));
  process.exit(1);
});
