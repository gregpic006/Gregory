/**
 * auth.mjs — Obtention d'un client authentifié Google.
 *
 * C'est le module où 90 % des blocages arrivent. Il est donc écrit avec une
 * obsession : quand ça échoue, dire EXACTEMENT quoi corriger et où, avec le
 * texte à copier-coller (identifiant client numérique, liste de portées).
 *
 * Deux modes :
 *
 *   "oauth" — LE MODE PAR DÉFAUT. Client OAuth de type « Application de
 *       bureau ». Le script ouvre le navigateur, tu te connectes une fois avec
 *       ton compte administrateur, et le jeton est mis en cache : les fois
 *       suivantes, plus rien à faire. Aucune clé privée sur le disque.
 *
 *       POURQUOI C'EST DEVENU LE DÉFAUT : Google bloque désormais la création
 *       de clés de compte de service sur les nouvelles organisations (règle
 *       d'organisation « iam.managed.disableServiceAccountKeyCreation »).
 *       Désactiver cette protection affaiblit le domaine ; on ne le demande
 *       donc pas.
 *
 *       CE QUE ÇA COÛTE, DIT FRANCHEMENT : en OAuth, le script agit EN TON NOM
 *       et ne peut pas agir au nom des autres membres de l'équipe. Concrètement,
 *       « ajouter le calendrier directement dans l'Agenda de quelqu'un d'autre »
 *       devient impossible : les autres reçoivent un courriel de partage et
 *       cliquent une fois. Le module signale cette limite au lieu de la cacher
 *       (voir « __impersonationUnavailable » plus bas).
 *
 *   "service-account" — compte de service + délégation à l'échelle du domaine.
 *       Le compte de service n'est pas un utilisateur Workspace : il n'existe
 *       pas dans l'annuaire et ne peut pas être administrateur. Son seul
 *       pouvoir vient de la délégation autorisée par un super-admin, plus
 *       l'identité qu'il emprunte (le « subject »). Tourne sans humain et
 *       permet l'emprunt d'identité — mais exige une clé privée sur disque,
 *       donc une organisation qui autorise encore leur création.
 *
 * Aucune dépendance hors googleapis.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { google } from 'googleapis';
import log from './log.mjs';

/* ------------------------------------------------------------------ */
/* Portées                                                             */
/* ------------------------------------------------------------------ */

/** Mode d'authentification utilisé quand config.json ne dit rien. */
export const DEFAULT_AUTH_MODE = 'oauth';

/**
 * Le jeu de portées STRICT — celui de la délégation à l'échelle du domaine.
 *
 * ATTENTION : la délégation exige une correspondance EXACTE, caractère par
 * caractère. Une portée en trop côté code, ou une portée « .readonly » côté
 * console, et Google refuse TOUT avec « unauthorized_client ». C'est la cause
 * numéro un des blocages. Ne jamais retaper cette liste à la main : la coller
 * telle que produite par scopeLine('delegation').
 *
 * Pourquoi exactement ces sept-là :
 *   - « calendar » (complet) couvre les calendriers, leurs partages (ACL) ET
 *     l'abonnement de chaque personne. Ne PAS lister les sous-portées : elles
 *     ne feraient qu'allonger la liste à faire correspondre.
 *   - « drive » (complet) est obligatoire. « drive.file » ne voit que les
 *     fichiers créés par la trousse elle-même : impossible de reprendre un
 *     Drive partagé qui existe déjà, ni d'en faire l'inventaire.
 *   - « admin.directory.customer.readonly » est exigée par customers.get, que
 *     la commande « audit » appelle pour lire les informations du domaine.
 *     Sans elle, l'audit se termine par un 403 incompréhensible.
 */
const DELEGATION_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user',
  'https://www.googleapis.com/auth/admin.directory.group',
  'https://www.googleapis.com/auth/admin.directory.group.member',
  'https://www.googleapis.com/auth/admin.directory.customer.readonly',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/apps.groups.settings',
];

/**
 * Portée d'identité : sert uniquement à savoir QUI s'est connecté, pour pouvoir
 * dire « tu es connecté avec X alors que la config attend Y ». Elle n'a de sens
 * qu'en mode OAuth. En mode délégation elle est NUISIBLE : elle ne figure pas
 * dans la liste collée dans la console, donc elle casserait la correspondance.
 */
const IDENTITY_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

/**
 * Portées qui ne servent qu'à l'identité et qui sont retirées d'office en mode
 * délégation, même si l'appelant les demande.
 */
const IDENTITY_ONLY_SCOPES = new Set([
  'openid',
  IDENTITY_SCOPE,
  'https://www.googleapis.com/auth/userinfo.profile',
]);

/**
 * Demandée en plus au moment d'ouvrir le navigateur (mode OAuth seulement).
 * C'est « openid » qui fait que Google renvoie un id_token : sans lui, il
 * faudrait un appel réseau supplémentaire pour connaître le compte connecté.
 * Elle n'est volontairement PAS dans SCOPES.oauth : rien à faire correspondre
 * ici, et la liste publiée reste celle des sept portées utiles + l'identité.
 */
const OAUTH_EXTRA_AUTH_SCOPES = ['openid'];

/**
 * Les deux jeux de portées de la trousse.
 *
 *   SCOPES.delegation — jeu strict, à coller dans la console d'administration.
 *   SCOPES.oauth      — les mêmes + userinfo.email. Aucune liste à recopier
 *                       dans une console en mode OAuth : la portée
 *                       supplémentaire ne peut donc rien casser.
 *
 * Les clés par domaine (directory, groups, calendar, drive) sont des
 * SOUS-ENSEMBLES pratiques : une commande qui n'a besoin que de l'agenda peut
 * demander SCOPES.calendar. En mode OAuth, la trousse élargit de toute façon au
 * jeu complet pour n'ouvrir le navigateur qu'une seule fois (voir getAuthClient).
 */
export const SCOPES = Object.freeze({
  /** Jeu strict de la délégation à l'échelle du domaine. Ordre stable : ne pas mélanger. */
  delegation: Object.freeze([...DELEGATION_SCOPES]),
  /** Jeu du mode OAuth : le strict, plus de quoi lire le courriel connecté. */
  oauth: Object.freeze([...DELEGATION_SCOPES, IDENTITY_SCOPE]),

  /** Annuaire : utilisateurs, groupes, membres, et lecture des infos du domaine. */
  directory: Object.freeze([
    'https://www.googleapis.com/auth/admin.directory.user',
    'https://www.googleapis.com/auth/admin.directory.group',
    'https://www.googleapis.com/auth/admin.directory.group.member',
    'https://www.googleapis.com/auth/admin.directory.customer.readonly',
  ]),
  /** Réglages de groupe : qui peut publier, qui peut voir les archives, etc. */
  groups: Object.freeze(['https://www.googleapis.com/auth/apps.groups.settings']),
  /** Calendriers : création des agendas partagés, partages (ACL) et abonnements. */
  calendar: Object.freeze(['https://www.googleapis.com/auth/calendar']),
  /** Drive : création du Drive partagé, de ses dossiers et de ses membres. */
  drive: Object.freeze(['https://www.googleapis.com/auth/drive']),
});

/**
 * Toutes les portées de la trousse. C'est le jeu OAuth, puisque OAuth est le
 * mode par défaut. getAuthClient() retire lui-même la portée d'identité quand
 * il tourne en mode délégation, pour ne jamais casser la correspondance.
 */
export const ALL_SCOPES = SCOPES.oauth;

/**
 * Rend le jeu de portées correspondant au mode d'authentification.
 * @param {'oauth'|'service-account'|'delegation'} [mode]
 * @returns {string[]} une copie modifiable, jamais le tableau gelé
 */
export function scopesFor(mode = DEFAULT_AUTH_MODE) {
  const strict = mode === 'service-account' || mode === 'delegation';
  return [...(strict ? SCOPES.delegation : SCOPES.oauth)];
}

/**
 * La liste de portées en UNE seule ligne, séparée par des virgules SANS espace :
 * exactement le format qu'attend le champ « Champs d'application OAuth » de la
 * console d'administration.
 *
 * Toujours utiliser scopeLine('delegation') pour ce champ — jamais le jeu OAuth,
 * qui contient une portée de plus.
 *
 * @param {'oauth'|'service-account'|'delegation'} [mode]
 * @returns {string}
 */
export function scopeLine(mode = 'delegation') {
  return scopesFor(mode).join(',');
}

/**
 * Met une liste de portées quelconque au format « console » (virgules, sans
 * espace). Conservée pour le code qui l'utilisait déjà ; pour la délégation,
 * préférer scopeLine('delegation'), qui ne peut pas se tromper de jeu.
 * @param {string[]} [scopes]
 * @returns {string}
 */
