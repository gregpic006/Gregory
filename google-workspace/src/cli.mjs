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
 * readOnly : la commande ne modifie jamais rien. On force alors apply=false,
 *            peu importe ce qui est passé en ligne de commande (ceinture ET bretelles).
 * steps    : commande composite — on exécute ces commandes dans l'ordre.
 */
const COMMANDS = {
  doctor: {
    summary: "Vérifie l'accès : clé, délégation, API activées. Ne modifie rien.",
    readOnly: true,
  },
  audit: {
    summary: "Dresse l'inventaire de ce qui existe déjà dans le domaine. Ne modifie rien.",
    readOnly: true,
  },
  setup: {
    summary: "Fait tout, dans l'ordre : groupe, puis calendriers, puis Drive partagé.",
    steps: ['group', 'calendar', 'drive'],
  },
  group: {
    summary: "Crée le groupe d'équipe et synchronise ses membres.",
  },
  calendar: {
    summary: "Crée les calendriers partagés et accorde les accès à l'équipe.",
  },
  drive: {
    summary: "Crée le Drive partagé, applique les restrictions et bâtit l'arborescence.",
  },
  detach: {
    summary: "Détache l'adresse personnelle des ressources de l'entreprise.",
  },
  verify: {
    summary: "Relit tout via l'API et confirme que le résultat est conforme. Ne modifie rien.",
    readOnly: true,
  },
};

const COMMAND_ORDER = ['doctor', 'audit', 'setup', 'group', 'calendar', 'drive', 'detach', 'verify'];

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
 * ------------------------------------------------------------------ */

const ESC = '[';
let COLOR_ON = false;

