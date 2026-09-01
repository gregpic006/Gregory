/**
 * init.mjs — Découvre ton domaine et écrit config.json. Zéro adresse à taper.
 *
 * C'EST LA PREMIÈRE COMMANDE À LANCER. Elle se connecte à Google, lit la liste
 * réelle des usagers du domaine, en déduit tout ce dont la trousse a besoin, et
 * propose un config.json complet. Tu relis, tu relances avec --apply, c'est écrit.
 *
 * POURQUOI ELLE EXISTE : recopier huit adresses à la main dans un fichier JSON,
 * c'est huit occasions de se tromper — et une faute de frappe dans une adresse
 * ne se voit pas, elle se manifeste trois commandes plus loin par un « membre
 * introuvable » incompréhensible. L'annuaire Google connaît déjà les bonnes
 * réponses : on les lui demande.
 *
 * CE QU'ELLE DÉCOUVRE TOUTE SEULE :
 *   - le domaine ;
 *   - le super-administrateur (pour « adminEmail ») ;
 *   - l'équipe (tous les comptes actifs), avec le bon rôle pour chacun ;
 *   - le groupe d'équipe, s'il en existe déjà un ;
 *   - l'adresse personnelle externe à détacher (le fameux @gmail.com), repérée
 *     dans les adresses de secours et les adresses secondaires des comptes.
 *
 * PARTICULARITÉ : c'est la SEULE commande qui fonctionne AVANT que config.json
 * existe. Elle ne passe donc jamais par loadConfig(). Elle se fabrique une
 * configuration minimale en mémoire (juste de quoi s'authentifier) et lit
 * config.example.json pour les valeurs par défaut (calendriers, Drive, dossiers).
 *
 * ELLE N'ÉCRIT RIEN CHEZ GOOGLE. Jamais, même avec --apply. Les seules
 * écritures possibles sont locales : config.json et sa copie de sauvegarde.
 *
 * OPTIONS RECONNUES (en plus de --apply) :
 *   --force              écrase un config.json existant (après sauvegarde .bak)
 *   --admin <adresse>    force le compte à emprunter (utile en mode compte de service)
 *   --oauth              force le mode OAuth navigateur (le défaut)
 *   --service-account    force le mode compte de service
 *
 * Note pour la personne qui maintient la trousse : ces options sont déclarées
 * dans src/cli.mjs (catalogue COMMANDS, entrée « init ») et transmises telles
 * quelles dans le paramètre « argv ». Elles sont relues ici, et seulement ici :
 * aucune variable d'environnement ne permet d'écraser config.json sans --force,
 * pour qu'un réglage oublié dans un profil de terminal ne puisse jamais
 * remplacer un fichier en silence.
 */

import { chmodSync, copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectPages, explainGoogleError, getClients, isForbidden, withRetry } from '../lib/google.mjs';
import { ALL_SCOPES } from '../lib/auth.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import baseLog from '../lib/log.mjs';

export const meta = {
  name: 'init',
  summary: "Lit les usagers réels du domaine et génère config.json. Aucune adresse à taper à la main.",
};

/* ================================================================== *
 * Constantes
 * ================================================================== */

/** Alias accepté par l'Admin SDK pour « mon compte client ». */
const CUSTOMER_KEY = 'my_customer';

/** Plafonds documentés. Les confondre fait tronquer une liste en silence. */
const USERS_PAGE_SIZE = 500; // admin.users.list  : max 500 (défaut 100 !)
const GROUPS_PAGE_SIZE = 200; // admin.groups.list : max 200

/**
 * Masque `fields` explicite : on ne rapatrie que ce qu'on utilise.
 *
 * PIÈGE : dans les types générés de googleapis, `Schema$User.emails` est typé
 * `any`. C'est en réalité un TABLEAU de { address, primary, type, customType },
 * et il est carrément ABSENT quand l'usager n'a pas d'adresse secondaire. On
 * code donc toujours défensivement : Array.isArray(u.emails) ? u.emails : [].
 */
const USER_FIELDS =
  'nextPageToken,users(id,primaryEmail,name(givenName,familyName,fullName),isAdmin,isDelegatedAdmin,' +
  'suspended,archived,isEnrolledIn2Sv,recoveryEmail,emails,aliases,nonEditableAliases,lastLoginTime)';

const GROUP_FIELDS = 'nextPageToken,groups(id,email,name,description,directMembersCount)';

/** Racine de la trousse : c'est là que vivent config.example.json et .gitignore. */
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Adresses de rôle : ce sont des boîtes de service, jamais « le groupe de l'équipe ». */
const ROLE_ADDRESSES =
  /^(abuse|postmaster|mailer-daemon|no-?reply|noreply|webmaster|hostmaster|security|securite|sécurité|support|info|contact|allo|bonjour|hello|ventes|sales|marketing|facturation|billing|compta|comptabilite|comptabilité|rh|hr|admin|administrateur|administration)$/i;

/** Ce à quoi ressemble le nom ou l'adresse d'un groupe « toute l'équipe ». */
const TEAM_GROUP_HINTS = [
  /^equipe/i,
  /^équipe/i,
  /^team/i,
  /^staff/i,
  /^personnel/i,
  /^interne/i,
  /^tous$/i,
  /^tout-le-monde$/i,
  /^all$/i,
  /^everyone$/i,
];

/** Adresses candidates pour un nouveau groupe, dans l'ordre de préférence. */
const NEW_GROUP_LOCAL_PARTS = ['equipe', 'equipe-interne', 'team', 'equipe-workspace'];

/* ================================================================== *
 * Petits utilitaires
 * ================================================================== */

/** Minuscules + espaces retirés. Google ne distingue pas la casse des adresses. */
const lower = (value) => String(value ?? '').trim().toLowerCase();

/** Partie domaine d'une adresse, en minuscules. Chaîne vide si ce n'en est pas une. */
function domainOf(email) {
  const at = lower(email).lastIndexOf('@');
  return at === -1 ? '' : lower(email).slice(at + 1);
}

/** Partie avant l'arobase, en minuscules. */
function localPartOf(email) {
  const at = lower(email).lastIndexOf('@');
  return at === -1 ? lower(email) : lower(email).slice(0, at);
}

/** Forme d'adresse plausible. Volontairement permissif : Google l'est aussi. */
function looksLikeEmail(value) {
  return /^[^\s@,;:<>"()[\]\\]+@[^\s@,;:<>"()[\]\\]+\.[a-z]{2,}$/i.test(String(value ?? '').trim());
}

/** Coupe un texte trop long pour un tableau de console. */
function shorten(value, max = 58) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** JSON indenté, avec le saut de ligne final que tout éditeur attend. */
function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Retire le BOM UTF-8 que collent certains éditeurs Windows. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Lit un fichier JSON. Retourne null si absent ou illisible : aucun de ces
 * fichiers n'est vital pour init, on préfère continuer avec des valeurs par
 * défaut plutôt que de bloquer la seule commande qui débloque le client.
 *
 * @param {string} path
 * @returns {{ json: unknown, error: string|null }}
 */
function readJsonFile(path) {
  try {
    if (!existsSync(path) || statSync(path).isDirectory()) return { json: null, error: 'absent' };
    return { json: JSON.parse(stripBom(readFileSync(path, 'utf8'))), error: null };
  } catch (e) {
    return { json: null, error: e?.message ?? String(e) };
  }
}

/**
 * Complète le journal fourni par le CLI.
 *
 * Le CLI « durcit » le journal en ne gardant qu'une poignée de fonctions :
 * raw, blank, bold et dim peuvent donc être absentes. On retombe alors sur le
 * vrai module plutôt que de planter en plein milieu d'un affichage.
 *
 * @param {object} injected
 * @returns {object}
 */
function makeView(injected) {
  const names = ['banner', 'step', 'info', 'ok', 'warn', 'err', 'plan', 'skip', 'table', 'raw', 'blank', 'bold', 'dim'];
  const view = {};
  for (const name of names) {
    view[name] = typeof injected?.[name] === 'function' ? injected[name] : baseLog[name];
  }
  return view;
}

/**
 * Décode la partie « charge utile » d'un jeton d'identité Google (JWT) pour en
 * tirer l'adresse du compte connecté.
 *
 * On ne VÉRIFIE pas la signature, et c'est volontaire : ce jeton vient d'être
 * reçu directement de Google sur une connexion TLS, et on ne s'en sert que pour
 * afficher « tu es connecté comme … ». Aucune décision de sécurité n'en dépend.
 *
 * @param {string|undefined|null} idToken
 * @returns {string|null}
 */
function emailFromIdToken(idToken) {
  if (typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return looksLikeEmail(payload?.email) ? lower(payload.email) : null;
  } catch {
    return null;
  }
}

/* ================================================================== *
 * Options de la ligne de commande
 * ================================================================== */

/**
 * Lit --force, --admin et le mode d'authentification.
 *
 * Ces options sont déclarées dans le catalogue de src/cli.mjs, qui les transmet
 * telles quelles dans « argv ». Une valeur qu'on ne sait pas interpréter n'est
 * JAMAIS ignorée en silence : elle produit un avertissement, sinon un
 * « --admin greg@ » mal tapé se traduirait par un comportement inexpliqué.
 *
 * @param {object} params paramètres reçus par run()
 * @returns {{ force: boolean, admin: string|null, mode: string|null, configPath: string|null, problems: string[] }}
 */