export function formatScopeList(scopes = SCOPES.delegation) {
  return [...new Set(scopes)].join(',');
}

/**
 * Texte d'instructions pour autoriser la délégation à l'échelle du domaine.
 * Utilisé tel quel dans les messages d'erreur : c'est ce que l'admin doit faire.
 *
 * La liste affichée est TOUJOURS au moins le jeu strict complet, même si
 * l'appelant ne demandait qu'un sous-ensemble (une commande qui ne touche qu'à
 * l'agenda, par exemple). Sans ce garde-fou, le message dirait « colle cette
 * liste » en n'affichant qu'une portée : la coller REMPLACERAIT la délégation
 * existante et casserait toutes les autres commandes. Les portées d'identité
 * (openid, userinfo.*) sont retirées : elles n'ont rien à faire dans la console.
 *
 * @param {{ clientId?: string|null, scopes?: string[], serviceAccountEmail?: string|null }} params
 * @returns {string}
 */
export function delegationInstructions({ clientId = null, scopes = SCOPES.delegation, serviceAccountEmail = null } = {}) {
  const extra = (Array.isArray(scopes) ? scopes : [])
    .filter((s) => typeof s === 'string' && s !== '' && !IDENTITY_ONLY_SCOPES.has(s) && !DELEGATION_SCOPES.includes(s));
  const toPaste = [...DELEGATION_SCOPES, ...new Set(extra)];

  return [
    'Autoriser le compte de service dans la console d\'administration Google :',
    '',
    '  1. Aller sur https://admin.google.com/ac/owl/domainwidedelegation',
    '     (chemin manuel : Menu > Sécurité > Contrôle des accès et des données >',
    '      Commandes des API > Délégation à l\'échelle du domaine > Gérer > Ajouter)',
    '',
    '  2. Coller CET identifiant client (le nombre à 21 chiffres, PAS le courriel) :',
    '',
    `        ${clientId ?? '(introuvable dans le fichier de clé — champ "client_id")'}`,
    '',
    serviceAccountEmail
      ? `     (pour information, le courriel du compte de service est ${serviceAccountEmail} —\n      ce n'est PAS ce qu'il faut coller dans le champ « ID client »)\n`
      : null,
    '  3. Coller CETTE liste de portées, telle quelle, en une seule ligne :',
    '',
    `        ${formatScopeList(toPaste)}`,
    '',
    '  4. Enregistrer, puis attendre de 1 à 10 minutes (propagation chez Google).',
    '',
    'Deux pièges fréquents :',
    '  - La correspondance des portées est EXACTE. Une portée en trop côté code,',
    '    ou une portée « .readonly » côté console, et Google refuse tout.',
    '  - Sur certains domaines, une modification de la délégation exige',
    '    l\'approbation d\'un DEUXIÈME super-administrateur. Si l\'ajout reste',
    '    « en attente », c\'est ça — ce n\'est pas un bogue.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Erreurs                                                             */
/* ------------------------------------------------------------------ */

/** Erreur d'authentification : le message est déjà rédigé pour un humain. */
export class AuthError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = details.code ?? 'AUTH_FAILED';
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

/* ------------------------------------------------------------------ */
/* Utilitaires internes                                                */
/* ------------------------------------------------------------------ */

/** Développe `~` et rend un chemin absolu par rapport au dossier du config.json. */
function resolveFromConfig(config, filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return null;
  let p = filePath.trim();
  if (p === '~') p = homedir();
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  const base = config?.__configDir ?? process.cwd();
  return isAbsolute(p) ? p : resolve(base, p);
}

/** Chemin du fichier de clé du compte de service. */
function keyFilePath(config) {
  return config?.auth?.resolved?.keyFile ?? resolveFromConfig(config, config?.auth?.keyFile);
}

/** Vrai si le chemin existe et pointe sur un fichier (pas un dossier). */
function isFile(path) {
  try {
    return Boolean(path) && existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Fichiers « client_secret….json » d'un dossier, triés pour être stables.
 * C'est le nom EXACT sous lequel la console Google Cloud télécharge un client
 * OAuth : personne ne devrait avoir à le renommer.
 * @param {string} dir
 * @returns {string[]}
 */
function clientSecretFilesIn(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => /^client_secret.*\.json$/i.test(name))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Liste, dans l'ordre de préférence, les endroits où le fichier de client OAuth
 * peut se trouver :
 *   1. ce qui est écrit dans config.json (auth.oauthClientFile) ;
 *   2. ./oauth-client.json, à côté du config.json puis dans le dossier courant ;
 *   3. le premier ./client_secret*.json trouvé, tel que téléchargé par Google.
 * @param {object} config
 * @returns {{ configured: string|null, dirs: string[], candidates: string[] }}
 */
function oauthClientCandidates(config) {
  const configured =
    config?.auth?.resolved?.oauthClientFile ?? resolveFromConfig(config, config?.auth?.oauthClientFile);

  /** @type {string[]} */
  const dirs = [];
  for (const dir of [config?.__configDir ?? null, process.cwd()]) {
    if (typeof dir === 'string' && dir !== '' && !dirs.includes(dir)) dirs.push(dir);
  }

  /** @type {string[]} */
  const candidates = [];
  const add = (p) => {
    if (typeof p === 'string' && p !== '' && !candidates.includes(p)) candidates.push(p);
  };

  add(configured);
  for (const dir of dirs) add(join(dir, 'oauth-client.json'));
  for (const dir of dirs) for (const file of clientSecretFilesIn(dir)) add(file);

  return { configured, dirs, candidates };
}

/**
 * Chemin du fichier de client OAuth réellement utilisable.
 * Si aucun candidat n'existe, retourne le chemin attendu (pour le message
 * d'erreur) ou null s'il n'y a même pas de chemin à proposer.
 * @param {object} config
 * @returns {string|null}
 */
function oauthClientPath(config) {
  const { configured, candidates } = oauthClientCandidates(config);
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return configured ?? candidates[0] ?? null;
}

/** Chemin du cache de jetons OAuth. */
function tokenFilePath(config) {
  return config?.auth?.resolved?.tokenFile ?? resolveFromConfig(config, config?.auth?.tokenFile);
}

/** Lit et analyse un fichier JSON, avec un message français si ça tourne mal. */
function readJsonFile(path, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new AuthError(
      `Impossible de lire ${label} : ${path}\nDétail : ${e.message}\n` +
        'Quoi faire : vérifier que le fichier existe et qu\'il est lisible.',
      { code: 'AUTH_FILE_UNREADABLE', cause: e },
    );
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new AuthError(
      `${label} n'est pas du JSON valide : ${path}\nDétail : ${e.message}\n` +
        'Quoi faire : re-télécharger le fichier depuis la console Google Cloud sans le modifier.',
      { code: 'AUTH_FILE_INVALID', cause: e },
    );
  }
}

/**
 * Extrait le code d'erreur normalisé d'une erreur googleapis / gaxios.
 * Le point de terminaison de jetons renvoie { error, error_description } ;
 * les API renvoient { error: { code, message, errors:[...] } }.
 * @param {unknown} e
 * @returns {{ code: string|null, description: string, status: number|null }}
 */
function tokenErrorInfo(e) {
  let data = e?.response?.data ?? e?.data ?? null;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      /* on garde la chaîne brute */
    }
  }

  let code = null;
  let description = '';

  if (data && typeof data === 'object') {
    if (typeof data.error === 'string') code = data.error;
    else if (data.error && typeof data.error === 'object') code = data.error.status ?? data.error.code ?? null;
    description = data.error_description ?? (typeof data.error === 'object' ? data.error?.message : '') ?? '';
  }

  const message = String(e?.message ?? '');
  if (!code) {
    for (const known of ['unauthorized_client', 'invalid_grant', 'invalid_client', 'invalid_scope', 'access_denied', 'invalid_request']) {
      if (message.includes(known)) {
        code = known;
        break;
      }
    }
  }

  const status = e?.response?.status ?? (typeof e?.code === 'number' ? e.code : null);
  return { code: code ? String(code) : null, description: String(description || message), status };
}

/** Décode la charge utile d'un id_token JWT sans vérifier la signature. */
function decodeIdToken(idToken) {
  try {
    const payload = String(idToken).split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Neutralise le HTML d'une valeur avant de la remettre dans une page.
 * La page de retour affiche des valeurs venues de l'URL : sans échappement, un
 * lien piégé vers 127.0.0.1 pourrait y faire exécuter du script.
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Ouvre une URL dans le navigateur par défaut. Silencieux si ça ne marche pas. */
function openBrowser(url) {
  if (process.env.PORTAIL_NO_BROWSER) return false;
  const isWindows = process.platform === 'win32';
  const command = process.platform === 'darwin' ? 'open' : isWindows ? 'cmd.exe' : 'xdg-open';

  // Sous Windows, l'URL d'autorisation contient des « & ». Passée telle quelle
  // à cmd.exe, elle serait coupée au premier « & » (séparateur de commandes) :
  // le navigateur ouvrirait une adresse tronquée et cmd tenterait d'exécuter le
  // reste. On met donc l'URL entre guillemets nous-mêmes, en demandant à Node de
  // ne pas retoucher la ligne de commande (windowsVerbatimArguments).
  const args = isWindows ? ['/c', 'start', '""', `"${url}"`] : [url];
  const options = { stdio: 'ignore', detached: true, windowsVerbatimArguments: isWindows };

  try {
    const child = spawn(command, args, options);
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Mode « compte de service »                                          */
/* ------------------------------------------------------------------ */

/** Un seul avertissement de permissions par fichier et par exécution. */
const permissionWarned = new Set();

/**
 * Avertit si un fichier SECRET est lisible par d'autres comptes de la machine.
 *
 * La clé privée d'un compte de service est le seul facteur d'authentification :
 * pas de mot de passe, pas de validation en deux étapes. Qui la lit peut agir
 * sur tout le domaine. Ce n'est qu'un avertissement — on ne bloque pas et on ne
 * modifie pas les permissions à la place de l'utilisateur.
 *
 * @param {string} path
 */
function warnIfReadableByOthers(path) {
  if (process.platform === 'win32') return; // pas de bits POSIX ici
  if (!path || permissionWarned.has(path)) return;
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) === 0) return;
    permissionWarned.add(path);
    log.warn(
      `Le fichier de clé ${path} est lisible par d'autres comptes de cet ordinateur ` +
        `(permissions ${mode.toString(8).padStart(3, '0')}). Cette clé donne à elle seule ` +
        'un accès complet au domaine, sans mot de passe ni validation en deux étapes.\n' +
        `Quoi faire : dans un terminal, chmod 600 "${path}"`,
    );
  } catch {
    /* pas de permissions lisibles : on n'en fait pas un problème */
  }
}

/** Noms de fichiers de secrets que le .gitignore de la trousse couvre déjà. */
const IGNORED_SECRET_NAMES = [/^service-account\.json$/i, /^oauth-client\.json$/i, /^client_secret.*\.json$/i];

/**
 * Avertit si la clé privée est rangée DANS le dossier de la trousse sous un nom
 * que le .gitignore ne couvre pas — le scénario par lequel une clé donnant
 * l'accès complet au domaine finit publiée dans un dépôt.
 *
 * @param {string} path chemin absolu du fichier de clé
 * @param {object} config configuration chargée (pour connaître le dossier du projet)
 */
function warnIfSecretMayBeCommitted(path, config) {
  const projectDir = config?.__configDir ?? null;
  if (!path || !projectDir || permissionWarned.has(`git:${path}`)) return;
  if (!path.startsWith(`${projectDir}/`) && !path.startsWith(`${projectDir}\\`)) return; // rangée ailleurs : rien à craindre ici

  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  if (IGNORED_SECRET_NAMES.some((re) => re.test(name))) return;

  permissionWarned.add(`git:${path}`);
  log.warn(
    `La clé privée « ${name} » est rangée dans le dossier de la trousse, mais son nom ne fait ` +
      'pas partie de ceux que le .gitignore exclut. Si ce dossier est un dépôt Git, la clé ' +
      'risque d\'être publiée avec le code — elle donne à elle seule un accès complet au domaine.\n' +
      'Quoi faire, au choix : la renommer « service-account.json » (nom déjà exclu), ' +
      `ajouter la ligne « ${name} » au fichier .gitignore, ou la ranger hors du dossier du projet ` +
      'et pointer "auth": { "keyFile": "..." } dessus.',
  );
}

/**
 * Charge et valide le fichier de clé du compte de service.
 * @param {object} config
 * @returns {{ client_email: string, private_key: string, client_id: string|null, path: string }}
 */
function loadServiceAccountKey(config) {
  const path = keyFilePath(config);

  if (!path) {
    throw new AuthError(
      'Aucun fichier de clé de compte de service n\'est configuré.\n' +
        'Quoi faire : renseigner "auth": { "keyFile": "./service-account.json" } dans config.json.',
      { code: 'AUTH_KEYFILE_MISSING' },
    );
  }

  if (!existsSync(path)) {
    throw new AuthError(
      [
        `Fichier de clé du compte de service introuvable : ${path}`,
        '',
        'Quoi faire — créer la clé (une seule fois) :',
        '  1. https://console.cloud.google.com/iam-admin/serviceaccounts',
        '  2. Choisir le projet, puis « Créer un compte de service »',
        '     (aucun rôle IAM n\'est nécessaire : un compte de service ne tire pas',
        '      son pouvoir d\'un rôle Cloud, mais de la délégation Workspace).',
        '  3. Onglet « Clés » > Ajouter une clé > Créer une clé > JSON',
        `  4. Déposer le fichier téléchargé ici : ${path}`,
        '',
        'Ce fichier est un secret : il ne doit jamais être versionné ni envoyé par courriel.',
        'Le .gitignore de la trousse l\'exclut déjà.',
        '',
        'SI L\'ÉTAPE 3 EST IMPOSSIBLE (bouton grisé, message « la création de clés est',
        'désactivée ») : c\'est normal. Google bloque par défaut la création de clés de',
        'compte de service sur les nouvelles organisations, avec la règle',
        '« iam.managed.disableServiceAccountKeyCreation ». C\'est une protection utile :',
        'ne la désactive pas pour cette trousse.',
        '',
        'Quoi faire à la place : revenir au mode par défaut, qui ne demande aucune clé,',
        'en mettant "auth": { "mode": "oauth" } dans config.json. Tu te connecteras une',
        'fois dans le navigateur, et c\'est tout.',
      ].join('\n'),
      { code: 'AUTH_KEYFILE_NOT_FOUND' },
    );
  }

  warnIfReadableByOthers(path);
  warnIfSecretMayBeCommitted(path, config);

  const key = readJsonFile(path, 'Le fichier de clé du compte de service');

  if (key.installed || key.web) {
    throw new AuthError(
      [
        `Le fichier ${path} est un client OAuth, pas une clé de compte de service.`,
        '',
        'Deux fichiers différents se ressemblent :',
        '  - clé de compte de service : contient "type": "service_account" et "private_key"',
        '  - client OAuth             : contient "installed" ou "web"',
        '',
        'Quoi faire, au choix :',
        '  a) mettre ce fichier dans "auth": { "oauthClientFile": ... } et passer',
        '     "auth": { "mode": "oauth" } ; ou',
        '  b) télécharger une vraie clé de compte de service (console Cloud >',
        '     IAM et administration > Comptes de service > Clés > JSON).',
      ].join('\n'),
      { code: 'AUTH_KEYFILE_WRONG_TYPE' },
    );
  }

  if (key.type !== 'service_account') {
    throw new AuthError(
      `Le fichier ${path} n'est pas une clé de compte de service ` +
        `(champ "type" = ${JSON.stringify(key.type ?? null)}, attendu "service_account").\n` +
        'Quoi faire : re-télécharger la clé depuis Console Cloud > IAM et administration >\n' +
        'Comptes de service > (le compte) > Clés > Ajouter une clé > JSON.',
      { code: 'AUTH_KEYFILE_WRONG_TYPE' },
    );
  }

  const missing = ['client_email', 'private_key'].filter((f) => typeof key[f] !== 'string' || key[f].trim() === '');
  if (missing.length > 0) {
    throw new AuthError(
      `Le fichier de clé ${path} est incomplet : il manque ${missing.map((m) => `"${m}"`).join(' et ')}.\n` +
        'Quoi faire : re-télécharger une clé JSON complète depuis la console Cloud.',
      { code: 'AUTH_KEYFILE_INCOMPLETE' },
    );
  }

  // Piège classique en intégration continue : la clé est passée par une variable
  // d'environnement et les sauts de ligne sont restés littéraux (\n en deux
  // caractères). Sans cette correction : « invalid_grant / Invalid JWT Signature ».
  const privateKey = key.private_key.includes('\\n') && !key.private_key.includes('\n')
    ? key.private_key.replace(/\\n/g, '\n')
    : key.private_key;

  if (!privateKey.includes('BEGIN') || !privateKey.includes('PRIVATE KEY')) {
    throw new AuthError(
      `La clé privée contenue dans ${path} est malformée (elle ne ressemble pas à un bloc PEM).\n` +
        'Quoi faire : re-télécharger la clé JSON sans l\'ouvrir ni la réenregistrer dans un\n' +
        'éditeur qui reformate le texte.',
      { code: 'AUTH_KEY_MALFORMED' },
    );
  }

  return {
    client_email: key.client_email.trim(),
    private_key: privateKey,
    private_key_id: typeof key.private_key_id === 'string' ? key.private_key_id : undefined,
    client_id: typeof key.client_id === 'string' ? key.client_id : null,
    path,
  };
}

/**
 * Transforme un échec d'obtention de jeton en diagnostic actionnable.
 * @param {unknown} e
 * @param {{ key: object, scopes: string[], subject: string }} ctx
 * @returns {AuthError}
 */
function diagnoseServiceAccountError(e, { key, scopes, subject }) {
  const { code, description } = tokenErrorInfo(e);
  const raw = `${code ?? ''} ${description}`.trim();

  if (code === 'unauthorized_client' || /unauthorized to retrieve access tokens/i.test(description)) {
    return new AuthError(
      [
        'Google a REFUSÉ d\'émettre un jeton : la délégation à l\'échelle du domaine',
        'n\'autorise pas ce compte de service pour ces portées.',
        '',
        `Message de Google : ${raw}`,
        '',
        // On publie TOUJOURS le jeu complet (SCOPES.delegation), jamais les
        // seules portées de la commande en cours. Le champ de la console
        // REMPLACE la liste enregistrée : y coller les 1 ou 2 portées d'une
        // commande ferait échouer toutes les autres commandes de la trousse.
        delegationInstructions({
          clientId: key.client_id,
          scopes: SCOPES.delegation,
          serviceAccountEmail: key.client_email,
        }),
        '',
        ...(scopes.length > 0 && scopes.length < SCOPES.delegation.length
          ? [
              `(La commande en cours n'avait besoin que de ${scopes.length} portée(s) sur ${SCOPES.delegation.length},`,
              ' mais il faut quand même coller la liste complète ci-dessus : le champ de la',
              ' console remplace ce qui s\'y trouve, et les autres commandes en ont besoin.)',
              '',
            ]
          : []),
        'Si la délégation est déjà en place, vérifier dans l\'ordre :',
        '  - l\'identifiant client collé est bien le nombre à 21 chiffres ci-dessus ;',
        '  - la liste de portées est identique à celle ci-dessus (aucune en moins) ;',
        '  - la délégation a été ajoutée sur LE BON domaine Workspace ;',
        '  - l\'ajout date de moins de 10 minutes (propagation en cours).',
      ].join('\n'),
      { code: 'AUTH_UNAUTHORIZED_CLIENT', cause: e },
    );
  }

  if (code === 'invalid_grant') {
    const now = new Date();
    return new AuthError(
      [
        'Google a REFUSÉ le jeton signé (invalid_grant).',
        '',
        `Message de Google : ${raw}`,
        '',
        'Causes possibles, de la plus fréquente à la moins fréquente :',
        '',
        `  1. Le compte emprunté « ${subject} » ne peut pas l'être :`,
        '     - l\'adresse n\'existe pas ou comporte une faute de frappe ;',
        '     - le compte est suspendu ;',
        '     - le compte ne s\'est JAMAIS connecté et n\'a jamais accepté les',
        '       conditions d\'utilisation. Un compte jamais utilisé ne peut pas',
        '       être emprunté. Se connecter une fois à https://mail.google.com',
        '       avec ce compte, puis relancer.',
        '',
        '  2. L\'horloge de cette machine est décalée de plus de 5 minutes par',
        `     rapport à Google. Heure locale vue par le script : ${now.toISOString()}`,
        '     (comparer avec https://time.is — corriger via la synchronisation',
        '     automatique de l\'heure du système si l\'écart dépasse 2 minutes).',
        '',
        '  3. La clé privée est malformée (sauts de ligne perdus lors d\'un',
        `     copier-coller). Fichier utilisé : ${key.path}`,
        '',
        '  4. La clé a été supprimée dans la console Cloud, ou le compte de',
        '     service a été désactivé. Vérifier :',
        '     https://console.cloud.google.com/iam-admin/serviceaccounts',
        '',
        `  5. Le compte emprunté n'est pas dans le domaine autorisé par la délégation.`,
      ].join('\n'),
      { code: 'AUTH_INVALID_GRANT', cause: e },
    );
  }

  if (code === 'invalid_client') {
    return new AuthError(
      [
        'Google ne reconnaît pas ce compte de service (invalid_client).',
        `Message de Google : ${raw}`,
        '',
        'Quoi faire :',
        `  - vérifier que le compte de service ${key.client_email} existe toujours ;`,
        '  - vérifier que le projet Google Cloud n\'a pas été supprimé ;',
        '  - re-télécharger une clé JSON à jour.',
      ].join('\n'),
      { code: 'AUTH_INVALID_CLIENT', cause: e },
    );
  }

  if (code === 'invalid_scope' || /invalid.*scope/i.test(raw)) {
    return new AuthError(
      [
        'Une des portées demandées est refusée ou mal orthographiée.',
        `Message de Google : ${raw}`,
        '',
        'Portées demandées par le script :',
        ...scopes.map((s) => `  ${s}`),
        '',
        'Quoi faire : comparer cette liste avec celle enregistrée dans la',
        'délégation à l\'échelle du domaine — elles doivent être identiques.',
      ].join('\n'),
      { code: 'AUTH_INVALID_SCOPE', cause: e },
    );
  }

  if (/has not been used in project|accessNotConfigured|SERVICE_DISABLED/i.test(raw)) {
    return new AuthError(
      [
        'Une API Google nécessaire n\'est pas activée dans le projet Cloud.',
        `Message de Google : ${raw}`,
        '',
        'Quoi faire — activer les quatre API de la trousse :',
        '  https://console.cloud.google.com/apis/library/admin.googleapis.com',
        '  https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
        '  https://console.cloud.google.com/apis/library/drive.googleapis.com',
        '  https://console.cloud.google.com/apis/library/groupssettings.googleapis.com',
        '',
        '(Attention : l\'API Agenda s\'appelle « calendar-json.googleapis.com »,',
        ' pas « calendar.googleapis.com » — chercher le second ne donne rien.)',
        '',
        'En une commande, si l\'outil gcloud est installé :',
        '  gcloud services enable admin.googleapis.com calendar-json.googleapis.com \\',
        '    drive.googleapis.com groupssettings.googleapis.com --project=MON_PROJET',
        '',
        'Compter 1 à 2 minutes après activation avant de relancer.',
      ].join('\n'),
      { code: 'AUTH_API_DISABLED', cause: e },
    );
  }

  // Message d'OpenSSL quand le bloc PEM a les bons entêtes mais un contenu
  // abîmé (copier-coller partiel, retours à la ligne perdus). Tel quel il est
  // incompréhensible : « error:1E08010C:DECODER routines::unsupported ».
  if (/DECODER routines|unsupported|PEM routines|bad decrypt|asn1 encoding/i.test(raw)) {
    return new AuthError(
      [
        'La clé privée du compte de service est illisible : son contenu est abîmé.',
        `Message technique : ${raw}`,
        '',
        `Fichier concerné : ${key.path}`,
        '',
        'Quoi faire : re-télécharger la clé JSON depuis la console Cloud',
        '(IAM et administration > Comptes de service > le compte > Clés > Ajouter',
        'une clé > JSON) et remplacer le fichier SANS l\'ouvrir dans un éditeur —',
        'un éditeur qui reformate le texte casse les retours à la ligne de la clé.',
      ].join('\n'),
      { code: 'AUTH_KEY_MALFORMED', cause: e },
    );
  }

  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(e?.code)) {
    return new AuthError(
      `Impossible de joindre les serveurs Google (${e.code}).\n` +
        'Quoi faire : vérifier la connexion Internet, puis relancer. Si la machine passe\n' +
        'par un proxy d\'entreprise, définir les variables HTTPS_PROXY et NO_PROXY.',
      { code: 'AUTH_NETWORK', cause: e },
    );
  }

  return new AuthError(
    [
      'L\'authentification par compte de service a échoué.',
      `Message de Google : ${raw || String(e?.message ?? e)}`,
      '',
      'Vérifications utiles :',
      `  - fichier de clé          : ${key.path}`,
      `  - compte de service       : ${key.client_email}`,
      `  - identifiant client      : ${key.client_id ?? '(absent du fichier)'}`,
      `  - compte emprunté         : ${subject}`,
      `  - nombre de portées       : ${scopes.length}`,
      '',
      'Relancer avec la variable DEBUG=1 pour voir la trace complète.',
    ].join('\n'),
    { code: 'AUTH_FAILED', cause: e },
  );
}

/**
 * Construit un client JWT impersonnant `subject`.
 * @param {{ config: object, scopes: string[], subject: string }} params
 */
async function getServiceAccountClient({ config, scopes, subject }) {
  const key = loadServiceAccountKey(config);

  if (!subject) {
    throw new AuthError(
      'Aucun compte à emprunter n\'est défini.\n' +
        'Quoi faire : renseigner "adminEmail" dans config.json — c\'est l\'adresse du\n' +
        'super-administrateur Workspace dont le script emprunte l\'identité.',
      { code: 'AUTH_NO_SUBJECT' },
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: 'service_account',
      client_email: key.client_email,
      private_key: key.private_key,
      private_key_id: key.private_key_id,
    },
    scopes: [...scopes],
    // C'est ICI que se joue l'emprunt d'identité : la revendication « sub » du JWT.
    clientOptions: { subject },
  });

  let client;
  try {
    client = await auth.getClient();
  } catch (e) {
    throw diagnoseServiceAccountError(e, { key, scopes, subject });
  }

  // On force l'obtention d'un jeton tout de suite : mieux vaut échouer ici, avec
  // un diagnostic complet, qu'au milieu de la création des ressources.
  try {
    if (typeof client.authorize === 'function') await client.authorize();
    else await client.getAccessToken();
  } catch (e) {
    throw diagnoseServiceAccountError(e, { key, scopes, subject });
  }

  // En mode compte de service, l'emprunt d'identité fonctionne : le drapeau
  // __impersonationUnavailable vaut donc false, et les commandes gardent leur
  // chemin « je fais tout à ta place ».
  applyAuthInfo(client, {
    mode: 'service-account',
    requested: subject,
    effective: subject,
    scopes,
    serviceAccount: key.client_email,
  });
  return client;
}

