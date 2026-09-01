/**
 * google.mjs — Clients googleapis, réessais et traduction des erreurs.
 *
 * Trois responsabilités :
 *   1. fabriquer les quatre clients d'API dont la trousse a besoin ;
 *   2. réessayer intelligemment (Google est éventuellement cohérent : une
 *      ressource fraîchement créée n'est pas immédiatement visible) ;
 *   3. traduire les erreurs Google en français actionnable.
 */

import { google } from 'googleapis';
import { getAuthClient, ALL_SCOPES } from './auth.mjs';
import log from './log.mjs';

/* ------------------------------------------------------------------ */
/* Clients                                                             */
/* ------------------------------------------------------------------ */

/**
 * Construit les clients googleapis prêts à l'emploi.
 *
 * @param {object} params
 * @param {object} params.config configuration chargée par loadConfig()
 * @param {string} [params.subject] compte à emprunter (défaut : config.adminEmail)
 * @param {string[]} [params.scopes] portées demandées (défaut : ALL_SCOPES)
 * @returns {Promise<{ admin: object, calendar: object, drive: object, groupsSettings: object, auth: object, subject: string }>}
 */
export async function getClients({ config, subject, scopes } = {}) {
  const impersonated = subject ?? config?.adminEmail ?? null;
  const auth = await getAuthClient({ config, subject: impersonated, scopes: scopes ?? ALL_SCOPES });

  return {
    /** Admin SDK Directory : utilisateurs, groupes, membres. */
    admin: google.admin({ version: 'directory_v1', auth }),
    /** Agenda : calendriers secondaires et partages. */
    calendar: google.calendar({ version: 'v3', auth }),
    /** Drive : Drive partagé, dossiers, permissions. */
    drive: google.drive({ version: 'v3', auth }),
    /** Groups Settings : réglages fins d'un groupe (qui publie, qui voit). */
    groupsSettings: google.groupssettings({ version: 'v1', auth }),
    auth,
    subject: impersonated,
  };
}

/* ------------------------------------------------------------------ */
/* Lecture des erreurs Google                                          */
/* ------------------------------------------------------------------ */

/**
 * Normalise une erreur googleapis / gaxios en une forme exploitable.
 *
 * Les erreurs Google prennent plusieurs formes selon l'API et la couche :
 *   - { error: { code, message, errors: [{ reason, message, domain }] } }
 *   - { error: "invalid_grant", error_description: "..." }   (jetons)
 *   - une simple erreur réseau Node (ECONNRESET, ENOTFOUND…)
 *
 * @param {unknown} e
 * @returns {{ status: number|null, reasons: string[], message: string, netCode: string|null, activationUrl: string|null }}
 */
export function errorInfo(e) {
  let data = e?.response?.data ?? e?.data ?? null;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      data = { error: { message: data } };
    }
  }

  const inner = data && typeof data === 'object' ? data.error : null;

  const status =
    e?.response?.status ??
    (inner && typeof inner === 'object' ? inner.code : null) ??
    (typeof e?.status === 'number' ? e.status : null) ??
    (typeof e?.code === 'number' ? e.code : null) ??
    null;

  /** @type {string[]} */
  const reasons = [];
  if (inner && typeof inner === 'object' && Array.isArray(inner.errors)) {
    for (const item of inner.errors) {
      if (item?.reason) reasons.push(String(item.reason));
    }
    if (inner.status) reasons.push(String(inner.status));
  } else if (typeof inner === 'string') {
    reasons.push(inner);
  }
  if (Array.isArray(e?.errors)) {
    for (const item of e.errors) if (item?.reason) reasons.push(String(item.reason));
  }

  const message =
    (inner && typeof inner === 'object' ? inner.message : null) ??
    data?.error_description ??
    (typeof inner === 'string' ? inner : null) ??
    e?.message ??
    String(e);

  const netCode = typeof e?.code === 'string' ? e.code : null;

  const urlMatch = String(message).match(/https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"')]+/);

  return {
    status: typeof status === 'number' ? status : null,
    reasons: [...new Set(reasons.map((r) => String(r)))],
    message: String(message),
    netCode,
    activationUrl: urlMatch ? urlMatch[0].replace(/[.,]$/, '') : null,
  };
}