function readFlags(params = {}) {
  const argv = Array.isArray(params.argv) ? params.argv : [];
  const flags = { force: false, admin: null, mode: null, configPath: null, problems: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? '');
    if (arg === '--force') flags.force = true;
    else if (arg === '--oauth') flags.mode = 'oauth';
    else if (arg === '--service-account' || arg === '--compte-de-service') flags.mode = 'service-account';
    else if (arg.startsWith('--mode=')) flags.mode = arg.slice('--mode='.length);
    else if (arg === '--mode' && argv[i + 1]) { flags.mode = String(argv[i + 1]); i += 1; }
    else if (arg.startsWith('--admin=')) flags.admin = arg.slice('--admin='.length);
    else if (arg === '--admin' && argv[i + 1]) { flags.admin = String(argv[i + 1]); i += 1; }
  }

  if (params.force !== undefined) flags.force = Boolean(params.force);
  if (params.adminEmail) flags.admin = String(params.adminEmail);
  if (params.mode) flags.mode = String(params.mode);
  if (params.configPath) flags.configPath = String(params.configPath);

  if (flags.admin !== null && !looksLikeEmail(flags.admin)) {
    flags.problems.push(
      `« ${flags.admin} » n'a pas la forme d'une adresse courriel : l'option --admin a été ignorée, ` +
        "et l'administrateur sera déduit de l'annuaire comme si l'option n'avait pas été donnée.\n" +
        'Quoi faire si ce n\'était pas voulu : relancer avec l\'adresse complète, par exemple ' +
        '--admin greg@mondomaine.ca',
    );
    flags.admin = null;
  } else if (flags.admin !== null) {
    flags.admin = lower(flags.admin);
  }

  if (flags.mode !== null && flags.mode !== 'oauth' && flags.mode !== 'service-account') {
    flags.problems.push(
      `« ${flags.mode} » n'est pas un mode de connexion connu : l'option a été ignorée. ` +
        'Les deux valeurs acceptées sont « oauth » (navigateur, le défaut) et « service-account » ' +
        '(clé de compte de service).',
    );
    flags.mode = null;
  }

  return flags;
}

/* ================================================================== *
 * Emplacement des fichiers
 * ================================================================== */

/**
 * Où écrire config.json ? On suit exactement la logique du CLI : le dossier
 * courant d'abord, la racine de la trousse ensuite.
 *
 * @param {object|null} config configuration déjà chargée, si elle existe
 * @param {string|null} explicit chemin passé avec --config
 * @returns {string} chemin absolu
 */
function resolveConfigTarget(config, explicit) {
  if (explicit) return resolve(process.cwd(), explicit);
  if (typeof config?.__configFile === 'string' && config.__configFile) return config.__configFile;

  const candidates = [resolve(process.cwd(), 'config.json'), join(ROOT_DIR, 'config.json')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1];
}

/**
 * Cherche le fichier de client OAuth téléchargé depuis la console Google.
 *
 * La console le nomme « client_secret_<long identifiant>.json ». La trousse
 * préfère « oauth-client.json » — c'est ce nom-là qui est dans .gitignore, donc
 * le seul qui soit protégé d'un envoi accidentel sur un dépôt PUBLIC.
 *
 * @param {string[]} directories dossiers à fouiller, dans l'ordre
 * @returns {{ path: string, isDefaultName: boolean }|null}
 */
