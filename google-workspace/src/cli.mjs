#!/usr/bin/env node
/**
 * Trousse Google Workspace — Portail
 * Point d'entrée en ligne de commande.
 *
 * Utilisation :
 *   node src/cli.mjs <commande> [--apply] [--config <chemin>] [--help]
 *
 * Règle de base : PAR DÉFAUT, RIEN N'EST MODIFIÉ.
 * Chaque commande affiche d'abord ce qu'elle ferait. Il faut ajouter --apply
 * pour que les changements soient réellement envoyés à Google.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(CLI_DIR, '..');
const COMMANDS_DIR = path.join(CLI_DIR, 'commands');
const MIN_NODE_MAJOR = 20;

/* ------------------------------------------------------------------ *
 * Catalogue des commandes
 * ------------------------------------------------------------------ */

/**
 * readOnly    : la commande ne modifie jamais rien. On force alors apply=false,
 *               peu importe ce qui est passé en ligne de commande (ceinture ET bretelles).
 * steps       : commande composite — on exécute ces commandes dans l'ordre.
 * needsConfig : false = la commande fonctionne SANS config.json (c'est le cas
 *               de « init », qui est justement là pour le créer).
 * touchesGoogle : false = même avec --apply, la commande n'écrit que sur le
 *               disque local. Sert uniquement à formuler les messages justes.
 * options     : options supplémentaires acceptées par cette commande-là.
 *               La valeur dit si l'option attend une valeur après elle.
 */
const COMMANDS = {
  init: {
    summary:
      "Lit les comptes réels de ton domaine et écrit config.json à ta place. N'écrit rien chez Google.",
    needsConfig: false,
    touchesGoogle: false,
    options: {
      '--force': false,
      '--oauth': false,
      '--service-account': false,
      '--compte-de-service': false,
      '--mode': true,
      '--admin': true,
    },
  },
  doctor: {
    summary: "Vérifie l'accès : clé, délégation, API activées. Ne modifie rien.",
    readOnly: true,
  },
  dns: {
    summary:
      'Vérifie le DNS du domaine : MX, SPF, DMARC, DKIM. Ne touche pas à Google, ne modifie rien.',
    readOnly: true,
    // Interroge le DNS public, pas Google : ni identifiants ni config.json requis.
    // Sans config.json, il faut nommer le domaine avec --domain.
    needsConfig: false,
    touchesGoogle: false,
    options: {
      '--domain': true,
      '--domaine': true,
    },
  },
  audit: {
    summary: 'Dresse l\'inventaire de ce qui existe déjà dans le domaine. Ne modifie rien.',
    readOnly: true,
  },
  setup: {
    summary: 'Fait tout, dans l\'ordre : groupe, puis calendriers, puis Drive partagé.',
    steps: ['group', 'calendar', 'drive'],
  },
  group: {
    summary: "Crée le groupe d'équipe et synchronise ses membres.",
  },
  calendar: {
    summary: 'Crée les calendriers partagés et accorde les accès à l\'équipe.',
  },
  drive: {
    summary: 'Crée le Drive partagé, applique les restrictions et bâtit l\'arborescence.',
  },
  detach: {
    summary: "Détache l'adresse personnelle des ressources de l'entreprise.",
    options: {
      '--recovery': true,
      '--recuperation': true,
      '--récupération': true,
    },
  },
  verify: {
    summary: "Relit tout via l'API et confirme que le résultat est conforme. Ne modifie rien.",
    readOnly: true,
  },
};

const COMMAND_ORDER = ['init', 'doctor', 'dns', 'audit', 'setup', 'group', 'calendar', 'drive', 'detach', 'verify'];

/* ------------------------------------------------------------------ *
 * Erreur d'utilisation (mauvaise commande, config manquante, etc.)
 * ------------------------------------------------------------------ */

class UsageError extends Error {
  constructor(message, { showHelp = false } = {}) {
    super(message);
    this.name = 'UsageError';
    this.showHelp = showHelp;
  }
}