/* ------------------------------------------------------------------ */
/* Mode OAuth (application de bureau, boucle locale 127.0.0.1)         */
/* ------------------------------------------------------------------ */

/** Ne dire qu'une fois par exécution « j'ai trouvé le fichier ici ». */
let announcedClientFile = null;

/** Lit le fichier de client OAuth et en extrait client_id / client_secret. */
function loadOAuthClient(config) {
  const { configured, dirs, candidates } = oauthClientCandidates(config);
  const path = candidates.find((candidate) => isFile(candidate)) ?? null;

  if (!path) {
    throw new AuthError(
      [
        'Aucun fichier de client OAuth n\'a été trouvé.',
        '',
        'Cherché, dans l\'ordre :',
        ...candidates.map((candidate) => `  ${candidate}`),
        ...(candidates.length === 0 ? ['  (aucun emplacement : le dossier du config.json est introuvable)'] : []),
        ...dirs.map((dir) => `  ${join(dir, 'client_secret*.json')}  (n'importe quel nom commençant par client_secret)`),
        '',
        'Quoi faire — créer le client (une seule fois, 3 minutes) :',
        '  1. https://console.cloud.google.com/apis/credentials',
        '  2. « Créer des identifiants » > « ID client OAuth »',
        '  3. Type d\'application : « Application de bureau » (Desktop app).',
        '     Ce type accepte n\'importe quel port sur 127.0.0.1 : il n\'y a AUCUNE',
        '     URI de redirection à déclarer.',
        '  4. Télécharger le JSON et le déposer dans le dossier de la trousse :',
        `     ${dirs[0] ?? process.cwd()}`,
        '     Pas besoin de le renommer : un fichier « client_secret….json » est',
        '     reconnu tel quel.',
        '',
        'Sur l\'écran de consentement, choisir « Interne » : pas de vérification',
        'Google à passer, et le jeton de rafraîchissement n\'expire pas au bout de',
        '7 jours (ce qui arrive aux applications « Externe » en mode test).',
      ].join('\n'),
      { code: 'AUTH_OAUTH_FILE_NOT_FOUND' },
    );
  }

  const json = readJsonFile(path, 'Le fichier de client OAuth');

  if (json.type === 'service_account') {
    throw new AuthError(
      `Le fichier ${path} est une clé de compte de service, pas un client OAuth.\n` +
        'Quoi faire : soit passer "auth": { "mode": "service-account" } et pointer\n' +
        '"keyFile" sur ce fichier, soit créer un vrai client OAuth de type\n' +
        '« Application de bureau » dans https://console.cloud.google.com/apis/credentials.',
      { code: 'AUTH_OAUTH_WRONG_TYPE' },
    );
  }

  // Le fichier téléchargé par Google range tout sous « installed » (application
  // de bureau) ou sous « web » (application Web). Les deux sont acceptés.
  const isInstalled = json.installed && typeof json.installed === 'object';
  const isWeb = !isInstalled && json.web && typeof json.web === 'object';
  let block = isInstalled ? json.installed : isWeb ? json.web : null;

  if (!block) {
    // Tolérance : certaines personnes collent seulement le contenu du bloc.
    if (typeof json.client_id === 'string' && typeof json.client_secret === 'string') {
      block = json;
    } else {
      const foundKeys = Object.keys(json ?? {});
      throw new AuthError(
        [
          `Le fichier ${path} n'a pas la forme d'un client OAuth Google.`,
          '',
          'Un vrai fichier de client OAuth commence par « installed » (application de',
          'bureau) ou par « web » (application Web), comme ceci :',
          '',
          '    { "installed": { "client_id": "...", "client_secret": "...", ... } }',
          '',
          `Clés trouvées à la racine de ton fichier : ${foundKeys.length > 0 ? foundKeys.map((k) => `"${k}"`).join(', ') : '(aucune)'}`,
          '',
          'Quoi faire : re-télécharger le JSON depuis',
          'https://console.cloud.google.com/apis/credentials (icône de téléchargement',
          'à droite de la ligne du client), sans l\'ouvrir ni le modifier.',
        ].join('\n'),
        { code: 'AUTH_OAUTH_WRONG_SHAPE' },
      );
    }
  }

  if (typeof block.client_id !== 'string' || typeof block.client_secret !== 'string') {
    throw new AuthError(
      `Le fichier ${path} ne contient pas "client_id" et "client_secret".\n` +
        'Quoi faire : re-télécharger le JSON du client OAuth depuis\n' +
        'https://console.cloud.google.com/apis/credentials (icône de téléchargement).',
      { code: 'AUTH_OAUTH_INCOMPLETE' },
    );
  }

  // Dire où on a pris le fichier quand ce n'est pas celui écrit dans config.json :
  // sinon on se demande longtemps quel fichier la trousse a bien pu utiliser.
  if (path !== configured && announcedClientFile !== path) {
    announcedClientFile = path;
    log.info(`Client OAuth trouvé automatiquement : ${path}`);
  }

  /** @type {string[]} */
  const declaredRedirects = Array.isArray(block.redirect_uris) ? block.redirect_uris : [];

  return {
    clientId: block.client_id,
    clientSecret: block.client_secret,
    isWeb: Boolean(isWeb),
    declaredRedirects,
    path,
  };
}