/** Vrai si l'erreur est un « ressource introuvable » (404). */
export function isNotFound(e) {
  const { status, reasons } = errorInfo(e);
  return status === 404 || reasons.some((r) => ['notfound', 'not_found'].includes(r.toLowerCase()));
}

/** Vrai si l'erreur est un conflit / doublon (409, ou « entity already exists »). */
export function isConflict(e) {
  const { status, reasons, message } = errorInfo(e);
  if (status === 409) return true;
  if (reasons.some((r) => ['duplicate', 'alreadyexists', 'conflict'].includes(r.toLowerCase()))) return true;
  return /already exists|entity already exists|duplicate/i.test(message);
}

/** Vrai si l'erreur est un refus d'accès (403). */
export function isForbidden(e) {
  const { status } = errorInfo(e);
  return status === 403;
}

/** Vrai si l'erreur est une authentification invalide ou expirée (401). */
export function isUnauthenticated(e) {
  const { status } = errorInfo(e);
  return status === 401;
}

/* ------------------------------------------------------------------ */
/* Réessais                                                            */
/* ------------------------------------------------------------------ */

/** Codes réseau Node considérés comme temporaires. */
const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'ENOTFOUND',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

/** Statuts HTTP toujours temporaires. */
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Motifs de 403 qui ne sont JAMAIS de la propagation : réessayer ne ferait que
 * faire perdre une minute à l'utilisateur avant d'échouer quand même.
 */
const HARD_403_REASONS = new Set([
  'accessnotconfigured',
  'servicedisabled',
  'insufficientpermissions',
  'notauthorized',
  'autherror',
  'domainpolicy',
  'forbiddenforadministrator',
  'cannotdeleteprimarycalendar',
  'quotaexceeded',
  'storagequotaexceeded',
]);

const HARD_403_PATTERNS = [
  /has not been used in project/i,
  /Not Authorized to access this resource/i,
  /insufficient authentication scopes/i,
  /Request had insufficient authentication scopes/i,
  /has not enabled/i,
  /is disabled/i,
];

/** Attente passive. */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Décide si une erreur mérite un réessai.
 * @param {unknown} e
 * @param {boolean} propagation autoriser les réessais « propagation » (403/404)
 * @returns {{ retry: boolean, kind: 'transient'|'propagation'|null }}
 */
function classifyError(e, propagation) {
  const { status, reasons, message, netCode } = errorInfo(e);

  if (netCode && TRANSIENT_NET_CODES.has(netCode)) return { retry: true, kind: 'transient' };
  if (status && TRANSIENT_STATUS.has(status)) return { retry: true, kind: 'transient' };
  if (reasons.some((r) => ['ratelimitexceeded', 'userratelimitexceeded', 'backenderror', 'unavailable', 'internalerror'].includes(r.toLowerCase()))) {
    return { retry: true, kind: 'transient' };
  }

  if (!propagation) return { retry: false, kind: null };

  // Propagation : Google documente qu'une ressource fraîchement créée (groupe,
  // Drive partagé, appartenance) peut rester invisible quelques secondes à
  // quelques minutes. Elle se manifeste par un 404 ou un 403 « mou ».
  if (status === 404) return { retry: true, kind: 'propagation' };

  if (status === 403) {
    const lowered = reasons.map((r) => r.toLowerCase());
    if (lowered.some((r) => HARD_403_REASONS.has(r))) return { retry: false, kind: null };
    if (HARD_403_PATTERNS.some((re) => re.test(message))) return { retry: false, kind: null };
    return { retry: true, kind: 'propagation' };
  }

  return { retry: false, kind: null };
}

