/**
 * audit.mjs — Commande « audit » : portrait complet du Google Workspace.
 *
 * LECTURE SEULE, SANS EXCEPTION.
 * Cette commande n'appelle que des méthodes `get` et `list`. Elle ignore
 * volontairement l'option --apply : même lancée avec --apply, elle ne modifie
 * rien (cli.mjs la marque déjà « readOnly » — ceinture ET bretelles).
 *
 * RÈGLE DE SÉCURITÉ NUMÉRO UN — on ne touche JAMAIS au « Mon Drive » personnel.
 * Concrètement, ce fichier n'appelle jamais `drive.files.list` ni
 * `drive.files.get` : AUCUN fichier n'est énuméré, ni dans un Drive partagé,
 * ni — surtout — dans le « Mon Drive » de qui que ce soit. Côté Drive, on lit
 * uniquement :
 *   - `drives.list`       → la liste des Drive PARTAGÉS du domaine ;
 *   - `permissions.list`  → la liste des MEMBRES d'un Drive partagé, en passant
 *                           l'identifiant du Drive partagé lui-même.
 * Une garde explicite (assertSharedDriveId) refuse tout appel dont
 * l'identifiant de Drive partagé est vide ou invalide.
 *
 * Robustesse : chaque section est isolée. Si une API n'est pas activée (cas
 * classique : Groups Settings), ou si le compte utilisé par la trousse n'a pas le privilège
 * requis, on affiche un avertissement en français et on continue avec le reste.
 */

import {
  getClients,
  withRetry,
  isNotFound,
  isForbidden,
  errorInfo,
  explainGoogleError,
} from '../lib/google.mjs';
import { ALL_SCOPES } from '../lib/auth.mjs';

export const meta = {
  name: 'audit',
  summary:
    "Dresse l'inventaire complet du domaine : compte, usagers, groupes, calendriers, " +
    "Drive partagés, et surtout : où traîne encore l'adresse personnelle. Ne modifie rien.",
};

/* ================================================================== *
 * Constantes d'API
 * ================================================================== */

/** Alias accepté par l'Admin SDK pour « mon compte client ». */
const CUSTOMER_KEY = 'my_customer';

/** Plafonds documentés — trois valeurs différentes, ne pas les confondre. */
const USERS_PAGE_SIZE = 500; // admin.users.list      : max 500 (défaut 100)
const GROUPS_PAGE_SIZE = 200; // admin.groups.list    : max 200
const MEMBERS_PAGE_SIZE = 200; // admin.members.list  : max 200
const CALENDAR_PAGE_SIZE = 250; // calendarList/acl   : max 250
const DRIVE_PAGE_SIZE = 100; // drives/permissions    : max 100 (défaut 10 !)

/**
 * Garde-fou anti-boucle infinie. Si Google renvoyait indéfiniment le même
 * jeton de page, l'audit tournerait sans fin sans jamais rien afficher. Au-delà
 * de ce plafond on préfère interrompre la lecture avec un message clair : la
 * zone sera alors déclarée « non balayée » plutôt que silencieusement tronquée.
 */
const MAX_PAGES = 500;

/** Masques `fields` explicites : on ne rapatrie que ce qu'on affiche. */
const USER_FIELDS =
  'nextPageToken,users(id,primaryEmail,name,isAdmin,isDelegatedAdmin,suspended,suspensionReason,' +
  'archived,isEnrolledIn2Sv,isEnforcedIn2Sv,recoveryEmail,recoveryPhone,emails,aliases,' +
  'nonEditableAliases,lastLoginTime,creationTime,orgUnitPath)';

const GROUP_FIELDS = 'nextPageToken,groups(id,email,name,description,directMembersCount,adminCreated,aliases)';

const MEMBER_FIELDS = 'nextPageToken,members(id,email,role,type,status)';

const CALENDAR_LIST_FIELDS =
  'nextPageToken,items(id,summary,summaryOverride,description,timeZone,accessRole,primary,selected,hidden,deleted)';

const ACL_FIELDS = 'nextPageToken,items(id,role,scope)';

const DRIVE_RESTRICTION_FIELDS =
  'adminManagedRestrictions,copyRequiresWriterPermission,domainUsersOnly,driveMembersOnly,' +
  'sharingFoldersRequiresOrganizerPermission';

const DRIVE_LIST_FIELDS = `nextPageToken,drives(id,name,createdTime,restrictions(${DRIVE_RESTRICTION_FIELDS}))`;

const DRIVE_GET_FIELDS = `id,name,createdTime,restrictions(${DRIVE_RESTRICTION_FIELDS})`;

const PERMISSION_FIELDS =
  'nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,deleted,' +
  'permissionDetails(role,permissionType,inherited))';

/** Restrictions du Drive partagé que la trousse sait comparer. */
const RESTRICTION_LABELS = {
  domainUsersOnly: 'Accès limité aux usagers du domaine',
  driveMembersOnly: 'Accès limité aux membres du Drive',
  copyRequiresWriterPermission: 'Copie / impression / téléchargement bloqués pour les lecteurs',
  sharingFoldersRequiresOrganizerPermission: "Seuls les gestionnaires peuvent partager un dossier",
  adminManagedRestrictions: 'Restrictions verrouillées par un admin du domaine',
};

/* ================================================================== *
 * Ce que l'API ne voit PAS et ne peut PAS changer.
 * Source : notes de recherche vérifiées (facturation Workspace = aucune API
 * cliente ; Cloud Billing API = Google Cloud seulement ; Reseller API =
 * revendeurs seulement).
 * ================================================================== */

const ANGLES_MORTS = [
  {
    titre: 'Contacts de facturation',
    pourquoi:
      "C'est l'endroit le plus probable où dort encore l'adresse personnelle, et aucune API cliente n'existe " +
      'pour la facturation Google Workspace.',
    chemin:
      "console.admin.google.com > Facturation > Comptes de paiement > ⋮ Plus (à côté de l'abonnement) > " +
      'Afficher les paramètres de paiement > Contacts de paiement',
    note:
      "Le contact PRINCIPAL ne se modifie pas : il faut AJOUTER le nouveau contact, cliquer le lien de " +
      "vérification reçu par courriel (sinon il reste « En attente » et ne reçoit RIEN), le promouvoir " +
      "contact principal, PUIS seulement retirer l'ancien.",
  },
  {
    titre: 'Utilisateurs du profil de paiement',
    pourquoi:
      "Couche différente des contacts : ce sont les comptes Google qui ont des PERMISSIONS sur le profil de " +
      "paiement. L'adresse personnelle en est probablement l'administratrice.",
    chemin: 'payments.google.com > Paramètres > Utilisateurs de paiement',
    note:
      "Ne jamais se retirer soi-même avant d'avoir promu une adresse du domaine : si l'adresse personnelle est " +
      'le seul administrateur du profil, on perd la main sur les moyens de paiement et les factures.',
  },
  {
    titre: 'Administrateur principal (Primary admin) du compte',
    pourquoi: "Champ distinct de l'adresse secondaire. C'est lui qui reçoit les avis produit et critiques.",
    chemin: "console.admin.google.com > Compte > Paramètres du compte > Profil > Coordonnées > Administrateur principal",
    note: "Doit pointer sur un compte réel du domaine, jamais sur un alias.",
  },
  {
    titre: 'Préférences de communication',
    pourquoi: "Détermine qui reçoit quoi (sécurité, facturation, nouveautés). Aucune API.",
    chemin: 'console.admin.google.com > Compte > Paramètres du compte > Préférences > Préférences de communication',
    note: 'Demande le privilège « Paramètres du domaine ».',
  },
  {
    titre: 'Responsable de la protection des données / représentant en confidentialité',
    pourquoi: "Si quelque chose y a été saisi à l'inscription, l'adresse personnelle peut s'y trouver.",
    chemin: 'console.admin.google.com > Compte > Paramètres du compte > Aspects juridiques et conformité',
    note: 'Super-administrateur requis.',
  },
  {
    titre: 'Comptes en conflit / usagers non gérés',
    pourquoi:
      "L'API ne voit pas les comptes Google PERSONNELS créés avec une adresse du domaine (avant l'inscription " +
      'à Workspace : YouTube, Analytics, Search Console, Ads…). Ils causent des écrans de choix de compte et ' +
      'des données « disparues ».',
    chemin:
      'console.admin.google.com > Annuaire > Utilisateurs > Plus d\'options > ' +
      'Outil de transfert pour les utilisateurs non gérés',
    note:
      "Deux issues : inviter la personne à transférer son compte, ou lui demander de le renommer. " +
      "Il n'existe AUCUN outil Google pour fusionner deux comptes.",
  },
  {
    titre: 'Récupération du compte super-administrateur (interrupteur global)',
    pourquoi:
      "Sur plusieurs éditions (dont Business Plus), l'auto-récupération est DÉSACTIVÉE par défaut : l'adresse " +
      "de récupération ne servira à rien le jour où il faudra s'en servir.",
    chemin:
      'console.admin.google.com > Sécurité > Authentification > Récupération du compte > ' +
      'Récupération du compte super-administrateur',
    note: "À vérifier EN PREMIER. Rappel : un compte protégé par la validation en deux étapes ne peut être " +
      "réinitialisé qu'avec une adresse de récupération — un numéro de téléphone ne suffit pas.",
  },
  {
    titre: 'Projets Google Cloud possédés par l\'adresse personnelle',
    pourquoi:
      "Un projet GCP créé avec le Gmail (typiquement pour générer la clé de compte de service) reste possédé " +
      "par le Gmail, sous « Aucune organisation ». Il ne migre pas tout seul.",
    chemin: 'console.cloud.google.com > IAM et administration > Gérer les ressources',
    note: "Une demande de migration vers l'organisation expire après 30 jours si personne ne l'accepte.",
  },
  {
    titre: 'Google Search Console',
    pourquoi:
      "Si le domaine a déjà été validé avec l'adresse personnelle, ce compte détient un jeton de propriété " +
      "indépendant de Workspace.",
    chemin: 'search.google.com/search-console > Paramètres > Utilisateurs et autorisations',
    note: "Ajouter le compte du domaine comme propriétaire AVANT de retirer l'ancien.",
  },
  {
    titre: 'Compte chez le registraire du domaine',
    pourquoi:
      "Hors Google, mais c'est la clé maîtresse : en récupération assistée, Google exige une preuve de " +
      'propriété du domaine (enregistrement DNS à publier, valable 48 h).',
    chemin: 'Site du registraire (là où le domaine a été acheté)',
    note: "Si ce compte est lui-même ouvert sous l'adresse personnelle, il faut le régler aussi.",
  },
  {
    titre: 'Fichiers du « Mon Drive » personnel',
    pourquoi:
      "Par choix de conception, cette trousse ne regarde JAMAIS le contenu d'un « Mon Drive ». C'est " +
      "l'exigence numéro un : aucun document personnel n'est listé, déplacé ni partagé.",
    chemin: 'drive.google.com > Mon Drive > Partagés avec des personnes (vérification à faire à l\'œil)',
    note:
      "Si des documents d'entreprise vivent encore dans un « Mon Drive », il faut les déplacer à la main vers " +
      'le Drive partagé — jamais par script.',
  },
];