/* ------------------------------------------------------------------ *
 * Couleurs (aucune dépendance : séquences ANSI à la main)
 *
 * Les règles doivent être EXACTEMENT celles de src/lib/log.mjs, sinon l'aide
 * du CLI et les messages des commandes ne s'accorderaient pas (par exemple
 * FORCE_COLOR=0, qui veut dire « pas de couleur », pas « couleur forcée »).
 * ------------------------------------------------------------------ */

const ESC = '\u001b[';
let COLOR_ON = false;

function computeColor(forcedOff) {
  if (forcedOff) return false;
  // Convention NO_COLOR (https://no-color.org) : toute valeur non vide désactive.
  if (typeof process.env.NO_COLOR === 'string' && process.env.NO_COLOR !== '') return false;
  if (process.env.TERM === 'dumb') return false;
  const force = process.env.FORCE_COLOR;
  if (typeof force === 'string' && force !== '' && force !== '0') return true;
  return Boolean(process.stdout && process.stdout.isTTY);
}

const paint = (code, text) => (COLOR_ON ? `${ESC}${code}m${text}${ESC}0m` : text);
const yellow = (t) => paint('33', t);
const bold = (t) => paint('1', t);
const dim = (t) => paint('2', t);
const cyan = (t) => paint('36', t);

/** Dessine un cadre bien visible autour de quelques lignes. */
function box(lines, colorize = (t) => t) {
  // On aplatit d'abord : une chaîne contenant un saut de ligne casserait le cadre.
  const flat = lines.flatMap((line) => String(line).split('\n'));
  if (flat.length === 0) return '';
  const width = Math.max(...flat.map((l) => l.length)) + 2;
  const out = [];
  out.push('+' + '='.repeat(width) + '+');
  for (const line of flat) {
    out.push('| ' + line + ' '.repeat(width - line.length - 1) + '|');
  }
  out.push('+' + '='.repeat(width) + '+');
  return out.map(colorize).join('\n');
}

/* ------------------------------------------------------------------ *
 * Analyse des arguments (à la main, zéro dépendance)
 * ------------------------------------------------------------------ */

/**
 * Première passe : on cherche le nom de la commande dans les arguments, avant
 * même de les analyser. C'est nécessaire parce que certaines commandes
 * acceptent des options qui leur sont propres (« init --force », par exemple) :
 * il faut savoir de quelle commande il s'agit pour savoir quoi accepter.
 *
 * @param {string[]} argv
 * @returns {string|null}
 */
function detectCommand(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? '');
    if (arg === '--config') {
      i += 1; // la valeur du --config n'est pas un nom de commande
      continue;
    }
    if (arg.startsWith('-')) continue;
    const lowered = arg.toLowerCase();
    if (Object.hasOwn(COMMANDS, lowered)) return lowered;
  }
  return null;
}

/**
 * @param {string[]} argv
 * @param {Record<string, boolean>} extraOptions options propres à la commande
 */