/**
 * Exécute un appel Google avec réessais et attente exponentielle.
 *
 * Deux familles d'erreurs sont réessayées :
 *   - les erreurs temporaires : 429, 500, 502, 503, 504, coupures réseau ;
 *   - la PROPAGATION : un groupe, un Drive partagé ou une appartenance qui
 *     vient d'être créé n'est pas immédiatement visible partout chez Google.
 *     Cela se traduit par un 404 ou un 403 pendant quelques secondes à
 *     quelques minutes.
 *
 * Budget d'attente réel avec les valeurs par défaut (tries = 6) : les cinq
 * pauses valent 2, 4, 8, 16 puis 32 secondes, soit 62 secondes au total —
 * environ une minute, pas deux. Pour couvrir une propagation plus lente, passer
 * explicitement { tries: 7 } (126 s) plutôt que d'espérer que le défaut suffise.
 *
 * ATTENTION — pour une recherche d'existence où le 404 est une réponse ATTENDUE
 * (« est-ce que ce groupe existe déjà ? »), passer { propagation: false },
 * sinon chaque vérification négative attendra une minute pour rien.
 *
 * ATTENTION (2) — RÉESSAI ET DOUBLONS. Un réessai relance l'appel EN ENTIER.
 * Sur une lecture, c'est sans danger. Sur une CRÉATION, un 500 ou une coupure
 * réseau peut survenir APRÈS que Google a créé la ressource : le réessai en
 * créerait alors une deuxième. Pour toute création, l'appelant doit donc soit
 * fournir une clé d'idempotence (drives.create → requestId déterministe), soit
 * relire l'existant avant de créer et traiter le conflit (isConflict) comme un
 * succès. Cette fonction ne peut pas le deviner à sa place.
 *
 * @template T
 * @param {() => Promise<T>} fn appel à exécuter
 * @param {object} [options]
 * @param {number} [options.tries=6] nombre total de tentatives
 * @param {string} [options.label] description courte, affichée pendant l'attente
 * @param {boolean} [options.propagation=true] réessayer les 404/403 de propagation
 * @param {number} [options.baseDelayMs=2000] délai de la première attente
 * @param {number} [options.maxDelayMs=64000] plafond d'attente entre deux essais
 * @param {object} [options.log] journal à utiliser (défaut : celui de la trousse)
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
  const {
    tries = 6,
    label = 'appel à Google',
    propagation = true,
    baseDelayMs = 2000,
    maxDelayMs = 64000,
    log: logger = log,
  } = options;

  const attempts = Math.max(1, Number(tries) || 1);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      const { retry, kind } = classifyError(e, propagation);

      if (!retry || attempt === attempts) break;

      // 2 s, 4 s, 8 s, 16 s, 32 s, 64 s — plus une pincée d'aléatoire pour ne
      // pas retomber en rafale sur le même créneau.
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
      const seconds = Math.round(delay / 1000);
      const { status, message } = errorInfo(e);

      if (kind === 'propagation') {
        logger.info(
          `${label} : Google n'a pas encore répercuté la création partout ` +
            `(${status ?? 'erreur'}). C'est normal juste après une création. ` +
            `Nouvel essai ${attempt + 1}/${attempts} dans ${seconds} s…`,
        );
      } else {
        logger.info(
          `${label} : Google est momentanément indisponible (${status ?? errorInfo(e).netCode ?? 'erreur'} — ` +
            `${String(message).slice(0, 120)}). Nouvel essai ${attempt + 1}/${attempts} dans ${seconds} s…`,
        );
      }

      await sleep(delay + jitter);
    }
  }

  if (lastError && typeof lastError === 'object') {
    try {
      lastError.explication = explainGoogleError(lastError);
      lastError.tentatives = attempts;
    } catch {
      /* ne jamais masquer l'erreur d'origine à cause du diagnostic */
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------------ */
/* Traduction des erreurs                                              */
/* ------------------------------------------------------------------ */

/**
 * Traduit une erreur Google en explication française actionnable.
 *
 * @param {unknown} e
 * @param {{ context?: string }} [options] contexte court, ex. « création du Drive partagé »
 * @returns {string}
 */