/* ================================================================== *
 * Petits utilitaires
 * ================================================================== */

const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const sameEmail = (a, b) => lower(a) !== '' && lower(a) === lower(b);
const ouiNon = (v) => (v ? 'oui' : 'non');
const tiret = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

/**
 * Code HTTP d'une erreur googleapis, quelle que soit sa forme.
 *
 * On passe par le normaliseur de la trousse : selon la couche qui lève,
 * `error.code` n'est PAS le statut HTTP mais un code réseau en toutes lettres
 * (« ECONNRESET », « ETIMEDOUT »). Le lire en premier ferait manquer les 400.
 */
function errCode(error) {
  try {
    const { status } = errorInfo(error);
    if (typeof status === 'number') return status;
  } catch {
    /* on retombe sur une lecture directe */
  }
  const brut = error?.status ?? error?.response?.status ?? error?.code;
  return typeof brut === 'number' ? brut : null;
}

/** Traduit une erreur Google en français, sans jamais lever à son tour. */
function expliquer(error) {
  try {
    const texte = explainGoogleError(error);
    if (typeof texte === 'string' && texte.trim() !== '') return texte.trim();
  } catch {
    /* on retombe sur le message brut */
  }
  return error?.message ? String(error.message) : String(error);
}

/** Coupe un texte trop long pour un tableau console. */
function couper(texte, max = 60) {
  const s = String(texte ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Étiquette alignée pour les lignes « champ : valeur ». */
function champ(label, largeur = 28) {
  const s = String(label);
  return s.length >= largeur ? `${s} :` : `${s.padEnd(largeur, ' ')}:`;
}

/** Formate une date ISO en heure locale du Québec. */
function formatDate(iso, timeZone) {
  if (!iso) return '—';
  // Un compte qui ne s'est JAMAIS connecté renvoie l'epoch, pas null.
  if (String(iso).startsWith('1970-01-01')) return 'jamais';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    return new Intl.DateTimeFormat('fr-CA', { dateStyle: 'short', timeStyle: 'short', timeZone }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * Appel de LECTURE avec reprise sur erreur passagère (429, 5xx, coupure réseau).
 *
 * `propagation: false` est essentiel ici. Par défaut, withRetry réessaie aussi
 * les 404 et les 403 « mous », parce qu'une ressource fraîchement CRÉÉE met
 * quelques secondes à apparaître partout chez Google. L'audit ne crée rien :
 * un 404 veut dire « ça n'existe pas » et un 403 « ce compte n'a pas le
 * privilège » — deux réponses définitives. Sans ce réglage, chaque groupe ou
 * chaque Drive illisible ferait dormir l'audit six secondes pour rien, ce qui
 * se compte en minutes sur un domaine qui a beaucoup de groupes.
 *
 * @param {string} label
 * @param {() => Promise<any>} fn
 */
function lire(label, fn) {
  if (typeof withRetry === 'function') return withRetry(fn, { tries: 3, label, propagation: false });
  return fn();
}

/**
 * Exécute une section de collecte en l'isolant : une panne d'API n'arrête
 * jamais l'audit, elle produit un avertissement et la section suivante continue.
 *
 * @returns {Promise<{ ok: boolean, value: any, error: unknown }>}
 */
async function collecter(log, warnings, label, fn) {
  try {
    return { ok: true, value: await fn(), error: null };
  } catch (error) {
    const texte = expliquer(error);
    log.warn(`${label} — lecture impossible. ${texte}`);
    warnings.push(`${label} : ${texte}`);
    return { ok: false, value: null, error };
  }
}

/**
 * Garde-fou de pagination : refuse de dépasser MAX_PAGES.
 * @param {number} pages nombre de pages DÉJÀ lues
 * @param {string} label nom de l'appel, pour le message
 */
function encorePaginer(pageToken, pages, label) {
  if (!pageToken) return false;
  if (pages >= MAX_PAGES) {
    throw new Error(
      `${label} : Google a renvoyé plus de ${MAX_PAGES} pages de résultats. La lecture est interrompue par ` +
        "sécurité (jeton de page qui ne progresse plus). Cette zone est signalée comme non balayée.",
    );
  }
  return true;
}

/**
 * GARDE DE SÉCURITÉ. Refuse tout identifiant de Drive partagé douteux.
 * Sans elle, un identifiant vide transformerait un appel « membres du Drive
 * partagé » en appel sur un fichier quelconque.
 */
function assertSharedDriveId(driveId) {
  if (typeof driveId !== 'string' || driveId.trim() === '') {
    throw new Error(
      "REFUS — identifiant de Drive partagé vide. Par sécurité, la trousse n'interroge jamais un fichier " +
        "dont on ne peut pas prouver qu'il appartient à un Drive partagé.",
    );
  }
  return driveId.trim();
}

/* ================================================================== *
 * Lectures paginées
 * ================================================================== */

/** Tous les usagers du compte client. Pagination gérée. */
async function listerUsagers(admin) {
  const users = [];
  let pageToken;
  let fields = USER_FIELDS;
  let encore = true;
  let pages = 0;

  // Boucle « while » et non « do...while » : en cas de repli sur le masque
  // `fields`, on doit REJOUER la même page, pas passer à la suivante.
  while (encore) {
    const params = {
      customer: CUSTOMER_KEY, // et NON `domain` : sinon un seul domaine est couvert
      maxResults: USERS_PAGE_SIZE,
      projection: 'full',
      orderBy: 'email',
      pageToken,
    };
    if (fields) params.fields = fields;

    let data;
    try {
      ({ data } = await lire('admin.users.list', () => admin.users.list(params)));
    } catch (error) {
      // Un masque `fields` refusé (400) ne doit pas faire échouer tout l'audit :
      // on rejoue la même page sans masque, quitte à rapatrier plus de données.
      if (fields && errCode(error) === 400) {
        fields = null;
        continue;
      }
      throw error;
    }

    users.push(...(data.users ?? [])); // `users` est ABSENT (pas []) si 0 résultat
    pageToken = data.nextPageToken ?? undefined;
    pages += 1;
    encore = encorePaginer(pageToken, pages, 'admin.users.list');
  }

  return users;
}

/** Tous les groupes du compte client. Pagination gérée. */
async function listerGroupes(admin) {
  const groups = [];
  let pageToken;
  let pages = 0;
  do {
    const { data } = await lire('admin.groups.list', () =>
      admin.groups.list({
        customer: CUSTOMER_KEY, // ne jamais combiner avec `userKey`
        maxResults: GROUPS_PAGE_SIZE,
        orderBy: 'email',
        pageToken,
        fields: GROUP_FIELDS,
      }),
    );
    groups.push(...(data.groups ?? []));
    pageToken = data.nextPageToken ?? undefined;
    pages += 1;
  } while (encorePaginer(pageToken, pages, 'admin.groups.list'));
  return groups;
}

/** Tous les membres d'un groupe. Pagination gérée. */
async function listerMembres(admin, groupKey) {
  const members = [];
  let pageToken;
  let pages = 0;
  do {
    const { data } = await lire(`admin.members.list(${groupKey})`, () =>
      admin.members.list({
        groupKey,
        maxResults: MEMBERS_PAGE_SIZE,
        includeDerivedMembership: false,
        pageToken,
        fields: MEMBER_FIELDS,
      }),
    );
    members.push(...(data.members ?? []));
    pageToken = data.nextPageToken ?? undefined;
    pages += 1;
  } while (encorePaginer(pageToken, pages, `admin.members.list(${groupKey})`));
  return members;
}

/** Toute la liste de calendriers du compte utilisé par la trousse. Pagination gérée. */
async function listerCalendriers(calendar) {
  const items = [];
  let pageToken;
  let pages = 0;
  do {
    const { data } = await lire('calendar.calendarList.list', () =>
      calendar.calendarList.list({
        maxResults: CALENDAR_PAGE_SIZE,
        showHidden: true, // sinon un calendrier masqué est invisible → faux « absent »
        showDeleted: false,
        pageToken,
        fields: CALENDAR_LIST_FIELDS,
      }),
    );
    items.push(...(data.items ?? []));
    pageToken = data.nextPageToken ?? undefined;
    pages += 1;
  } while (encorePaginer(pageToken, pages, 'calendar.calendarList.list'));
  return items;
}

/** Toutes les règles ACL d'un calendrier. Pagination gérée. */
async function listerAcl(calendar, calendarId) {
  const items = [];
  let pageToken;
  let pages = 0;
  do {
    const { data } = await lire(`calendar.acl.list(${calendarId})`, () =>
      calendar.acl.list({ calendarId, maxResults: CALENDAR_PAGE_SIZE, pageToken, fields: ACL_FIELDS }),
    );
    items.push(...(data.items ?? []));
    pageToken = data.nextPageToken ?? undefined;
    pages += 1;
  } while (encorePaginer(pageToken, pages, `calendar.acl.list(${calendarId})`));
  return items;
}

/**
 * Liste les Drive PARTAGÉS. Jamais de fichiers, jamais de « Mon Drive ».
 * Tente d'abord en accès administrateur de domaine (vue complète), et retombe
 * sur la vue « mes Drive » si le compte utilisé par la trousse n'a pas ce privilège.
 */
async function listerDrivesPartages(drive) {
  const lireListe = async (useDomainAdminAccess) => {
    const drives = [];
    let pageToken;
    let pages = 0;
    do {
      const { data } = await lire('drive.drives.list', () =>
        drive.drives.list({
          pageSize: DRIVE_PAGE_SIZE, // défaut = 10 seulement
          useDomainAdminAccess,
          pageToken,
          fields: DRIVE_LIST_FIELDS,
        }),
      );
      drives.push(...(data.drives ?? []));
      pageToken = data.nextPageToken ?? undefined;
      pages += 1;
    } while (encorePaginer(pageToken, pages, 'drive.drives.list'));
    return drives;
  };

  try {
    return { drives: await lireListe(true), adminAccess: true, degrade: null };
  } catch (error) {
    if (!isForbidden(error)) throw error;
    // Le compte utilisé n'est pas administrateur Drive : vue partielle.
    return { drives: await lireListe(false), adminAccess: false, degrade: expliquer(error) };
  }
}

/** Membres d'un Drive partagé. `fileId` = identifiant du Drive partagé. */
async function listerMembresDrive(drive, driveId, useDomainAdminAccess) {
  const fileId = assertSharedDriveId(driveId); // garde de sécurité
  const permissions = [];
  let pageToken;
  let pages = 0;
  do {
    const { data } = await lire(`drive.permissions.list(${fileId})`, () =>
      drive.permissions.list({
        fileId,
        supportsAllDrives: true, // OBLIGATOIRE sur un Drive partagé
        useDomainAdminAccess,
        pageSize: DRIVE_PAGE_SIZE,
        pageToken,
        fields: PERMISSION_FIELDS,
      }),
    );
    permissions.push(...(data.permissions ?? []));
    pageToken = data.nextPageToken ?? undefined;
    pages += 1;
  } while (encorePaginer(pageToken, pages, `drive.permissions.list(${fileId})`));
  return permissions;
}

/* ================================================================== *
 * Analyse d'un usager
 * ================================================================== */

/**
 * Adresses secondaires « vraies » : ni l'adresse principale, ni un alias.
 * @returns {Array<{ address: string, type: string|null }>}
 */
function adressesSecondaires(user) {
  const principale = lower(user?.primaryEmail);
  const alias = new Set([...(user?.aliases ?? []), ...(user?.nonEditableAliases ?? [])].map(lower));
  const vues = new Set();
  const out = [];
  for (const entree of Array.isArray(user?.emails) ? user.emails : []) {
    const adresse = lower(entree?.address);
    if (!adresse || adresse === principale || alias.has(adresse) || entree?.primary === true) continue;
    if (vues.has(adresse)) continue;
    vues.add(adresse);
    out.push({ address: String(entree.address).trim(), type: entree?.type ?? null });
  }
  return out;
}

/* ================================================================== *
 * Commande
 * ================================================================== */

/**
 * @param {{ config: any, apply: boolean, state: any, log: any }} ctx
 * @returns {Promise<{created: string[], updated: string[], unchanged: string[], warnings: string[]}>}
 */
export async function run({ config, apply, state, log }) {
  /** @type {string[]} */ const warnings = [];
  /** @type {string[]} */ const unchanged = [];
  /** @type {Array<{ p: number, t: string }>} */ const aFaire = [];

  const tz = config?.timeZone || 'America/Toronto';
  const perso = lower(config?.personalEmail);
  const domaine = lower(config?.domain);

  // Normalisation défensive : config.json est écrit à la main, chaque champ
  // peut être absent, à null, ou du mauvais type. On ne veut pas qu'un audit
  // — la commande censée être la plus sûre de la trousse — plante là-dessus.
  /** @type {Array<{email: string, name?: string, role?: string}>} */
  const equipe = (Array.isArray(config?.team) ? config.team : []).filter((m) => lower(m?.email) !== '');
  const calendriersVoulus = (Array.isArray(config?.calendars) ? config.calendars : []).filter((c) => c && c.key);
  const groupeVoulu = lower(config?.group?.email) !== '' ? String(config.group.email).trim() : null;
  const nomDriveVoulu = typeof config?.sharedDrive?.name === 'string' ? config.sharedDrive.name.trim() : '';
  const driveConfigure = nomDriveVoulu !== '';

  if (apply) {
    log.info("L'option --apply n'a aucun effet ici : « audit » est en lecture seule et ne modifie jamais rien.");
  }
  log.info(
    "Aucun fichier n'est énuméré, ni dans un Drive partagé ni dans un « Mon Drive » : " +
      "l'audit ne lit que des listes de ressources et de permissions.",
  );

  const scopes = Array.isArray(ALL_SCOPES) && ALL_SCOPES.length > 0 ? ALL_SCOPES : undefined;
  const { admin, calendar, drive, groupsSettings } = await getClients({
    config,
    subject: config.adminEmail,
    scopes,
  });

  /* ---------------------------------------------------------------- *
   * COLLECTE — tout est lu d'abord, puis affiché section par section,
   * parce que la section « adresse personnelle » a besoin des groupes,
   * des calendriers ET du Drive.
   * ---------------------------------------------------------------- */

  log.step('Collecte des informations (lecture seule)');

  log.info('Lecture du compte client…');
  const resCompte = await collecter(log, warnings, 'Compte client', async () => {
    const { data } = await lire('admin.customers.get', () =>
      admin.customers.get({
        customerKey: CUSTOMER_KEY,
        fields: 'id,customerDomain,alternateEmail,customerCreationTime,language,phoneNumber,postalAddress',
      }),
    );
    return data;
  });

  log.info("Lecture de l'annuaire des usagers…");
  const resUsagers = await collecter(log, warnings, 'Usagers', () => listerUsagers(admin));
  const usagers = resUsagers.ok ? resUsagers.value : [];

  log.info('Lecture des groupes et de leurs membres…');
  const resGroupes = await collecter(log, warnings, 'Groupes', () => listerGroupes(admin));
  const groupes = resGroupes.ok ? resGroupes.value : [];

  /** @type {Map<string, {membres: any[], erreur: string|null}>} */
  const membresParGroupe = new Map();
  for (const g of groupes) {
    try {
      membresParGroupe.set(lower(g.email), { membres: await listerMembres(admin, g.email), erreur: null });
    } catch (error) {
      const texte = expliquer(error);
      membresParGroupe.set(lower(g.email), { membres: [], erreur: texte });
      log.warn(`Groupe ${g.email} — impossible de lire les membres. ${texte}`);
      warnings.push(`Membres du groupe ${g.email} : ${texte}`);
    }
  }

  /*
   * Appartenance réelle au groupe d'équipe.
   *
   * Une règle d'accès accordée à « group:equipe@… » ne donne l'accès qu'aux
   * MEMBRES de ce groupe. Conclure « tout le monde a accès » du seul fait que
   * la règle existe est faux : une personne absente du groupe n'a rien. On
   * croise donc les deux informations. Si les membres n'ont pas pu être lus,
   * on reste prudent et on le dit, plutôt que de rassurer à tort.
   */
  const infoGroupeEquipe = groupeVoulu ? membresParGroupe.get(lower(groupeVoulu)) ?? null : null;
  const membresGroupeLisibles = Boolean(infoGroupeEquipe && !infoGroupeEquipe.erreur);
  const membresGroupeEquipe = new Set((infoGroupeEquipe?.membres ?? []).map((m) => lower(m.email)));

  /**
   * Une personne a-t-elle accès à une ressource ?
   * @param {string} email
   * @param {Set<string>} portees clés « type:valeur » des règles d'accès existantes
   * @param {boolean} viaGroupe une règle vise-t-elle le groupe d'équipe ?
   * @param {boolean} viaDomaine une règle vise-t-elle tout le domaine ?
   */
  function aAcces(email, portees, viaGroupe, viaDomaine) {
    if (portees.has(`user:${lower(email)}`)) return true;
    if (viaDomaine && lower(email).endsWith(`@${domaine}`)) return true;
    if (!viaGroupe) return false;
    // Règle accordée au groupe : encore faut-il que la personne y soit.
    return membresGroupeLisibles ? membresGroupeEquipe.has(lower(email)) : true;
  }

  // Réglages du groupe d'équipe : API distincte, souvent pas activée.
  let reglagesGroupe = null;
  if (groupeVoulu) {
    const res = await collecter(log, warnings, `Réglages du groupe ${groupeVoulu}`, async () => {
      const { data } = await groupsSettings.groups.get({
        groupUniqueId: groupeVoulu, // l'ADRESSE du groupe, pas son id numérique
        alt: 'json',
      });
      return data;
    });
    reglagesGroupe = res.ok ? res.value : null;
    if (!res.ok) {
      aFaire.push({
        p: 4,
        t:
          "Activer l'API « Groups Settings » dans le projet Google Cloud (ou l'ajouter aux scopes de la " +
          "délégation), sinon les réglages de confidentialité du groupe ne peuvent être ni lus ni appliqués.",
      });
    }
  }

  log.info('Lecture des calendriers…');
  const resCalendriers = await collecter(log, warnings, 'Calendriers', () => listerCalendriers(calendar));
  const entreesCalendrier = resCalendriers.ok ? resCalendriers.value : [];

  /** @type {Array<any>} */
  const calendriersAnalyses = [];
  for (const spec of calendriersVoulus) {
    const analyse = {
      key: spec.key,
      summary: spec.summary,
      attenduRole: spec.role,
      attenduTz: spec.timeZone,
      existe: false,
      id: null,
      timeZone: null,
      accessRole: null,
      source: null,
      acl: [],
      aclErreur: null,
      ambigus: [],
      // Faux dès qu'une lecture a échoué : on n'a alors PAS le droit de
      // conclure « ce calendrier n'existe pas » (cf. section 5).
      lectureFiable: resCalendriers.ok,
      cacheErreur: null,
    };

    // 1) le cache local, s'il pointe encore sur un calendrier vivant
    const cache = state?.calendars?.[spec.key];
    if (typeof cache === 'string' && cache !== '') {
      try {
        const { data } = await calendar.calendars.get({
          calendarId: cache,
          fields: 'id,summary,description,timeZone',
        });
        analyse.existe = true;
        analyse.id = data.id;
        analyse.timeZone = data.timeZone ?? null;
        analyse.source = 'cache local';
        // Le cache est un simple fichier local : il peut avoir été copié d'un
        // autre poste ou d'un autre domaine. Si le nom ne correspond pas, on le
        // signale plutôt que d'auditer le mauvais calendrier en silence.
        if (lower(data.summary) !== lower(spec.summary)) {
          log.warn(
            `Le cache local associe la clé « ${spec.key} » à un calendrier nommé « ${data.summary} », ` +
              `alors que config.json demande « ${spec.summary} ». Vérifie le fichier de cache local ` +
              "(.state.json) : il pointe peut-être sur le calendrier d'un autre domaine.",
          );
          warnings.push(
            `Cache local : la clé « ${spec.key} » pointe sur « ${data.summary} », pas sur « ${spec.summary} ».`,
          );
        }
      } catch (error) {
        if (isNotFound(error)) {
          log.warn(
            `Le cache local pointe sur un calendrier « ${spec.key} » qui n'existe plus (${cache}). ` +
              "On le retrouve par son nom, sinon il sera recréé par « setup ».",
          );
        } else {
          // 403, panne réseau… : on ne SAIT pas si le calendrier existe.
          analyse.cacheErreur = expliquer(error);
          analyse.lectureFiable = false;
          log.warn(`Calendrier « ${spec.key} » — vérification du cache impossible. ${analyse.cacheErreur}`);
        }
      }
    }

    // 2) sinon, recherche par nom dans la liste d'abonnement
    if (!analyse.existe) {
      const correspondances = entreesCalendrier.filter(
        (e) => !e.primary && lower(e.summary) === lower(spec.summary),
      );
      if (correspondances.length > 1) {
        analyse.ambigus = correspondances.map((c) => c.id);
        const proprietaire = correspondances.find((c) => c.accessRole === 'owner');
        const choisi = proprietaire ?? correspondances[0];
        analyse.existe = true;
        analyse.id = choisi.id;
        analyse.timeZone = choisi.timeZone ?? null;
        analyse.accessRole = choisi.accessRole ?? null;
        analyse.source = 'recherche par nom';
        warnings.push(
          `${correspondances.length} calendriers portent le nom « ${spec.summary} ». ` +
            "Google autorise les doublons : il faut en supprimer un à la main dans Google Agenda.",
        );
      } else if (correspondances.length === 1) {
        const c = correspondances[0];
        analyse.existe = true;
        analyse.id = c.id;
        analyse.timeZone = c.timeZone ?? null;
        analyse.accessRole = c.accessRole ?? null;
        analyse.source = 'recherche par nom';
      }
    }

    // 3) les règles d'accès, si le calendrier existe
    if (analyse.existe && analyse.id) {
      try {
        analyse.acl = await listerAcl(calendar, analyse.id);
      } catch (error) {
        analyse.aclErreur = expliquer(error);
        log.warn(`Calendrier « ${spec.summary} » — règles d'accès illisibles. ${analyse.aclErreur}`);
        warnings.push(`ACL du calendrier « ${spec.summary} » : ${analyse.aclErreur}`);
      }
    }

    calendriersAnalyses.push(analyse);
  }

  /*
   * BALAYAGE ÉLARGI DES CALENDRIERS.
   *
   * Les analyses ci-dessus ne couvrent que les calendriers décrits dans
   * config.json. Or l'adresse personnelle a très bien pu rester attachée à un
   * VIEUX calendrier créé avant la trousse. Sans cette passe, la section 3
   * pourrait afficher un rassurant « l'adresse n'apparaît nulle part » alors
   * qu'elle est propriétaire d'un autre agenda du compte.
   *
   * On ne peut lire les règles d'accès (`acl.list`) que sur les calendriers où
   * le compte est « owner » ou « writer » — un simple lecteur reçoit un 403.
   * Les autres sont donc déclarés « non balayés », honnêtement, plutôt que
   * passés sous silence.
   */
  const idsDejaAnalyses = new Set(calendriersAnalyses.map((c) => c.id).filter(Boolean));
  /** @type {Array<{ id: string, summary: string, acl: any[] }>} */
  const autresCalendriers = [];
  /** @type {string[]} */
  const calendriersNonBalayes = [];

  const candidats = entreesCalendrier.filter((e) => e.id && !e.primary && !idsDejaAnalyses.has(e.id));
  const LIMITE_CALENDRIERS = 100;
  for (const [index, entree] of candidats.entries()) {
    const nom = entree.summaryOverride || entree.summary || entree.id;
    if (index >= LIMITE_CALENDRIERS) {
      calendriersNonBalayes.push(
        `${candidats.length - LIMITE_CALENDRIERS} autre(s) calendrier(s) (au-delà de la limite de ` +
          `${LIMITE_CALENDRIERS} par exécution)`,
      );
      break;
    }
    if (entree.accessRole !== 'owner' && entree.accessRole !== 'writer') {
      // Accès insuffisant pour lire les partages : on le dit.
      calendriersNonBalayes.push(`« ${nom} » (accès « ${entree.accessRole ?? 'inconnu'} », partages illisibles)`);
      continue;
    }
    try {
      autresCalendriers.push({ id: entree.id, summary: nom, acl: await listerAcl(calendar, entree.id) });
    } catch (error) {
      const texte = expliquer(error);
      calendriersNonBalayes.push(`« ${nom} » (${texte})`);
      log.warn(`Calendrier « ${nom} » — règles d'accès illisibles. ${texte}`);
    }
  }

  log.info('Lecture des Drive partagés…');
  const resDrives = await collecter(log, warnings, 'Drive partagés', () => listerDrivesPartages(drive));
  const drivesPartages = resDrives.ok ? resDrives.value.drives : [];
  const driveAdminAccess = resDrives.ok ? resDrives.value.adminAccess : false;
  if (resDrives.ok && !driveAdminAccess) {
    log.warn(
      `Le compte ${config.adminEmail} n'a pas le privilège « administrateur Drive » : la liste ci-dessous ne ` +
        "montre que " +
        "les Drive partagés dont il est membre. Un Drive existant ailleurs dans l'organisation resterait invisible.",
    );
    warnings.push(
      "Liste des Drive partagés incomplète (privilège administrateur Drive absent sur " +
        `${config.adminEmail}).`,
    );
  }

  // Le Drive de la config est-il dans la liste ? Sinon, on tente le cache.
  let driveCible = null;
  if (state?.driveId) driveCible = drivesPartages.find((d) => d.id === state.driveId) ?? null;
  if (!driveCible && driveConfigure) {
    driveCible = drivesPartages.find((d) => lower(d.name) === lower(nomDriveVoulu)) ?? null;
  }

  const doublonsDrive = driveConfigure
    ? drivesPartages.filter((d) => lower(d.name) === lower(nomDriveVoulu))
    : [];
  if (doublonsDrive.length > 1) {
    warnings.push(
      `${doublonsDrive.length} Drive partagés portent le nom « ${nomDriveVoulu} ». ` +
        'Google autorise les doublons : à démêler à la main dans drive.google.com.',
    );
  }

  if (!driveCible && typeof state?.driveId === 'string' && state.driveId !== '') {
    try {
      const { data } = await drive.drives.get({
        driveId: assertSharedDriveId(state.driveId),
        useDomainAdminAccess: driveAdminAccess,
        fields: DRIVE_GET_FIELDS,
      });
      driveCible = data;
      drivesPartages.push(data);
    } catch (error) {
      if (!isNotFound(error)) {
        log.warn(`Vérification du Drive partagé du cache local impossible. ${expliquer(error)}`);
      }
    }
  }

  /** @type {Map<string, {permissions: any[], erreur: string|null}>} */
  const membresParDrive = new Map();
  for (const d of drivesPartages) {
    try {
      membresParDrive.set(d.id, {
        permissions: await listerMembresDrive(drive, d.id, driveAdminAccess),
        erreur: null,
      });
    } catch (error) {
      const texte = expliquer(error);
      membresParDrive.set(d.id, { permissions: [], erreur: texte });
      log.warn(`Drive partagé « ${d.name} » — membres illisibles. ${texte}`);
      warnings.push(`Membres du Drive partagé « ${d.name} » : ${texte}`);
    }
  }

  /* ---------------------------------------------------------------- *
   * SECTION 1 — Le compte
   * ---------------------------------------------------------------- */

  log.banner('1. Le compte');

  const compte = resCompte.ok ? resCompte.value : null;
  if (!compte) {
    log.warn(
      "Le compte client n'a pas pu être lu. Vérifie que l'API Admin SDK est activée et que la délégation " +
        'inclut le scope admin.directory.customer.',
    );
  } else {
    log.info(`${champ('Domaine principal')} ${tiret(compte.customerDomain)}`);
    log.info(`${champ('Identifiant client')} ${tiret(compte.id)}`);
    log.info(`${champ('Créé le')} ${formatDate(compte.customerCreationTime, tz)}`);
    log.info(`${champ('Langue')} ${tiret(compte.language)}`);
    log.info(`${champ('Adresse secondaire du compte')} ${tiret(compte.alternateEmail)}`);
    log.info(`${champ('Téléphone')} ${tiret(compte.phoneNumber)}`);

    if (domaine && lower(compte.customerDomain) !== domaine) {
      log.warn(
        `Le domaine principal du compte Google est « ${compte.customerDomain} », mais config.json vise ` +
          `« ${config.domain} ». Vérifie le champ « domain » de config.json.`,
      );
      warnings.push(`Domaine de config.json (${config.domain}) ≠ domaine du compte (${compte.customerDomain}).`);
    }

    if (!compte.alternateEmail) {
      log.warn(
        "Aucune adresse secondaire n'est enregistrée sur le compte. C'est là que Google envoie les avis " +
          'critiques (sécurité, facturation, suspension). Sans elle, la récupération du compte est beaucoup plus dure.',
      );
      aFaire.push({
        p: 1,
        t:
          "Renseigner l'adresse secondaire du compte (obligatoirement HORS du domaine — Google refuse une " +
          "adresse @" + (compte.customerDomain ?? config.domain) + "). Console : Compte > Paramètres du compte > " +
          'Profil > Coordonnées.',
      });
    } else {
      unchanged.push(`Compte client ${compte.customerDomain} (adresse secondaire : ${compte.alternateEmail})`);
    }
  }

  /* ---------------------------------------------------------------- *
   * SECTION 2 — Les usagers
   * ---------------------------------------------------------------- */

  log.banner('2. Les usagers');

  if (!resUsagers.ok) {
    log.warn("L'annuaire n'a pas pu être lu : les sections suivantes seront incomplètes.");
  } else if (usagers.length === 0) {
    log.warn(
      "Aucun usager trouvé dans l'annuaire. C'est très inhabituel : vérifie que « adminEmail » de config.json " +
        `(${config.adminEmail}) est bien un compte de ce domaine, et qu'il est super-administrateur.`,
    );
  } else {
    log.info(`${usagers.length} usager(s) dans l'annuaire.`);
    log.table(
      usagers.map((u) => ({
        Courriel: u.primaryEmail,
        Nom: couper(u.name?.fullName ?? '—', 28),
        'Super-admin': ouiNon(u.isAdmin),
        Suspendu: ouiNon(u.suspended),
        'Deux étapes': ouiNon(u.isEnrolledIn2Sv),
        Récupération: tiret(u.recoveryEmail),
        'Dernier accès': formatDate(u.lastLoginTime, tz),
      })),
    );

    for (const u of usagers) {
      const secondaires = adressesSecondaires(u);
      const alias = (u.aliases ?? []).filter((a) => lower(a) !== lower(u.primaryEmail));
      const details = [];
      if (secondaires.length > 0) {
        details.push(
          `adresses secondaires : ${secondaires.map((s) => (s.type ? `${s.address} (${s.type})` : s.address)).join(', ')}`,
        );
      }
      if (alias.length > 0) details.push(`alias : ${alias.join(', ')}`);
      if (u.recoveryPhone) details.push(`téléphone de récupération : ${u.recoveryPhone}`);
      if (u.suspended && u.suspensionReason) details.push(`motif de suspension : ${u.suspensionReason}`);
      if (details.length > 0) log.info(`${u.primaryEmail} — ${details.join(' · ')}`);
    }

    unchanged.push(`${usagers.length} usager(s) dans l'annuaire`);
  }

  const parCourriel = new Map(usagers.map((u) => [lower(u.primaryEmail), u]));
  const superAdmins = usagers.filter((u) => u.isAdmin && !u.suspended);
  const usagerAdmin = parCourriel.get(lower(config.adminEmail)) ?? null;

  if (resUsagers.ok && usagers.length > 0) {
    if (superAdmins.length < 2) {
      log.warn(
        `Il n'y a que ${superAdmins.length} super-administrateur actif. Un mot de passe perdu ou un téléphone ` +
          'volé et personne ne peut plus rien débloquer.',
      );
      // Ne jamais proposer une adresse déjà utilisée : le conseil paraîtrait
      // absurde à quelqu'un qui lit « créer admin@… » alors que c'est le compte
      // avec lequel il vient de lancer l'audit.
      const exemple = ['secours', 'admin2', 'urgence']
        .map((n) => `${n}@${config.domain}`)
        .find((adresse) => !parCourriel.has(lower(adresse)));
      aFaire.push({
        p: 1,
        t:
          'Créer un DEUXIÈME super-administrateur' +
          (exemple ? ` (par exemple ${exemple})` : '') +
          ", avec son propre mot de passe, sa validation en deux étapes et ses codes de secours imprimés et " +
          'rangés hors ligne. Console : Annuaire > Utilisateurs > Ajouter un utilisateur, puis, sur la fiche ' +
          "créée, Rôles et privilèges d'administrateur > Super Admin. Compter jusqu'à 24 h de propagation. " +
          "Ce compte ne sert QU'AUX URGENCES : ne pas s'en servir au quotidien.",
      });
    }
    if (usagerAdmin && !usagerAdmin.isEnrolledIn2Sv) {
      log.warn(`${config.adminEmail} n'a PAS la validation en deux étapes. C'est le compte le plus sensible du domaine.`);
      aFaire.push({
        p: 1,
        t: `Activer la validation en deux étapes sur ${config.adminEmail} (myaccount.google.com > Sécurité), et générer les codes de secours.`,
      });
    }
    if (usagerAdmin && !usagerAdmin.recoveryEmail) {
      log.warn(
        `${config.adminEmail} n'a aucune adresse de récupération. Rappel : un compte protégé par la 2FA ne ` +
          "peut être réinitialisé QU'AVEC une adresse de récupération — un numéro de téléphone ne suffit pas.",
      );
      aFaire.push({
        p: 1,
        t: `Ajouter une adresse de récupération externe et neutre à ${config.adminEmail} (pas une adresse du domaine : le secours doit survivre à la panne qu'il secourt).`,
      });
    }
    if (usagerAdmin && !usagerAdmin.isAdmin) {
      log.warn(
        `${config.adminEmail} n'apparaît pas comme super-administrateur. La trousse a besoin d'un super-admin ` +
          'pour créer groupes, calendriers et Drive partagé.',
      );
      warnings.push(`${config.adminEmail} n'est pas super-administrateur.`);
    }
    if (!usagerAdmin) {
      log.warn(`${config.adminEmail} est introuvable dans l'annuaire. Vérifie le champ « adminEmail » de config.json.`);
      warnings.push(`${config.adminEmail} introuvable dans l'annuaire.`);
    }

    const manquants = equipe.filter((m) => !parCourriel.has(lower(m.email)));
    if (manquants.length > 0) {
      log.warn(
        `${manquants.length} personne(s) de config.json n'existe(nt) pas encore dans l'annuaire : ` +
          manquants.map((m) => m.email).join(', '),
      );
      aFaire.push({
        p: 3,
        t:
          "Créer les comptes manquants : " +
          manquants.map((m) => m.email).join(', ') +
          '. Console : Annuaire > Utilisateurs > Ajouter un utilisateur. (La trousse ne crée pas de comptes : ' +
          'chaque compte coûte une licence.)',
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * SECTION 3 — Où apparaît l'adresse personnelle
   * ---------------------------------------------------------------- */

  log.banner("3. Où apparaît l'adresse personnelle");

  /** @type {Array<{ lieu: string, detail: string, auto: boolean, quoiFaire: string }>} */
  const occurrences = [];

  if (!perso) {
    log.info(
      "Aucune adresse personnelle n'est configurée (champ « personalEmail » à null dans config.json) : " +
        'rien à balayer.',
    );
  } else {
    log.info(`Adresse recherchée : ${config.personalEmail}`);

    // a) adresse de récupération d'un usager
    for (const u of usagers) {
      if (sameEmail(u.recoveryEmail, perso)) {
        // RISQUE DE VERROUILLAGE. Si cette adresse est le SEUL moyen de
        // reprendre la main sur un compte d'administrateur, la retirer sans
        // remplaçant, c'est se condamner au formulaire de récupération de
        // Google (défi DNS de 48 h) ou au support. À dire en priorité 1.
        if (u.isAdmin && !u.recoveryPhone) {
          aFaire.push({
            p: 1,
            t:
              `AVANT de lancer « detach » : ${u.primaryEmail} est administrateur et ${config.personalEmail} est ` +
              "son SEUL moyen de récupération (aucun téléphone de secours enregistré). Ajouter d'abord une " +
              "autre adresse de récupération externe ET un téléphone, vérifier qu'ils fonctionnent, et " +
              "seulement ensuite détacher l'adresse personnelle. Sinon, un mot de passe oublié se règle par " +
              'le formulaire de récupération de Google (preuve DNS à publier sous 48 h) ou par le support.',
          });
        }
        occurrences.push({
          lieu: `Récupération de ${u.primaryEmail}`,
          detail: `recoveryEmail = ${u.recoveryEmail}`,
          auto: true,
          quoiFaire:
            "AUTOMATIQUE — « detach » remplace ce champ (users.patch). ATTENTION : il faut d'abord avoir une " +
            'autre adresse de récupération valide, sinon on se retire le seul filet de sécurité du compte.',
        });
      }
    }

    // b) adresse secondaire (emails[]) d'un usager
    for (const u of usagers) {
      for (const s of adressesSecondaires(u)) {
        if (sameEmail(s.address, perso)) {
          occurrences.push({
            lieu: `Fiche de ${u.primaryEmail}`,
            detail: `adresse secondaire${s.type ? ` (${s.type})` : ''} = ${s.address}`,
            auto: true,
            quoiFaire:
              "AUTOMATIQUE — « detach » réécrit le tableau emails[] au complet (relire, filtrer, users.update). " +
              "Le tableau ne se modifie jamais par morceaux : c'est un remplacement intégral.",
          });
        }
      }
    }

    // c) alias (théoriquement impossible hors du domaine, on vérifie quand même)
    for (const u of usagers) {
      const tousAlias = [...(u.aliases ?? []), ...(u.nonEditableAliases ?? [])];
      if (tousAlias.some((a) => sameEmail(a, perso))) {
        occurrences.push({
          lieu: `Alias de ${u.primaryEmail}`,
          detail: `alias = ${config.personalEmail}`,
          auto: false,
          quoiFaire:
            "MANUEL — un alias se retire avec users.aliases.delete, hors du périmètre de « detach ». " +
            'Console : Annuaire > Utilisateurs > [la personne] > Informations utilisateur > Alias de courriel.',
        });
      }
    }

    // d) adresse secondaire du compte client
    if (compte && sameEmail(compte.alternateEmail, perso)) {
      occurrences.push({
        lieu: 'Compte client (adresse secondaire)',
        detail: `alternateEmail = ${compte.alternateEmail}`,
        auto: true,
        quoiFaire:
          "AUTOMATIQUE — « detach » peut la remplacer (customers.patch), MAIS Google EXIGE une adresse hors du " +
          `domaine : impossible d'y mettre une adresse @${compte.customerDomain ?? config.domain}. Il faut donc ` +
          "fournir une autre adresse externe, neutre et surveillée (une boîte d'entreprise chez un autre " +
          'fournisseur, par exemple). Sans adresse de remplacement, ne pas y toucher.',
      });
    }

    // e) membre d'un groupe
    for (const g of groupes) {
      const info = membresParGroupe.get(lower(g.email));
      if (!info) continue;
      for (const m of info.membres) {
        if (sameEmail(m.email, perso)) {
          occurrences.push({
            lieu: `Groupe ${g.email}`,
            detail: `membre (rôle ${m.role ?? 'MEMBER'}, type ${m.type ?? 'USER'})`,
            auto: true,
            quoiFaire: "AUTOMATIQUE — « detach » retire ce membre (members.delete).",
          });
        }
      }
    }

    // f) règle d'accès sur un calendrier DE LA CONFIG
    for (const c of calendriersAnalyses) {
      for (const regle of c.acl) {
        if (regle?.scope?.type === 'user' && sameEmail(regle.scope.value, perso)) {
          occurrences.push({
            lieu: `Calendrier « ${c.summary} »`,
            detail: `règle d'accès ${regle.id ?? `${regle.scope.type}:${regle.scope.value}`} — rôle ${regle.role}`,
            auto: true,
            quoiFaire: "AUTOMATIQUE — « detach » supprime la règle (acl.delete).",
          });
        }
      }
    }

    // f bis) règle d'accès sur un calendrier QUI N'EST PAS DANS config.json.
    // « detach » ne connaît que les calendriers de la config : y toucher
    // reviendrait à modifier un agenda dont la trousse n'a pas la charge.
    for (const c of autresCalendriers) {
      for (const regle of c.acl) {
        if (regle?.scope?.type === 'user' && sameEmail(regle.scope.value, perso)) {
          occurrences.push({
            lieu: `Calendrier « ${c.summary} » (hors config.json)`,
            detail: `règle d'accès ${regle.id ?? `${regle.scope.type}:${regle.scope.value}`} — rôle ${regle.role}`,
            auto: false,
            quoiFaire:
              "MANUEL — ce calendrier n'est pas décrit dans config.json ; la trousse n'y touche jamais. " +
              `Google Agenda > « ${c.summary} » > Paramètres et partage > Partager avec des personnes.` +
              (regle.role === 'owner'
                ? " ATTENTION : le rôle est « propriétaire ». Donner d'abord ce rôle à une adresse du domaine, " +
                  "vérifier qu'elle l'a bien reçu, PUIS seulement retirer l'ancienne — sinon le calendrier devient orphelin."
                : ''),
          });
        }
      }
    }

    // g) permission sur un Drive partagé
    for (const d of drivesPartages) {
      const info = membresParDrive.get(d.id);
      if (!info) continue;
      const estCible = driveCible && d.id === driveCible.id;
      for (const p of info.permissions) {
        if (sameEmail(p.emailAddress, perso)) {
          occurrences.push({
            lieu: `Drive partagé « ${d.name} »`,
            detail: `membre ${p.type} — rôle ${p.role}`,
            auto: Boolean(estCible),
            quoiFaire: estCible
              ? "AUTOMATIQUE — « detach » retire cette permission du Drive partagé configuré (permissions.delete)."
              : "MANUEL — ce Drive partagé n'est pas celui de config.json ; la trousse n'y touche jamais. " +
                `Console : drive.google.com > Drive partagés > « ${d.name} » > Gérer les membres.`,
          });
        }
      }
    }

    // Honnêteté : si une lecture a échoué, on ne peut PAS conclure « c'est propre ».
    /** @type {string[]} */ const zonesNonBalayees = [];
    if (!resCompte.ok) zonesNonBalayees.push("l'adresse secondaire du compte client");
    if (!resUsagers.ok) {
      zonesNonBalayees.push('les adresses de récupération, adresses secondaires et alias des usagers');
    }
    if (!resGroupes.ok) zonesNonBalayees.push('les appartenances aux groupes');
    for (const [courriel, info] of membresParGroupe) {
      if (info.erreur) zonesNonBalayees.push(`les membres du groupe ${courriel}`);
    }
    if (!resCalendriers.ok) zonesNonBalayees.push("les règles d'accès des calendriers");
    for (const c of calendriersAnalyses) {
      if (c.aclErreur) zonesNonBalayees.push(`les règles d'accès du calendrier « ${c.summary} »`);
    }
    for (const nom of calendriersNonBalayes) zonesNonBalayees.push(`les partages du calendrier ${nom}`);
    if (!resDrives.ok) zonesNonBalayees.push('les membres des Drive partagés');
    if (resDrives.ok && !driveAdminAccess) {
      zonesNonBalayees.push(
        `les Drive partagés dont ${config.adminEmail} n'est pas membre (privilège administrateur Drive absent)`,
      );
    }
    for (const d of drivesPartages) {
      if (membresParDrive.get(d.id)?.erreur) zonesNonBalayees.push(`les membres du Drive partagé « ${d.name} »`);
    }

    if (occurrences.length === 0 && zonesNonBalayees.length === 0) {
      log.ok(
        `L'adresse ${config.personalEmail} n'apparaît nulle part dans ce que l'API peut voir : ` +
          "annuaire, groupes, partages de calendriers et membres des Drive partagés ont tous été lus.",
      );
      log.info(
        "Une limite demeure, quoi qu'il arrive : Google ne sait lister que les calendriers auxquels " +
          `${config.adminEmail} est abonné. Un agenda oublié, auquel ce compte n'est pas abonné, n'apparaît ` +
          "dans aucune liste. Et surtout, la FACTURATION n'a aucune API : elle se vérifie à la main " +
          '(voir les angles morts ci-dessous).',
      );
    } else if (occurrences.length === 0) {
      log.warn(
        `Aucune occurrence trouvée, MAIS le balayage est incomplet : ${zonesNonBalayees.join(', ')} ` +
          "n'ont pas pu être lus. On ne peut donc pas conclure que l'adresse est complètement détachée.",
      );
      warnings.push(
        `Balayage de ${config.personalEmail} incomplet : ${zonesNonBalayees.length} zone(s) illisible(s).`,
      );
    } else {
      log.warn(`${occurrences.length} occurrence(s) trouvée(s).`);
      log.table(
        occurrences.map((o, i) => ({
          '#': String(i + 1),
          Où: couper(o.lieu, 42),
          Quoi: couper(o.detail, 46),
          Retrait: o.auto ? 'AUTOMATIQUE' : 'MANUEL',
        })),
      );
      occurrences.forEach((o, i) => {
        log.info(`${i + 1}. ${o.lieu} — ${o.detail}`);
        if (o.auto) log.info(`   ${o.quoiFaire}`);
        else log.warn(`   ${o.quoiFaire}`);
      });

      const auto = occurrences.filter((o) => o.auto).length;
      const manuel = occurrences.length - auto;
      if (auto > 0) {
        aFaire.push({
          p: 2,
          t:
            `${auto} occurrence(s) retirable(s) par la trousse : lancer « node src/cli.mjs detach » (simulation) ` +
            'pour lire le plan, puis « node src/cli.mjs detach --apply ».',
        });
      }
      if (manuel > 0) {
        aFaire.push({ p: 2, t: `${manuel} occurrence(s) à retirer À LA MAIN — voir les chemins de console ci-dessus.` });
      }
      warnings.push(
        `${config.personalEmail} apparaît encore à ${occurrences.length} endroit(s) visibles par l'API.`,
      );
    }

    if (zonesNonBalayees.length > 0 && occurrences.length > 0) {
      log.warn(
        `Balayage INCOMPLET : ${zonesNonBalayees.join(', ')} n'ont pas pu être lus. ` +
          "Il peut donc rester d'autres occurrences, en plus de celles listées.",
      );
      warnings.push(
        `Balayage de ${config.personalEmail} incomplet : ${zonesNonBalayees.length} zone(s) illisible(s).`,
      );
    }
  }

  log.step("Ce que l'API ne voit PAS et ne peut PAS changer");
  log.info(
    'Les endroits suivants échappent complètement au script : aucune API cliente ne les expose. ' +
      "Ils se règlent à la main, dans l'ordre, et c'est là que se cachent les vrais risques.",
  );
  for (const angle of ANGLES_MORTS) {
    log.info(`• ${angle.titre}`);
    log.info(`    Pourquoi : ${angle.pourquoi}`);
    log.info(`    Chemin   : ${angle.chemin}`);
    log.info(`    À savoir : ${angle.note}`);
  }
  log.info(
    "Règle d'or pour tous ces changements : AJOUTER la nouvelle adresse, la VÉRIFIER (courriel de " +
      "confirmation cliqué), la PROMOUVOIR, et seulement APRÈS retirer l'ancienne. Jamais « supprimer puis remplacer ».",
  );

  /* ---------------------------------------------------------------- *
   * SECTION 4 — Groupes
   * ---------------------------------------------------------------- */

  log.banner('4. Les groupes');

  if (!resGroupes.ok) {
    log.warn("Les groupes n'ont pas pu être lus.");
  } else if (groupes.length === 0) {
    log.info('Aucun groupe dans le domaine.');
  } else {
    log.table(
      groupes.map((g) => ({
        Adresse: g.email,
        Nom: couper(g.name ?? '—', 30),
        Membres: String(g.directMembersCount ?? '?'),
        'Créé par un admin': ouiNon(g.adminCreated),
      })),
    );
    for (const g of groupes) {
      const info = membresParGroupe.get(lower(g.email));
      if (!info) continue;
      if (info.erreur) {
        log.warn(`${g.email} — membres illisibles : ${info.erreur}`);
        continue;
      }
      if (info.membres.length === 0) {
        log.info(`${g.email} — aucun membre.`);
        continue;
      }
      log.info(
        `${g.email} — ${info.membres
          .map((m) => `${m.email} (${m.role ?? 'MEMBER'}${lower(m.email).endsWith(`@${domaine}`) ? '' : ', EXTERNE'})`)
          .join(', ')}`,
      );
    }
    unchanged.push(`${groupes.length} groupe(s) existant(s)`);
  }

  // Le groupe d'équipe de la config
  if (groupeVoulu) {
    const attendu = lower(groupeVoulu);
    const trouve = groupes.find((g) => lower(g.email) === attendu) ?? null;
    if (!trouve && !resGroupes.ok) {
      // La liste des groupes n'a PAS pu être lue : « absent » et « illisible »
      // ne sont pas la même chose. Conseiller une création ici pourrait faire
      // écraser les réglages d'un groupe qui existe déjà.
      log.warn(
        `Impossible de dire si le groupe « ${groupeVoulu} » existe : la lecture des groupes a échoué. ` +
          "Ne lance PAS « group --apply » avant d'avoir vérifié à la main.",
      );
      aFaire.push({
        p: 2,
        t:
          `Vérifier à la main si le groupe ${groupeVoulu} existe (Annuaire > Groupes), puis corriger le droit ` +
          "de lecture manquant. L'audit n'a pas pu le déterminer.",
      });
    } else if (!trouve) {
      log.warn(`Le groupe d'équipe « ${groupeVoulu} » n'existe pas encore.`);
      aFaire.push({
        p: 3,
        t: `Créer le groupe d'équipe ${groupeVoulu} : node src/cli.mjs group --apply`,
      });
    } else {
      const info = membresParGroupe.get(attendu);
      const membres = info?.membres ?? [];
      const presents = new Set(membres.map((m) => lower(m.email)));
      const absents = equipe.filter((m) => !presents.has(lower(m.email)));
      if (absents.length > 0) {
        log.warn(
          `${absents.length} personne(s) de l'équipe ne sont pas dans ${groupeVoulu} : ` +
            absents.map((m) => m.email).join(', '),
        );
        aFaire.push({
          p: 3,
          t: `Ajouter au groupe ${groupeVoulu} : ${absents.map((m) => m.email).join(', ')} — node src/cli.mjs group --apply`,
        });
      } else if (membres.length > 0) {
        log.ok(`Le groupe ${groupeVoulu} contient bien les ${equipe.length} personne(s) de l'équipe.`);
      }
      unchanged.push(`Groupe ${groupeVoulu} — ${membres.length} membre(s)`);

      const externes = membres.filter((m) => !lower(m.email).endsWith(`@${domaine}`));
      if (externes.length > 0) {
        log.warn(
          `Le groupe ${groupeVoulu} contient ${externes.length} membre(s) EXTERNE(S) au domaine : ` +
            externes.map((m) => m.email).join(', '),
        );
        warnings.push(`Membres externes dans ${groupeVoulu} : ${externes.map((m) => m.email).join(', ')}`);
      }
    }

    if (reglagesGroupe) {
      log.info(
        `Réglages de ${groupeVoulu} — qui peut joindre : ${tiret(reglagesGroupe.whoCanJoin)} · ` +
          `qui peut publier : ${tiret(reglagesGroupe.whoCanPostMessage)} · ` +
          `qui voit les membres : ${tiret(reglagesGroupe.whoCanViewMembership)} · ` +
          `membres externes permis : ${tiret(reglagesGroupe.allowExternalMembers)}`,
      );
      // Rappel : dans cette API, TOUS les booléens sont des CHAÎNES ('true'/'false').
      if (lower(reglagesGroupe.allowExternalMembers) === 'true') {
        log.warn(
          `${groupeVoulu} accepte des membres externes au domaine. Pour un groupe interne, ce devrait ` +
            'être « false ».',
        );
        aFaire.push({
          p: 4,
          t: `Interdire les membres externes sur ${groupeVoulu} : node src/cli.mjs group --apply`,
        });
      }
      if (lower(reglagesGroupe.whoCanJoin) === 'anyone_can_join') {
        log.warn(`${groupeVoulu} peut être rejoint par n'importe qui sur Internet. À corriger.`);
        aFaire.push({ p: 1, t: `Restreindre l'adhésion au groupe ${groupeVoulu} (whoCanJoin = INVITED_CAN_JOIN).` });
      }
      if (lower(reglagesGroupe.whoCanPostMessage) === 'anyone_can_post') {
        log.warn(
          `N'importe qui sur Internet peut écrire à ${groupeVoulu} sans être membre. C'est une porte ouverte ` +
            'au pourriel, et les messages arrivent dans la boîte de toute l\'équipe.',
        );
        aFaire.push({
          p: 2,
          t: `Restreindre l'envoi de messages au groupe ${groupeVoulu} (whoCanPostMessage = ALL_MEMBERS_CAN_POST) : node src/cli.mjs group --apply`,
        });
      }
      if (lower(reglagesGroupe.whoCanViewGroup) === 'anyone_can_view') {
        log.warn(
          `Les archives de ${groupeVoulu} sont visibles par n'importe qui sur Internet : tout ce qui a été ` +
            'échangé dans ce groupe est public.',
        );
        aFaire.push({
          p: 1,
          t: `Rendre les archives du groupe ${groupeVoulu} privées (whoCanViewGroup = ALL_MEMBERS_CAN_VIEW) : node src/cli.mjs group --apply`,
        });
      }
    }
  } else {
    log.info(
      "Aucun groupe d'équipe n'est configuré (« group » à null) : les accès sont accordés directement aux " +
        '4 adresses. C\'est valide, mais chaque arrivée ou départ demandera de repasser dans chaque ressource.',
    );
  }

  /* ---------------------------------------------------------------- *
   * SECTION 5 — Calendriers
   * ---------------------------------------------------------------- */

  log.banner('5. Les calendriers');

  if (!resCalendriers.ok) {
    log.warn("La liste des calendriers n'a pas pu être lue.");
  } else if (calendriersVoulus.length === 0) {
    log.info('Aucun calendrier configuré dans config.json.');
  } else {
    log.table(
      calendriersAnalyses.map((c) => ({
        Clé: c.key,
        Nom: couper(c.summary, 34),
        Existe: ouiNon(c.existe),
        Fuseau: tiret(c.timeZone),
        'Règles d\'accès': c.aclErreur ? 'illisibles' : String(c.acl.length),
      })),
    );

    for (const c of calendriersAnalyses) {
      if (!c.existe && !c.lectureFiable) {
        // Une lecture a échoué : on ne conclut pas. Créer un calendrier qui
        // existe déjà en produirait un DEUXIÈME du même nom — Google l'autorise.
        log.warn(
          `Impossible de dire si le calendrier « ${c.summary} » existe : ` +
            `${c.cacheErreur ?? "la liste des calendriers n'a pas pu être lue"}. ` +
            "Ne lance PAS « calendar --apply » avant d'avoir vérifié dans Google Agenda.",
        );
        aFaire.push({
          p: 2,
          t:
            `Vérifier à la main dans Google Agenda si le calendrier « ${c.summary} » existe déjà. ` +
            "L'audit n'a pas pu le déterminer, et créer un doublon est possible.",
        });
        continue;
      }
      if (!c.existe) {
        log.warn(
          `Le calendrier « ${c.summary} » n'apparaît pas dans les agendas de ${config.adminEmail}.`,
        );
        log.info(
          "   À savoir : Google ne liste que les agendas AUXQUELS ce compte est abonné. Un calendrier peut " +
            "exister sans y figurer. Si tu sais qu'il existe déjà, ouvre-le une fois dans Google Agenda avant " +
            "de lancer « calendar --apply », sinon un deuxième calendrier du même nom sera créé.",
        );
        aFaire.push({ p: 3, t: `Créer le calendrier « ${c.summary} » : node src/cli.mjs calendar --apply` });
        continue;
      }

      log.info(`« ${c.summary} » — id ${c.id} (retrouvé par : ${c.source})`);
      if (c.ambigus.length > 1) {
        log.warn(
          `Plusieurs calendriers portent le nom « ${c.summary} » : ${c.ambigus.join(', ')}. ` +
            'Google autorise les doublons — supprimer les copies inutiles à la main dans Google Agenda.',
        );
      }

      // Comparaison de fuseau : Google normalise America/Montreal en America/Toronto.
      if (c.timeZone && c.attenduTz && canonTz(c.timeZone) !== canonTz(c.attenduTz)) {
        log.warn(
          `Fuseau du calendrier « ${c.summary} » : ${c.timeZone}, alors que config.json demande ${c.attenduTz}.`,
        );
        aFaire.push({ p: 4, t: `Corriger le fuseau du calendrier « ${c.summary} » : node src/cli.mjs calendar --apply` });
      }

      if (c.aclErreur) {
        log.warn(`Règles d'accès illisibles : ${c.aclErreur}`);
        continue;
      }

      log.table(
        c.acl.map((r) => ({
          Portée: `${r.scope?.type ?? '?'}${r.scope?.value ? `:${r.scope.value}` : ''}`,
          Rôle: tiret(r.role),
          Identifiant: couper(r.id ?? '—', 44),
        })),
      );

      // Le rôle accordé à l'équipe correspond-il à celui demandé dans
      // config.json ? Sans ce contrôle, un calendrier partagé en simple
      // lecture passait pour conforme alors que config.json demande « writer ».
      if (c.attenduRole) {
        /** @type {Set<string>} */
        const rolesEquipe = new Set();
        for (const r of c.acl) {
          if (!r.role || r.role === 'none') continue;
          const type = r.scope?.type;
          const valeur = lower(r.scope?.value);
          const viseEquipe =
            (groupeVoulu && type === 'group' && valeur === lower(groupeVoulu)) ||
            (type === 'domain' && valeur === domaine) ||
            (type === 'user' && equipe.some((m) => lower(m.email) === valeur));
          if (viseEquipe) rolesEquipe.add(r.role);
        }
        if (rolesEquipe.size > 0 && !rolesEquipe.has(c.attenduRole)) {
          log.warn(
            `L'équipe a le rôle « ${[...rolesEquipe].join(' / ')} » sur « ${c.summary} », alors que ` +
              `config.json demande « ${c.attenduRole} ».`,
          );
          log.info(
            "   Pour mémoire : « reader » = voir seulement · « writer » = ajouter et modifier des événements · " +
              '« owner » = peut en plus supprimer le calendrier et changer les accès.',
          );
          aFaire.push({
            p: 4,
            t: `Corriger le niveau d'accès de l'équipe au calendrier « ${c.summary} » : node src/cli.mjs calendar --apply`,
          });
        }
      }

      const publique = c.acl.find((r) => r.scope?.type === 'default' && r.role && r.role !== 'none');
      if (publique) {
        log.warn(
          `« ${c.summary} » est PUBLIC : la règle « default » donne le rôle « ${publique.role} » à n'importe ` +
            'quel internaute, connecté ou non. À retirer sauf intention explicite.',
        );
        aFaire.push({
          p: 1,
          t: `Retirer l'accès public du calendrier « ${c.summary} » (règle « default »). Google Agenda > Paramètres du calendrier > Autorisations d'accès.`,
        });
      }

      // L'équipe a-t-elle bien accès ?
      const portees = new Set(
        c.acl.filter((r) => r.role && r.role !== 'none').map((r) => `${r.scope?.type}:${lower(r.scope?.value)}`),
      );
      const viaGroupe = groupeVoulu ? portees.has(`group:${lower(groupeVoulu)}`) : false;
      const viaDomaine = portees.has(`domain:${domaine}`);
      const sansAcces = equipe.filter((m) => !aAcces(m.email, portees, viaGroupe, viaDomaine));
      if (sansAcces.length > 0) {
        log.warn(
          `${sansAcces.length} personne(s) n'ont pas accès à « ${c.summary} » : ` +
            sansAcces.map((m) => m.email).join(', '),
        );
        aFaire.push({
          p: 3,
          t: `Accorder l'accès au calendrier « ${c.summary} » à : ${sansAcces.map((m) => m.email).join(', ')} — node src/cli.mjs calendar --apply`,
        });
      } else {
        unchanged.push(`Calendrier « ${c.summary} » — ${c.acl.length} règle(s) d'accès`);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * SECTION 6 — Drive partagés
   * ---------------------------------------------------------------- */

  log.banner('6. Les Drive partagés');
  log.info(
    "Rappel : seuls les Drive PARTAGÉS sont listés. Aucun « Mon Drive », aucun fichier personnel n'est lu.",
  );

  if (!resDrives.ok && drivesPartages.length === 0) {
    log.warn("La liste des Drive partagés n'a pas pu être lue.");
  } else if (drivesPartages.length === 0) {
    log.info('Aucun Drive partagé visible.');
  } else {
    if (!resDrives.ok) {
      log.warn(
        "La liste complète des Drive partagés n'a pas pu être lue. Seul le Drive retrouvé grâce au cache " +
          'local est affiché ci-dessous : il en existe peut-être d\'autres.',
      );
    }
    log.info(
      `${drivesPartages.length} Drive partagé(s) — vue ${driveAdminAccess ? 'administrateur de domaine (complète)' : 'limitée aux Drive dont ' + config.adminEmail + ' est membre'}.`,
    );
    log.table(
      drivesPartages.map((d) => ({
        Nom: couper(d.name ?? '—', 34),
        // Jamais tronqué : un identifiant coupé est un identifiant faux, et
        // c'est exactement ce qu'on recopie dans une URL ou dans config.json.
        Identifiant: tiret(d.id),
        'Créé le': formatDate(d.createdTime, tz),
        Membres: membresParDrive.get(d.id)?.erreur ? 'illisibles' : String(membresParDrive.get(d.id)?.permissions.length ?? 0),
        Cible: driveCible && d.id === driveCible.id ? 'oui' : '',
      })),
    );

    for (const d of drivesPartages) {
      const info = membresParDrive.get(d.id);
      log.info(`« ${d.name} » (${d.id})`);
      if (info?.erreur) {
        log.warn(`   Membres illisibles : ${info.erreur}`);
      } else if ((info?.permissions.length ?? 0) === 0) {
        log.warn(
          "   Aucun membre lisible. Un Drive partagé sans gestionnaire est ingérable : seul un administrateur " +
            'de domaine peut le récupérer.',
        );
      } else {
        log.table(
          info.permissions.map((p) => ({
            Type: tiret(p.type),
            Adresse: tiret(p.emailAddress ?? p.domain ?? (p.type === 'anyone' ? "n'importe qui" : '—')),
            Rôle: tiret(p.role),
            Nom: couper(p.displayName ?? '—', 24),
          })),
        );
        const ouvert = info.permissions.filter((p) => p.type === 'anyone');
        if (ouvert.length > 0) {
          log.warn(`   « ${d.name} » est accessible à N'IMPORTE QUI sur Internet. À corriger tout de suite.`);
          aFaire.push({
            p: 1,
            t: `Retirer le partage public du Drive partagé « ${d.name} » (drive.google.com > Drive partagés > Gérer les membres).`,
          });
        }
        const domainesEtrangers = info.permissions.filter((p) => p.type === 'domain' && lower(p.domain) !== domaine);
        if (domainesEtrangers.length > 0) {
          log.warn(
            `   « ${d.name} » est partagé avec un autre domaine : ` +
              domainesEtrangers.map((p) => p.domain).join(', '),
          );
        }
        const organisateurs = info.permissions.filter((p) => p.role === 'organizer');
        if (organisateurs.length === 0) {
          log.warn(`   « ${d.name} » n'a aucun gestionnaire (rôle « organizer »). C'est un Drive orphelin en devenir.`);
        }
      }
    }

    if (driveCible) unchanged.push(`Drive partagé « ${driveCible.name} » (${driveCible.id})`);
  }

  if (!driveConfigure) {
    log.info(
      "Aucun Drive partagé n'est décrit dans config.json (champ « sharedDrive »). Rien à comparer : " +
        "l'audit ne propose donc aucune création.",
    );
  } else if (!driveCible && !resDrives.ok) {
    /*
     * DANGER DE DOUBLON. La lecture des Drive partagés a ÉCHOUÉ : on ne sait
     * pas si « nomDriveVoulu » existe. Or Google autorise deux Drive partagés
     * du même nom et `drives.create` ne déduplique pas par nom. Conseiller une
     * création ici, c'est risquer un deuxième Drive à moitié rempli, que
     * personne ne remarquera avant que des fichiers y aient été déposés.
     */
    log.warn(
      `Impossible de dire si le Drive partagé « ${nomDriveVoulu} » existe : la lecture a échoué. ` +
        "Ne lance PAS « drive --apply » : Google accepte deux Drive partagés du même nom, et le doublon " +
        "ne se répare qu'à la main.",
    );
    aFaire.push({
      p: 2,
      t:
        `Vérifier à la main dans drive.google.com > Drive partagés si « ${nomDriveVoulu} » existe déjà, ` +
        "puis relancer l'audit. L'audit n'a pas pu le déterminer.",
    });
  } else if (!driveCible && !driveAdminAccess) {
    log.warn(
      `Le Drive partagé « ${nomDriveVoulu} » n'est pas visible depuis ${config.adminEmail}, mais la vue est ` +
        "PARTIELLE : ce compte n'a pas le privilège « administrateur Drive » et ne voit que les Drive dont il " +
        "est membre. Le Drive peut donc exister sans apparaître ici.",
    );
    aFaire.push({
      p: 2,
      t:
        `Avant de créer quoi que ce soit : vérifier dans drive.google.com > Drive partagés si « ${nomDriveVoulu} » ` +
        `existe déjà, ou donner à ${config.adminEmail} le privilège d'administrateur Drive (Console d'admin > ` +
        "Rôles d'administrateur). Sans ça, « drive --apply » risque de créer un DOUBLON.",
    });
  } else if (!driveCible) {
    log.warn(`Le Drive partagé « ${nomDriveVoulu} » de config.json n'existe pas encore.`);
    aFaire.push({ p: 3, t: `Créer le Drive partagé « ${nomDriveVoulu} » : node src/cli.mjs drive --apply` });
  } else {
    const attendues = config.sharedDrive?.restrictions ?? {};
    const actuelles = driveCible.restrictions ?? {};
    const ecarts = [];
    for (const [cle, voulu] of Object.entries(attendues)) {
      if (typeof voulu !== 'boolean') continue;
      const actuel = actuelles[cle];
      if (actuel !== voulu) {
        ecarts.push({
          Restriction: RESTRICTION_LABELS[cle] ?? cle,
          Voulu: ouiNon(voulu),
          Actuel: actuel === undefined ? 'non défini' : ouiNon(actuel),
        });
      }
    }
    log.info(`Restrictions du Drive partagé « ${driveCible.name} » :`);
    if (ecarts.length === 0) {
      log.ok('Toutes les restrictions demandées sont en place.');
    } else {
      log.table(ecarts);
      aFaire.push({
        p: 4,
        t: `${ecarts.length} restriction(s) du Drive partagé « ${driveCible.name} » ne correspondent pas à config.json : node src/cli.mjs drive --apply`,
      });
    }

    // L'équipe a-t-elle accès au Drive partagé ?
    const infoCible = membresParDrive.get(driveCible.id);
    if (infoCible && !infoCible.erreur) {
      const acces = new Set(
        infoCible.permissions.map((p) => `${p.type}:${lower(p.emailAddress ?? p.domain ?? 'anyone')}`),
      );
      const viaGroupe = groupeVoulu ? acces.has(`group:${lower(groupeVoulu)}`) : false;
      const viaDomaine = acces.has(`domain:${domaine}`);
      const sansAcces = equipe.filter((m) => !aAcces(m.email, acces, viaGroupe, viaDomaine));
      if (sansAcces.length > 0) {
        log.warn(
          `${sansAcces.length} personne(s) n'ont pas accès au Drive partagé : ` + sansAcces.map((m) => m.email).join(', '),
        );
        aFaire.push({
          p: 3,
          t: `Donner accès au Drive partagé à : ${sansAcces.map((m) => m.email).join(', ')} — node src/cli.mjs drive --apply`,
        });
      }
    }
    log.info(
      "L'audit ne liste volontairement aucun dossier ni fichier. Pour vérifier l'arborescence du Drive " +
        'partagé : node src/cli.mjs verify',
    );
  }

  /* ---------------------------------------------------------------- *
   * SECTION 7 — Diagnostic final
   * ---------------------------------------------------------------- */

  log.banner('7. Diagnostic — ce qui reste à faire');

  // Rappels systématiques : l'API ne peut ni les voir ni les régler.
  aFaire.push({
    p: 2,
    t:
      "Vérifier les CONTACTS DE FACTURATION à la main (aucune API) : Facturation > Comptes de paiement > ⋮ > " +
      "Afficher les paramètres de paiement > Contacts de paiement. Ajouter l'adresse du domaine, cliquer le " +
      "courriel de vérification, la promouvoir contact principal, PUIS retirer l'ancienne.",
  });
  aFaire.push({
    p: 2,
    t:
      "Vérifier l'interrupteur « Récupération du compte super-administrateur » : Sécurité > Authentification > " +
      "Récupération du compte. Il est DÉSACTIVÉ par défaut sur plusieurs éditions (dont Business Plus).",
  });
  aFaire.push({
    p: 3,
    t:
      "Passer l'outil de transfert pour les utilisateurs non gérés (Annuaire > Utilisateurs > Plus d'options) " +
      "afin de détecter un compte Google personnel créé avec une adresse @" + config.domain + " avant Workspace.",
  });

  const vus = new Set();
  const liste = aFaire
    .filter((item) => {
      const cle = `${item.p}|${item.t}`;
      if (vus.has(cle)) return false;
      vus.add(cle);
      return true;
    })
    .sort((a, b) => a.p - b.p);

  if (liste.length === 0) {
    log.ok("Rien à signaler : tout ce que l'API peut voir est conforme à config.json.");
  } else {
    // La légende AVANT la liste : elle ne sert à rien une fois qu'on a fini de
    // lire les points, et ce classement est un choix de la trousse, pas une
    // règle de Google — autant le dire.
    log.info('Ordre de priorité (classement propre à cette trousse, du plus grave au moins grave) :');
    log.info("  P1 — risque de PERDRE L'ACCÈS au compte : à régler en premier, avant tout le reste.");
    log.info('  P2 — adresse personnelle encore rattachée, et facturation.');
    log.info('  P3 — ressources manquantes (groupe, calendrier, Drive partagé).');
    log.info('  P4 — réglages fins de conformité.');
    log.blank?.();
    for (const item of liste) log.info(`[P${item.p}] ${item.t}`);
  }

  log.step('Rappel');
  log.info("Cet audit n'a RIEN modifié. Prochaine étape logique :");
  log.info('  1. node src/cli.mjs setup           (simulation de la mise en place)');
  log.info('  2. node src/cli.mjs setup --apply   (exécution)');
  log.info('  3. node src/cli.mjs detach          (simulation du détachement de l\'adresse personnelle)');

  return { created: [], updated: [], unchanged, warnings };
}

/**
 * Normalise un fuseau horaire : America/Montreal est un simple alias déprécié
 * d'America/Toronto, et Google le réécrit silencieusement. Sans normalisation,
 * on signalerait un écart qui n'existe pas.
 */
function canonTz(tz) {
  try {
    return new Intl.DateTimeFormat('fr-CA', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return String(tz ?? '');
  }
}

export default { meta, run };