function parseArgs(argv, extraOptions = {}) {
  const parsed = {
    command: null,
    apply: false,
    help: false,
    version: false,
    configPath: null,
    noColor: false,
    extras: [],
    passthrough: [], // options propres à la commande, transmises telles quelles
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--') continue;

    if (arg === '--help' || arg === '-h' || arg === 'help' || arg === 'aide') {
      parsed.help = true;
    } else if (arg === '--version' || arg === '-v') {
      parsed.version = true;
    } else if (arg === '--apply') {
      parsed.apply = true;
    } else if (arg === '--no-color' || arg === '--sans-couleur') {
      parsed.noColor = true;
    } else if (arg === '--config') {
      const value = argv[i + 1];
      // Un mot commençant par « - » est forcément une autre option : sans ce
      // contrôle, « --config --apply » avalerait le --apply en silence.
      if (value === undefined || value === '' || value.startsWith('-')) {
        throw new UsageError(
          "L'option --config attend un chemin de fichier.\n" +
            '  Exemple : node src/cli.mjs setup --config ./config.json\n' +
            "  (Pour un fichier dont le nom commence par « - », utilise la forme --config=./-mon-fichier.json.)",
        );
      }
      parsed.configPath = value;
      i += 1;
    } else if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (!value) {
        throw new UsageError(
          "L'option --config attend un chemin de fichier.\n" +
            '  Exemple : node src/cli.mjs setup --config=./config.json',
        );
      }
      parsed.configPath = value;
    } else if (Object.hasOwn(extraOptions, arg)) {
      parsed.passthrough.push(arg);
      if (extraOptions[arg]) {
        const value = argv[i + 1];
        // Même précaution que pour --config : « --recovery --apply » ne doit pas
        // prendre « --apply » pour une adresse courriel et le faire disparaître.
        if (value === undefined || value === '' || value.startsWith('-')) {
          throw new UsageError(
            `L'option « ${arg} » attend une valeur juste après elle.\n` +
              `  Exemple : node src/cli.mjs ${detectCommand(argv) ?? '<commande>'} ${arg} <valeur> --apply`,
          );
        }
        parsed.passthrough.push(value);
        i += 1;
      }
    } else if (arg.startsWith('--') && arg.includes('=') && Object.hasOwn(extraOptions, arg.slice(0, arg.indexOf('=')))) {
      parsed.passthrough.push(arg);
    } else if (arg.startsWith('-')) {
      throw new UsageError(`Option inconnue : « ${arg} ».`, { showHelp: true });
    } else if (parsed.command === null) {
      parsed.command = arg.toLowerCase();
    } else {
      parsed.extras.push(arg);
    }
  }

  return parsed;
}

/** Distance de Levenshtein — sert seulement à suggérer la bonne commande. */
function editDistance(a, b) {
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[cols - 1];
}