export function explainGoogleError(e, options = {}) {
  const { status, reasons, message, netCode, activationUrl } = errorInfo(e);
  const lowered = reasons.map((r) => r.toLowerCase());
  const has = (...names) => names.some((n) => lowered.includes(n.toLowerCase()));
  const prefix = options.context ? `${options.context} — ` : '';
  const detail = `\nMessage de Google : ${message}`;

  if (netCode && TRANSIENT_NET_CODES.has(netCode)) {
    return (
      `${prefix}impossible de joindre Google (${netCode}).${detail}\n` +
      'Quoi faire : vérifier la connexion Internet et relancer. Derrière un proxy\n' +
      'd\'entreprise, définir les variables HTTPS_PROXY et NO_PROXY.'
    );
  }

  if (status === 401) {
    return (
      `${prefix}Google a refusé l'authentification (401).${detail}\n` +
      'Quoi faire :\n' +
      '  - en mode OAuth : l\'autorisation a expiré ou a été révoquée. Supprimer le\n' +
      '    fichier de jetons (auth.tokenFile) et relancer pour se reconnecter ;\n' +
      '  - en mode compte de service : vérifier que l\'heure de la machine est juste\n' +
      '    (un décalage de plus de 5 minutes invalide les jetons).'
    );
  }

  if (status === 403 && (has('accessNotConfigured', 'serviceDisabled') || /has not been used in project/i.test(message))) {
    return (
      `${prefix}une API Google nécessaire n'est pas activée dans le projet Cloud.${detail}\n` +
      'Quoi faire : activer l\'API' +
      (activationUrl ? ` en ouvrant :\n  ${activationUrl}` : ' dans la console Cloud.') +
      '\n\nLes quatre API utilisées par la trousse :\n' +
      '  https://console.cloud.google.com/apis/library/admin.googleapis.com\n' +
      '  https://console.cloud.google.com/apis/library/calendar-json.googleapis.com\n' +
      '  https://console.cloud.google.com/apis/library/drive.googleapis.com\n' +
      '  https://console.cloud.google.com/apis/library/groupssettings.googleapis.com\n' +
      'Compter 1 à 2 minutes après activation avant de relancer.'
    );
  }

  if (status === 403 && (has('insufficientPermissions') || /insufficient authentication scopes/i.test(message))) {
    return (
      `${prefix}le jeton n'a pas les portées suffisantes pour cette opération.${detail}\n` +
      'Quoi faire :\n' +
      '  - mode compte de service : la liste de portées enregistrée dans la délégation\n' +
      '    à l\'échelle du domaine est incomplète. La remplacer par celle qu\'affiche\n' +
      '    la commande « scopes » de la trousse (correspondance EXACTE exigée) ;\n' +
      '  - mode OAuth : supprimer le fichier de jetons et se reconnecter pour\n' +
      '    accorder les nouvelles portées.'
    );
  }

  if (status === 403 && /Not Authorized to access this resource/i.test(message)) {
    return (
      `${prefix}le jeton est valide, mais le compte emprunté n'a pas le droit de faire cela.${detail}\n` +
      'Quoi faire :\n' +
      '  - vérifier que « adminEmail » est bien un super-administrateur du domaine\n' +
      '    (ou possède un rôle d\'administrateur délégué couvrant cette opération) ;\n' +
      '  - vérifier que l\'API Admin SDK est activée dans le projet Cloud ;\n' +
      '  - vérifier que ce compte s\'est déjà connecté au moins une fois.'
    );
  }

  if (status === 403 && has('sharingRateLimitExceeded')) {
    return (
      `${prefix}Google limite temporairement le nombre de partages.${detail}\n` +
      'Quoi faire : attendre quelques minutes et relancer. La trousse est idempotente :\n' +
      'ce qui a déjà été fait ne sera pas refait.'
    );
  }

  if (status === 403 && (has('teamDriveMembershipRequired', 'insufficientFilePermissions'))) {
    return (
      `${prefix}l'accès au Drive partagé est refusé pour ce compte.${detail}\n` +
      'Quoi faire : vérifier que le compte emprunté (adminEmail) est bien membre\n' +
      '« gestionnaire » du Drive partagé. Juste après la création du Drive, ce refus\n' +
      'peut aussi être temporaire : relancer dans une minute.'
    );
  }

  if (status === 403 && has('domainPolicy')) {
    return (
      `${prefix}une règle du domaine Workspace interdit cette opération.${detail}\n` +
      'Quoi faire : dans la console d\'administration, vérifier les règles de partage\n' +
      'de Drive et de création de Drive partagés (Applications > Google Workspace >\n' +
      'Drive et Docs > Paramètres de partage).'
    );
  }

  if (status === 403) {
    return (
      `${prefix}Google a refusé l'opération (403).${detail}\n` +
      'Quoi faire : vérifier que le compte emprunté a les droits nécessaires, et que\n' +
      'les portées de la délégation couvrent bien cette API.'
    );
  }

  if (status === 404) {
    return (
      `${prefix}la ressource demandée est introuvable (404).${detail}\n` +
      'Quoi faire :\n' +
      '  - si elle vient d\'être créée : c\'est de la propagation, relancer dans une minute ;\n' +
      '  - si elle a été supprimée à la main dans l\'interface Google : supprimer le\n' +
      '    fichier de cache d\'état pour forcer une redécouverte complète.'
    );
  }

  if (status === 409 || isConflict(e)) {
    return (
      `${prefix}la ressource existe déjà (conflit).${detail}\n` +
      'Ce n\'est normalement pas bloquant : la trousse est idempotente et réutilise\n' +
      'l\'existant. Si le message persiste, une ressource du même nom a peut-être été\n' +
      'créée manuellement en parallèle.'
    );
  }

  if (status === 429 || has('rateLimitExceeded', 'userRateLimitExceeded')) {
    return (
      `${prefix}trop de requêtes envoyées à Google en peu de temps (429).${detail}\n` +
      'Quoi faire : attendre une minute et relancer. Les réessais automatiques ont déjà\n' +
      'été épuisés.'
    );
  }

  if (status === 400 && has('invalid', 'invalidParameter', 'badRequest', 'invalidArgument')) {
    return (
      `${prefix}Google a refusé les données envoyées (400).${detail}\n` +
      'Quoi faire : ce message pointe presque toujours un champ de config.json —\n' +
      'un nom vide, un fuseau horaire inconnu, une adresse mal formée. Corriger le\n' +
      'champ mentionné ci-dessus puis relancer.'
    );
  }

  if (status === 400) {
    return `${prefix}requête refusée par Google (400).${detail}\nQuoi faire : vérifier les valeurs correspondantes dans config.json.`;
  }

  if (status && status >= 500) {
    return (
      `${prefix}Google a rencontré une erreur de son côté (${status}).${detail}\n` +
      'Quoi faire : ce n\'est pas une erreur de configuration. Relancer dans quelques\n' +
      'minutes ; la trousse reprendra là où elle en est.'
    );
  }

  return (
    `${prefix}échec de l'appel à Google${status ? ` (${status})` : ''}.${detail}\n` +
    'Quoi faire : relancer avec DEBUG=1 pour la trace complète.'
  );
}

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
/* ------------------------------------------------------------------ */

