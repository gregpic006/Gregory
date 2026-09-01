/**
 * state.mjs — Cache local des identifiants créés par la trousse.
 *
 * IMPORTANT — ce cache est une OPTIMISATION, jamais une source de vérité.
 * Il évite de re-chercher chaque calendrier et chaque dossier à chaque
 * exécution. Les commandes doivent TOUJOURS pouvoir retrouver l'état réel via
 * l'API si le fichier est absent, effacé ou périmé (ressource supprimée à la
 * main dans l'interface Google, par exemple).
 *
 * Conséquence pratique : on ne lève jamais d'erreur ici. Un cache illisible est
 * traité comme un cache vide, avec un avertissement.
 *
 * Forme du fichier :
 * {
 *   "version": 1,
 *   "updatedAt": "2026-09-01T14:00:00.000Z",
 *   "domain": "portailgestion.ca",
 *   "group": { "email": "equipe@portailgestion.ca", "id": "01abc..." },
 *   "driveId": "0AB...",
 *   "calendars": { "visites": "c_abc@group.calendar.google.com" },
 *   "folders":   { "/01 Immeubles": "1xY...", "/01 Immeubles/Baux": "1zW..." }
 * }
 *
 * Toutes les fonctions sont SYNCHRONES : `saveState(f, s)` et
 * `await saveState(f, s)` fonctionnent tous les deux.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import log from './log.mjs';

/** Version du format. Un cache d'une autre version est ignoré, pas migré. */
export const STATE_VERSION = 1;

/** @returns {object} un cache vide, prêt à être rempli. */
export function emptyState() {
  return {
    version: STATE_VERSION,
    updatedAt: null,
    domain: null,
    group: null,
    driveId: null,
    calendars: {},
    folders: {},
  };
}

/**
 * Garantit que l'objet a bien toutes les sections attendues, même si le fichier
 * sur disque est partiel ou a été écrit par une version antérieure.
 * @param {unknown} raw
 * @returns {object}
 */
function normalizeState(raw) {
  const base = emptyState();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;

  const out = { ...base, ...raw };
  out.version = STATE_VERSION;
  for (const key of ['calendars', 'folders']) {
    if (typeof out[key] !== 'object' || out[key] === null || Array.isArray(out[key])) {
      out[key] = {};
    }
  }
  if (typeof out.driveId !== 'string' || out.driveId === '') out.driveId = base.driveId;
  return out;
}

/**
 * Lit le cache d'état. Ne lève JAMAIS : en cas de problème, retourne un cache
 * vide et avertit. Le script doit pouvoir tourner sans cache.
 *
 * @param {string} file chemin du fichier de cache (ex. ./.state.json)
 * @param {{ onWarn?: (msg: string) => void }} [options]
 * @returns {object}
 */
export function loadState(file, options = {}) {
  const onWarn = options.onWarn ?? log.warn;
  const state = emptyState();

  if (!file) return state;
  if (!existsSync(file)) return state;

  try {
    if (statSync(file).isDirectory()) {
      onWarn(`Le cache d'état « ${file} » est un dossier, pas un fichier. Il est ignoré : tout sera re-découvert via l'API.`);
      return state;
    }
  } catch {
    return state;
  }

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    onWarn(`Impossible de lire le cache d'état « ${file} » (${e.message}). Il est ignoré : tout sera re-découvert via l'API (un peu plus lent, sans conséquence).`);
    return state;
  }

  if (text.trim() === '') return state;

  let parsed;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    // Le cache est corrompu : on le met de côté plutôt que de l'écraser en
    // silence, au cas où il contiendrait des identifiants récupérables.
    const backup = `${file}.corrompu`;
    try {
      renameSync(file, backup);
      onWarn(`Le cache d'état « ${file} » est illisible (JSON invalide). Il a été renommé en « ${backup} » et un cache neuf sera créé. Aucune donnée Google n'est perdue : tout est re-découvert via l'API.`);
    } catch {
      onWarn(`Le cache d'état « ${file} » est illisible (JSON invalide) et n'a pas pu être renommé. Il est ignoré ; tout sera re-découvert via l'API.`);
    }
    return state;
  }

  const normalized = normalizeState(parsed);

  if (parsed?.version !== undefined && parsed.version !== STATE_VERSION) {
    onWarn(`Le cache d'état « ${file} » vient d'une version antérieure de la trousse (version ${parsed.version}). Les identifiants sont conservés, mais tout ce qui manque sera re-découvert via l'API.`);
  }

  return normalized;
}