/** Lit le cache de jetons. Retourne null si absent ou inutilisable. */
function readTokenCache(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

/** Écrit le cache de jetons avec des permissions restreintes (600). */
function writeTokenCache(path, tokens) {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    // writeFileSync n'applique « mode » qu'à la création : on force au cas où
    // le fichier existait déjà avec des permissions plus larges.
    chmodSync(path, 0o600);
  } catch {
    /* systèmes de fichiers sans permissions POSIX (Windows) : sans conséquence */
  }
}

/**
 * Supprime le cache de jetons OAuth. Utile quand l'autorisation a été révoquée
 * ou que l'on veut se reconnecter avec un autre compte.
 * @param {object} config
 * @returns {boolean} true si un fichier a été supprimé
 */
export function clearTokenCache(config) {
  const path = tokenFilePath(config);
  if (!path || !existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** Vérifie que les jetons en cache couvrent bien toutes les portées demandées. */
function tokenCoversScopes(tokens, scopes) {
  if (!tokens?.scope) return false;
  const granted = new Set(String(tokens.scope).split(/\s+/).filter(Boolean));
  return scopes.every((s) => granted.has(s));
}

/**
 * Exécute le flux d'autorisation complet via un mini-serveur sur 127.0.0.1.
 *
 * Le port est ÉPHÉMÈRE : on écoute sur le port 0, le système en attribue un de
 * libre, et on lit ensuite le numéro réel. Coder un port en dur reviendrait à
 * planter le jour où une autre application l'occupe. Le type de client
 * « Application de bureau » accepte n'importe quel port sur 127.0.0.1, il n'y a
 * donc rien à déclarer côté console.
 *
 * @param {{ oauthClient: object, scopes: string[], loginHint: string|null, timeoutMs: number }} params
 * @returns {Promise<{ tokens: object, redirectUri: string }>}
 */
async function runLoopbackFlow({ oauthClient, scopes, loginHint, timeoutMs }) {
  // PORTAIL_OAUTH_PORT n'existe que pour les cas tordus (pare-feu qui n'autorise
  // qu'un port précis). Par défaut : 0, donc « n'importe lequel de libre ».
  const rawPort = process.env.PORTAIL_OAUTH_PORT;
  const requestedPort = Number(rawPort ?? 0) || 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new AuthError(
      `La variable PORTAIL_OAUTH_PORT vaut « ${rawPort} », ce qui n'est pas un numéro de port valide (0 à 65535).\n` +
        'Quoi faire : retirer cette variable pour laisser le script choisir un port libre tout seul.',
      { code: 'AUTH_PORT_INVALID' },
    );
  }
  const state = randomBytes(16).toString('hex');

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    /** @type {NodeJS.Timeout|null} */
    let timer = null;

    const server = createServer();
    // Un navigateur ouvre souvent PLUSIEURS connexions (préconnexion, favicon)
    // et les garde ouvertes (keep-alive). server.close() attend la fermeture de
    // chacune : sans rien de plus, la commande resterait bloquée plusieurs
    // minutes APRÈS une connexion réussie. On garde donc la liste des sockets
    // pour les couper nous-mêmes.
    /** @type {Set<import('node:net').Socket>} */
    const sockets = new Set();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // close() libère le port d'écoute TOUT DE SUITE ; son rappel, lui,
      // n'arrive qu'une fois toutes les connexions fermées — d'où la coupure
      // explicite juste après. On rend la main sans attendre ce rappel.
      try {
        server.close();
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      } catch {
        /* le serveur n'écoutait pas encore : rien à libérer */
      }
      fn(value);
    };

    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        finish(
          rejectPromise,
          new AuthError(
            (requestedPort === 0
              ? 'Aucun port libre n\'a pu être ouvert sur 127.0.0.1.\n'
              : `Le port ${requestedPort}, demandé par la variable PORTAIL_OAUTH_PORT, est déjà utilisé sur cette machine.\n`) +
              'Quoi faire : fermer l\'application qui l\'occupe, ou laisser le script choisir\n' +
              'un port libre en retirant la variable PORTAIL_OAUTH_PORT.',
            { code: 'AUTH_PORT_BUSY', cause: e },
          ),
        );
      } else {
        finish(rejectPromise, new AuthError(`Le serveur local d'autorisation n'a pas pu démarrer : ${e.message}`, { code: 'AUTH_SERVER', cause: e }));
      }
    });

    server.listen(requestedPort, '127.0.0.1', async () => {
      // Port réellement attribué par le système : c'est LUI qu'il faut mettre
      // dans l'URI de redirection, pas celui qu'on a demandé.
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      // google-auth-library expose « redirectUri » (champ public) et s'en sert
      // comme repli dans generateAuthUrl() comme dans getToken(). On le repasse
      // quand même explicitement aux deux appels : c'est ce que Google vérifie.
      oauthClient.redirectUri = redirectUri;

      const authorizeUrl = oauthClient.generateAuthUrl({
        access_type: 'offline', // demande un jeton de rafraîchissement
        prompt: 'consent', // force son émission même si l'accès a déjà été accordé
        scope: [...new Set([...scopes, ...OAUTH_EXTRA_AUTH_SCOPES])],
        state,
        redirect_uri: redirectUri,
        login_hint: loginHint || undefined,
        include_granted_scopes: false,
      });

      log.step('Autorisation Google requise (une seule fois)');
      log.info(
        `Le navigateur va s'ouvrir. Connecte-toi avec ${loginHint || 'ton compte administrateur Workspace'}, ` +
          'puis clique « Autoriser ».',
      );
      log.info('Si rien ne s\'ouvre, copie-colle cette adresse dans ton navigateur :');
      log.raw('');
      log.raw(`    ${authorizeUrl}`);
      log.raw('');
      log.info(`En attente du retour de Google sur ${redirectUri} — laisse ce terminal ouvert.`);

      openBrowser(authorizeUrl);

      timer = setTimeout(() => {
        finish(
          rejectPromise,
          new AuthError(
            `Aucune réponse de Google après ${Math.round(timeoutMs / 1000)} secondes.\n` +
              'Quoi faire : relancer la commande et terminer la connexion dans le navigateur.\n' +
              'Si le navigateur est sur une AUTRE machine que celle qui exécute le script,\n' +
              'le retour sur 127.0.0.1 ne peut pas aboutir : lancer la trousse depuis le poste\n' +
              'où tu ouvres le navigateur.',
            { code: 'AUTH_TIMEOUT' },
          ),
        );
      }, timeoutMs);

      // Le corps est asynchrone : une exception non capturée deviendrait un
      // « unhandled rejection », ce qui tue le processus Node par défaut.
      // On l'attrape donc pour la transformer en échec propre de la commande.
      const handleCallback = async (req, res) => {
        // Une réponse déjà donnée : on ne rejoue pas le tour (onglet rechargé,
        // deuxième requête du navigateur). Sans ce garde, on écrirait sur une
        // socket déjà coupée et le rejet non capturé tuerait la commande.
        if (settled) {
          try {
            res.writeHead(410, { Connection: 'close' }).end('cette autorisation est terminée');
          } catch {
            /* socket déjà fermée */
          }
          return;
        }

        let url;
        try {
          url = new URL(req.url, redirectUri);
        } catch {
          res.writeHead(400, { Connection: 'close' }).end('requête invalide');
          return;
        }

        if (url.pathname === '/favicon.ico') {
          res.writeHead(204, { Connection: 'close' }).end();
          return;
        }
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404, { Connection: 'close' }).end('rien ici');
          return;
        }

        /**
         * Écrit la page de retour et ne rend la main qu'une fois l'octet
         * dernier parti : on coupe les connexions juste après (voir finish),
         * donc répondre « en aveugle » afficherait une page blanche.
         * @returns {Promise<void>}
         */
        const respond = (title, body) =>
          new Promise((done) => {
            let over = false;
            const once = () => {
              if (over) return;
              over = true;
              done();
            };
            // Filet : si le navigateur a déjà raccroché, on n'attend pas.
            res.on('close', once);
            try {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
              res.end(
                `<!doctype html><html lang="fr"><meta charset="utf-8">` +
                  `<title>${escapeHtml(title)}</title>` +
                  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.6">` +
                  `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${body}</p></body></html>`,
                once,
              );
            } catch {
              once();
            }
          });

        const errorParam = url.searchParams.get('error');
        if (errorParam) {
          // errorParam vient de l'URL : n'importe quoi peut s'y trouver, donc
          // on l'échappe avant de le remettre dans la page.
          await respond(
            'Autorisation refusée',
            `Google a renvoyé : <code>${escapeHtml(errorParam)}</code>. Tu peux fermer cet onglet.`,
          );
          finish(
            rejectPromise,
            new AuthError(
              `L'autorisation a été refusée dans le navigateur (${errorParam}).\n` +
                (errorParam === 'access_denied'
                  ? 'Quoi faire : relancer et cliquer « Autoriser ». Si l\'écran de consentement\n' +
                    'affiche « accès bloqué », vérifier que l\'écran de consentement est en mode\n' +
                    '« Interne » et que le compte utilisé appartient bien au domaine.'
                  : 'Quoi faire : relancer la commande.'),
              { code: 'AUTH_DENIED' },
            ),
          );
          return;
        }

        if (url.searchParams.get('state') !== state) {
          await respond('Autorisation invalide', 'Le jeton anti-rejeu ne correspond pas. Tu peux fermer cet onglet.');
          finish(
            rejectPromise,
            new AuthError(
              'La réponse de Google ne correspond pas à la demande (paramètre « state » invalide).\n' +
                'Cela arrive si deux autorisations tournent en même temps, ou si un vieil onglet\n' +
                'a été rechargé. Quoi faire : fermer les onglets d\'autorisation et relancer.',
              { code: 'AUTH_STATE_MISMATCH' },
            ),
          );
          return;
        }

        const code = url.searchParams.get('code');
        if (!code) {
          await respond('Réponse incomplète', 'Google n\'a pas renvoyé de code d\'autorisation.');
          finish(rejectPromise, new AuthError('Google n\'a pas renvoyé de code d\'autorisation. Relancer la commande.', { code: 'AUTH_NO_CODE' }));
          return;
        }

        try {
          // On repasse l'URI de redirection explicitement : c'est le port
          // éphémère du tour en cours, et Google le vérifie à l'échange.
          const { tokens } = await oauthClient.getToken({ code, redirect_uri: redirectUri });
          await respond('Connexion réussie', 'La trousse Portail est autorisée. Tu peux fermer cet onglet et revenir au terminal.');
          finish(resolvePromise, { tokens, redirectUri });
        } catch (e) {
          await respond('Échec de l\'échange', 'Le code d\'autorisation n\'a pas pu être échangé. Voir le terminal.');
          const { code: errCode, description } = tokenErrorInfo(e);
          finish(
            rejectPromise,
            new AuthError(
              `L'échange du code d'autorisation a échoué (${errCode ?? 'erreur inconnue'}).\n` +
                `Message de Google : ${description}\n` +
                'Quoi faire : vérifier que le client OAuth est bien de type « Application de\n' +
                'bureau », puis relancer.',
              { code: 'AUTH_CODE_EXCHANGE', cause: e },
            ),
          );
        }
      };

      server.on('request', (req, res) => {
        handleCallback(req, res).catch((e) => {
          finish(
            rejectPromise,
            new AuthError(
              `Le serveur local d'autorisation a rencontré une erreur inattendue : ${e?.message ?? e}\n` +
                'Quoi faire : relancer la commande.',
              { code: 'AUTH_SERVER', cause: e },
            ),
          );
        });
      });
    });
  });
}

