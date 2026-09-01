/**
 * log.mjs — Affichage console de la trousse Portail.
 *
 * Tout le texte visible est en français. Les couleurs se désactivent
 * automatiquement quand la sortie n'est pas un terminal (redirection vers un
 * fichier, journal d'intégration continue) ou quand NO_COLOR est défini.
 *
 * Aucune dépendance externe : uniquement des séquences ANSI.
 */

const ESC = '\u001b';
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Codes ANSI de base. Volontairement limités aux 8 couleurs standards. */
const CODES = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  magenta: `${ESC}[35m`,
  cyan: `${ESC}[36m`,
  gray: `${ESC}[90m`,
};

let colorOverride = null;

/**
 * Force l'activation (true) ou la désactivation (false) de la couleur.
 * Passer null pour revenir à la détection automatique.
 * @param {boolean|null} value
 */
export function setColor(value) {
  colorOverride = value === null ? null : Boolean(value);
}

/** @returns {boolean} vrai si on peut émettre des séquences ANSI. */
export function isColorEnabled() {
  if (colorOverride !== null) return colorOverride;
  // Convention NO_COLOR (https://no-color.org) : toute valeur non vide désactive.
  if (typeof process.env.NO_COLOR === 'string' && process.env.NO_COLOR !== '') return false;
  if (process.env.TERM === 'dumb') return false;
  const force = process.env.FORCE_COLOR;
  if (typeof force === 'string' && force !== '' && force !== '0') return true;
  return Boolean(process.stdout && process.stdout.isTTY);
}

/**
 * Applique un ou plusieurs codes ANSI à un texte, si la couleur est active.
 * @param {unknown} text
 * @param {...string} names noms de clés de CODES
 * @returns {string}
 */
function paint(text, ...names) {
  const str = String(text);
  if (!isColorEnabled()) return str;
  const prefix = names.map((n) => CODES[n] ?? '').join('');
  if (!prefix) return str;
  return `${prefix}${str}${CODES.reset}`;
}

/** Retire les séquences ANSI d'une chaîne. */
export function stripAnsi(text) {
  return String(text).replace(ANSI_PATTERN, '');
}

/** Longueur visible d'une chaîne (sans les séquences ANSI). */
function visibleLength(text) {
  return stripAnsi(text).length;
}

/** Normalise un argument en texte affichable (gère les Error et les objets). */
function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Indente les lignes 2..n d'un message multiligne pour qu'elles s'alignent
 * sous le texte de la première ligne plutôt que sous la puce.
 * @param {unknown} text
 * @param {number} width
 */
function indentContinuation(text, width) {
  const pad = ' '.repeat(width);
  return toText(text).split('\n').join(`\n${pad}`);
}

function writeOut(line) {
  process.stdout.write(`${line}\n`);
}

function writeErr(line) {
  process.stderr.write(`${line}\n`);
}

/** Ligne vide. */
export function blank() {
  writeOut('');
}

/** Écrit une ligne telle quelle, sans puce ni couleur ajoutée. */
export function raw(msg = '') {
  writeOut(toText(msg));
}

/** Texte en gras (retourne la chaîne, n'écrit rien). */
export function bold(msg) {
  return paint(toText(msg), 'bold');
}

/** Texte atténué (retourne la chaîne, n'écrit rien). */
export function dim(msg) {
  return paint(toText(msg), 'dim');
}

/**
 * Début d'une étape. Précédé d'une ligne vide pour aérer la sortie.
 * @param {string} msg
 */
export function step(msg) {
  writeOut('');
  writeOut(`${paint('==>', 'cyan', 'bold')} ${paint(indentContinuation(msg, 4), 'bold')}`);
}

/**
 * Information neutre : ce que le script est en train de faire, et pourquoi.
 * @param {string} msg
 */
export function info(msg) {
  writeOut(`  ${paint('-', 'blue')} ${indentContinuation(msg, 4)}`);
}

/**
 * Succès : quelque chose a été créé ou modifié.
 * @param {string} msg
 */
export function ok(msg) {
  writeOut(`  ${paint('OK', 'green', 'bold')} ${indentContinuation(msg, 5)}`);
}

/**
 * Avertissement : le script continue, mais il y a un point à surveiller.
 * @param {string|Error} msg
 */
export function warn(msg) {
  writeErr(`  ${paint('ATTENTION', 'yellow', 'bold')} ${indentContinuation(msg, 12)}`);
}