/**
 * Écrit le cache d'état sur disque, de façon atomique (écriture dans un fichier
 * temporaire puis renommage), pour ne jamais laisser un fichier à moitié écrit
 * si le script est interrompu.
 *
 * Ne lève JAMAIS : une écriture de cache ratée ne doit pas faire échouer une
 * configuration Google qui, elle, a réussi.
 *
 * @param {string} file
 * @param {object} state
 * @param {{ onWarn?: (msg: string) => void }} [options]
 * @returns {boolean} true si l'écriture a réussi
 */
export function saveState(file, state, options = {}) {
  const onWarn = options.onWarn ?? log.warn;
  if (!file) return false;

  const payload = normalizeState(state);
  payload.updatedAt = new Date().toISOString();

  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const dir = dirname(file);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Le cache ne contient aucun secret, mais il révèle la structure interne :
    // on reste discret sur les permissions.
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* rien à faire : le fichier temporaire restera, sans conséquence */
    }
    onWarn(
      `Impossible d'écrire le cache d'état « ${file} » (${e.message}). ` +
        'Ce n\'est pas bloquant : la configuration Google a bien été appliquée, mais la ' +
        'prochaine exécution sera un peu plus lente (tout sera re-découvert via l\'API). ' +
        'Vérifier les droits d\'écriture du dossier.',
    );
    return false;
  }
}

/**
 * Découpe une clé en segments.
 *
 * Deux formes acceptées :
 *   - tableau : ['folders', '/01 Immeubles/Baux'] — chaque élément est un
 *     segment littéral. À utiliser dès que la clé peut contenir un point ou une
 *     barre oblique (typiquement les chemins de dossiers).
 *   - chaîne : 'calendars.visites' — découpée sur les points.
 *
 * @param {string|string[]} key
 * @returns {string[]}
 */
function toSegments(key) {
  if (Array.isArray(key)) return key.map((k) => String(k)).filter((k) => k !== '');
  return String(key ?? '')
    .split('.')
    .filter((k) => k !== '');
}

/**
 * Écrit une valeur dans le cache, en créant les objets intermédiaires au besoin.
 *
 * @example
 *   setStateKey(state, ['calendars', 'visites'], 'c_abc@group.calendar.google.com');
 *   setStateKey(state, ['folders', '/01 Immeubles/Baux'], '1xY...');
 *   setStateKey(state, 'driveId', '0AB...');
 *
 * @param {object} state
 * @param {string|string[]} key
 * @param {unknown} value
 * @returns {object} le même objet state, pour permettre le chaînage
 */
export function setStateKey(state, key, value) {
  const target = state && typeof state === 'object' ? state : emptyState();
  const segments = toSegments(key);
  if (segments.length === 0) return target;

  let node = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (typeof node[seg] !== 'object' || node[seg] === null || Array.isArray(node[seg])) {
      node[seg] = {};
    }
    node = node[seg];
  }
  node[segments[segments.length - 1]] = value;
  return target;
}

/**
 * Lit une valeur du cache. Retourne `fallback` si le chemin n'existe pas.
 *
 * @param {object} state
 * @param {string|string[]} key
 * @param {unknown} [fallback]
 * @returns {unknown}
 */
export function getStateKey(state, key, fallback = undefined) {
  const segments = toSegments(key);
  let node = state;
  for (const seg of segments) {
    if (typeof node !== 'object' || node === null || !(seg in node)) return fallback;
    node = node[seg];
  }
  return node === undefined ? fallback : node;
}

/**
 * Retire une entrée du cache. Utile quand une ressource s'avère disparue côté
 * Google : on nettoie l'identifiant périmé plutôt que de le réutiliser.
 *
 * @param {object} state
 * @param {string|string[]} key
 * @returns {object} le même objet state
 */
export function unsetStateKey(state, key) {
  const segments = toSegments(key);
  if (segments.length === 0) return state;

  let node = state;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (typeof node?.[seg] !== 'object' || node[seg] === null) return state;
    node = node[seg];
  }
  delete node[segments[segments.length - 1]];
  return state;
}

export default { loadState, saveState, setStateKey, getStateKey, unsetStateKey, emptyState, STATE_VERSION };