function findOAuthClientFile(directories) {
  const seen = new Set();

  for (const dir of directories) {
    if (!dir || seen.has(dir) || !existsSync(dir)) continue;
    seen.add(dir);

    const preferred = join(dir, 'oauth-client.json');
    if (existsSync(preferred)) return { path: preferred, isDefaultName: true };
  }

  for (const dir of seen) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const downloads = entries
      .filter((e) => e.isFile() && /^client_secret.*\.json$/i.test(e.name))
      .map((e) => {
        const full = join(dir, e.name);
        let mtime = 0;
        try {
          mtime = statSync(full).mtimeMs;
        } catch {
          /* fichier disparu entre-temps : il passera en dernier */
        }
        return { path: full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime); // le plus récemment téléchargé d'abord

    if (downloads.length > 0) return { path: downloads[0].path, isDefaultName: false };
  }

  return null;
}

/**
 * Le fichier `name` est-il couvert par une règle du .gitignore ?
 *
 * Vérification volontairement simple (égalité, ou motif avec astérisques). Elle
 * sert à AVERTIR, jamais à autoriser : dans le doute, on avertit.
 *
 * @param {string} gitignoreDir dossier contenant le .gitignore
 * @param {string} name nom de fichier, ex. « config.json.bak »
 * @returns {boolean}
 */
function gitignoreCovers(gitignoreDir, name) {
  const file = join(gitignoreDir, '.gitignore');
  if (!existsSync(file)) return false;

  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch {
    return false;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    const pattern = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (pattern === name) return true;
    if (pattern.includes('*')) {
      const regex = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      if (regex.test(name)) return true;
    }
  }
  return false;
}

/**
 * Le fichier `name`, déposé dans `dir`, serait-il ignoré par git ?
 *
 * Git applique les .gitignore de TOUS les dossiers parents, pas seulement celui
 * du dossier où se trouve le fichier : on remonte donc l'arborescence. C'est ce
 * qui évite de crier au loup quand la trousse est rangée dans un sous-dossier
 * d'un dépôt dont le .gitignore est à la racine — et, à l'inverse, d'affirmer
 * qu'un fichier est protégé alors qu'il vient d'être écrit dans un tout autre
 * projet (« --config ../autre-projet/config.json »).
 *
 * @param {string} dir dossier où le fichier est écrit
 * @param {string} name nom de fichier, ex. « config.json.bak »
 * @returns {boolean}
 */
function ignoredByGit(dir, name) {
  let current = resolve(dir);
  for (let depth = 0; depth < 40; depth += 1) {
    if (gitignoreCovers(current, name)) return true;
    const parent = dirname(current);
    if (parent === current) break; // racine du disque atteinte
    current = parent;
  }
  return false;
}

/* ================================================================== *
 * Lecture de l'annuaire
 * ================================================================== */

/**
 * Tous les usagers du compte client, pagination comprise.
 *
 * `customer: 'my_customer'` et NON `domain` : dans un compte multi-domaines,
 * `domain` n'en couvre qu'un seul et on raterait des comptes.
 *
 * @param {object} admin client Admin SDK Directory
 * @returns {Promise<object[]>}
 */
async function listUsers(admin) {
  return collectPages(
    (pageToken) =>
      admin.users.list({
        customer: CUSTOMER_KEY,
        maxResults: USERS_PAGE_SIZE,
        orderBy: 'email',
        projection: 'full', // nécessaire pour recoveryEmail et emails[]
        fields: USER_FIELDS,
        pageToken,
      }),
    { itemsKey: 'users', label: 'lecture des usagers du domaine' },
  );
}

/** Tous les groupes du compte client, pagination comprise. */
async function listGroups(admin) {
  return collectPages(
    (pageToken) =>
      admin.groups.list({
        customer: CUSTOMER_KEY,
        maxResults: GROUPS_PAGE_SIZE,
        orderBy: 'email',
        fields: GROUP_FIELDS,
        pageToken,
      }),
    { itemsKey: 'groups', label: 'lecture des groupes du domaine' },
  );
}

/**
 * Domaine principal déclaré par Google, s'il est lisible.
 *
 * Nécessite la portée admin.directory.customer.readonly. Si elle manque, on ne
 * bloque pas : le domaine se déduit très bien des adresses trouvées. C'est un
 * bonus, pas une dépendance.
 *
 * @param {object} admin
 * @returns {Promise<string|null>}
 */
async function readCustomerDomain(admin) {
  try {
    const res = await withRetry(
      () => admin.customers.get({ customerKey: CUSTOMER_KEY, fields: 'customerDomain' }),
      { label: 'lecture du domaine principal', propagation: false, tries: 2 },
    );
    const value = lower(res?.data?.customerDomain);
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

/* ================================================================== *
 * Déductions
 * ================================================================== */

/** Nom affichable d'un usager, avec repli en cascade jusqu'à l'adresse. */
function displayName(user) {
  const name = user?.name ?? {};
  if (typeof name.fullName === 'string' && name.fullName.trim() !== '') return name.fullName.trim();
  const parts = [name.givenName, name.familyName].filter((p) => typeof p === 'string' && p.trim() !== '');
  if (parts.length > 0) return parts.join(' ').trim();

  // Dernier recours : « marie.tremblay » devient « Marie Tremblay ».
  return localPartOf(user?.primaryEmail)
    .split(/[._-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ') || lower(user?.primaryEmail);
}

/**
 * Tous les domaines qui appartiennent au Workspace : le domaine principal, plus
 * ceux vus dans les adresses et les alias.
 *
 * Sert à répondre à « cette adresse est-elle EXTERNE ? ». Sans les alias, une
 * adresse « greg@portail.test-google-a.com » (alias automatique de Google)
 * passerait pour une adresse personnelle à détacher.
 *
 * @param {object[]} users
 * @param {string|null} mainDomain
 * @returns {Set<string>}
 */
function internalDomains(users, mainDomain) {
  const domains = new Set();
  if (mainDomain) domains.add(mainDomain);

  for (const user of users) {
    const primary = domainOf(user?.primaryEmail);
    if (primary) domains.add(primary);

    for (const key of ['aliases', 'nonEditableAliases']) {
      const list = Array.isArray(user?.[key]) ? user[key] : [];
      for (const alias of list) {
        const d = domainOf(alias);
        if (d) domains.add(d);
      }
    }
  }
  return domains;
}

/**
 * Déduit le domaine du Workspace.
 *
 * Ordre : ce que Google déclare > le domaine du compte connecté > le domaine le
 * plus représenté parmi les adresses principales. Le dernier critère est le
 * filet : il est juste dans tous les cas sauf un compte multi-domaines où la
 * majorité des comptes ne sont pas dans le domaine principal.
 *
 * @param {{ customerDomain: string|null, signedInEmail: string|null, users: object[] }} params
 * @returns {{ domain: string|null, source: string }}
 */
function deduceDomain({ customerDomain, signedInEmail, users }) {
  if (customerDomain) return { domain: customerDomain, source: 'domaine principal déclaré par Google' };

  const fromSignedIn = domainOf(signedInEmail);
  if (fromSignedIn) return { domain: fromSignedIn, source: `domaine du compte connecté (${signedInEmail})` };

  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const user of users) {
    const d = domainOf(user?.primaryEmail);
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  if (counts.size === 0) return { domain: null, source: 'aucune source' };

  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { domain: best[0], source: `domaine le plus fréquent parmi les ${users.length} compte(s) trouvé(s)` };
}

/**
 * Cherche les adresses PERSONNELLES EXTERNES rattachées aux comptes.
 *
 * Où on regarde :
 *   - `recoveryEmail` : l'adresse de secours d'un compte, souvent le gmail perso
 *     utilisé pour ouvrir le Workspace ;
 *   - `emails[]` : les adresses secondaires, hors adresse principale.
 *
 * Est retenue toute adresse dont le domaine n'appartient PAS au Workspace.
 * C'est très exactement ce que la commande « detach » sait détacher.
 *
 * @param {object[]} users
 * @param {Set<string>} owned domaines du Workspace
 * @returns {Array<{ email: string, count: number, sources: string[], onAdmin: boolean }>}
 */
function findPersonalEmails(users, owned) {
  /** @type {Map<string, { email: string, count: number, sources: Set<string>, onAdmin: boolean }>} */
  const found = new Map();

  const remember = (address, source, user) => {
    const email = lower(address);
    if (!looksLikeEmail(email)) return;
    if (owned.has(domainOf(email))) return; // adresse interne : rien à détacher

    const entry = found.get(email) ?? { email, count: 0, sources: new Set(), onAdmin: false };
    entry.count += 1;
    entry.sources.add(`${source} de ${lower(user?.primaryEmail)}`);
    if (user?.isAdmin === true) entry.onAdmin = true;
    found.set(email, entry);
  };

  for (const user of users) {
    /** @type {Set<string>} une même adresse chez une même personne ne compte qu'une fois */
    const perUser = new Set();

    if (looksLikeEmail(user?.recoveryEmail) && !perUser.has(lower(user.recoveryEmail))) {
      perUser.add(lower(user.recoveryEmail));
      remember(user.recoveryEmail, 'adresse de secours', user);
    }

    // PIÈGE : `emails` est typé `any` dans googleapis et carrément absent quand
    // l'usager n'a aucune adresse secondaire.
    const secondaries = Array.isArray(user?.emails) ? user.emails : [];
    for (const item of secondaries) {
      const address = lower(item?.address);
      if (!address || item?.primary === true) continue;
      if (address === lower(user?.primaryEmail)) continue;
      if (perUser.has(address)) continue;
      perUser.add(address);
      remember(address, 'adresse secondaire', user);
    }
  }

  return [...found.values()]
    .map((e) => ({ email: e.email, count: e.count, sources: [...e.sources], onAdmin: e.onAdmin }))
    // Celle d'un SUPER-ADMIN d'abord, et seulement ensuite la plus fréquente.
    //
    // L'ordre inverse serait dangereux : « detach --apply » retire cette adresse
    // des adresses de secours des comptes où elle figure. Si trois employés ont
    // chacun mis la même adresse externe en secours, elle serait plus fréquente
    // que le gmail du fondateur — et la trousse proposerait de couper à ces
    // personnes leur moyen de récupérer leur compte. Or l'adresse qu'on cherche
    // est celle qui a servi à OUVRIR le Workspace : elle est sur le compte
    // super-administrateur.
    // Le tri se termine par l'ordre alphabétique : deux exécutions donnent
    // exactement le même résultat, donc un diff vide.
    .sort((a, b) => Number(b.onAdmin) - Number(a.onAdmin) || b.count - a.count || a.email.localeCompare(b.email));
}

/**
 * Note la ressemblance d'un groupe existant avec « le groupe de toute l'équipe ».
 *
 * @param {object} group
 * @param {string} domain
 * @param {number} teamSize
 * @returns {number} 0 = ce n'est visiblement pas ça
 */
function scoreTeamGroup(group, domain, teamSize) {
  const email = lower(group?.email);
  const local = localPartOf(email);
  const name = String(group?.name ?? '');

  // Un groupe sans adresse exploitable ne peut pas être écrit dans config.json.
  if (!looksLikeEmail(email)) return 0;

  // Le groupe DOIT être dans le domaine administré : un compte client
  // multi-domaines peut très bien avoir un « equipe@filiale.ca », mais la
  // validation de config.json refuse (à juste titre) un group.email hors
  // domaine, et Google crée toujours un groupe dans le domaine visé. Le retenir
  // ici produirait un config.json que la trousse elle-même refuserait de lire.
  if (domainOf(email) !== lower(domain)) return 0;

  if (ROLE_ADDRESSES.test(local)) return 0; // boîte de service, pas l'équipe

  let score = 0;
  if (email === `equipe@${domain}`) score += 100;
  if (TEAM_GROUP_HINTS.some((re) => re.test(local))) score += 50;
  if (/equipe|équipe|team|personnel|tout le monde|toute l'équipe/i.test(name)) score += 40;

  // Un groupe qui contient déjà à peu près tout le monde est un bon candidat.
  const members = Number(group?.directMembersCount ?? 0);
  if (score > 0 && teamSize > 0 && members >= Math.max(2, teamSize - 1) && members <= teamSize + 2) score += 10;

  return score;
}

/* ================================================================== *
 * Construction de la configuration proposée
 * ================================================================== */

/**
 * Valeurs par défaut lues dans config.example.json : calendriers, Drive,
 * arborescence, nom du groupe, mode d'authentification et — précieux pour qui
 * ouvrira le fichier — les commentaires « _… » qui expliquent chaque réglage.
 *
 * Si le modèle est absent ou abîmé, on retombe sur des valeurs internes : init
 * doit fonctionner, c'est la commande qui débloque tout le reste.
 *
 * @param {object} view journal
 * @param {string[]} warnings
 * @returns {object}
 */
function loadTemplate(view, warnings) {
  const path = join(ROOT_DIR, 'config.example.json');
  const { json, error } = readJsonFile(path);

  if (json && typeof json === 'object' && !Array.isArray(json)) {
    view.info(`Valeurs par défaut (calendriers, Drive, arborescence) lues dans ${path}.`);
    return json;
  }

  warnings.push(
    `Le modèle ${path} est ${error === 'absent' ? 'introuvable' : `illisible (${error})`}.\n` +
      "Ce n'est pas bloquant : la configuration proposée utilise des valeurs par défaut internes " +
      '(un calendrier « Équipe », un Drive partagé « Espace d\'équipe », aucune arborescence de dossiers).\n' +
      'Quoi faire pour retrouver l\'arborescence complète : récupérer config.example.json depuis le dépôt, puis relancer « init ».',
  );

  return {
    calendars: [
      {
        key: 'equipe',
        summary: 'Équipe',
        description: "Calendrier partagé de l'équipe.",
        timeZone: DEFAULTS.timeZone,
        role: 'writer',
      },
    ],
    sharedDrive: DEFAULTS.sharedDrive,
    group: { name: 'Équipe', description: "Groupe qui porte les accès de l'équipe." },
    auth: { mode: 'oauth' },
  };
}

/**
 * Section « auth » du config.json généré.
 *
 * On reprend l'ORDRE des champs du modèle et ses commentaires « _… » : c'est là
 * qu'est expliqué, en français, ce que chaque réglage change. Un config.json qui
 * s'explique tout seul, c'est un appel de moins six mois plus tard.
 *
 * @param {object} params
 * @returns {object}
 */
function buildAuthSection({ template, previous, config, mode, oauthClientFile }) {
  const asAuth = (v) => (v?.auth && typeof v.auth === 'object' && !Array.isArray(v.auth) ? v.auth : {});
  const modelAuth = asAuth(template);
  // Le config.json existant relu tel quel : il sert quand loadConfig n'a pas pu
  // l'ouvrir (fichier abîmé) — ses chemins et ses explications restent lisibles.
  const previousAuth = asAuth(previous);

  const values = {
    mode,
    oauthClientFile,
    tokenFile: config?.auth?.tokenFile ?? previousAuth.tokenFile ?? modelAuth.tokenFile ?? DEFAULTS.auth.tokenFile,
    keyFile: config?.auth?.keyFile ?? previousAuth.keyFile ?? modelAuth.keyFile ?? DEFAULTS.auth.keyFile,
  };

  /** @type {Record<string, unknown>} */
  const section = {};
  // L'ordre des champs vient du modèle ; les explications « _… » aussi, avec un
  // repli sur celles du fichier existant si le modèle a disparu.
  for (const [key, value] of Object.entries({ ...previousAuth, ...modelAuth })) {
    if (key.startsWith('_')) section[key] = value; // commentaire
    else if (key in values) section[key] = values[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (!(key in section)) section[key] = value;
  }
  return section;
}

/**
 * Assemble le config.json proposé, dans l'ordre de champs du modèle pour qu'il
 * reste familier à qui a déjà ouvert config.example.json.
 *
 * RÈGLE IMPORTANTE — « init » ne découvre que des PERSONNES : le domaine,
 * l'administrateur, l'équipe, le groupe et l'adresse personnelle. Tout le reste
 * (fuseau horaire, calendriers, Drive partagé et son arborescence) est un choix
 * humain qu'aucune API ne peut deviner. Ces champs-là sont donc REPRIS TELS
 * QUELS du config.json existant quand il y en a un, et seul un premier config
 * part des valeurs du modèle. Sans cette règle, la commande conseillée dans
 * « _LISEZ_MOI » (init --apply --force, après une arrivée dans l'équipe)
 * remettrait l'arborescence de démonstration du modèle à la place de celle du
 * client — et « drive » irait ensuite la créer pour de vrai.
 *
 * @param {object} params
 * @returns {object}
 */
function buildProposedConfig({
  template,
  previous,
  domain,
  adminEmail,
  personalEmail,
  otherPersonalEmails,
  team,
  group,
  otherGroups,
  auth,
}) {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const sources = [isObject(previous) ? previous : null, isObject(template) ? template : null];

  /**
   * Premier des deux fichiers (config.json existant, puis modèle) qui propose
   * une valeur utilisable pour ce champ ; sinon la valeur par défaut interne.
   */
  const keep = (key, isUsable, fallback) => {
    for (const source of sources) {
      if (source && isUsable(source[key])) return source[key];
    }
    return fallback;
  };

  const settings = {
    domain,
    adminEmail,
    personalEmail,
    timeZone: keep('timeZone', (v) => typeof v === 'string' && v.trim() !== '', DEFAULTS.timeZone),
    team,
    group,
    calendars: keep('calendars', (v) => Array.isArray(v), []),
    sharedDrive: keep('sharedDrive', isObject, DEFAULTS.sharedDrive),
    auth,
  };
  if (typeof settings.timeZone === 'string') settings.timeZone = settings.timeZone.trim();

  /** @type {Record<string, unknown>} */
  const config = {
    _LISEZ_MOI:
      'Fichier généré par « node src/cli.mjs init ». Il contient de VRAIES adresses : ' +
      'il est dans .gitignore et ne doit JAMAIS être commité — le dépôt est public. ' +
      'Pour le régénérer après une arrivée ou un départ dans l\'équipe : ' +
      'node src/cli.mjs init --apply --force (les calendriers, le Drive partagé et ' +
      'son arborescence sont conservés tels quels).',
  };

  // On replace au passage les explications « _… » du modèle juste avant le
  // champ qu'elles décrivent : le fichier produit s'explique alors tout seul,
  // sans avoir à rouvrir config.example.json six mois plus tard.
  for (const [key, value] of Object.entries(settings)) {
    const commentKey = `_${key}`;
    if (!(commentKey in config)) {
      const comment = keep(commentKey, (v) => typeof v === 'string' && v.trim() !== '', null);
      if (comment !== null) config[commentKey] = comment;
    }
    config[key] = value;
  }

  // Champs de commentaire : les clés qui commencent par « _ » sont ignorées par
  // la validation. Elles servent uniquement à laisser une trace des autres
  // possibilités, pour ne pas avoir à relancer une découverte pour les revoir.
  if (otherPersonalEmails.length > 0) {
    config._personalEmail_autres_candidats = otherPersonalEmails.map(
      (c) => `${c.email} — trouvée ${c.count} fois (${c.sources.slice(0, 3).join(' ; ')})`,
    );
  }
  if (otherGroups.length > 0) {
    config._group_autres_candidats = otherGroups.map(
      (g) => `${lower(g.email)} — « ${g.name ?? ''} », ${Number(g.directMembersCount ?? 0)} membre(s)`,
    );
  }

  return config;
}

/* ================================================================== *
 * Comparaison avec un config.json existant
 * ================================================================== */

/**
 * Aplatit un objet JSON en « chemin -> valeur », pour comparer deux
 * configurations champ par champ plutôt que de montrer deux pavés de JSON.
 * Les champs de commentaire (préfixe « _ ») sont ignorés : ce ne sont pas des
 * réglages, les voir changer n'apprend rien.
 *
 * @param {unknown} value
 * @param {string} prefix
 * @param {Map<string, string>} out
 * @returns {Map<string, string>}
 */
function flattenJson(value, prefix = '', out = new Map()) {
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(prefix, '(liste vide)');
    value.forEach((item, i) => flattenJson(item, `${prefix}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => !k.startsWith('_'));
    if (keys.length === 0) out.set(prefix, '(objet vide)');
    for (const key of keys) flattenJson(value[key], prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, value === null ? 'null' : String(value));
  }
  return out;
}

/**
 * Différences entre l'ancien et le nouveau config.json.
 * @param {unknown} before
 * @param {unknown} after
 * @returns {{ added: object[], removed: object[], changed: object[], total: number }}
 */
function diffConfigs(before, after) {
  const a = flattenJson(before);
  const b = flattenJson(after);

  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, value] of b) {
    if (!a.has(key)) added.push({ Champ: key, 'Valeur ajoutée': shorten(value) });
    else if (a.get(key) !== value) changed.push({ Champ: key, Avant: shorten(a.get(key), 32), Après: shorten(value, 32) });
  }
  for (const [key, value] of a) {
    if (!b.has(key)) removed.push({ Champ: key, 'Valeur retirée': shorten(value) });
  }

  return { added, removed, changed, total: added.length + removed.length + changed.length };
}

/** Affiche une section de différences, tronquée si elle est énorme. */
function showDiffSection(view, title, rows, limit = 25) {
  if (rows.length === 0) return;
  view.info(`${title} (${rows.length}) :`);
  view.table(rows.slice(0, limit));
  if (rows.length > limit) view.info(`  … et ${rows.length - limit} autre(s) non affiché(s).`);
}

/* ================================================================== *
 * Écriture du fichier
 * ================================================================== */

/**
 * Écrit config.json en 0600 : il contient de vraies adresses, il n'a pas à être
 * lisible par les autres comptes de la machine.
 *
 * @param {string} path
 * @param {string} content
 */
function writePrivateFile(path, content) {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  try {
    // writeFileSync n'applique « mode » qu'à la création : on force au cas où le
    // fichier existait déjà avec des permissions plus larges.
    chmodSync(path, 0o600);
  } catch {
    /* système de fichiers sans permissions POSIX (Windows) : sans conséquence */
  }
}

/* ================================================================== *
 * Commande
 * ================================================================== */

/**
 * @param {object} params
 * @param {object|null} [params.config] configuration déjà chargée, si config.json existe déjà
 * @param {boolean} [params.apply] false = simulation (défaut), true = on écrit config.json
 * @param {object} [params.state] cache local — inutilisé ici : init ne crée rien chez Google
 * @param {object} params.log
 * @returns {Promise<{created: object[], updated: object[], unchanged: object[], warnings: string[]}>}
 */
export async function run({ config = null, apply = false, state = {}, log, ...rest } = {}) {
  void state; // init ne crée aucune ressource Google : il n'y a rien à mettre en cache

  const view = makeView(log);
  /** @type {{created: object[], updated: object[], unchanged: object[], warnings: string[]}} */
  const summary = { created: [], updated: [], unchanged: [], warnings: [] };

  const flags = readFlags(rest);
  for (const problem of flags.problems) summary.warnings.push(problem);

  const targetPath = resolveConfigTarget(config, flags.configPath);
  const targetDir = dirname(targetPath);

  // Le config.json existant, relu TEL QUEL (pas la version normalisée par
  // loadConfig) : c'est lui qui garde les réglages que « init » ne découvre pas
  // — fuseau horaire, calendriers, Drive partagé et son arborescence. On le lit
  // ici, une seule fois, parce qu'il sert deux fois : à bâtir la proposition,
  // puis à en montrer les différences.
  const exists = existsSync(targetPath);
  const { json: previous, error: previousError } = exists ? readJsonFile(targetPath) : { json: null, error: null };
  const previousUsable = previous !== null && typeof previous === 'object' && !Array.isArray(previous);

  view.step('À quoi sert cette commande');
  view.info(
    'Elle lit la liste réelle des comptes de ton domaine chez Google et en déduit toute la\n' +
      "configuration : le domaine, l'administrateur, l'équipe, le groupe, et l'adresse\n" +
      "personnelle à détacher. Tu n'as aucune adresse à taper : le risque de faute de frappe\n" +
      'disparaît. Elle ne modifie RIEN chez Google, jamais.',
  );
  view.info(`Fichier visé : ${targetPath}`);

  // Le modèle donne les valeurs par défaut de tout ce qui ne se découvre pas :
  // calendriers, Drive, arborescence, et le mode d'authentification recommandé.
  const template = loadTemplate(view, summary.warnings);

  /* ---------------------------------------------------------------- *
   * 1/6 — De quoi s'authentifier
   * ---------------------------------------------------------------- */
  view.step('1/6 — Comment se connecter à Google');

  // Priorité : l'option de la ligne de commande, puis le choix déjà inscrit dans
  // un config.json existant, puis le mode recommandé par le modèle.
  const templateMode = template?.auth?.mode === 'service-account' || template?.auth?.mode === 'oauth' ? template.auth.mode : 'oauth';
  const mode = flags.mode ?? config?.auth?.mode ?? templateMode;

  // Chemin du client OAuth : celui de la config existante s'il est valide,
  // sinon on va le chercher sur le disque (le fichier téléchargé de la console
  // s'appelle « client_secret_….json », personne ne pense à le renommer).
  let oauthClientPath = null;
  if (typeof config?.auth?.resolved?.oauthClientFile === 'string' && existsSync(config.auth.resolved.oauthClientFile)) {
    oauthClientPath = config.auth.resolved.oauthClientFile;
  } else {
    const found = findOAuthClientFile([targetDir, process.cwd(), ROOT_DIR]);
    if (found) {
      oauthClientPath = found.path;
      const fileName = basename(oauthClientPath);
      const clientDir = dirname(oauthClientPath);
      view.ok(
        found.isDefaultName
          ? `Client OAuth trouvé : ${oauthClientPath}`
          : `Client OAuth trouvé : ${oauthClientPath} — c'est le fichier tel que la console Google le nomme.`,
      );

      // La trousse s'accommode très bien de ce nom-là. Le risque est ailleurs :
      // .gitignore ne protège que « oauth-client.json ». Sous son nom d'origine,
      // le fichier partirait sur GitHub au prochain « git add . » — et le dépôt
      // est PUBLIC. On ne le signale que s'il n'est réellement pas couvert.
      if (!ignoredByGit(clientDir, fileName) && !ignoredByGit(ROOT_DIR, fileName)) {
        summary.warnings.push(
          `Le fichier de client OAuth s'appelle « ${fileName} », et aucune règle du .gitignore ne le couvre.\n` +
            'La trousse, elle, le trouve très bien sous ce nom. Le problème est ailleurs : le dépôt est ' +
            'PUBLIC, et ce fichier partirait sur GitHub au prochain « git add . ».\n' +
            'Quoi faire, au choix (une seule commande, dans ' + clientDir + ') :\n' +
            `  mv "${fileName}" oauth-client.json      # ce nom-là est déjà protégé par .gitignore\n` +
            `ou ajouter la ligne « ${fileName} » au .gitignore.`,
        );
      }
    }
  }

  if (mode === 'oauth') {
    view.info(
      'Mode OAuth (le défaut) : le navigateur va s\'ouvrir et tu te connectes UNE fois avec ton\n' +
        'compte super-administrateur. Aucune clé privée sur le disque. Google bloque par défaut la\n' +
        'création de clés de compte de service sur les nouvelles organisations, et le client a\n' +
        'choisi de garder cette protection : c\'est donc ce mode-ci le chemin normal.',
    );
    if (!oauthClientPath) {
      view.warn(
        'Aucun fichier de client OAuth trouvé pour l\'instant. Si la connexion échoue, le message\n' +
          'suivant expliquera exactement quoi télécharger et où le déposer.',
      );
    }
  } else {
    view.info('Mode compte de service : aucune fenêtre de navigateur, la clé du compte de service est utilisée.');
  }

  // Configuration MINIMALE, juste de quoi s'authentifier : c'est tout ce dont
  // auth.mjs a besoin. « init » est la seule commande qui doit fonctionner AVANT
  // que config.json existe : elle ne passe donc jamais par loadConfig().
  //
  // Quand un config.json existe déjà, on reprend ses chemins tels que loadConfig
  // les a résolus, mais on travaille sur une copie : on ne modifie jamais l'objet
  // de configuration que le CLI a passé aux autres commandes.
  const already = config?.auth?.resolved ?? null;
  const authConfig = {
    domain: config?.domain ?? null,
    adminEmail: flags.admin ?? config?.adminEmail ?? null,
    auth: {
      mode,
      keyFile: config?.auth?.keyFile ?? DEFAULTS.auth.keyFile,
      oauthClientFile: config?.auth?.oauthClientFile ?? DEFAULTS.auth.oauthClientFile,
      tokenFile: config?.auth?.tokenFile ?? DEFAULTS.auth.tokenFile,
    },
  };

  // Chemins absolus prêts à l'emploi : auth.mjs les préfère aux chemins relatifs.
  Object.defineProperty(authConfig, '__configDir', { value: targetDir, enumerable: false, configurable: true });
  Object.defineProperty(authConfig.auth, 'resolved', {
    value: {
      keyFile: already?.keyFile ?? resolve(targetDir, authConfig.auth.keyFile),
      oauthClientFile: oauthClientPath ?? already?.oauthClientFile ?? resolve(targetDir, authConfig.auth.oauthClientFile),
      tokenFile: already?.tokenFile ?? resolve(targetDir, authConfig.auth.tokenFile),
    },
    enumerable: false,
    configurable: true,
  });

  /* ---------------------------------------------------------------- *
   * 2/6 — Connexion
   * ---------------------------------------------------------------- */
  view.step('2/6 — Connexion à Google');
  view.info(
    'On demande d\'un coup toutes les autorisations de la trousse (annuaire, groupes,\n' +
      'calendriers, Drive). C\'est volontaire : une seule visite dans le navigateur, et les\n' +
      'commandes suivantes ne redemanderont plus rien.',
  );

  // Les erreurs levées ici (AuthError) portent déjà un message rédigé pour un
  // humain, avec la marche à suivre : on les laisse remonter telles quelles
  // plutôt que de les noyer sous un message générique.
  const { admin, auth } = await getClients({
    config: authConfig,
    subject: authConfig.adminEmail ?? undefined,
    scopes: ALL_SCOPES,
  });

  const signedInEmail = flags.admin ?? emailFromIdToken(auth?.credentials?.id_token) ?? authConfig.adminEmail ?? null;
  if (signedInEmail) view.ok(`Connecté comme ${signedInEmail}.`);
  else view.info("Impossible de savoir quel compte s'est connecté : on déduira tout de l'annuaire.");

  /* ---------------------------------------------------------------- *
   * 3/6 — Les usagers
   * ---------------------------------------------------------------- */
  view.step("3/6 — Lecture des comptes du domaine");

  let users;
  try {
    users = await listUsers(admin);
  } catch (e) {
    const forbidden = isForbidden(e);
    throw new Error(
      "La liste des comptes du domaine n'a pas pu être lue. Sans elle, « init » ne peut rien deviner.\n" +
        explainGoogleError(e, { context: 'lecture des usagers du domaine' }) +
        (forbidden
          ? '\n\nCause la plus fréquente ici : le compte connecté n\'est pas SUPER-administrateur du\n' +
            'domaine. Seul un super-admin peut lire l\'annuaire complet.\n' +
            'Quoi faire : supprimer le fichier de jetons (.tokens.json) pour te reconnecter avec\n' +
            'le bon compte, puis relancer « node src/cli.mjs init ».'
          : ''),
    );
  }

  // Filet : un compte sans adresse principale ne peut rien recevoir et ferait
  // échouer la validation de config.json avec un message obscur. Google n'en
  // renvoie normalement jamais — mais « normalement » n'est pas « jamais ».
  const usable = users.filter((u) => looksLikeEmail(u?.primaryEmail));
  if (usable.length !== users.length) {
    summary.warnings.push(
      `${users.length - usable.length} compte(s) retourné(s) par Google n'ont pas d'adresse principale ` +
        'exploitable : ils ont été écartés. Rien à faire de ton côté, sauf si tu attendais quelqu\'un qui ' +
        'manque dans la liste ci-dessous.',
    );
    users = usable;
  }

  if (users.length === 0) {
    throw new Error(
      "Google n'a retourné aucun compte pour ce domaine. C'est anormal : ton propre compte devrait\n" +
        "au minimum apparaître.\n" +
        'Quoi faire :\n' +
        '  1. vérifier que tu es connecté au bon compte Google (le super-admin du domaine) ;\n' +
        '  2. vérifier que l\'API Admin SDK est activée :\n' +
        '     https://console.cloud.google.com/apis/library/admin.googleapis.com',
    );
  }

  const customerDomain = await readCustomerDomain(admin);
  let { domain, source: domainSource } = deduceDomain({ customerDomain, signedInEmail, users });
  if (!domain) {
    throw new Error(
      "Impossible de déduire le domaine du Workspace à partir des comptes trouvés.\n" +
        'Quoi faire : relancer en précisant le compte administrateur, par exemple :\n' +
        '  node src/cli.mjs init --admin greg@mondomaine.ca',
    );
  }
  view.ok(`Domaine : ${domain} (${domainSource}).`);

  const owned = internalDomains(users, domain);
  if (owned.size > 1) {
    view.info(`Domaines rattachés au Workspace (alias compris) : ${[...owned].sort().join(', ')}.`);
  }

  const active = users.filter((u) => u?.suspended !== true && u?.archived !== true);
  const inactive = users.filter((u) => u?.suspended === true || u?.archived === true);

  if (active.length === 0) {
    throw new Error(
      `Les ${users.length} compte(s) du domaine sont tous suspendus ou archivés : il n'y a personne à ` +
        "mettre dans l'équipe, et un config.json sans équipe ne servirait à rien.\n" +
        'Quoi faire : réactiver au moins un compte dans https://admin.google.com/ac/users, ' +
        'puis relancer « node src/cli.mjs init ».',
    );
  }

  view.info(`${users.length} compte(s) trouvé(s) : ${active.length} actif(s), ${inactive.length} suspendu(s) ou archivé(s).`);
  view.table(
    users.map((u) => ({
      Courriel: lower(u?.primaryEmail),
      Nom: shorten(displayName(u), 28),
      'Super-admin': u?.isAdmin === true ? 'oui' : u?.isDelegatedAdmin === true ? 'délégué' : 'non',
      'Suspendu/archivé': u?.archived === true ? 'archivé' : u?.suspended === true ? 'suspendu' : 'non',
      '2FA': u?.isEnrolledIn2Sv === true ? 'oui' : 'NON',
      Équipe: u?.suspended !== true && u?.archived !== true ? 'oui' : '—',
    })),
  );
  view.info(
    "« Super-admin » = super-administrateur du domaine (peut tout faire). « délégué » = administrateur\n" +
      "délégué : ce n'est PAS la même chose, ses droits sont limités à ce qu'un rôle lui accorde,\n" +
      "et il ne peut pas forcément faire tourner cette trousse.",
  );

  if (inactive.length > 0) {
    view.info(
      `${inactive.length} compte(s) suspendu(s) ou archivé(s) ne sont PAS mis dans l'équipe : ` +
        'leur donner des accès ne servirait à rien. Ils restent listés ci-dessus pour que tu saches ' +
        "qu'ils existent : " +
        inactive.map((u) => lower(u.primaryEmail)).join(', ') +
        '.',
    );
  }

  const noTwoFactor = active.filter((u) => u?.isEnrolledIn2Sv !== true);
  if (noTwoFactor.length > 0) {
    summary.warnings.push(
      `${noTwoFactor.length} compte(s) actif(s) n'ont PAS la validation en deux étapes : ` +
        noTwoFactor.map((u) => lower(u.primaryEmail)).join(', ') +
        '.\nCe n\'est pas bloquant pour la trousse, mais un compte administrateur sans 2FA est la ' +
        'porte d\'entrée la plus courante.\nQuoi faire : https://admin.google.com/ac/security/2sv',
    );
  }

  /* ---------------------------------------------------------------- *
   * 4/6 — adminEmail et équipe
   * ---------------------------------------------------------------- */
  view.step('4/6 — Administrateur et équipe');

  const superAdmins = active.filter((u) => u?.isAdmin === true);
  const signedInUser = signedInEmail ? active.find((u) => lower(u.primaryEmail) === lower(signedInEmail)) : null;

  // À domaines multiples, on préfère un super-admin DU domaine visé : « adminEmail »
  // et « group.email » doivent y être, sinon la validation de config.json échoue.
  const inDomain = (u) => domainOf(u?.primaryEmail) === domain;

  let adminEmail = null;
  if (signedInUser?.isAdmin === true) {
    // Priorité absolue au compte connecté : en mode OAuth, c'est EN SON NOM que
    // toutes les commandes agiront. Écrire quelqu'un d'autre ici serait un piège.
    adminEmail = lower(signedInUser.primaryEmail);
    view.ok(`adminEmail = ${adminEmail} — c'est le compte connecté, et il est super-administrateur.`);
  } else if (superAdmins.length > 0) {
    const chosen = superAdmins.find(inDomain) ?? superAdmins[0];
    adminEmail = lower(chosen.primaryEmail);
    view.ok(`adminEmail = ${adminEmail} — premier super-administrateur trouvé dans l'annuaire.`);
    if (signedInEmail) {
      summary.warnings.push(
        `Le compte connecté (${signedInEmail}) n'est pas super-administrateur du domaine, ou n'apparaît ` +
          `pas parmi les comptes actifs. « adminEmail » a donc été mis à ${adminEmail}.\n` +
          'Attention : en mode OAuth, les commandes agissent au nom du compte CONNECTÉ, pas de celui écrit ' +
          'dans « adminEmail ». Si ce ne sont pas les mêmes, reconnecte-toi avec le bon compte (supprimer ' +
          '.tokens.json) avant de lancer « setup ».',
      );
    }
  } else {
    const fallback = active.find(inDomain) ?? active[0];
    adminEmail = lower(fallback.primaryEmail);
    summary.warnings.push(
      "Aucun compte SUPER-administrateur n'a été trouvé parmi les comptes actifs. « adminEmail » a été " +
        `mis à ${adminEmail} faute de mieux, mais la trousse a besoin d'un super-admin pour créer un ` +
        'groupe, un Drive partagé et des calendriers.\n' +
        'Quoi faire : ouvrir https://admin.google.com/ac/roles et donner le rôle « Super-administrateur » ' +
        'à la bonne personne, puis relancer « init ».',
    );
  }

  // COHÉRENCE OBLIGATOIRE — la validation de config.json REFUSE un « adminEmail »
  // qui n'est pas dans « domain » (Google refuse le jeton d'un compte emprunté
  // hors du domaine administré). Un compte client à plusieurs domaines peut très
  // bien avoir son administrateur ailleurs que dans le domaine principal déclaré
  // par Google : sans ce rattrapage, « init » écrirait un fichier que la trousse
  // elle-même refuserait de lire, trois commandes plus loin, sans qu'on comprenne
  // pourquoi. On aligne donc le domaine sur l'administrateur, et on le dit.
  if (domainOf(adminEmail) !== domain) {
    const previousDomain = domain;
    domain = domainOf(adminEmail);
    domainSource = `domaine de l'administrateur ${adminEmail}`;
    summary.warnings.push(
      `Ce compte client Google gère plusieurs domaines : Google déclare « ${previousDomain} » comme ` +
        `domaine principal, mais l'administrateur retenu (${adminEmail}) est dans « ${domain} ».\n` +
        `« domain » a été mis à ${domain}, parce que le compte administrateur et le groupe d'équipe ` +
        'doivent obligatoirement être dans le même domaine que celui indiqué ici — sinon la trousse ' +
        'refuse de lire son propre fichier.\n' +
        `Quoi faire si c'est bien ${previousDomain} qu'il faut administrer : relancer en désignant un ` +
        `super-administrateur de ce domaine-là, par exemple : node src/cli.mjs init --admin quelquun@${previousDomain}`,
    );
    view.ok(`Domaine retenu : ${domain} (${domainSource}).`);
  }

  if (superAdmins.length > 1) {
    view.info(
      `${superAdmins.length} super-administrateurs : ${superAdmins.map((u) => lower(u.primaryEmail)).join(', ')}. ` +
        'Ils reçoivent tous le rôle « organizer » dans l\'équipe.',
    );
  }

  // « organizer » = peut gérer le Drive partagé et le groupe. On le donne aux
  // super-admins : ce sont eux qui devront réparer si quelque chose casse.
  const team = active
    .map((u) => ({
      email: lower(u.primaryEmail),
      name: displayName(u),
      role: u?.isAdmin === true ? 'organizer' : 'member',
    }))
    .sort((a, b) => {
      if (a.email === adminEmail) return -1;
      if (b.email === adminEmail) return 1;
      if (a.role !== b.role) return a.role === 'organizer' ? -1 : 1;
      return a.email.localeCompare(b.email);
    });

  if (!team.some((m) => m.role === 'organizer') && team.length > 0) {
    team[0].role = 'organizer';
    summary.warnings.push(
      `Personne n'étant super-administrateur, le rôle « organizer » a été donné d'office à ${team[0].email} : ` +
        'sans organisateur, personne ne pourrait gérer le Drive partagé. Vérifie que c\'est la bonne personne.',
    );
  }

  view.table(team.map((m) => ({ Adresse: m.email, Nom: m.name, Rôle: m.role })));
  view.info('« organizer » = peut gérer le Drive partagé et ses membres. « member » = accès normal.');

  if (team.length > 20) {
    summary.warnings.push(
      `L'équipe proposée contient ${team.length} personnes. La trousse est prévue pour une petite équipe : ` +
        'tous ces comptes recevront un accès au Drive partagé et aux calendriers.\n' +
        'Quoi faire si ce n\'est pas voulu : ouvrir config.json et retirer les lignes de « team » qui ne ' +
        'devraient pas y être, avant de lancer « setup ».',
    );
  }

  /* ---------------------------------------------------------------- *
   * 5/6 — Groupe et adresse personnelle
   * ---------------------------------------------------------------- */
  view.step("5/6 — Groupe d'équipe et adresse personnelle à détacher");

  /* --- Groupe ------------------------------------------------------ */
  let groups = [];
  try {
    groups = await listGroups(admin);
  } catch (e) {
    summary.warnings.push(
      "La liste des groupes existants n'a pas pu être lue : la configuration proposera donc de créer un " +
        'groupe neuf. Si un groupe d\'équipe existe déjà, la commande « group » le réutilisera de toute façon ' +
        "(elle cherche toujours avant de créer).\n" +
        explainGoogleError(e, { context: 'lecture des groupes du domaine' }),
    );
  }

  const userEmails = new Set(users.map((u) => lower(u.primaryEmail)));
  const scored = groups
    .map((g) => ({ group: g, score: scoreTeamGroup(g, domain, team.length) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.group.directMembersCount ?? 0) - Number(a.group.directMembersCount ?? 0) ||
        lower(a.group.email).localeCompare(lower(b.group.email)),
    );

  const templateGroup = template?.group && typeof template.group === 'object' ? template.group : {};
  const defaultGroupName = typeof templateGroup.name === 'string' && templateGroup.name.trim() !== '' ? templateGroup.name.trim() : 'Équipe';
  const defaultGroupDescription =
    typeof templateGroup.description === 'string' && templateGroup.description.trim() !== ''
      ? templateGroup.description.trim()
      : "Groupe qui contient l'équipe. Les accès (calendrier, Drive partagé) sont accordés à ce groupe " +
        'plutôt qu\'à chaque personne : quand quelqu\'un arrive ou part, on modifie le groupe et tous les ' +
        'accès suivent.';

  let group;
  const otherGroups = [];

  if (scored.length > 0) {
    const chosen = scored[0].group;
    group = {
      email: lower(chosen.email),
      // On garde le nom et la description RÉELS du groupe : si on mettait ceux
      // du modèle, la commande « group » renommerait un groupe déjà en service.
      name: typeof chosen.name === 'string' && chosen.name.trim() !== '' ? chosen.name.trim() : defaultGroupName,
      description: typeof chosen.description === 'string' ? chosen.description.trim() : '',
    };
    view.ok(
      `Groupe d'équipe existant réutilisé : ${group.email} (« ${group.name} », ` +
        `${Number(chosen.directMembersCount ?? 0)} membre(s)). Aucun deuxième groupe ne sera créé.`,
    );
    otherGroups.push(...scored.slice(1).map((entry) => entry.group));
  } else {
    const localPart =
      NEW_GROUP_LOCAL_PARTS.find((candidate) => !userEmails.has(`${candidate}@${domain}`)) ?? NEW_GROUP_LOCAL_PARTS[0];
    group = { email: `${localPart}@${domain}`, name: defaultGroupName, description: defaultGroupDescription };
    view.info(
      `Aucun groupe d'équipe évident dans le domaine. Proposition : créer ${group.email}. ` +
        'Les accès au calendrier et au Drive partagé seront accordés à ce groupe plutôt qu\'à chaque ' +
        'personne — un départ ou une arrivée se règlera alors en une seule modification.',
    );
    if (localPart !== NEW_GROUP_LOCAL_PARTS[0]) {
      summary.warnings.push(
        `L'adresse equipe@${domain} est déjà celle d'un compte utilisateur : une adresse ne peut pas être à la ` +
          `fois une personne et un groupe. L'adresse ${group.email} est donc proposée à la place.`,
      );
    }
  }

  if (otherGroups.length > 0) {
    view.info(
      "D'autres groupes ressemblaient aussi à un groupe d'équipe. Ils sont notés dans config.json " +
        '(champ « _group_autres_candidats ») au cas où le choix ne serait pas le bon :',
    );
    view.table(
      otherGroups.map((g) => ({
        Adresse: lower(g.email),
        Nom: shorten(g.name ?? '', 30),
        Membres: Number(g.directMembersCount ?? 0),
      })),
    );
  }

  /* --- Adresse personnelle ----------------------------------------- */
  const candidates = findPersonalEmails(users, owned);
  let personalEmail = null;
  const otherPersonalEmails = [];

  if (candidates.length === 0) {
    view.info(
      "Aucune adresse externe (type @gmail.com) n'a été trouvée dans les adresses de secours ni dans les " +
        `adresses secondaires des comptes. « personalEmail » restera à null : la commande « detach » n'aura ` +
        'rien à faire.\n' +
        'Si tu sais qu\'il y en a une, écris-la à la main dans config.json, champ « personalEmail ».',
    );
  } else {
    personalEmail = candidates[0].email;
    otherPersonalEmails.push(...candidates.slice(1));

    view.ok(`Adresse personnelle à détacher : ${personalEmail}.`);
    view.info(
      (candidates[0].onAdmin
        ? "C'est une adresse externe rattachée au compte super-administrateur — typiquement celle qui a " +
          'servi à ouvrir le Workspace. '
        : "C'est l'adresse externe la plus souvent rattachée aux comptes du domaine. ") +
        "La commande « detach » la retirera des ressources de l'entreprise.",
    );
    view.table(
      candidates.map((c) => ({
        Adresse: c.email,
        'Trouvée (fois)': c.count,
        'Compte super-admin': c.onAdmin ? 'oui' : 'non',
        Où: shorten(c.sources.join(' ; '), 46),
      })),
    );
    if (otherPersonalEmails.length > 0) {
      view.info(
        `${otherPersonalEmails.length} autre(s) adresse(s) externe(s) trouvée(s). Les autres sont notées dans ` +
          'config.json (champ « _personalEmail_autres_candidats »). Si ce n\'est pas la bonne, il suffit ' +
          'de recopier la bonne dans le champ « personalEmail ».',
      );
    }

    if (!candidates[0].onAdmin) {
      summary.warnings.push(
        `L'adresse retenue pour « personalEmail » (${personalEmail}) n'est PAS rattachée à un compte ` +
          "super-administrateur : c'est l'adresse externe d'un ou de plusieurs collègues.\n" +
          "Pourquoi c'est important : « detach » retire cette adresse des adresses de SECOURS des comptes " +
          'où elle figure. Appliquée à la mauvaise adresse, elle priverait ces personnes de leur moyen de ' +
          'récupérer leur compte Google.\n' +
          'Quoi faire : relire le tableau ci-dessus et, si ce n\'est pas la bonne, corriger le champ ' +
          '« personalEmail » de config.json AVANT de lancer « detach » (ou le mettre à null).',
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * 6/6 — config.json
   * ---------------------------------------------------------------- */
  view.step('6/6 — Configuration proposée');

  let oauthClientFile = oauthClientPath
    ? relative(targetDir, oauthClientPath) || `./${basename(oauthClientPath)}`
    : (config?.auth?.oauthClientFile ?? template?.auth?.oauthClientFile ?? DEFAULTS.auth.oauthClientFile);
  // Un chemin relatif commence par « ./ » : sans ça, il se lit comme un nom perdu.
  if (!oauthClientFile.startsWith('.') && !oauthClientFile.startsWith('/')) oauthClientFile = `./${oauthClientFile}`;

  const authSection = buildAuthSection({
    template,
    previous: previousUsable ? previous : null,
    config,
    mode,
    oauthClientFile,
  });

  const proposed = buildProposedConfig({
    template,
    previous: previousUsable ? previous : null,
    domain,
    adminEmail,
    personalEmail,
    otherPersonalEmails,
    team,
    group,
    otherGroups,
    auth: authSection,
  });

  const content = formatJson(proposed);

  view.table([
    { Champ: 'domain', 'Valeur proposée': proposed.domain },
    { Champ: 'adminEmail', 'Valeur proposée': proposed.adminEmail },
    { Champ: 'personalEmail', 'Valeur proposée': proposed.personalEmail ?? 'null (aucune trouvée)' },
    { Champ: 'team', 'Valeur proposée': `${team.length} personne(s)` },
    { Champ: 'group.email', 'Valeur proposée': proposed.group.email },
    { Champ: 'calendars', 'Valeur proposée': `${proposed.calendars.length} calendrier(s)` },
    { Champ: 'sharedDrive.name', 'Valeur proposée': proposed.sharedDrive?.name ?? '(aucun)' },
    { Champ: 'auth.mode', 'Valeur proposée': proposed.auth.mode },
    { Champ: 'auth.oauthClientFile', 'Valeur proposée': proposed.auth.oauthClientFile },
  ]);

  const backupPath = `${targetPath}.bak`;

  /* --- Comparaison avec l'existant --------------------------------- */
  let identical = false;
  if (exists) {
    if (!previousUsable) {
      summary.warnings.push(
        `${targetPath} existe mais n'a pas pu être relu (${previousError ?? 'contenu inattendu'}) : impossible ` +
          'de montrer les différences, et les réglages qui ne se découvrent pas (fuseau horaire, ' +
          'calendriers, Drive partagé) repartent des valeurs du modèle config.example.json. ' +
          'Le fichier actuel sera sauvegardé en .bak avant toute écriture.',
      );
    } else {
      const diff = diffConfigs(previous, proposed);
      identical = diff.total === 0;

      if (identical) {
        view.skip(
          `${targetPath} existe déjà et correspond exactement à ce qui vient d'être découvert. Rien à écrire.`,
        );
      } else {
        view.step(`Différences avec le ${basename(targetPath)} actuel`);
        view.info(
          `${diff.total} différence(s). Les champs de commentaire (ceux qui commencent par « _ ») ne sont pas comparés.`,
        );
        showDiffSection(view, 'Champs AJOUTÉS par rapport au fichier actuel', diff.added);
        showDiffSection(view, 'Champs RETIRÉS (présents aujourd\'hui, absents de la proposition)', diff.removed);
        showDiffSection(view, 'Champs MODIFIÉS', diff.changed);

        if (diff.removed.length > 0) {
          view.warn(
            'Des champs seraient RETIRÉS. Si tu as ajusté config.json à la main (une personne ajoutée, un ' +
              'dossier de plus, un fuseau horaire), ces ajustements seraient perdus. La sauvegarde .bak permet ' +
              'de les récupérer, mais relis la liste ci-dessus avant de continuer.',
          );
        }
      }
    }
  }

  /* --- Écriture ---------------------------------------------------- */
  if (identical) {
    summary.unchanged.push({ label: `Configuration ${targetPath}` });
  } else if (!apply) {
    view.step('Contenu proposé pour config.json');
    view.blank();
    for (const line of content.split('\n')) view.raw(`    ${line}`);
    view.blank();

    if (exists && !flags.force) {
      view.plan(
        `${targetPath} existe déjà. Il ne sera PAS écrasé sans que tu le demandes.\n` +
          'Pour l\'écraser (une copie de sécurité est faite avant) :\n' +
          '  node src/cli.mjs init --apply --force',
      );
      // Pas de ligne « à ajuster » dans le résumé final : elle inviterait à
      // relancer avec --apply seul, ce qui ne ferait justement RIEN. On met un
      // point à lire, qui dit la commande exacte.
      summary.warnings.push(
        `${targetPath} existe déjà : « --apply » seul ne le remplacera pas. La commande complète est ` +
          `« node src/cli.mjs init --apply --force » (l'ancien fichier est d'abord copié dans ` +
          `${basename(backupPath)}).`,
      );
    } else {
      view.plan(
        `Écrire ${targetPath}.\n` +
          'Rien n\'a été écrit. Relis la proposition ci-dessus, puis relance avec --apply pour l\'écrire :\n' +
          `  node src/cli.mjs init --apply${exists ? ' --force' : ''}`,
      );
      summary[exists ? 'updated' : 'created'].push({ label: `Configuration ${targetPath}` });
    }
  } else if (exists && !flags.force) {
    // --apply sans --force sur un fichier existant : on refuse, c'est le seul
    // fichier que le client a pu ajuster à la main.
    view.warn(
      `${targetPath} existe déjà et n'a PAS été écrasé.\n` +
        'C\'est volontaire : ce fichier a peut-être été ajusté à la main, et l\'écraser en silence ferait ' +
        'perdre ce travail.\n' +
        'Quoi faire :\n' +
        `  - garder le fichier actuel : il n'y a rien à faire ;\n` +
        `  - le remplacer par la proposition ci-dessus (l'ancien est copié dans ${basename(backupPath)}) :\n` +
        '      node src/cli.mjs init --apply --force',
    );
    summary.warnings.push(
      `${targetPath} existe déjà : il n'a pas été remplacé. Relancer avec --apply --force pour le remplacer ` +
        `(l'ancien sera sauvegardé dans ${basename(backupPath)}).`,
    );
  } else {
    if (exists) {
      try {
        copyFileSync(targetPath, backupPath);
        try {
          chmodSync(backupPath, 0o600);
        } catch {
          /* système de fichiers sans permissions POSIX : sans conséquence */
        }
        view.ok(`Ancienne configuration sauvegardée dans ${backupPath}.`);
      } catch (e) {
        throw new Error(
          `Impossible de sauvegarder ${targetPath} dans ${backupPath} : ${e?.message ?? e}\n` +
            "Rien n'a été écrasé. Quoi faire : vérifier les droits d'écriture sur le dossier " +
            `${targetDir}, puis relancer.`,
        );
      }

      if (!ignoredByGit(targetDir, basename(backupPath))) {
        summary.warnings.push(
          `Le fichier de sauvegarde ${basename(backupPath)} contient de vraies adresses et ne semble couvert par ` +
            'aucune règle du .gitignore — alors que le dépôt est PUBLIC.\n' +
            'Quoi faire, au choix :\n' +
            `  - le supprimer quand tu n'en as plus besoin : rm "${backupPath}"\n` +
            `  - ou ajouter cette ligne au .gitignore du dossier ${targetDir} :\n` +
            `      ${basename(backupPath)}`,
        );
      }
    }

    try {
      writePrivateFile(targetPath, content);
    } catch (e) {
      throw new Error(
        `L'écriture de ${targetPath} a échoué : ${e?.message ?? e}\n` +
          `Quoi faire : vérifier les droits d'écriture sur le dossier ${targetDir}, puis relancer.`,
      );
    }

    view.ok(`${targetPath} écrit (lisible par toi seul).`);
    summary[exists ? 'updated' : 'created'].push({ label: `Configuration ${targetPath}` });
  }

  /* ---------------------------------------------------------------- *
   * Rappels finaux
   * ---------------------------------------------------------------- */
  view.step('À retenir');

  // On ne PROMET pas que le fichier est ignoré par git : on le vérifie. Écrit
  // ailleurs que dans la trousse (« --config ../autre-projet/config.json »),
  // il peut très bien atterrir dans un dépôt qui, lui, ne l'ignore pas.
  const configIgnored = ignoredByGit(targetDir, basename(targetPath));

  view.warn(
    `${basename(targetPath)} contient de VRAIES adresses : ton domaine, ton équipe, et l'adresse ` +
      'personnelle à détacher.\n' +
      (configIgnored
        ? 'Il est dans .gitignore et ne doit JAMAIS être commité — le dépôt est PUBLIC. Le modèle à ' +
          'partager, c\'est config.example.json, qui ne contient que des adresses inventées.'
        : 'Il ne doit JAMAIS être commité — le dépôt est PUBLIC. Le modèle à partager, c\'est ' +
          'config.example.json, qui ne contient que des adresses inventées.'),
  );

  if (!configIgnored) {
    summary.warnings.push(
      `Aucune règle du .gitignore du dossier ${targetDir} ne couvre « ${basename(targetPath)} », qui ` +
        'contient pourtant de vraies adresses — et le dépôt est PUBLIC.\n' +
        'Quoi faire, au choix :\n' +
        `  - ajouter la ligne « ${basename(targetPath)} » au fichier .gitignore de ce dossier ;\n` +
        `  - ou écrire la configuration dans la trousse elle-même, où elle est déjà protégée :\n` +
        `      node src/cli.mjs init --apply --config ${join(ROOT_DIR, 'config.json')}`,
    );
  }

  if (mode === 'oauth') {
    view.info(
      "À savoir avant de lancer « setup » — en mode OAuth, la trousse agit au nom de TON compte et\n" +
        "ne peut pas agir au nom des autres. Conséquence concrète : les calendriers partagés seront\n" +
        'créés et partagés avec le groupe, mais ils apparaîtront automatiquement dans TON agenda\n' +
        `seulement. Les ${Math.max(0, team.length - 1)} autre(s) personne(s) recevront un courriel de partage et devront cliquer\n` +
        'une fois dessus pour ajouter le calendrier au leur. Ce n\'est pas un bogue : Google ne permet\n' +
        'pas de faire autrement sans clé de compte de service, et le client a choisi de garder cette\n' +
        'protection activée.',
    );
  }

  view.info(
    'La suite, dans l\'ordre :\n' +
      '  1. node src/cli.mjs doctor          vérifie que tous les accès fonctionnent\n' +
      '  2. node src/cli.mjs audit           montre ce qui existe déjà dans le domaine\n' +
      '  3. node src/cli.mjs setup           simulation : ce qui serait créé\n' +
      '  4. node src/cli.mjs setup --apply   création pour de vrai\n' +
      '  5. node src/cli.mjs verify          relit tout et confirme',
  );

  return summary;
}

export default { meta, run };