/**
 * Construit un client OAuth2 autorisé, en réutilisant le cache si possible.
 * @param {{ config: object, scopes: string[], subject: string|null }} params
 */
async function getOAuthUserClient({ config, scopes, subject }) {
  const clientInfo = loadOAuthClient(config);
  const tokenPath = tokenFilePath(config);
  // Le compte que la configuration s'attend à voir connecté. C'est LUI qu'on
  // suggère au navigateur, jamais le « subject » demandé : en OAuth, demander
  // le calendrier d'un collègue ne veut pas dire qu'il faut se connecter en
  // tant que lui — au contraire, ce serait la mauvaise manœuvre.
  const expectedEmail = typeof config?.adminEmail === 'string' && config.adminEmail.trim() !== '' ? config.adminEmail.trim() : null;

  if (clientInfo.isWeb) {
    log.warn(
      `Le client OAuth ${clientInfo.path} est de type « Application Web ». Le type ` +
        '« Application de bureau » est recommandé : il accepte n\'importe quel port de ' +
        'boucle locale sans déclaration préalable. Avec un client Web, il faut déclarer ' +
        'l\'URI de redirection exacte dans la console, sinon Google renvoie redirect_uri_mismatch.',
    );
  }

  const oauthClient = new google.auth.OAuth2(clientInfo.clientId, clientInfo.clientSecret);

  // Persiste automatiquement les jetons rafraîchis par la bibliothèque.
  oauthClient.on('tokens', (tokens) => {
    if (!tokenPath) return;
    try {
      const previous = readTokenCache(tokenPath) ?? {};
      writeTokenCache(tokenPath, { ...previous, ...tokens });
    } catch (e) {
      log.warn(`Impossible de mettre à jour le cache de jetons (${e.message}). L'exécution continue.`);
    }
  });

  const cached = readTokenCache(tokenPath);

  if (cached?.refresh_token) {
    if (!tokenCoversScopes(cached, scopes)) {
      log.info('Les autorisations demandées ont changé depuis la dernière connexion : une nouvelle autorisation est nécessaire.');
    } else {
      oauthClient.setCredentials(cached);
      try {
        await oauthClient.getAccessToken(); // rafraîchit si nécessaire ; silencieux si le jeton est encore bon
        const connected = await resolveConnectedEmail({ oauthClient, tokens: cached, tokenPath });
        warnIfWrongAccount(connected, expectedEmail);
        applyAuthInfo(oauthClient, {
          mode: 'oauth',
          requested: subject,
          effective: connected ?? expectedEmail,
          scopes,
          reused: true,
        });
        return oauthClient;
      } catch (e) {
        const { code, description } = tokenErrorInfo(e);
        if (code === 'invalid_grant') {
          log.warn(
            'L\'autorisation enregistrée n\'est plus valide (accès révoqué, mot de passe changé, ' +
              'ou application « Externe » en mode test dont le jeton expire après 7 jours). ' +
              'Une nouvelle connexion va être demandée.',
          );
        } else {
          log.warn(`Le jeton en cache n'a pas pu être rafraîchi (${code ?? 'erreur inconnue'} : ${description}). Une nouvelle connexion va être demandée.`);
        }
      }
    }
  }

  const timeoutMs = Number(process.env.PORTAIL_OAUTH_TIMEOUT_MS ?? 300000) || 300000;
  const { tokens } = await runLoopbackFlow({ oauthClient, scopes, loginHint: expectedEmail, timeoutMs });

  if (!tokens.refresh_token) {
    log.warn(
      'Google n\'a pas renvoyé de jeton de rafraîchissement : il faudra se reconnecter ' +
        'à la prochaine exécution. Cela arrive si l\'accès avait déjà été accordé auparavant. ' +
        'Pour repartir à neuf : révoquer l\'accès sur https://myaccount.google.com/permissions, ' +
        'puis relancer.',
    );
  }

  oauthClient.setCredentials(tokens);
  if (tokenPath) {
    try {
      writeTokenCache(tokenPath, { ...(cached ?? {}), ...tokens });
      log.ok(`Autorisation enregistrée dans ${tokenPath} (lisible par toi seul). Les prochaines exécutions ne demanderont plus rien.`);
    } catch (e) {
      log.warn(`L'autorisation a réussi mais n'a pas pu être enregistrée (${e.message}) : il faudra se reconnecter à la prochaine exécution.`);
    }
  }

  const connected = await resolveConnectedEmail({ oauthClient, tokens, tokenPath });
  if (connected) log.ok(`Connecté en tant que ${connected}.`);
  warnIfWrongAccount(connected, expectedEmail);
  applyAuthInfo(oauthClient, {
    mode: 'oauth',
    requested: subject,
    effective: connected ?? expectedEmail,
    scopes,
    reused: false,
  });
  return oauthClient;
}

