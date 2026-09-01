/**
 * config.mjs — Lecture, valeurs par défaut et validation de config.json.
 *
 * Philosophie : on bloque tôt et on dit exactement quoi corriger, dans quel
 * champ. Une erreur de configuration attrapée ici coûte 10 secondes ; la même
 * erreur attrapée par l'API Google coûte un message anglais incompréhensible
 * et, dans le pire des cas, une ressource créée à moitié.
 *
 * Deux niveaux :
 *   - ERREUR  → on lève, rien ne s'exécute.
 *   - AVERTISSEMENT → on continue, mais on le dit (ex. un membre de l'équipe
 *     dont l'adresse n'est pas dans le domaine : c'est légal, mais c'est
 *     presque toujours une faute de frappe).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import log from './log.mjs';

/** Rôles acceptés pour un membre de l'équipe (rôle dans le Drive partagé / le groupe). */
export const TEAM_ROLES = ['organizer', 'member'];

/** Rôles ACL acceptés par l'API Calendar (calendar.acl.insert → role). */
export const CALENDAR_ROLES = ['none', 'freeBusyReader', 'reader', 'writer', 'owner'];

/** Restrictions acceptées par l'API Drive (drives.restrictions). */
export const DRIVE_RESTRICTION_KEYS = [
  'domainUsersOnly',
  'driveMembersOnly',
  'copyRequiresWriterPermission',
  'sharingFoldersRequiresOrganizerPermission',
  'adminManagedRestrictions',
];

/** Profondeur maximale de l'arborescence de dossiers. Au-delà, c'est ingérable. */
const MAX_FOLDER_DEPTH = 8;

/** Longueur maximale d'un nom de dossier Drive. */
const MAX_FOLDER_NAME_LENGTH = 255;

/**
 * Valeurs par défaut. Tout champ absent de config.json prend cette valeur.
 * Les restrictions du Drive partagé sont volontairement SERRÉES par défaut :
 * l'exigence numéro un du client est que rien ne fuite à l'extérieur.
 */
export const DEFAULTS = Object.freeze({
  domain: null,
  adminEmail: null,
  personalEmail: null,
  timeZone: 'America/Toronto',
  team: [],
  group: null,
  calendars: [],
  sharedDrive: {
    name: "Espace d'équipe",
    restrictions: {
      domainUsersOnly: true,
      driveMembersOnly: true,
      copyRequiresWriterPermission: false,
      sharingFoldersRequiresOrganizerPermission: true,
    },
    folders: [],
    createReadme: true,
  },
  auth: {
    // « oauth » est le défaut, et c'est le MÊME défaut que celui d'auth.mjs
    // (DEFAULT_AUTH_MODE). Les deux modules doivent rester d'accord : sinon un
    // config.json sans « auth.mode » partirait en mode compte de service et
    // réclamerait une clé privée que Google refuse désormais de créer sur les
    // organisations récentes.
    mode: 'oauth',
    keyFile: './service-account.json',
    oauthClientFile: './oauth-client.json',
    tokenFile: './.tokens.json',
  },
});

/**
 * Clés reconnues, par section. Sert à repérer les fautes de frappe : une clé
 * inconnue est ignorée en silence par JSON.parse, ce qui donne un script qui
 * « ne tient pas compte » d'un réglage sans jamais le dire.
 * Les clés commençant par « _ » sont libres (commentaires dans le JSON).
 */
const KNOWN_KEYS = Object.freeze({
  root: ['domain', 'adminEmail', 'personalEmail', 'timeZone', 'team', 'group', 'calendars', 'sharedDrive', 'auth'],
  sharedDrive: ['name', 'restrictions', 'folders', 'createReadme'],
  auth: ['mode', 'keyFile', 'oauthClientFile', 'tokenFile'],
  // Les sous-objets comptent AUTANT que la racine : « timezone » au lieu de
  // « timeZone » dans un calendrier passait autrefois inaperçu, et le
  // calendrier était créé dans le mauvais fuseau sans que rien ne le dise.
  team: ['email', 'name', 'role'],
  group: ['email', 'name', 'description'],
  calendar: ['key', 'summary', 'description', 'timeZone', 'role'],
  folder: ['name', 'children'],
});

/** Distance de Levenshtein, pour suggérer « tu voulais dire … ». */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let previous = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const current = [i];
    for (let j = 1; j <= n; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[n];
}