/**
 * Parcourt toutes les pages d'une liste Google et retourne tous les éléments.
 *
 * Toutes les API de la trousse paginent : sans cela, un domaine de plus de
 * 100 utilisateurs ou un dossier de plus de 100 fichiers serait silencieusement
 * tronqué — le pire genre de bogue, parce qu'il ne se voit pas.
 *
 * @template T
 * @param {(pageToken: string|undefined) => Promise<{ data: Record<string, unknown> }>} fetchPage
 * @param {object} options
 * @param {string} options.itemsKey nom du tableau dans la réponse (ex. 'files', 'groups')
 * @param {string} [options.label] description pour les messages de réessai
 * @param {number} [options.maxPages=200] garde-fou contre une boucle infinie
 * @param {object} [options.retry] options transmises à withRetry
 * @returns {Promise<T[]>}
 */
export async function collectPages(fetchPage, { itemsKey, label = 'lecture de la liste', maxPages = 200, retry = {} } = {}) {
  /** @type {unknown[]} */
  const items = [];
  let pageToken;
  let pages = 0;

  do {
    const token = pageToken;
    const res = await withRetry(() => fetchPage(token), { label, propagation: false, ...retry });
    const data = res?.data ?? {};
    const page = itemsKey ? data[itemsKey] : null;
    if (Array.isArray(page)) items.push(...page);
    pageToken = typeof data.nextPageToken === 'string' && data.nextPageToken !== '' ? data.nextPageToken : undefined;
    pages += 1;
  } while (pageToken && pages < maxPages);

  if (pageToken) {
    const logger = retry?.log ?? log;
    logger.warn(
      `${label} : plus de ${maxPages} pages de résultats, la lecture a été arrêtée. ` +
        'Si ce message apparaît, la trousse dépasse le volume pour lequel elle a été prévue.',
    );
  }

  return /** @type {any[]} */ (items);
}