/**
 * Courriel réellement connecté, par fichier de cache de jetons.
 * On ne le cherche qu'une fois par exécution : c'est le même pour toutes les
 * commandes, et la deuxième méthode coûte un appel réseau.
 * @type {Map<string, string|null>}
 */
const connectedEmailCache = new Map();

/**
 * Qui s'est connecté, réellement ?
 *
 * Deux façons de le savoir, de la moins chère à la plus chère :
 *   1. l'id_token renvoyé par Google (gratuit, hors ligne) ;
 *   2. le point de terminaison « tokeninfo », si l'id_token manque.
 *
 * Si les deux échouent, on retourne null : la trousse continue, elle se
 * contentera de ne pas pouvoir nommer le compte.
 *
 * @param {{ oauthClient: object, tokens: object|null, tokenPath: string|null }} params
 * @returns {Promise<string|null>}
 */
async function resolveConnectedEmail({ oauthClient, tokens, tokenPath }) {
  const cacheKey = tokenPath ?? '(sans cache)';
  if (connectedEmailCache.has(cacheKey)) return connectedEmailCache.get(cacheKey);

  let email = decodeIdToken(tokens?.id_token)?.email ?? null;

  if (!email && typeof oauthClient?.getTokenInfo === 'function') {
    try {
      const accessToken = oauthClient.credentials?.access_token ?? tokens?.access_token ?? null;
      if (accessToken) {
        const info = await oauthClient.getTokenInfo(accessToken);
        email = info?.email ?? null;
      }
    } catch {
      /* Sans conséquence : on continue sans connaître le nom du compte. */
    }
  }

  const result = typeof email === 'string' && email.trim() !== '' ? email.trim() : null;
  connectedEmailCache.set(cacheKey, result);
  return result;
}