function suggestCommand(name) {
  let best = null;
  let bestScore = Infinity;
  for (const candidate of COMMAND_ORDER) {
    const score = editDistance(name, candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore <= 3 ? best : null;
}

/* ------------------------------------------------------------------ *
 * Aide
 * ------------------------------------------------------------------ */

function readVersion() {
  try {
    const raw = readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8');
    return JSON.parse(raw).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp() {
  const pad = (name) => name.padEnd(9, ' ');
  const lines = [];

  lines.push(bold('Trousse Google Workspace — Portail') + dim(` (v${readVersion()})`));
  lines.push('Automatise la mise en place du Workspace : groupe, calendriers, Drive partagé.');
  lines.push('');
  lines.push(bold('UTILISATION'));
  lines.push('  node src/cli.mjs <commande> [--apply] [--config <chemin>] [--help]');
  lines.push('');
  lines.push(bold('COMMANDES'));
  for (const name of COMMAND_ORDER) {
    const def = COMMANDS[name];
    const tag = def.readOnly ? dim(' (lecture seule)') : '';
    lines.push(`  ${cyan(pad(name))} ${def.summary}${tag}`);
  }
  lines.push('');
  lines.push(bold('OPTIONS'));
  lines.push(
    `  ${cyan('--apply')}             Exécute pour de vrai. Sans cette option : simulation, rien n'est modifié.`,
  );
  lines.push(`  ${cyan('--config <chemin>')}   Fichier de configuration à utiliser (défaut : ./config.json).`);
  lines.push(`  ${cyan('--no-color')}          Désactive les couleurs (utile pour un journal ou un courriel).`);
  lines.push(`  ${cyan('-h, --help')}          Affiche cette aide.`);
  lines.push(`  ${cyan('-v, --version')}       Affiche la version de la trousse.`);
  lines.push('');
  lines.push(dim("  Options propres à « init » : --force (remplacer un config.json existant),"));
  lines.push(dim('  --oauth ou --service-account (mode de connexion), --admin <adresse>.'));
  lines.push(
    dim("  Option propre à « detach » : --recovery <adresse> — l'adresse de récupération qui"),
  );
  lines.push(dim("  remplacera l'adresse personnelle. Obligatoire quand il y en a une à remplacer."));
  lines.push('');
  lines.push(bold("PREMIÈRE UTILISATION (dans l'ordre)"));
  lines.push('  1. npm install');
  lines.push('  2. node src/cli.mjs init                 propose un config.json à partir de ton domaine');
  lines.push('  3. node src/cli.mjs init --apply         écrit le fichier config.json');
  lines.push("  4. node src/cli.mjs doctor               vérifie que l'accès à Google fonctionne");
  lines.push('  5. node src/cli.mjs setup                simulation : montre ce qui serait fait');
  lines.push('  6. node src/cli.mjs setup --apply        exécute pour de vrai');
  lines.push('  7. node src/cli.mjs verify               confirme que tout est bien en place');
  lines.push('');
  lines.push(
    dim('  (Tu peux aussi partir du modèle à la main : cp config.example.json config.json, puis'),
  );
  lines.push(dim("  remplacer les adresses d'exemple « @exemple.ca » par les vraies.)"));
  lines.push('');
  lines.push(bold('EXEMPLES'));
  lines.push(dim("  # Voir l'état actuel du domaine, sans rien changer"));
  lines.push('  node src/cli.mjs audit');
  lines.push('');
  lines.push(dim('  # Créer seulement le Drive partagé, pour de vrai'));
  lines.push('  node src/cli.mjs drive --apply');
  lines.push('');
  lines.push(dim("  # Détacher l'adresse personnelle des ressources de l'entreprise"));
  lines.push('  node src/cli.mjs detach            ' + dim('# simulation'));
  lines.push('  node src/cli.mjs detach --apply    ' + dim('# pour de vrai'));
  lines.push('');
  lines.push(dim('  # Utiliser un autre fichier de configuration'));
  lines.push('  node src/cli.mjs setup --apply --config ./config.autre-domaine.json');
  lines.push('');
  lines.push(
    dim('Raccourcis npm : npm run init · npm run doctor · npm run audit · npm run setup · npm run setup:apply · npm run verify'),
  );

  console.log(lines.join('\n'));
}

/* ------------------------------------------------------------------ *
 * Journalisation : on utilise src/lib/log.mjs, avec un filet de sécurité
 * si une fonction venait à manquer (la trousse reste utilisable).
 * ------------------------------------------------------------------ */

/**
 * Replis minimalistes. Il en faut UN PAR FONCTION que les commandes appellent :
 * une fonction absente de cette liste ET absente de log.mjs ferait planter la
 * commande avec « log.machin is not a function » en plein milieu du travail.
 */
const LOG_FALLBACKS = {
  banner: (m) => console.log(`\n=== ${m} ===`),
  step: (m) => console.log(`\n> ${m}`),
  info: (m) => console.log(`  ${m}`),
  ok: (m) => console.log(`  [OK] ${m}`),
  warn: (m) => console.warn(`  [ATTENTION] ${m}`),
  err: (m) => console.error(`  [ERREUR] ${m}`),
  plan: (m) => console.log(`  [PLAN] ${m}`),
  skip: (m) => console.log(`  [DÉJÀ OK] ${m}`),
  raw: (m = '') => console.log(String(m)),
  blank: () => console.log(''),
  bold: (m) => String(m),
  dim: (m) => String(m),
  table: (rows) => {
    // Repli très simple : une ligne par enregistrement, « clé: valeur ».
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        console.log(
          '  ' +
            Object.entries(row)
              .map(([k, v]) => `${k}: ${v ?? ''}`)
              .join(' | '),
        );
      } else {
        console.log('  ' + (Array.isArray(row) ? row.join(' | ') : String(row)));
      }
    }
  },
};

function hardenLog(mod) {
  // On repart de TOUT ce que log.mjs exporte (y compris ce qui n'a pas de repli
  // ci-dessous : stripAnsi, setColor, isColorEnabled…), puis on bouche les trous.
  const out = {};
  for (const [name, value] of Object.entries(mod ?? {})) {
    if (typeof value === 'function') out[name] = value;
  }
  for (const [name, fallback] of Object.entries(LOG_FALLBACKS)) {
    if (typeof out[name] !== 'function') out[name] = fallback;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Chemins : configuration et cache d'état
 * ------------------------------------------------------------------ */

function resolveConfigPath(explicit) {
  if (explicit) return path.resolve(process.cwd(), explicit);
  const candidates = [path.resolve(process.cwd(), 'config.json'), path.join(ROOT_DIR, 'config.json')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1];
}

/** Vrai si la commande a besoin d'un config.json déjà écrit pour fonctionner. */
function needsConfigFile(definition) {
  return definition?.needsConfig !== false;
}

function ensureConfigExists(configPath) {
  if (existsSync(configPath)) return;
  throw new UsageError(
    `Fichier de configuration introuvable : ${configPath}\n` +
      '\n' +
      'Quoi faire — le plus simple, la trousse le remplit pour toi :\n' +
      `  1. cd ${ROOT_DIR}\n` +
      '  2. node src/cli.mjs init            montre le config.json proposé, sans rien écrire\n' +
      '  3. node src/cli.mjs init --apply    écrit le fichier\n' +
      '\n' +
      'Ou à la main :\n' +
      '  cp config.example.json config.json\n' +
      "  puis ouvre config.json et remplace les adresses d'exemple « @exemple.ca » par les vraies.\n" +
      '\n' +
      'Si ta configuration est ailleurs : node src/cli.mjs <commande> --config /chemin/vers/config.json',
  );
}

/**
 * Le cache d'état vit à côté du config.json utilisé (et non du dossier courant) :
 * deux domaines gérés depuis la même machine ont ainsi deux caches distincts.
 */
function resolveStateFile(config, configPath) {
  const baseDir = path.dirname(config?.__configFile ?? configPath);
  return path.join(baseDir, '.state.json');
}

/* ------------------------------------------------------------------ *
 * Chargement dynamique d'une commande
 * ------------------------------------------------------------------ */

async function loadCommandModule(name) {
  const file = path.join(COMMANDS_DIR, `${name}.mjs`);
  if (!existsSync(file)) {
    throw new UsageError(
      `La commande « ${name} » est introuvable : le fichier ${file} n'existe pas.\n` +
        'La trousse est probablement incomplète. Vérifie le contenu du dossier src/commands/.',
    );
  }
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.run !== 'function') {
    throw new UsageError(
      `Le fichier ${file} n'exporte pas de fonction « run ». Impossible d'exécuter la commande « ${name} ».`,
    );
  }
  return mod;
}

/* ------------------------------------------------------------------ *
 * Résumés retournés par les commandes
 * ------------------------------------------------------------------ */

function describeEntry(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object') return String(entry);

  const candidate =
    entry.label ??
    entry.message ??
    entry.name ??
    entry.summary ??
    entry.title ??
    entry.email ??
    entry.path ??
    entry.key;
  // Un « nom » qui serait lui-même un objet donnerait « [object Object] » :
  // on ne retient que ce qui s'affiche vraiment.
  const label = typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : null;
  const id = typeof entry.id === 'string' || typeof entry.id === 'number' ? String(entry.id) : null;

  if (label && id && id !== label) return `${label} (${id})`;
  if (label) return label;
  if (id) return id;
  try {
    return JSON.stringify(entry);
  } catch {
    return String(entry);
  }
}

function toList(value) {
  if (value === null || value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.map(describeEntry).filter((item) => item !== null && item !== '');
}

function normalizeSummary(result) {
  return {
    created: toList(result?.created),
    updated: toList(result?.updated),
    unchanged: toList(result?.unchanged),
    warnings: toList(result?.warnings),
  };
}

/**
 * @param {object} log
 * @param {Array} summaries
 * @param {{ apply: boolean, readOnly: boolean, touchesGoogle: boolean }} mode
 * @param {number} elapsedMs
 */
function printSummary(log, summaries, mode, elapsedMs) {
  const { apply, readOnly, touchesGoogle } = mode;
  log.banner('Résumé');

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalUnchanged = 0;
  let totalWarnings = 0;

  for (const entry of summaries) {
    const { name, created, updated, unchanged, warnings } = entry;
    totalCreated += created.length;
    totalUpdated += updated.length;
    totalUnchanged += unchanged.length;
    totalWarnings += warnings.length;

    const verbCreated = apply ? 'créé(s)' : 'à créer';
    const verbUpdated = apply ? 'ajusté(s)' : 'à ajuster';
    log.step(
      `${name} : ${created.length} ${verbCreated}, ${updated.length} ${verbUpdated}, ` +
        `${unchanged.length} déjà conforme(s), ${warnings.length} point(s) à lire`,
    );

    for (const item of created) {
      if (apply) log.ok(`Créé : ${item}`);
      else log.plan(`À créer : ${item}`);
    }
    for (const item of updated) {
      if (apply) log.ok(`Ajusté : ${item}`);
      else log.plan(`À ajuster : ${item}`);
    }
    for (const item of unchanged) log.skip(item);
    for (const item of warnings) log.warn(item);
  }

  const seconds = (elapsedMs / 1000).toFixed(1);
  log.step(
    `Total : ${totalCreated} création(s), ${totalUpdated} ajustement(s), ` +
      `${totalUnchanged} déjà conforme(s), ${totalWarnings} point(s) à lire — en ${seconds} s`,
  );

  const chezQui = touchesGoogle ? 'chez Google' : 'sur ton ordinateur';

  if (readOnly) {
    // Surtout pas d'invitation à relancer avec --apply : cette commande-là
    // ignore --apply, et le dire ici embrouillerait.
    log.info("Cette commande est en lecture seule : elle n'a rien modifié, ni chez Google ni sur ton ordinateur.");
  } else if (!apply) {
    log.plan(`Rien n'a été modifié ${chezQui}. Relance la même commande avec --apply quand le plan te convient.`);
  } else {
    log.ok('Terminé.');
    if (touchesGoogle) {
      log.info("Pour confirmer le résultat en relisant tout via l'API : node src/cli.mjs verify");
    }
  }

  if (totalWarnings > 0) {
    log.warn(
      `Il y a ${totalWarnings} point(s) à lire ci-dessus (lignes « ATTENTION »). ` +
        'Chacun dit ce qui demande une décision ou une intervention à la main dans la console Google. ' +
        'Rien ne se corrige tout seul en relançant : lis-les avant de passer à la suite.',
    );
  }
}

/* ------------------------------------------------------------------ *
 * Programme principal
 * ------------------------------------------------------------------ */

async function main() {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (Number.isFinite(nodeMajor) && nodeMajor < MIN_NODE_MAJOR) {
    console.error(
      `Cette trousse exige Node.js ${MIN_NODE_MAJOR} ou plus récent. Version détectée : ${process.versions.node}.\n` +
        'Installe une version à jour depuis https://nodejs.org puis relance la commande.',
    );
    return 1;
  }

  const argv = process.argv.slice(2);
  const guessedCommand = detectCommand(argv);
  const args = parseArgs(argv, COMMANDS[guessedCommand]?.options ?? {});

  if (args.noColor) process.env.NO_COLOR = '1';
  COLOR_ON = computeColor(args.noColor);

  if (args.version) {
    console.log(readVersion());
    return 0;
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  if (!args.command) {
    printHelp();
    console.error('\n' + yellow('Il faut préciser une commande. Par exemple : node src/cli.mjs doctor'));
    return 1;
  }

  const definition = COMMANDS[args.command];
  if (!definition) {
    const suggestion = suggestCommand(args.command);
    throw new UsageError(
      `Commande inconnue : « ${args.command} ».\n` +
        (suggestion ? `Voulais-tu dire « ${suggestion} » ?\n` : '') +
        `Commandes disponibles : ${COMMAND_ORDER.join(', ')}.`,
    );
  }

  if (args.extras.length > 0) {
    throw new UsageError(
      `Argument en trop : « ${args.extras[0]} ». Une seule commande à la fois.\n` +
        '  Exemple : node src/cli.mjs setup --apply',
      { showHelp: true },
    );
  }

  // Les commandes en lecture seule ne peuvent JAMAIS écrire, même avec --apply.
  const readOnly = Boolean(definition.readOnly);
  const apply = readOnly ? false : args.apply;
  const touchesGoogle = definition.touchesGoogle !== false;

  const log = hardenLog(await import('./lib/log.mjs'));

  const configPath = resolveConfigPath(args.configPath);

  // Garde-fou : config.example.json est le MODÈLE, et c'est le seul fichier de
  // configuration que le .gitignore laisse partir sur le dépôt (public). Y
  // écrire les vraies adresses du domaine les publierait au prochain commit.
  if (!needsConfigFile(definition) && path.basename(configPath) === 'config.example.json') {
    throw new UsageError(
      `Refus d'écrire dans ${configPath}.\n` +
        '\n' +
        "Ce fichier-là est le MODÈLE de la trousse : c'est le seul fichier de configuration qui\n" +
        'peut être publié sur le dépôt (qui est PUBLIC). Il ne doit contenir que des adresses\n' +
        "d'exemple, jamais celles de ton domaine.\n" +
        '\n' +
        'Quoi faire : viser config.json, qui lui reste privé :\n' +
        '  node src/cli.mjs init --config ./config.json',
    );
  }

  // « init » est la commande qui CRÉE config.json : exiger le fichier ici
  // rendrait la trousse impossible à démarrer.
  const needsConfig = needsConfigFile(definition);
  let config = null;
  if (needsConfig) {
    ensureConfigExists(configPath);
    const { loadConfig } = await import('./lib/config.mjs');
    config = await loadConfig(configPath);
  } else if (existsSync(configPath)) {
    const { loadConfig } = await import('./lib/config.mjs');
    try {
      config = await loadConfig(configPath);
    } catch (error) {
      // Un config.json cassé ne doit pas empêcher « init » de le regénérer :
      // c'est précisément le moment où on en a le plus besoin.
      log.warn(
        `Le fichier ${configPath} existe mais n'est pas utilisable : ${error?.message ?? error}\n` +
          "On continue sans lui : la commande « init » va justement en proposer un nouveau.",
      );
      config = null;
    }
  }

  log.banner(`Trousse Google Workspace — commande « ${args.command} »`);
  if (config) {
    log.info(`Domaine cible                : ${config.domain}`);
    log.info(`Compte au nom duquel on agit : ${config.adminEmail}`);
    log.info(`Mode de connexion            : ${config?.auth?.mode ?? 'inconnu'}`);
    log.info(`Configuration                : ${configPath}`);
  } else {
    log.info(`Configuration                : aucune pour l'instant (fichier visé : ${configPath})`);
  }

  if (readOnly) {
    log.info('Cette commande est en LECTURE SEULE : elle ne modifie rien, peu importe les options.');
    if (args.apply) {
      log.warn(`La commande « ${args.command} » ne modifie jamais rien : l'option --apply est sans effet ici.`);
    }
  } else if (!apply) {
    console.log(
      '\n' +
        box(
          [
            'MODE SIMULATION — rien ne sera modifié.',
            'Ajoute --apply pour exécuter pour de vrai.',
          ],
          (line) => yellow(bold(line)),
        ),
    );
  } else if (touchesGoogle) {
    log.warn('MODE RÉEL (--apply) : les changements ci-dessous seront appliqués chez Google.');
  } else {
    log.warn(`MODE RÉEL (--apply) : un fichier va être écrit sur ton ordinateur. Rien n'est envoyé à Google.`);
  }

  // Cache local des identifiants créés. Ce n'est qu'une optimisation :
  // s'il est absent ou périmé, les commandes redécouvrent tout via l'API.
  const stateModule = await import('./lib/state.mjs');
  const stateFile = resolveStateFile(config, configPath);
  let state;
  try {
    state = (await stateModule.loadState(stateFile, { onWarn: log.warn })) ?? {};
  } catch (error) {
    log.warn(
      `Cache local illisible (${stateFile}) : ${error?.message ?? error}. ` +
        "On continue sans cache : tout sera redécouvert via l'API.",
    );
    state = {};
  }

  const persistState = async () => {
    if (!apply) return;
    try {
      await stateModule.saveState(stateFile, state, { onWarn: log.warn });
    } catch (error) {
      log.warn(
        `Impossible d'écrire le cache local (${stateFile}) : ${error?.message ?? error}. ` +
          "Ce n'est pas grave : le cache n'est qu'une optimisation, rien n'est perdu chez Google.",
      );
    }
  };

  const steps = definition.steps ?? [args.command];
  if (steps.length > 1) {
    log.info(`Étapes prévues : ${steps.join(' -> ')}`);
  }

  const startedAt = Date.now();
  const summaries = [];

  try {
    for (const stepName of steps) {
      const mod = await loadCommandModule(stepName);
      const label = mod.meta?.name ?? stepName;
      const description = mod.meta?.summary ?? COMMANDS[stepName]?.summary ?? '';
      log.banner(`Commande « ${label} »`);
      if (description) log.info(description);

      const result = await mod.run({
        config,
        apply,
        state,
        log,
        configPath,
        argv: args.passthrough,
      });
      summaries.push({ name: label, ...normalizeSummary(result) });
      await persistState();
    }
  } finally {
    // Même si une étape échoue : ce qui a déjà été créé chez Google est noté
    // dans le cache, pour que la reprise soit plus rapide (et jamais en double).
    await persistState();
  }

  printSummary(log, summaries, { apply, readOnly, touchesGoogle }, Date.now() - startedAt);
  return 0;
}

/* ------------------------------------------------------------------ *
 * Filet de sécurité : on attrape TOUT et on explique en français.
 * ------------------------------------------------------------------ */

let alreadyReported = false;

async function reportFatal(error) {
  if (alreadyReported) return 1;
  alreadyReported = true;

  let logModule;
  let explain = null;
  try {
    logModule = hardenLog(await import('./lib/log.mjs'));
  } catch {
    logModule = hardenLog(null);
  }
  try {
    ({ explainGoogleError: explain } = await import('./lib/google.mjs'));
  } catch {
    explain = null;
  }

  if (error instanceof UsageError) {
    logModule.err(error.message);
    if (error.showHelp) {
      console.log('');
      printHelp();
    }
    return 1;
  }

  let explanation = null;
  if (typeof explain === 'function') {
    try {
      const value = explain(error);
      if (typeof value === 'string' && value.trim()) explanation = value;
    } catch {
      explanation = null;
    }
  }

  logModule.err("La commande a échoué. Aucune autre modification n'a été tentée.");
  logModule.err(explanation ?? error?.message ?? String(error));
  logModule.info('Pistes :');
  logModule.info("  · node src/cli.mjs doctor  -> vérifie l'authentification et les API activées");
  logModule.info("  · Relis config.json (domaine, adresses, mode de connexion)");
  logModule.info('  · Pour la trace technique complète : PORTAIL_DEBUG=1 node src/cli.mjs <commande>');

  if (process.env.PORTAIL_DEBUG && error?.stack) {
    console.error('\n' + error.stack);
  }
  return 1;
}

/**
 * Sort proprement.
 *
 * process.exit() coupe le processus sans attendre que la sortie soit
 * réellement écrite : redirigée vers un fichier ou un « pipe » (par exemple
 * « node src/cli.mjs audit > journal.txt »), la fin du rapport serait perdue.
 * On vide donc les tampons avant de partir.
 */
async function exitAfterFlush(code) {
  const flush = (stream) =>
    new Promise((resolve) => {
      if (!stream || typeof stream.write !== 'function' || stream.writableEnded) return resolve();
      try {
        stream.write('', () => resolve());
      } catch {
        resolve();
      }
    });

  const timeout = new Promise((resolve) => setTimeout(resolve, 2000).unref?.());
  try {
    await Promise.race([Promise.all([flush(process.stdout), flush(process.stderr)]), timeout]);
  } catch {
    /* on sort quand même */
  }
  process.exit(code);
}

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  reportFatal(error).then((code) => exitAfterFlush(code));
});

process.on('uncaughtException', (error) => {
  reportFatal(error).then((code) => exitAfterFlush(code));
});

process.on('SIGINT', () => {
  console.log("\nInterrompu par l'utilisateur. Rien de plus n'a été envoyé à Google.");
  exitAfterFlush(130);
});

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  exitCode = await reportFatal(error);
}
await exitAfterFlush(exitCode);