/* ------------------------------------------------------------------ */
/* Garde de sécurité Drive                                             */
/* ------------------------------------------------------------------ */

/**
 * GARDE DE SÉCURITÉ — exigence numéro un du client.
 *
 * Refuse toute opération sur un fichier ou un dossier qui n'appartient pas au
 * Drive partagé visé. Sans cette vérification, une erreur de logique ou un
 * identifiant périmé dans le cache pourrait faire déplacer, partager ou
 * supprimer un document du « Mon Drive » personnel du propriétaire.
 *
 * Toute commande Drive qui écrit DOIT passer par ici avant d'agir.
 *
 * @param {{ id?: string, name?: string, driveId?: string|null }} file
 *        fichier lu avec, au minimum, fields: 'id, name, driveId'
 * @param {string} expectedDriveId identifiant du Drive partagé cible
 * @param {{ action?: string }} [options] description de l'action, pour le message
 * @throws {Error} si le fichier n'est pas dans le Drive partagé attendu
 */
export function assertInSharedDrive(file, expectedDriveId, options = {}) {
  const action = options.action ?? 'modifier cet élément';

  if (!expectedDriveId) {
    throw new Error(
      'REFUS DE SÉCURITÉ : aucun Drive partagé cible n\'est connu, impossible de ' +
        `${action}.\nC'est un bogue interne : le Drive partagé doit être créé ou retrouvé ` +
        'avant toute opération sur des fichiers.',
    );
  }

  if (!file || typeof file !== 'object') {
    throw new Error(
      `REFUS DE SÉCURITÉ : impossible de vérifier l'emplacement de l'élément avant de ${action}.\n` +
        'Aucune opération ne sera faite. Lire le fichier avec fields: "id, name, driveId" avant d\'agir.',
    );
  }

  if (file.driveId !== expectedDriveId) {
    throw new Error(
      [
        `REFUS DE SÉCURITÉ : la trousse a failli ${action} en dehors du Drive partagé.`,
        '',
        `  Élément            : ${file.name ?? '(nom inconnu)'} (id ${file.id ?? 'inconnu'})`,
        `  Drive de l'élément : ${file.driveId ?? 'aucun — c\'est un fichier de « Mon Drive » personnel'}`,
        `  Drive attendu      : ${expectedDriveId}`,
        '',
        'Aucune modification n\'a été faite. La trousse ne touche JAMAIS aux documents',
        'personnels : elle n\'agit que dans le Drive partagé qu\'elle a créé.',
        '',
        'Cause probable : un identifiant périmé dans le cache d\'état. Supprimer le',
        'fichier de cache (.state.json) et relancer en mode simulation pour vérifier.',
      ].join('\n'),
    );
  }
}

export default {
  getClients,
  withRetry,
  isNotFound,
  isConflict,
  isForbidden,
  isUnauthenticated,
  explainGoogleError,
  errorInfo,
  collectPages,
  assertInSharedDrive,
  sleep,
};