/** Une seule mise en garde « mauvais compte » par exécution : sinon c'est du bruit. */
let wrongAccountWarned = false;

/** Avertit si le compte connecté n'est pas celui qu'attend config.json. */
function warnIfWrongAccount(connectedEmail, expectedEmail) {
  if (wrongAccountWarned) return;
  const actual = normalizeEmail(connectedEmail);
  const expected = normalizeEmail(expectedEmail);
  if (!actual || !expected || actual === expected) return;

  wrongAccountWarned = true;
  log.warn(
    `Tu es connecté avec « ${connectedEmail} », alors que config.json attend ` +
      `« ${expectedEmail} » (champ adminEmail). Tout sera créé au nom de « ${connectedEmail} », ` +
      'et seul un super-administrateur peut créer des groupes et lire l\'annuaire. ' +
      'Si ce n\'est pas voulu : supprimer le fichier de jetons (auth.tokenFile) et relancer ' +
      'pour te reconnecter avec le bon compte.',
  );
}

/* ------------------------------------------------------------------ */
/* Emprunt d'identité : disponible ou non, et comment le dire           */
/* ------------------------------------------------------------------ */

/** Met un courriel en forme comparable (minuscules, sans espaces). null si vide. */
function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/** N'expliquer qu'une fois par personne que l'emprunt d'identité est impossible. */
const impersonationNoticed = new Set();