/**
 * Erreur : quelque chose a échoué. Le message doit toujours dire quoi faire.
 * @param {string|Error} msg
 */
export function err(msg) {
  writeErr(`  ${paint('ERREUR', 'red', 'bold')} ${indentContinuation(msg, 9)}`);
  if (msg instanceof Error && process.env.DEBUG && msg.stack) {
    writeErr(paint(msg.stack, 'gray'));
  }
}

/**
 * Mode simulation : décrit une action qui SERAIT faite avec --apply.
 * @param {string} msg
 */
export function plan(msg) {
  writeOut(`  ${paint('[PLAN]', 'yellow', 'bold')} ${indentContinuation(msg, 9)}`);
}

/**
 * Idempotence : la ressource existe déjà et est conforme, rien à faire.
 * @param {string} msg
 */
export function skip(msg) {
  writeOut(`  ${paint('[DÉJÀ OK]', 'gray')} ${paint(indentContinuation(msg, 12), 'gray')}`);
}

/**
 * Tableau aligné.
 *
 * Accepte :
 *   - un tableau d'objets    → les clés (union de tous les objets) font les entêtes ;
 *   - un tableau de tableaux → colonnes brutes, entêtes via options.columns.
 *
 * @param {Array<Record<string, unknown>>|Array<Array<unknown>>} rows
 * @param {{ columns?: string[], indent?: number, header?: boolean }} [options]
 */
export function table(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    writeOut(`  ${paint('(aucune ligne à afficher)', 'gray')}`);
    return;
  }

  const indent = ' '.repeat(options.indent ?? 2);
  const showHeader = options.header !== false;

  /** @type {string[]} */
  let headers;
  /** @type {string[][]} */
  let body;

  if (Array.isArray(list[0])) {
    const width = Math.max(...list.map((r) => (Array.isArray(r) ? r.length : 0)));
    headers = options.columns ?? Array.from({ length: width }, (_, i) => `col${i + 1}`);
    body = list.map((r) => headers.map((_, i) => toText(Array.isArray(r) ? r[i] : '')));
  } else {
    /** @type {string[]} */
    const seen = [];
    for (const row of list) {
      for (const key of Object.keys(row ?? {})) {
        if (!seen.includes(key)) seen.push(key);
      }
    }
    headers = options.columns ?? seen;
    body = list.map((row) => headers.map((key) => toText(row?.[key])));
  }

  const widths = headers.map((h, i) => {
    const cells = body.map((r) => visibleLength(r[i] ?? ''));
    return Math.max(showHeader ? visibleLength(h) : 0, ...cells, 1);
  });

  const renderRow = (cells, painter) => {
    const rendered = cells.map((cell, i) => {
      const text = cell ?? '';
      const padding = ' '.repeat(Math.max(0, widths[i] - visibleLength(text)));
      return (painter ? painter(text) : text) + padding;
    });
    return (indent + rendered.join('  ')).replace(/\s+$/, '');
  };

  if (showHeader) {
    writeOut(renderRow(headers, (t) => paint(t, 'bold')));
    writeOut(indent + widths.map((w) => paint('-'.repeat(w), 'gray')).join('  '));
  }
  for (const row of body) writeOut(renderRow(row));
}

/**
 * Grand titre encadré, pour séparer les grandes phases du script.
 * @param {string} title
 */
export function banner(title) {
  const text = toText(title).trim();
  const terminalWidth = Math.max(40, Math.min(process.stdout?.columns ?? 80, 100));
  const inner = Math.max(visibleLength(text), terminalWidth - 4);
  const border = `+${'-'.repeat(inner + 2)}+`;
  const filler = ' '.repeat(inner - visibleLength(text));
  writeOut('');
  writeOut(paint(border, 'cyan'));
  writeOut(`${paint('|', 'cyan')} ${paint(text, 'bold', 'cyan')}${filler} ${paint('|', 'cyan')}`);
  writeOut(paint(border, 'cyan'));
}

/** Objet regroupant toutes les fonctions, pour `import log from './log.mjs'`. */
const log = {
  step,
  info,
  ok,
  warn,
  err,
  plan,
  skip,
  table,
  banner,
  blank,
  raw,
  bold,
  dim,
  stripAnsi,
  isColorEnabled,
  setColor,
};

export default log;