/** Avertit pour chaque clé non reconnue, avec la correction la plus probable. */
function warnUnknownKeys(object, known, sectionLabel, warnings) {
  for (const key of Object.keys(object)) {
    if (key.startsWith('_')) continue; // convention de commentaire
    if (known.includes(key)) continue;

    const lowered = key.toLowerCase();
    const candidates = known
      .map((k) => ({ k, d: editDistance(lowered, k.toLowerCase()) }))
      .sort((x, y) => x.d - y.d);
    const best = candidates[0];
    const suggestion = best && best.d <= Math.max(2, Math.ceil(key.length / 3)) ? ` Tu voulais peut-être « ${best.k} » ?` : '';

    warnings.push(
      `${sectionLabel} : le champ « ${key} » n'est pas reconnu et sera ignoré.${suggestion} ` +
        `Champs acceptés : ${known.join(', ')}.`,
    );
  }
}

/** Erreur de configuration : message déjà formaté et lisible par un humain. */
export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {{ problems?: Array<{ field: string, msg: string }>, file?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'CONFIG_INVALID';
    this.problems = details.problems ?? [];
    this.file = details.file ?? null;
  }
}

/* ------------------------------------------------------------------ */
/* Petits utilitaires                                                  */
/* ------------------------------------------------------------------ */

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Validation d'adresse courriel : volontairement permissive sur la partie
 * locale (Google accepte les points, tirets, apostrophes…) mais stricte sur la
 * forme générale.
 */
const EMAIL_RE = /^[^\s@,;:<>"()[\]\\]+@[^\s@,;:<>"()[\]\\]+\.[a-z]{2,}$/i;

/** Nom de domaine simple (pas d'URL, pas d'arobase, pas de barre oblique). */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Clé de calendrier : sert aussi de clé dans le cache d'état. */
const CALENDAR_KEY_RE = /^[a-z0-9][a-z0-9._-]*$/i;

const isEmail = (v) => typeof v === 'string' && EMAIL_RE.test(v.trim());

/** Retourne la partie domaine d'un courriel, en minuscules. */
const domainOf = (email) => String(email).split('@').pop().trim().toLowerCase();

/** Développe `~` et rend un chemin absolu relativement à `base`. */
export function resolvePath(base, filePath) {
  if (!isNonEmptyString(filePath)) return null;
  let p = filePath.trim();
  if (p === '~') p = homedir();
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(base, p);
}

/** Définit une propriété non énumérable (invisible pour JSON.stringify). */
function defineHidden(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: false, writable: true, configurable: true });
}

/** Retire le BOM UTF-8 éventuel laissé par certains éditeurs Windows. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/* ------------------------------------------------------------------ */
/* Chargement                                                          */
/* ------------------------------------------------------------------ */

/**
 * Charge, complète et valide le fichier de configuration.
 *
 * Fonction SYNCHRONE : `loadConfig(p)` et `await loadConfig(p)` fonctionnent
 * tous les deux, ce qui évite un piège d'appel côté CLI.
 *
 * @param {string} [file] chemin du config.json (défaut : ./config.json)
 * @param {{ onWarn?: (msg: string) => void }} [options]
 * @returns {object} la configuration normalisée
 * @throws {ConfigError} message français listant tout ce qu'il faut corriger
 */