function computeColor(forcedOff) {
  if (forcedOff) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

const paint = (code, text) => (COLOR_ON ? `${ESC}${code}m${text}${ESC}0m` : text);
const yellow = (t) => paint('33', t);
const bold = (t) => paint('1', t);
const dim = (t) => paint('2', t);
const cyan = (t) => paint('36', t);

/** Dessine un cadre bien visible autour de quelques lignes. */
function box(lines, colorize = (t) => t) {
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  const out = [];
  out.push('+' + '='.repeat(width) + '+');
  for (const line of lines) {
    out.push('| ' + line + ' '.repeat(width - line.length - 1) + '|');
  }
  out.push('+' + '='.repeat(width) + '+');
  return out.map(colorize).join('\n');
}

/* ------------------------------------------------------------------ *
 * Analyse des arguments (à la main, zéro dépendance)
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const parsed = {
    command: null,
    apply: false,
    help: false,
    version: false,
    configPath: null,
    noColor: false,
    extras: [],
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
      if (!value || value.startsWith('-')) {
        throw new UsageError(
          "L'option --config attend un chemin de fichier.\n" +
            '  Exemple : node src/cli.mjs setup --config ./config.json',
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
  lines.push(bold("PREMIÈRE UTILISATION (dans l'ordre)"));
  lines.push('  1. cp config.example.json config.json   puis remplace toutes les valeurs « REMPLACER »');
  lines.push('  2. npm install');
  lines.push("  3. node src/cli.mjs doctor              vérifie que l'accès à Google fonctionne");
  lines.push('  4. node src/cli.mjs setup               simulation : montre ce qui serait fait');
  lines.push('  5. node src/cli.mjs setup --apply       exécute pour de vrai');
  lines.push('  6. node src/cli.mjs verify              confirme que tout est bien en place');
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
    dim('Raccourcis npm : npm run doctor · npm run audit · npm run setup · npm run setup:apply · npm run verify'),
  );

  console.log(lines.join('\n'));
}

/* ------------------------------------------------------------------ *
 * Journalisation : on utilise src/lib/log.mjs, avec un filet de sécurité
 * si une fonction venait à manquer (la trousse reste utilisable).
 * ------------------------------------------------------------------ */

function hardenLog(mod) {
  const fallbacks = {
    banner: (m) => console.log(`\n=== ${m} ===`),
    step: (m) => console.log(`\n> ${m}`),
    info: (m) => console.log(`  ${m}`),
    ok: (m) => console.log(`  [OK] ${m}`),
    warn: (m) => console.warn(`  [ATTENTION] ${m}`),
    err: (m) => console.error(`  [ERREUR] ${m}`),
    plan: (m) => console.log(`  [PLAN] ${m}`),
    skip: (m) => console.log(`  [DÉJÀ OK] ${m}`),
    table: (rows) => console.log(rows),
  };
  const out = {};
  for (const [name, fallback] of Object.entries(fallbacks)) {
    out[name] = typeof mod?.[name] === 'function' ? mod[name] : fallback;
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

function ensureConfigExists(configPath) {
  if (existsSync(configPath)) return;
  throw new UsageError(
    `Fichier de configuration introuvable : ${configPath}\n` +
      '\n' +
      'Quoi faire :\n' +
      `  1. cd ${ROOT_DIR}\n` +
      '  2. cp config.example.json config.json\n' +
      '  3. Ouvre config.json et remplace toutes les valeurs « REMPLACER » par les vraies.\n' +
      '  4. Relance la commande.\n' +
      '\n' +
      'Si ta configuration est ailleurs : node src/cli.mjs <commande> --config /chemin/vers/config.json',
  );
}

function resolveStateFile(config, configPath) {
  const fromConfig = typeof config?.stateFile === 'string' ? config.stateFile.trim() : '';
  const baseDir = path.dirname(configPath);
  if (fromConfig) return path.resolve(baseDir, fromConfig);
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

  const label =
    entry.label ??
    entry.message ??
    entry.name ??
    entry.summary ??
    entry.title ??
    entry.email ??
    entry.path ??
    entry.key;
  if (label && entry.id && entry.id !== label) return `${label} (${entry.id})`;
  if (label) return String(label);
  if (entry.id) return String(entry.id);
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

function printSummary(log, summaries, apply, elapsedMs) {
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
        `${unchanged.length} déjà conforme(s), ${warnings.length} avertissement(s)`,
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
      `${totalUnchanged} déjà conforme(s), ${totalWarnings} avertissement(s) — en ${seconds} s`,
  );

  if (!apply) {
    log.plan("Rien n'a été modifié chez Google. Relance la même commande avec --apply quand le plan te convient.");
  } else {
    log.ok('Terminé.');
    log.info("Pour confirmer le résultat en relisant tout via l'API : node src/cli.mjs verify");
  }

  if (totalWarnings > 0) {
    log.warn(
      `Il y a ${totalWarnings} avertissement(s) ci-dessus. Ce ne sont pas des erreurs, mais lis-les : ` +
        'ils indiquent ce qui demande une intervention manuelle dans la console Google.',
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

  const args = parseArgs(process.argv.slice(2));

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
  const apply = definition.readOnly ? false : args.apply;

  const log = hardenLog(await import('./lib/log.mjs'));

  const configPath = resolveConfigPath(args.configPath);
  ensureConfigExists(configPath);

  const { loadConfig } = await import('./lib/config.mjs');
  const config = await loadConfig(configPath);

  log.banner(`Trousse Google Workspace — commande « ${args.command} »`);
  log.info(`Domaine cible           : ${config.domain}`);
  log.info(`Compte impersonné       : ${config.adminEmail}`);
  log.info(`Mode d'authentification : ${config?.auth?.mode ?? 'inconnu'}`);
  log.info(`Configuration           : ${configPath}`);

  if (definition.readOnly) {
    log.info('Cette commande est en LECTURE SEULE : elle ne modifie rien, peu importe les options.');
    if (args.apply) {
      log.warn(`La commande « ${args.command} » ne modifie jamais rien : l'option --apply est sans effet ici.`);
    }
  } else if (!apply) {
    console.log(
      '\n' +
        box(['MODE SIMULATION — rien ne sera modifié.', 'Ajoute --apply pour exécuter pour de vrai.'], (line) =>
          yellow(bold(line)),
        ),
    );
  } else {
    log.warn('MODE RÉEL (--apply) : les changements ci-dessous seront appliqués chez Google.');
  }

  // Cache local des identifiants créés. Ce n'est qu'une optimisation :
  // s'il est absent ou périmé, les commandes redécouvrent tout via l'API.
  const stateModule = await import('./lib/state.mjs');
  const stateFile = resolveStateFile(config, configPath);
  let state;
  try {
    state = (await stateModule.loadState(stateFile)) ?? {};
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
      await stateModule.saveState(stateFile, state);
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

  for (const stepName of steps) {
    const mod = await loadCommandModule(stepName);
    const label = mod.meta?.name ?? stepName;
    const description = mod.meta?.summary ?? COMMANDS[stepName]?.summary ?? '';
    log.banner(`Commande « ${label} »`);
    if (description) log.info(description);

    const result = await mod.run({ config, apply, state, log });
    summaries.push({ name: label, ...normalizeSummary(result) });
    await persistState();
  }

  printSummary(log, summaries, apply, Date.now() - startedAt);
  return 0;
}

/* ------------------------------------------------------------------ *
 * Filet de sécurité : on attrape TOUT et on explique en français.
 * ------------------------------------------------------------------ */

async function reportFatal(error) {
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
  logModule.info("  · Relis config.json (domaine, adresses, mode d'authentification)");
  logModule.info('  · Pour la trace technique complète : PORTAIL_DEBUG=1 node src/cli.mjs <commande>');

  if (process.env.PORTAIL_DEBUG && error?.stack) {
    console.error('\n' + error.stack);
  }
  return 1;
}

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  reportFatal(error).then((code) => process.exit(code));
});

process.on('SIGINT', () => {
  console.log("\nInterrompu par l'utilisateur. Rien de plus n'a été envoyé à Google.");
  process.exit(130);
});

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  exitCode = await reportFatal(error);
}
process.exit(exitCode);