/**
 * Marque le client avec tout ce que les commandes ont besoin de savoir.
 *
 * `__impersonationUnavailable` est un BOOLÉEN, volontairement : une commande
 * écrit simplement `if (clients.auth.__impersonationUnavailable) { … }`.
 *
 * Il vaut true en mode OAuth dès qu'on a demandé à agir au nom de quelqu'un
 * SANS pouvoir prouver que c'est la personne connectée. On ne lance PAS
 * d'erreur — on rend le client de la personne connectée et on laisse la
 * commande décider (typiquement : « calendar » enverra une invitation de
 * partage au lieu d'ajouter le calendrier de force).
 *
 * Le cas « compte connecté inconnu » (id_token absent ET tokeninfo injoignable)
 * compte comme INDISPONIBLE, et non comme disponible : dans le doute, la
 * trousse doit annoncer une invitation plutôt que prétendre avoir agi au nom
 * d'une personne dont elle ne sait même pas si c'est celle qui est connectée.
 *
 * @param {object} client
 * @param {{ mode: string, requested: string|null, effective: string|null, scopes: string[], reused?: boolean, serviceAccount?: string|null }} info
 */
function applyAuthInfo(client, { mode, requested, effective, scopes, reused = false, serviceAccount = null }) {
  const wanted = normalizeEmail(requested);
  const actual = normalizeEmail(effective);
  const unavailable = mode === 'oauth' && Boolean(wanted) && wanted !== actual;

  client.__impersonationUnavailable = unavailable;
  client.__effectiveSubject = effective ?? requested ?? null;
  client.__impersonationDetail = unavailable
    ? {
        mode,
        requested,
        connected: effective,
        why:
          'En mode OAuth, la trousse agit au nom de la personne connectée et ne peut pas ' +
          'agir au nom de quelqu\'un d\'autre. L\'emprunt d\'identité exige un compte de ' +
          'service avec délégation à l\'échelle du domaine.',
      }
    : null;

  client.__portail = {
    mode,
    subject: requested ?? null,
    effectiveSubject: client.__effectiveSubject,
    connectedAs: mode === 'oauth' ? effective ?? null : null,
    serviceAccount,
    scopes: [...scopes],
    impersonationUnavailable: unavailable,
    reused: Boolean(reused),
  };

  // Filet de sécurité : si une commande oublie de lire le drapeau, au moins la
  // trace console dit la vérité plutôt que de laisser croire que ça a marché.
  if (unavailable && !impersonationNoticed.has(wanted)) {
    impersonationNoticed.add(wanted);
    log.info(
      `Mode OAuth : impossible d'agir au nom de ${requested} — la trousse agit au nom ` +
        `${effective ? `de ${effective}` : 'du compte connecté dans le navigateur'}. ` +
        `${requested} recevra plutôt une invitation à accepter.`,
    );
  }

  return client;
}

/* ------------------------------------------------------------------ */
/* Point d'entrée                                                      */
/* ------------------------------------------------------------------ */

/** Cache des clients par (mode, clé, subject, portées) pour un même processus. */
const clientCache = new Map();

/**
 * Mode d'authentification effectif. Absent ou vide = OAuth, parce que c'est le
 * chemin qui marche sans clé privée et sans toucher aux règles d'organisation.
 * @param {object} config
 * @returns {'oauth'|'service-account'}
 */
export function authMode(config) {
  const raw = config?.auth?.mode;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_AUTH_MODE;
  const mode = String(raw).trim().toLowerCase();
  if (mode === 'oauth' || mode === 'service-account') return mode;
  throw new AuthError(
    `Mode d'authentification inconnu : « ${raw} ».\n` +
      'Valeurs acceptées dans config.json > auth.mode :\n' +
      '  "oauth"           — le script ouvre le navigateur, tu te connectes une fois (défaut) ;\n' +
      '  "service-account" — clé de compte de service + délégation à l\'échelle du domaine.',
    { code: 'AUTH_UNKNOWN_MODE' },
  );
}

/**
 * Portées réellement demandées à Google, selon le mode.
 *
 * En OAuth : on demande TOUJOURS le jeu complet, même si l'appelant n'a besoin
 * que de l'agenda. Sinon chaque commande rouvrirait le navigateur pour ajouter
 * une portée — insupportable. Une autorisation, une fois, pour toute la trousse.
 *
 * En délégation : on RETIRE les portées d'identité (openid, userinfo.email).
 * Elles ne figurent pas dans la liste collée dans la console d'administration,
 * et la correspondance y est exacte : les laisser ferait échouer TOUT avec
 * « unauthorized_client ».
 *
 * @param {'oauth'|'service-account'} mode
 * @param {string[]|undefined} scopes
 * @returns {string[]}
 */
function effectiveScopes(mode, scopes) {
  const asked = Array.isArray(scopes) ? scopes.filter((s) => typeof s === 'string' && s !== '') : [];

  if (mode === 'oauth') {
    return [...new Set([...asked, ...SCOPES.oauth])];
  }

  const base = asked.length > 0 ? asked : SCOPES.delegation;
  const kept = [...new Set(base)].filter((s) => !IDENTITY_ONLY_SCOPES.has(s));
  // Un appelant qui ne demanderait QUE des portées d'identité se retrouverait
  // sinon avec une liste vide : Google émettrait un jeton sans aucun droit et
  // le premier appel d'API échouerait sans rien expliquer.
  return kept.length > 0 ? kept : [...SCOPES.delegation];
}

/**
 * Retourne un client Google authentifié, prêt à être passé à googleapis.
 *
 * @param {object} params
 * @param {object} params.config configuration chargée par loadConfig()
 * @param {string[]} [params.scopes] portées demandées (défaut : le jeu du mode)
 * @param {string} [params.subject] compte à emprunter (défaut : config.adminEmail)
 * @returns {Promise<object>} client utilisable comme `auth:` dans googleapis.
 *   En mode OAuth, il porte `__impersonationUnavailable === true` quand le
 *   compte demandé n'est pas celui qui est connecté : la commande doit alors
 *   proposer autre chose plutôt que d'échouer.
 * @throws {AuthError} message français diagnostiquant la cause exacte
 */
export async function getAuthClient({ config, scopes, subject } = {}) {
  if (!config || typeof config !== 'object') {
    throw new AuthError(
      'getAuthClient a été appelé sans configuration. C\'est un bogue interne de la trousse :\n' +
        'la configuration doit être chargée avec loadConfig() avant toute authentification.',
      { code: 'AUTH_NO_CONFIG' },
    );
  }

  const mode = authMode(config);
  const requested = effectiveScopes(mode, scopes);
  const impersonated = subject ?? config.adminEmail ?? null;

  const cacheKey = JSON.stringify([mode, keyFilePath(config), oauthClientPath(config), impersonated, [...requested].sort()]);
  if (clientCache.has(cacheKey)) return clientCache.get(cacheKey);

  const promise =
    mode === 'service-account'
      ? getServiceAccountClient({ config, scopes: requested, subject: impersonated })
      : getOAuthUserClient({ config, scopes: requested, subject: impersonated });

  // On met la promesse en cache (pas seulement le résultat) pour que deux appels
  // simultanés ne lancent pas deux fois le flux OAuth.
  clientCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (e) {
    clientCache.delete(cacheKey);
    throw e;
  }
}

/**
 * Description courte du mode d'authentification, pour l'affichage.
 * @param {object} config
 * @returns {string}
 */
export function describeAuth(config) {
  let mode;
  try {
    mode = authMode(config);
  } catch {
    // Un mode invalide sera diagnostiqué à la connexion, avec le bon message.
    mode = String(config?.auth?.mode ?? DEFAULT_AUTH_MODE);
  }
  const who = config?.adminEmail ?? 'non défini';
  if (mode === 'service-account') {
    return `compte de service avec délégation, identité empruntée : ${who}`;
  }
  return `OAuth (application de bureau), connexion dans le navigateur avec : ${who} — ` +
    'la trousse agit en son nom seulement, sans emprunter l\'identité des autres membres';
}

/**
 * Identifiant client numérique du compte de service, s'il est disponible.
 * Retourne null en mode OAuth ou si le fichier de clé est absent.
 * @param {object} config
 * @returns {string|null}
 */
export function serviceAccountClientId(config) {
  try {
    const path = keyFilePath(config);
    if (!path || !existsSync(path) || statSync(path).isDirectory()) return null;
    const key = JSON.parse(readFileSync(path, 'utf8'));
    return typeof key.client_id === 'string' ? key.client_id : null;
  } catch {
    return null;
  }
}

export default {
  getAuthClient,
  SCOPES,
  ALL_SCOPES,
  DEFAULT_AUTH_MODE,
  scopesFor,
  scopeLine,
  formatScopeList,
  delegationInstructions,
  authMode,
  describeAuth,
  serviceAccountClientId,
  clearTokenCache,
  AuthError,
};