export function loadConfig(file = './config.json', options = {}) {
  const onWarn = options.onWarn ?? log.warn;
  const path = resolvePath(process.cwd(), file);

  if (!existsSync(path)) {
    throw new ConfigError(
      [
        `Fichier de configuration introuvable : ${path}`,
        '',
        'Quoi faire :',
        `  1. Copier le modèle : cp config.example.json ${file}`,
        '  2. Ouvrir le fichier et remplir le domaine, les adresses et l\'équipe.',
        `  3. Relancer la commande (ou pointer ailleurs avec --config <chemin>).`,
      ].join('\n'),
      { file: path },
    );
  }

  if (statSync(path).isDirectory()) {
    throw new ConfigError(
      `Le chemin de configuration « ${path} » est un dossier, pas un fichier.\n` +
        'Quoi faire : pointer directement sur le fichier JSON, par exemple ' +
        `${join(path, 'config.json')}.`,
      { file: path },
    );
  }

  let text;
  try {
    text = stripBom(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(
      `Impossible de lire ${path} : ${e.message}\n` +
        'Quoi faire : vérifier les permissions du fichier (droits de lecture).',
      { file: path },
    );
  }

  if (text.trim() === '') {
    throw new ConfigError(
      `Le fichier ${path} est vide.\n` +
        'Quoi faire : y coller le contenu de config.example.json, puis le remplir.',
      { file: path },
    );
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(
      [
        `Le fichier ${path} n'est pas du JSON valide.`,
        `Détail technique : ${e.message}`,
        '',
        'Causes les plus fréquentes :',
        '  - une virgule en trop avant une accolade } ou un crochet ]',
        '  - une virgule manquante entre deux champs',
        '  - des guillemets « courbes » collés depuis Word au lieu de guillemets droits "',
        '  - des commentaires // ou /* */ : le JSON n\'en accepte pas',
        '',
        'Quoi faire : coller le contenu dans un validateur JSON, corriger, relancer.',
      ].join('\n'),
      { file: path },
    );
  }

  if (!isPlainObject(json)) {
    throw new ConfigError(
      `Le fichier ${path} doit contenir un objet JSON { ... }, ` +
        `pas ${Array.isArray(json) ? 'un tableau' : `une valeur de type ${typeof json}`}.`,
      { file: path },
    );
  }

  const { config, errors, warnings } = validateConfig(json);

  if (errors.length > 0) {
    throw new ConfigError(formatProblems(path, errors), { problems: errors, file: path });
  }

  for (const w of warnings) onWarn(w);

  const dir = dirname(path);
  defineHidden(config, '__configFile', path);
  defineHidden(config, '__configDir', dir);
  defineHidden(config, '__warnings', warnings);

  // Chemins absolus prêts à l'emploi pour auth.mjs (non énumérables : ils ne
  // polluent pas une éventuelle réécriture du config.json).
  defineHidden(config.auth, 'resolved', {
    keyFile: resolvePath(dir, config.auth.keyFile),
    oauthClientFile: resolvePath(dir, config.auth.oauthClientFile),
    tokenFile: resolvePath(dir, config.auth.tokenFile),
  });

  return config;
}

/** Met en forme la liste des problèmes en un message d'erreur unique. */
function formatProblems(path, problems) {
  const lines = [
    `${problems.length} problème${problems.length > 1 ? 's' : ''} dans ${path} :`,
    '',
  ];
  const numberWidth = String(problems.length).length;
  const continuation = ' '.repeat(2 + numberWidth + 2);
  problems.forEach((p, i) => {
    lines.push(`  ${String(i + 1).padStart(numberWidth)}. champ « ${p.field} »`);
    for (const line of p.msg.split('\n')) lines.push(`${continuation}${line}`);
  });
  lines.push('');
  lines.push('Corrige ces champs dans le fichier de configuration, puis relance.');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Valide et normalise un objet de configuration déjà analysé.
 * Exportée pour permettre des tests sans fichier sur disque.
 *
 * @param {object} input
 * @returns {{ config: object, errors: Array<{field: string, msg: string}>, warnings: string[] }}
 */
export function validateConfig(input) {
  /** @type {Array<{field: string, msg: string}>} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const fail = (field, msg) => errors.push({ field, msg });

  // Une clé mal orthographiée serait sinon ignorée en silence, et la valeur par
  // défaut s'appliquerait sans que personne ne s'en rende compte.
  warnUnknownKeys(input, KNOWN_KEYS.root, 'config.json', warnings);
  if (isPlainObject(input.sharedDrive)) warnUnknownKeys(input.sharedDrive, KNOWN_KEYS.sharedDrive, 'sharedDrive', warnings);
  if (isPlainObject(input.auth)) warnUnknownKeys(input.auth, KNOWN_KEYS.auth, 'auth', warnings);

  /* --- domaine ---------------------------------------------------- */
  let domain = null;
  if (!isNonEmptyString(input.domain)) {
    fail('domain', 'Champ obligatoire. Exemple : "domain": "portailgestion.ca"');
  } else {
    domain = input.domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (domain.includes('@')) {
      fail('domain', `« ${input.domain} » ressemble à un courriel. Mettre seulement le domaine, sans arobase.\nExemple : "domain": "portailgestion.ca"`);
      domain = domain.split('@').pop();
    } else if (!DOMAIN_RE.test(domain)) {
      fail('domain', `« ${input.domain} » n'est pas un nom de domaine valide.\nAttendu : quelque chose comme "portailgestion.ca" (sans https://, sans barre oblique).`);
    }
  }

  /* --- adminEmail ------------------------------------------------- */
  let adminEmail = null;
  if (!isNonEmptyString(input.adminEmail)) {
    fail('adminEmail', `Champ obligatoire : l'adresse du super-administrateur Workspace que le script emprunte (impersonation).\nExemple : "adminEmail": "greg@${domain ?? 'mondomaine.ca'}"`);
  } else {
    adminEmail = input.adminEmail.trim().toLowerCase();
    if (!isEmail(adminEmail)) {
      fail('adminEmail', `« ${input.adminEmail} » n'est pas une adresse courriel valide.`);
    } else if (domain && domainOf(adminEmail) !== domain) {
      fail(
        'adminEmail',
        `L'adresse « ${adminEmail} » n'est pas dans le domaine « ${domain} ».\n` +
          'Le compte emprunté DOIT appartenir au domaine Workspace administré, sinon Google\n' +
          'refuse le jeton (erreur invalid_grant).\n' +
          `Quoi faire : mettre l'adresse du super-admin du domaine, par exemple greg@${domain}.`,
      );
    }
  }

  /* --- personalEmail ---------------------------------------------- */
  let personalEmail = null;
  if (input.personalEmail !== undefined && input.personalEmail !== null && input.personalEmail !== '') {
    if (!isEmail(input.personalEmail)) {
      fail('personalEmail', `« ${input.personalEmail} » n'est pas une adresse courriel valide.\nMettre null si aucune adresse personnelle n'est à détacher.`);
    } else {
      personalEmail = String(input.personalEmail).trim().toLowerCase();
      if (domain && domainOf(personalEmail) === domain) {
        fail(
          'personalEmail',
          `L'adresse « ${personalEmail} » est dans le domaine « ${domain} ».\n` +
            'Ce champ désigne l\'adresse PERSONNELLE EXTERNE (gmail, hotmail…) à détacher\n' +
            'des ressources de l\'entreprise. Une adresse du domaine ici serait détachée\n' +
            'par erreur.\n' +
            'Quoi faire : y mettre l\'adresse personnelle externe, ou null s\'il n\'y en a pas.',
        );
      }
      if (adminEmail && personalEmail === adminEmail) {
        fail('personalEmail', 'personalEmail et adminEmail sont identiques. Ce sont deux comptes différents : l\'un administre le domaine, l\'autre est l\'adresse perso à détacher.');
      }
    }
  }

  /* --- timeZone global (défaut des calendriers) -------------------- */
  let timeZone = DEFAULTS.timeZone;
  if (input.timeZone !== undefined && input.timeZone !== null) {
    if (!isNonEmptyString(input.timeZone) || !isValidTimeZone(input.timeZone.trim())) {
      fail('timeZone', `« ${input.timeZone} » n'est pas un fuseau horaire IANA valide.\nExemple pour le Québec : "America/Toronto" (ou "America/Montreal").`);
    } else {
      timeZone = input.timeZone.trim();
    }
  }

  /* --- team ------------------------------------------------------- */
  /** @type {Array<{email: string, name: string, role: string}>} */
  const team = [];
  if (input.team === undefined || input.team === null) {
    fail('team', 'Champ obligatoire : la liste des membres de l\'équipe.\nExemple : "team": [ { "email": "greg@mondomaine.ca", "name": "Greg Picard", "role": "organizer" } ]');
  } else if (!Array.isArray(input.team)) {
    fail('team', `Doit être un tableau [ ... ], pas ${typeof input.team}.`);
  } else if (input.team.length === 0) {
    fail('team', 'La liste est vide : il faut au moins 1 membre, sinon il n\'y a personne à qui donner accès.');
  } else {
    const seenEmails = new Map();
    input.team.forEach((member, i) => {
      const field = `team[${i}]`;
      if (!isPlainObject(member)) {
        fail(field, `Chaque membre doit être un objet { "email": ..., "name": ..., "role": ... }, pas ${Array.isArray(member) ? 'un tableau' : typeof member}.`);
        return;
      }
      warnUnknownKeys(member, KNOWN_KEYS.team, field, warnings);

      let email = null;
      if (!isNonEmptyString(member.email)) {
        fail(`${field}.email`, 'Champ obligatoire.');
      } else if (!isEmail(member.email)) {
        fail(`${field}.email`, `« ${member.email} » n'est pas une adresse courriel valide.`);
      } else {
        email = member.email.trim().toLowerCase();
        if (seenEmails.has(email)) {
          fail(`${field}.email`, `L'adresse « ${email} » est déjà utilisée par team[${seenEmails.get(email)}]. Chaque membre doit avoir une adresse unique.`);
        } else {
          seenEmails.set(email, i);
        }
        if (domain && domainOf(email) !== domain) {
          warnings.push(
            `${field}.email : « ${email} » n'est pas dans le domaine « ${domain} ». ` +
              'C\'est accepté (utile pour un collaborateur externe), mais si c\'est une faute de ' +
              'frappe, le compte n\'existera pas et l\'ajout au groupe ou au Drive échouera.',
          );
        }
      }

      let name = null;
      if (!isNonEmptyString(member.name)) {
        fail(`${field}.name`, `Champ obligatoire : le nom affiché${email ? ` de ${email}` : ''}. Exemple : "name": "Greg Picard"`);
      } else {
        name = member.name.trim();
      }

      let role = 'member';
      if (member.role === undefined || member.role === null || member.role === '') {
        warnings.push(`${field}.role est absent : « member » sera utilisé par défaut.`);
      } else if (!TEAM_ROLES.includes(member.role)) {
        fail(`${field}.role`, `« ${member.role} » n'est pas un rôle valide. Valeurs acceptées : ${TEAM_ROLES.map((r) => `"${r}"`).join(' ou ')}.\n"organizer" = peut gérer le Drive partagé et ses membres ; "member" = accès normal.`);
      } else {
        role = member.role;
      }

      if (email && name) team.push({ email, name, role });
    });

    if (team.length > 0 && !team.some((m) => m.role === 'organizer')) {
      warnings.push(
        'Aucun membre de l\'équipe n\'a le rôle « organizer » : personne ne pourra gérer ' +
          'le Drive partagé (ajouter des membres, supprimer des fichiers définitivement). ' +
          'Donner ce rôle à au moins une personne, typiquement le propriétaire.',
      );
    }
    if (adminEmail && team.length > 0 && !team.some((m) => m.email === adminEmail)) {
      warnings.push(
        `L'administrateur « ${adminEmail} » n'apparaît pas dans « team ». Il administre le ` +
          'domaine, mais il ne recevra pas d\'accès au Drive partagé ni aux calendriers. ' +
          'L\'ajouter à « team » si c\'est un utilisateur au quotidien.',
      );
    }
  }

  /* --- group ------------------------------------------------------ */
  let group = null;
  if (input.group !== undefined && input.group !== null) {
    if (!isPlainObject(input.group)) {
      fail('group', `Doit être un objet { "email": ..., "name": ..., "description": ... } ou null.\nMettre null pour accorder les permissions directement à chaque adresse de l'équipe.`);
    } else {
      warnUnknownKeys(input.group, KNOWN_KEYS.group, 'group', warnings);
      let gEmail = null;
      if (!isNonEmptyString(input.group.email)) {
        fail('group.email', `Champ obligatoire quand « group » n'est pas null.\nExemple : "email": "equipe@${domain ?? 'mondomaine.ca'}"`);
      } else if (!isEmail(input.group.email)) {
        fail('group.email', `« ${input.group.email} » n'est pas une adresse courriel valide.`);
      } else {
        gEmail = input.group.email.trim().toLowerCase();
        if (domain && domainOf(gEmail) !== domain) {
          fail(
            'group.email',
            `L'adresse « ${gEmail} » n'est pas dans le domaine « ${domain} ».\n` +
              'Un groupe Google se crée obligatoirement dans le domaine administré.\n' +
              `Quoi faire : utiliser une adresse comme equipe@${domain}.`,
          );
        }
        if (team.some((m) => m.email === gEmail)) {
          fail('group.email', `« ${gEmail} » est aussi l'adresse d'un membre de l'équipe. Le groupe doit avoir sa propre adresse (ex. equipe@${domain ?? 'mondomaine.ca'}).`);
        }
      }

      let gName = null;
      if (!isNonEmptyString(input.group.name)) {
        fail('group.name', 'Champ obligatoire : le nom affiché du groupe. Exemple : "name": "Équipe Portail"');
      } else {
        gName = input.group.name.trim();
      }

      let gDesc = '';
      if (input.group.description !== undefined && input.group.description !== null) {
        if (typeof input.group.description !== 'string') {
          fail('group.description', `Doit être du texte, pas ${typeof input.group.description}.`);
        } else {
          gDesc = input.group.description.trim();
        }
      }

      if (gEmail && gName) group = { email: gEmail, name: gName, description: gDesc };
    }
  }

  /* --- calendars -------------------------------------------------- */
  /** @type {Array<{key: string, summary: string, description: string, timeZone: string, role: string}>} */
  const calendars = [];
  if (input.calendars !== undefined && input.calendars !== null) {
    if (!Array.isArray(input.calendars)) {
      fail('calendars', `Doit être un tableau [ ... ], pas ${typeof input.calendars}.`);
    } else {
      const seenKeys = new Map();
      input.calendars.forEach((cal, i) => {
        const field = `calendars[${i}]`;
        if (!isPlainObject(cal)) {
          fail(field, 'Chaque calendrier doit être un objet { "key": ..., "summary": ..., "timeZone": ..., "role": ... }.');
          return;
        }
        warnUnknownKeys(cal, KNOWN_KEYS.calendar, field, warnings);

        let key = null;
        if (!isNonEmptyString(cal.key)) {
          fail(`${field}.key`, 'Champ obligatoire : identifiant court et stable du calendrier, utilisé pour le retrouver d\'une exécution à l\'autre.\nExemple : "key": "visites"');
        } else if (!CALENDAR_KEY_RE.test(cal.key.trim())) {
          fail(`${field}.key`, `« ${cal.key} » contient des caractères interdits.\nUtiliser uniquement des lettres, chiffres, tirets, points et soulignés, en commençant par une lettre ou un chiffre. Exemple : "visites-proprietes".`);
        } else {
          key = cal.key.trim();
          if (seenKeys.has(key)) {
            fail(`${field}.key`, `La clé « ${key} » est déjà utilisée par calendars[${seenKeys.get(key)}]. Chaque clé doit être unique : c'est elle qui identifie le calendrier dans le cache.`);
          } else {
            seenKeys.set(key, i);
          }
        }

        let summary = null;
        if (!isNonEmptyString(cal.summary)) {
          fail(`${field}.summary`, 'Champ obligatoire : le nom visible du calendrier. Exemple : "summary": "Visites de propriétés"');
        } else {
          summary = cal.summary.trim();
        }

        let description = '';
        if (cal.description !== undefined && cal.description !== null) {
          if (typeof cal.description !== 'string') {
            fail(`${field}.description`, `Doit être du texte, pas ${typeof cal.description}.`);
          } else {
            description = cal.description.trim();
          }
        }

        let tz = timeZone;
        if (cal.timeZone !== undefined && cal.timeZone !== null && cal.timeZone !== '') {
          if (!isNonEmptyString(cal.timeZone) || !isValidTimeZone(cal.timeZone.trim())) {
            fail(`${field}.timeZone`, `« ${cal.timeZone} » n'est pas un fuseau horaire IANA valide.\nExemple pour le Québec : "America/Toronto". La liste complète est celle de la base IANA (Continent/Ville).`);
          } else {
            tz = cal.timeZone.trim();
          }
        }

        let role = 'writer';
        if (cal.role === undefined || cal.role === null || cal.role === '') {
          warnings.push(`${field}.role est absent : « writer » sera utilisé (l'équipe pourra créer et modifier des événements).`);
        } else if (!CALENDAR_ROLES.includes(cal.role)) {
          fail(`${field}.role`, `« ${cal.role} » n'est pas un rôle de partage Calendar valide.\nValeurs acceptées : ${CALENDAR_ROLES.map((r) => `"${r}"`).join(', ')}.\n"reader" = voir ; "writer" = voir et modifier les événements ; "owner" = gérer le partage.`);
        } else {
          role = cal.role;
        }

        if (key && summary) calendars.push({ key, summary, description, timeZone: tz, role });
      });
    }
  }
  if (calendars.length === 0 && errors.length === 0) {
    warnings.push('Aucun calendrier défini dans « calendars » : l\'étape des calendriers n\'aura rien à faire.');
  }

  /* --- sharedDrive ------------------------------------------------ */
  const rawDrive = isPlainObject(input.sharedDrive) ? input.sharedDrive : {};
  if (input.sharedDrive !== undefined && input.sharedDrive !== null && !isPlainObject(input.sharedDrive)) {
    fail('sharedDrive', `Doit être un objet { "name": ..., "restrictions": ..., "folders": [...] }, pas ${typeof input.sharedDrive}.`);
  }

  let driveName = DEFAULTS.sharedDrive.name;
  if (rawDrive.name !== undefined && rawDrive.name !== null) {
    if (!isNonEmptyString(rawDrive.name)) {
      fail('sharedDrive.name', 'Le nom du Drive partagé ne peut pas être vide. Exemple : "name": "Portail — Espace d\'équipe"');
    } else {
      driveName = rawDrive.name.trim();
    }
  } else if (input.sharedDrive !== undefined) {
    warnings.push(`sharedDrive.name est absent : « ${driveName} » sera utilisé.`);
  }

  const restrictions = { ...DEFAULTS.sharedDrive.restrictions };
  if (rawDrive.restrictions !== undefined && rawDrive.restrictions !== null) {
    if (!isPlainObject(rawDrive.restrictions)) {
      fail('sharedDrive.restrictions', `Doit être un objet de booléens, pas ${typeof rawDrive.restrictions}.`);
    } else {
      for (const [key, value] of Object.entries(rawDrive.restrictions)) {
        if (!DRIVE_RESTRICTION_KEYS.includes(key)) {
          fail(
            `sharedDrive.restrictions.${key}`,
            `Restriction inconnue de l'API Drive.\nValeurs acceptées : ${DRIVE_RESTRICTION_KEYS.join(', ')}.\n(Attention aux majuscules : Google distingue « driveMembersOnly » de « drivemembersonly ».)`,
          );
        } else if (typeof value !== 'boolean') {
          fail(`sharedDrive.restrictions.${key}`, `Doit valoir true ou false (sans guillemets), pas ${JSON.stringify(value)}.`);
        } else {
          restrictions[key] = value;
        }
      }
    }
  }
  if (restrictions.domainUsersOnly === false) {
    warnings.push(
      'sharedDrive.restrictions.domainUsersOnly est à false : des personnes EXTERNES au ' +
        'domaine pourront être ajoutées au Drive partagé. Mettre true pour verrouiller ' +
        'l\'accès aux seuls comptes du domaine.',
    );
  }

  /** @type {Array<{name: string, children: Array}>} */
  let folders = [];
  if (rawDrive.folders !== undefined && rawDrive.folders !== null) {
    if (!Array.isArray(rawDrive.folders)) {
      fail('sharedDrive.folders', `Doit être un tableau [ ... ] de dossiers, pas ${typeof rawDrive.folders}.`);
    } else {
      folders = validateFolders(rawDrive.folders, 'sharedDrive.folders', 1, fail, warnings);
    }
  }

  let createReadme = DEFAULTS.sharedDrive.createReadme;
  if (rawDrive.createReadme !== undefined && rawDrive.createReadme !== null) {
    if (typeof rawDrive.createReadme !== 'boolean') {
      fail('sharedDrive.createReadme', `Doit valoir true ou false (sans guillemets), pas ${JSON.stringify(rawDrive.createReadme)}.`);
    } else {
      createReadme = rawDrive.createReadme;
    }
  }

  /* --- auth ------------------------------------------------------- */
  const rawAuth = isPlainObject(input.auth) ? input.auth : {};
  if (input.auth !== undefined && input.auth !== null && !isPlainObject(input.auth)) {
    fail('auth', `Doit être un objet { "mode": ..., "keyFile": ... }, pas ${typeof input.auth}.`);
  }

  let mode = DEFAULTS.auth.mode;
  if (rawAuth.mode !== undefined && rawAuth.mode !== null) {
    if (rawAuth.mode !== 'service-account' && rawAuth.mode !== 'oauth') {
      fail(
        'auth.mode',
        `« ${rawAuth.mode} » n'est pas un mode valide. Valeurs acceptées :\n` +
          '  "service-account" — compte de service + délégation à l\'échelle du domaine.\n' +
          '                      Tourne sans humain, mais demande une clé JSON sur disque.\n' +
          '  "oauth"           — le script ouvre le navigateur, tu te connectes une fois.\n' +
          '                      Aucune clé privée sur disque.',
      );
    } else {
      mode = rawAuth.mode;
    }
  }

  const auth = {
    mode,
    keyFile: isNonEmptyString(rawAuth.keyFile) ? rawAuth.keyFile.trim() : DEFAULTS.auth.keyFile,
    oauthClientFile: isNonEmptyString(rawAuth.oauthClientFile) ? rawAuth.oauthClientFile.trim() : DEFAULTS.auth.oauthClientFile,
    tokenFile: isNonEmptyString(rawAuth.tokenFile) ? rawAuth.tokenFile.trim() : DEFAULTS.auth.tokenFile,
  };

  for (const key of ['keyFile', 'oauthClientFile', 'tokenFile']) {
    if (rawAuth[key] !== undefined && rawAuth[key] !== null && !isNonEmptyString(rawAuth[key])) {
      fail(`auth.${key}`, 'Doit être un chemin de fichier non vide (relatif au config.json, ou absolu).');
    }
  }

  const config = {
    domain,
    adminEmail,
    personalEmail,
    timeZone,
    team,
    group,
    calendars,
    sharedDrive: { name: driveName, restrictions, folders, createReadme },
    auth,
  };

  return { config, errors, warnings };
}

/**
 * Valide récursivement une arborescence de dossiers.
 * @param {unknown[]} nodes
 * @param {string} field chemin du champ pour les messages
 * @param {number} depth profondeur courante (1 = racine du Drive)
 * @param {(field: string, msg: string) => void} fail
 * @param {string[]} warnings
 * @returns {Array<{name: string, children: Array}>}
 */
function validateFolders(nodes, field, depth, fail, warnings) {
  /** @type {Array<{name: string, children: Array}>} */
  const out = [];

  if (depth > MAX_FOLDER_DEPTH) {
    fail(field, `L'arborescence dépasse ${MAX_FOLDER_DEPTH} niveaux. Une structure aussi profonde devient impossible à naviguer : la remonter à 2 ou 3 niveaux.`);
    return out;
  }

  /** @type {Map<string, number>} */
  const seen = new Map();

  nodes.forEach((node, i) => {
    const nodeField = `${field}[${i}]`;

    let raw;
    if (typeof node === 'string') {
      // Tolérance : un simple nom de dossier sans enfants.
      raw = { name: node, children: [] };
    } else if (isPlainObject(node)) {
      raw = node;
      warnUnknownKeys(node, KNOWN_KEYS.folder, nodeField, warnings);
    } else {
      fail(nodeField, `Chaque dossier doit être un objet { "name": "...", "children": [...] } (ou simplement une chaîne de caractères), pas ${Array.isArray(node) ? 'un tableau' : typeof node}.`);
      return;
    }

    if (!isNonEmptyString(raw.name)) {
      fail(`${nodeField}.name`, 'Le nom du dossier est obligatoire et ne peut pas être vide.');
      return;
    }

    const original = raw.name;
    const name = original.trim();

    if (name !== original) {
      warnings.push(`${nodeField}.name : « ${original} » commence ou finit par une espace ; le nom sera enregistré sous « ${name} ».`);
    }
    if (name.includes('/')) {
      fail(`${nodeField}.name`, `« ${name} » contient une barre oblique « / », interdite dans un nom de dossier Drive.\nPour créer une sous-arborescence, utiliser « children » plutôt qu'un chemin.`);
      return;
    }
    if (name === '.' || name === '..') {
      fail(`${nodeField}.name`, `« ${name} » est un nom réservé. Choisir un vrai nom de dossier.`);
      return;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(name)) {
      fail(`${nodeField}.name`, 'Le nom contient des caractères de contrôle invisibles (souvent un copier-coller raté). Le retaper à la main.');
      return;
    }
    if (name.length > MAX_FOLDER_NAME_LENGTH) {
      fail(`${nodeField}.name`, `Le nom fait ${name.length} caractères ; la limite de Google Drive est ${MAX_FOLDER_NAME_LENGTH}.`);
      return;
    }

    const dedupeKey = name.toLocaleLowerCase('fr-CA');
    if (seen.has(dedupeKey)) {
      const other = seen.get(dedupeKey);
      fail(
        `${nodeField}.name`,
        `Le dossier « ${name} » est en double au même niveau (déjà déclaré en ${field}[${other}]).\n` +
          'Drive accepte deux dossiers du même nom au même endroit, mais le script ne pourrait\n' +
          'plus savoir lequel réutiliser lors de la prochaine exécution.\n' +
          'Quoi faire : renommer l\'un des deux, ou en supprimer un.',
      );
      return;
    }
    seen.set(dedupeKey, i);

    let children = [];
    if (raw.children !== undefined && raw.children !== null) {
      if (!Array.isArray(raw.children)) {
        fail(`${nodeField}.children`, `Doit être un tableau [ ... ] de sous-dossiers, pas ${typeof raw.children}.`);
      } else if (raw.children.length > 0) {
        children = validateFolders(raw.children, `${nodeField}.children`, depth + 1, fail, warnings);
      }
    }

    out.push({ name, children });
  });

  return out;
}

/**
 * Vérifie qu'un identifiant de fuseau horaire est reconnu par le moteur ICU.
 * @param {string} tz
 * @returns {boolean}
 */
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    // Lève une RangeError si le fuseau est inconnu.
    new Intl.DateTimeFormat('fr-CA', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Aplatit l'arborescence de dossiers en chemins « / A / B ».
 * Pratique pour les commandes Drive et pour les clés du cache d'état.
 *
 * @param {Array<{name: string, children?: Array}>} folders
 * @param {string} [prefix]
 * @returns {Array<{path: string, name: string, parentPath: string|null, depth: number}>}
 */
export function flattenFolders(folders, prefix = '') {
  /** @type {Array<{path: string, name: string, parentPath: string|null, depth: number}>} */
  const out = [];
  for (const folder of folders ?? []) {
    const path = `${prefix}/${folder.name}`;
    out.push({
      path,
      name: folder.name,
      parentPath: prefix === '' ? null : prefix,
      depth: path.split('/').length - 1,
    });
    if (folder.children?.length) out.push(...flattenFolders(folder.children, path));
  }
  return out;
}

export default { loadConfig, validateConfig, isValidTimeZone, flattenFolders, resolvePath, DEFAULTS, ConfigError, TEAM_ROLES, CALENDAR_ROLES, DRIVE_RESTRICTION_KEYS };
