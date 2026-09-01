/**
 * drive.mjs — Commande « drive » : le Drive partagé de l'équipe.
 *
 * Ce que la commande fait, dans l'ordre :
 *
 *   1. retrouve OU crée le Drive partagé décrit dans config.sharedDrive ;
 *   2. applique les restrictions de partage (qui peut voir, copier, partager) ;
 *   3. inscrit les membres : le GROUPE d'équipe si un groupe est configuré,
 *      sinon chacune des adresses de config.team ;
 *   4. bâtit l'arborescence de dossiers, sans jamais créer de doublon ;
 *   5. dépose à la racine un mode d'emploi (Google Doc) qui explique où va
 *      quoi — c'est ce qui fait que le classement tient dans le temps.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ EXIGENCE NUMÉRO UN DU CLIENT : on ne touche JAMAIS au « Mon Drive »  │
 * │                                                                      │
 * │ La trousse ne déplace aucun fichier existant, n'en copie aucun et    │
 * │ n'en partage aucun. Elle ne fait que CRÉER des dossiers neufs À      │
 * │ L'INTÉRIEUR du Drive partagé qu'elle vient de créer ou de retrouver. │
 * │                                                                      │
 * │ Deux pièges rendent l'accident possible chez Google, et les deux     │
 * │ sont bouchés ici :                                                   │
 * │                                                                      │
 * │  1. files.create SANS « parents » dépose le fichier directement dans │
 * │     le « Mon Drive » personnel du compte utilisé — silencieusement,  │
 * │     sans erreur. → toute écriture passe par safeCreateFile(), qui    │
 * │     refuse un parent vide.                                           │
 * │                                                                      │
 * │  2. files.list interroge par défaut le « Mon Drive » (corpora vaut   │
 * │     « user »). On croit chercher dans le Drive partagé, on ne trouve │
 * │     rien, et le code « idempotent » recrée tout à chaque exécution.  │
 * │     → toute lecture passe par listFilesInSharedDrive(), qui impose   │
 * │     les quatre paramètres obligatoires.                              │
 * │                                                                      │
 * │ Et par-dessus tout ça : assertInSharedDrive() (plus bas) relit le    │
 * │ champ driveId de CHAQUE élément avant et après écriture. Si un       │
 * │ élément n'appartient pas au Drive partagé visé, la commande s'arrête │
 * │ net avec un message explicite plutôt que d'y toucher.                │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Idempotence : relancer la commande dix fois donne exactement le même
 * résultat qu'une seule fois. Rien n'est jamais créé en double.
 *
 * Prudence : la commande AJOUTE et AJUSTE, elle ne fait pas le ménage à la
 * place de l'humain. Elle ne supprime aucun dossier, ne retire aucun membre
 * et ne rétrograde jamais quelqu'un qui a plus d'accès que prévu.
 */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  getClients,
  withRetry,
  collectPages,
  isNotFound,
  isConflict,
  isForbidden,
  explainGoogleError,
  errorInfo,
  assertInSharedDrive as assertFileBelongsToDrive,
} from '../lib/google.mjs';
import { SCOPES } from '../lib/auth.mjs';
import { setStateKey, getStateKey } from '../lib/state.mjs';
import { flattenFolders } from '../lib/config.mjs';

export const meta = {
  name: 'drive',
  summary:
    "Crée le Drive partagé de l'équipe, applique les restrictions de partage, inscrit les membres, " +
    "bâtit l'arborescence de dossiers et dépose le mode d'emploi du classement. " +
    'Ne touche jamais aux documents personnels.',
};

/* ================================================================== *
 * Constantes d'API
 * ================================================================== */

/**
 * Portées demandées. La portée large « drive » est la SEULE que Google accepte
 * pour drives.create et drives.update : « drive.file » ne suffit pas, même
 * s'il couvrirait la création de dossiers. C'est exactement la liste inscrite
 * dans la délégation à l'échelle du domaine (commande « scopes »).
 */
const DRIVE_SCOPES = SCOPES.drive;

/** Type MIME d'un dossier Drive. */
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Type MIME d'un document Google Docs (la CIBLE de la conversion du mode d'emploi). */
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

/**
 * Plafonds de pagination. Attention : drives.list renvoie 10 éléments par
 * défaut, pas 100. Oublier de le préciser fait rater des Drives en silence,
 * et donc recréer un doublon.
 */
const DRIVES_PAGE_SIZE = 100; // maximum accepté par drives.list
const PERMISSIONS_PAGE_SIZE = 100; // maximum accepté par permissions.list
const FILES_PAGE_SIZE = 100;

/** Masques `fields` explicites : on ne rapatrie que ce qu'on utilise. */
const RESTRICTION_FIELDS = [
  'adminManagedRestrictions',
  'copyRequiresWriterPermission',
  'domainUsersOnly',
  'driveMembersOnly',
  'sharingFoldersRequiresOrganizerPermission',
].join(',');

const CAPABILITY_FIELDS = [
  'canChangeDomainUsersOnlyRestriction',
  'canChangeDriveMembersOnlyRestriction',
  'canChangeCopyRequiresWriterPermissionRestriction',
  'canChangeSharingFoldersRequiresOrganizerPermissionRestriction',
  'canAddChildren',
  'canManageMembers',
].join(',');

const DRIVE_FIELDS = `id,name,createdTime,restrictions(${RESTRICTION_FIELDS}),capabilities(${CAPABILITY_FIELDS})`;
const DRIVE_LIST_FIELDS = `nextPageToken,drives(id,name,createdTime,restrictions(${RESTRICTION_FIELDS}))`;
const PERMISSION_LIST_FIELDS =
  'nextPageToken,permissions(id,type,role,emailAddress,domain,deleted,permissionDetails(role,permissionType,inherited))';
const PERMISSION_FIELDS = 'id,type,role,emailAddress,domain';

/**
 * Masque minimal de TOUT fichier lu ou créé. `driveId` en fait partie
 * OBLIGATOIREMENT : c'est le seul champ qui permet de distinguer un élément
 * d'un Drive partagé d'un élément du « Mon Drive » personnel. Sans lui dans le
 * masque, Google ne le renvoie pas, la garde de sécurité lit `undefined` et
 * croit à tort avoir affaire à un document personnel (ou pire, on oublie de la
 * poser du tout).
 */
const FILE_FIELDS = 'id,name,mimeType,driveId,parents,trashed,webViewLink';

/** Nom exact du mode d'emploi déposé à la racine. Les « 000 » le font passer en premier. */
const README_NAME = '000 — LISEZ-MOI — Comment on range nos affaires';

/** Convention de nommage des fichiers, répétée dans le mode d'emploi et dans la console. */
const NAMING_CONVENTION = 'AAAA-MM-JJ — Type — Sujet';

/**
 * Rôles Drive, du plus petit au plus grand. Sert à ne JAMAIS rétrograder
 * quelqu'un qui a déjà plus d'accès que ce que config.json demande : on ajoute
 * et on rehausse, on n'enlève pas.
 */
const ROLE_RANK = { reader: 1, commenter: 2, writer: 3, fileOrganizer: 4, organizer: 5 };

/** Traduction des rôles Drive, pour les messages destinés à un non-programmeur. */
const ROLE_LABELS = {
  organizer: 'gestionnaire — ajoute des membres, crée, déplace et supprime tout',
  fileOrganizer: 'gestionnaire de contenu — crée, modifie et supprime les fichiers, sans gérer les membres',
  writer: 'contributeur — crée et modifie les fichiers',
  commenter: 'commentateur — lit et commente',
  reader: 'lecteur — lit seulement',
};

/** Traduction des restrictions, pour expliquer ce qu'on est en train de serrer. */
const RESTRICTION_LABELS = {
  domainUsersOnly: `l'accès est réservé aux comptes du domaine (aucun compte externe)`,
  driveMembersOnly: 'seuls les membres du Drive voient son contenu (pas de partage à la pièce vers un tiers)',
  copyRequiresWriterPermission: 'les lecteurs ne peuvent ni copier, ni imprimer, ni télécharger',
  sharingFoldersRequiresOrganizerPermission: 'seuls les gestionnaires peuvent partager un dossier',
  adminManagedRestrictions: 'seul un administrateur du domaine peut modifier ces réglages',
};

/** Capacité à vérifier avant de toucher à une restriction (quand Google en expose une). */
const RESTRICTION_CAPABILITIES = {
  domainUsersOnly: 'canChangeDomainUsersOnlyRestriction',
  driveMembersOnly: 'canChangeDriveMembersOnlyRestriction',
  copyRequiresWriterPermission: 'canChangeCopyRequiresWriterPermissionRestriction',
  sharingFoldersRequiresOrganizerPermission: 'canChangeSharingFoldersRequiresOrganizerPermissionRestriction',
  // adminManagedRestrictions : Google n'expose pas de capacité dédiée. On tente,
  // et on explique proprement si le compte n'a pas le droit.
};

/** Texte affiché à la place d'un identifiant qui n'existe pas encore (mode simulation). */
const PLANNED_ID = "(identifiant attribué par Google à la création)";

/* ================================================================== *
 * GARDE DE SÉCURITÉ — à lire avant de modifier quoi que ce soit ici
 * ================================================================== */

/**
 * GARDE DE SÉCURITÉ : refuse de toucher à un élément qui n'est pas dans le
 * Drive partagé de l'entreprise.
 *
 * POURQUOI ELLE EXISTE
 * --------------------
 * Le propriétaire ne veut SURTOUT PAS que ses documents personnels (ceux de
 * son « Mon Drive ») soient déplacés, copiés ou partagés par erreur. Un
 * identifiant périmé dans le cache local, une variable mal initialisée ou un
 * copier-coller malheureux suffirait, sans cette garde, à écrire au mauvais
 * endroit — et Google ne dirait rien, il exécuterait.
 *
 * COMMENT ELLE TRANCHE
 * --------------------
 * Un seul champ est fiable : `driveId`. Google le remplit UNIQUEMENT pour les
 * éléments qui vivent dans un Drive partagé. Un fichier du « Mon Drive »
 * personnel n'en a pas — il arrive avec driveId absent.
 *
 * Les autres champs qu'on serait tenté d'utiliser sont des pièges :
 *   - `ownedByMe` n'est PAS rempli pour les éléments d'un Drive partagé :
 *     un test « if (!fichier.ownedByMe) » se trompe silencieusement ;
 *   - `teamDriveId` est l'ancien nom, déprécié, et n'est plus garanti.
 *
 * COMMENT L'UTILISER
 * ------------------
 * Le fichier doit avoir été lu avec `driveId` dans le masque `fields`
 * (voir FILE_FIELDS). Sinon Google ne le renvoie pas, et la garde refuserait
 * un élément parfaitement légitime — ce qui est le bon sens de l'échec : on
 * bloque quand on ne sait pas, on ne devine jamais.
 *
 * @param {{ id?: string, name?: string, driveId?: string|null }} file élément lu avec FILE_FIELDS
 * @param {string} driveId identifiant du Drive partagé de l'entreprise
 * @param {{ action?: string }} [options] description de l'action, pour le message d'erreur
 * @throws {Error} message français explicite — et AUCUNE modification n'est faite
 */
export function assertInSharedDrive(file, driveId, options = {}) {
  // Le détail du message vit dans lib/google.mjs pour que toutes les commandes
  // refusent de la même façon, avec le même texte.
  assertFileBelongsToDrive(file, driveId, options);

  // Ceinture ET bretelles : un élément sans identifiant n'est pas exploitable.
  if (!file.id) {
    throw new Error(
      `REFUS DE SÉCURITÉ : Google a répondu sans identifiant pour « ${file.name ?? 'élément inconnu'} ». ` +
        "Aucune opération n'a été faite. Relancer la commande ; si ça se répète, c'est un bogue à signaler.",
    );
  }
}

/**
 * GARDE DE SÉCURITÉ (écriture) : crée un fichier ou un dossier UNIQUEMENT dans
 * le Drive partagé, jamais ailleurs.
 *
 * Rappel du piège que cette fonction bouche : chez Google, un appel
 * files.create sans « parents » ne produit pas d'erreur — il dépose le fichier
 * dans le « Mon Drive » personnel du compte utilisé. C'est comme ça que les
 * accidents arrivent en vrai. Ici, un parent vide ou multiple est refusé
 * AVANT l'appel, et l'emplacement du résultat est revérifié APRÈS.
 *
 * @param {object} params
 * @param {object} params.driveApi client Drive
 * @param {string} params.driveId Drive partagé cible
 * @param {string} params.parentId dossier parent (l'identifiant du Drive = sa racine)
 * @param {object} params.requestBody corps de la requête (sans « parents »)
 * @param {object} [params.media] contenu à téléverser, pour un document
 * @param {string} [params.label] description courte, pour les messages
 * @returns {Promise<object>} le fichier créé, dont l'emplacement a été vérifié
 */
async function safeCreateFile({ driveApi, driveId, parentId, requestBody, media, label = 'élément' }) {
  if (!driveId) {
    throw new Error(
      `REFUS DE SÉCURITÉ : aucun Drive partagé cible n'est connu, impossible de créer « ${label} ». ` +
        "C'est un bogue interne : le Drive doit être créé ou retrouvé avant toute écriture.",
    );
  }
  if (typeof parentId !== 'string' || parentId.trim() === '') {
    throw new Error(
      `REFUS DE SÉCURITÉ : « ${label} » allait être créé SANS dossier parent. Chez Google, cela le ` +
        "déposerait dans le « Mon Drive » personnel du compte utilisé, sans aucune erreur. " +
        "Rien n'a été créé.",
    );
  }

  const { data } = await withRetry(
    () =>
      driveApi.files.create({
        supportsAllDrives: true, // OBLIGATOIRE : sans ça, Drive partagé = 404
        requestBody: { ...requestBody, parents: [parentId] },
        ...(media ? { media } : {}),
        fields: FILE_FIELDS, // driveId DOIT y être : c'est ce que la garde relit
      }),
    // propagation: true — juste après la création du Drive ou d'un dossier
    // parent, Google peut répondre 404 le temps que la création se répercute.
    { tries: 4, propagation: true, label: `création de « ${label} »` },
  );

  // Vérification A POSTERIORI : si Google a déposé l'élément ailleurs que dans
  // le Drive partagé, on s'arrête net plutôt que de continuer à écrire.
  assertInSharedDrive(data, driveId, { action: `créer « ${label} »` });
  return data;
}

/* ================================================================== *
 * Petites fonctions utilitaires
 * ================================================================== */

/** Minuscules sûres, pour comparer des adresses courriel. */
function lower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Explication française d'une erreur Google, avec le contexte de l'appel. */
function explain(error, context) {
  try {
    return explainGoogleError(error, { context });
  } catch {
    return `${context} — ${error?.message ?? String(error)}`;
  }
}

/**
 * Échappe une valeur avant de l'insérer dans une requête `q` de Drive.
 * Sans ça, un nom de dossier contenant une apostrophe (« L'équipe ») casse la
 * requête — ou pire, la détourne.
 */
function escapeQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Échappe un texte destiné au HTML du mode d'emploi. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** URL cliquable d'un Drive partagé (ou d'un dossier). */
function driveUrl(id) {
  return `https://drive.google.com/drive/folders/${id}`;
}

/** Libellé français d'un rôle Drive. */
function roleLabel(role) {
  return ROLE_LABELS[role] ?? role;
}

/** Clé de comparaison d'une permission : « type:valeur ». */
function permissionKey(type, value) {
  return `${type}:${lower(value) || 'anyone'}`;
}

/**
 * Identifiant de requête STABLE pour drives.create.
 *
 * Google utilise `requestId` comme clé d'idempotence : si la création part,
 * que le réseau coupe, et qu'on rejoue le MÊME requestId, Google ne crée pas
 * un deuxième Drive. Avec un identifiant aléatoire (randomUUID), un simple
 * délai d'attente suivi d'un nouvel essai produirait DEUX Drives partagés
 * portant le même nom — Google n'impose aucune unicité de nom.
 *
 * On le dérive donc du nom du Drive (et du domaine) par SHA-256 : le même
 * config.json redonne toujours le même requestId, aujourd'hui comme dans six
 * mois, sur n'importe quelle machine, même si le cache local a été effacé.
 *
 * Le résultat est mis en forme d'UUID, la forme que Google documente.
 *
 * @param {string} name nom du Drive partagé
 * @param {string} domain domaine de l'entreprise
 * @returns {string}
 */
function stableRequestId(name, domain) {
  const hex = createHash('sha256')
    .update(`portail-gw:shared-drive:v1:${lower(domain)}:${String(name).trim()}`, 'utf8')
    .digest('hex');

  // Mise en forme 8-4-4-4-12, avec les marqueurs de version/variante d'un UUID.
  const part = (from, to) => hex.slice(from, to);
  return [
    part(0, 8),
    part(8, 12),
    `4${part(13, 16)}`,
    `${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${part(17, 20)}`,
    part(20, 32),
  ].join('-');
}

/* ================================================================== *
 * Lectures Drive — toujours bornées au Drive partagé
 * ================================================================== */

/**
 * Liste TOUS les Drive partagés visibles, en gérant la pagination.
 *
 * Deux précautions :
 *   - pageSize: 100 — le défaut de Google est 10 (!), et une page manquée
 *     ferait recréer un Drive qui existe déjà ;
 *   - on tente d'abord en accès administrateur de domaine, qui voit TOUS les
 *     Drive du domaine. Sans ce mode, on ne voit que les Drive dont le compte
 *     est déjà membre — et un Drive créé l'an dernier par quelqu'un d'autre
 *     resterait invisible, donc dupliqué.
 *
 * On filtre par nom côté client plutôt qu'avec le paramètre `q` : la plupart
 * des termes de recherche de `q` exigent l'accès administrateur, et une
 * comparaison en JavaScript est toujours juste, quel que soit le mode.
 *
 * @returns {Promise<{ drives: object[], asAdmin: boolean }>}
 */
async function listAllSharedDrives(driveApi) {
  const readAll = (useDomainAdminAccess) =>
    collectPages(
      (pageToken) =>
        driveApi.drives.list({
          pageSize: DRIVES_PAGE_SIZE,
          useDomainAdminAccess,
          pageToken,
          fields: DRIVE_LIST_FIELDS,
        }),
      { itemsKey: 'drives', label: 'lecture de la liste des Drive partagés' },
    );

  try {
    return { drives: await readAll(true), asAdmin: true };
  } catch (error) {
    if (!isForbidden(error)) throw error;
    // Le compte impersonné n'est pas administrateur Drive : vue partielle,
    // limitée aux Drive dont il est membre. C'est suffisant dans la plupart
    // des cas, mais on le signale.
    return { drives: await readAll(false), asAdmin: false };
  }
}

/**
 * Relit un Drive partagé par son identifiant. Retourne null s'il n'existe plus
 * (supprimé à la main dans l'interface de Google, par exemple).
 */
async function getSharedDriveOrNull(driveApi, driveId, asAdmin) {
  try {
    const { data } = await withRetry(
      () => driveApi.drives.get({ driveId, useDomainAdminAccess: asAdmin, fields: DRIVE_FIELDS }),
      // propagation: false — ici un 404 est une RÉPONSE (« ce Drive n'existe
      // pas »), pas une panne. Sans ça, chaque vérification négative
      // attendrait deux minutes pour rien.
      { tries: 3, propagation: false, label: `lecture du Drive partagé ${driveId}` },
    );
    return data ?? null;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (isForbidden(error) && asAdmin) {
      // Deuxième essai sans le mode administrateur : le compte est peut-être
      // simplement membre du Drive.
      return getSharedDriveOrNull(driveApi, driveId, false);
    }
    throw error;
  }
}

/**
 * Liste les fichiers d'un Drive partagé correspondant à une requête `q`.
 *
 * C'est LE SEUL point d'entrée en lecture de fichiers de cette commande. Les
 * quatre paramètres ci-dessous vont ensemble, toujours, sans exception :
 *
 *   corpora: 'drive'            → sinon Google interroge le « Mon Drive »
 *                                 personnel (c'est son défaut !) et répond
 *                                 « aucun résultat » sans la moindre erreur ;
 *   driveId                     → obligatoire dès que corpora vaut 'drive' ;
 *   includeItemsFromAllDrives   → sinon les Drive partagés sont ignorés ;
 *   supportsAllDrives           → sans lui, le paramètre précédent est inerte.
 *
 * Et par-dessus : un refiltrage côté client sur driveId, au cas où.
 */
async function listFilesInSharedDrive(driveApi, driveId, q, label) {
  if (!driveId) {
    throw new Error(
      `REFUS DE SÉCURITÉ : recherche « ${label} » demandée sans Drive partagé cible. ` +
        'Sans cet identifiant, Google chercherait dans le « Mon Drive » personnel.',
    );
  }

  const files = await collectPages(
    (pageToken) =>
      driveApi.files.list({
        q,
        corpora: 'drive',
        driveId,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        spaces: 'drive',
        pageSize: FILES_PAGE_SIZE,
        pageToken,
        orderBy: 'createdTime',
        fields: `nextPageToken,files(${FILE_FIELDS})`,
      }),
    { itemsKey: 'files', label },
  );

  // Ceinture et bretelles : on ne garde que ce qui est réellement dans le
  // Drive partagé visé, même si Google avait renvoyé autre chose.
  return files.filter((file) => file?.driveId === driveId && file?.trashed !== true);
}

/* ================================================================== *
 * 1. Le Drive partagé lui-même
 * ================================================================== */

/**
 * Retrouve ou crée le Drive partagé. Ne crée JAMAIS de doublon.
 *
 * Ordre de recherche :
 *   1. l'identifiant du cache local, revalidé via l'API (le cache peut être
 *      périmé : le Drive a pu être supprimé à la main) ;
 *   2. la recherche par NOM dans la liste des Drive partagés ;
 *   3. la création, avec un requestId stable (voir stableRequestId).
 *
 * @returns {Promise<{ drive: object|null, action: 'created'|'reused'|'planned', asAdmin: boolean }>}
 */
async function ensureSharedDrive({ driveApi, config, state, apply, log, warnings }) {
  const wantedName = config.sharedDrive.name;

  /* --- 1. Raccourci : l'identifiant connu du cache ------------------ */
  const cachedId = getStateKey(state, 'driveId', null);
  let asAdmin = true;

  if (typeof cachedId === 'string' && cachedId !== '') {
    const existing = await getSharedDriveOrNull(driveApi, cachedId, true);
    if (existing) {
      if (existing.name !== wantedName) {
        const message =
          `Le Drive partagé ${existing.id} (connu du cache local) s'appelle « ${existing.name} » alors que ` +
          `config.json demande « ${wantedName} ». La trousse continue avec CE Drive — c'est bien celui de ` +
          "l'équipe — sans le renommer. Pour changer son nom, faire le changement dans Google Drive ET " +
          'dans config.json, pour que les deux concordent.';
        log.warn(message);
        warnings.push(message);
      } else {
        log.skip(`Drive partagé « ${existing.name} » déjà créé (${existing.id}).`);
      }
      return { drive: existing, action: 'reused', asAdmin: true };
    }

    log.warn(
      `Le cache local pointait sur le Drive partagé ${cachedId}, mais il n'existe plus chez Google ` +
        '(supprimé à la main ?). On repart de la recherche par nom.',
    );
    setStateKey(state, 'driveId', null);
  }

  /* --- 2. Recherche par nom ---------------------------------------- */
  const listing = await listAllSharedDrives(driveApi);
  asAdmin = listing.asAdmin;

  if (!asAdmin) {
    const message =
      `Le compte ${config.adminEmail} n'a pas le privilège « administrateur Drive » : la trousse ne voit ` +
      "que les Drive partagés dont il est déjà membre. Si un Drive nommé « " + wantedName + " » existe " +
      "déjà mais appartient à quelqu'un d'autre, elle ne le verra pas et en créera un deuxième du même nom. " +
      'À vérifier une fois dans la console d\'administration si le doute existe.';
    log.warn(message);
    warnings.push(message);
  }

  const exact = listing.drives.filter((d) => String(d?.name ?? '').trim() === String(wantedName).trim());
  const matches =
    exact.length > 0
      ? exact
      : listing.drives.filter((d) => lower(d?.name) === lower(wantedName)); // Drive ignore la casse

  if (matches.length > 1) {
    // Google accepte parfaitement deux Drive partagés du même nom. On ne
    // devine pas : on prend toujours le même (tri par identifiant, donc stable
    // d'une exécution à l'autre) et on demande à l'humain de faire le ménage.
    const chosen = [...matches].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
    const message =
      `${matches.length} Drive partagés portent déjà le nom « ${wantedName} » (${matches
        .map((m) => m.id)
        .join(', ')}). La trousse utilise toujours le même (${chosen.id}) et n'en crée aucun autre. ` +
      'À corriger à la main : renommer ou supprimer les Drive en trop, sinon une partie de ' +
      "l'équipe risque de déposer ses documents dans le mauvais.";
    log.warn(message);
    warnings.push(message);
    setStateKey(state, 'driveId', chosen.id);
    const full = (await getSharedDriveOrNull(driveApi, chosen.id, asAdmin)) ?? chosen;
    return { drive: full, action: 'reused', asAdmin };
  }

  if (matches.length === 1) {
    const found = matches[0];
    log.skip(`Drive partagé « ${found.name} » retrouvé par son nom (${found.id}). Aucune création.`);
    setStateKey(state, 'driveId', found.id);
    const full = (await getSharedDriveOrNull(driveApi, found.id, asAdmin)) ?? found;
    return { drive: full, action: 'reused', asAdmin };
  }

  /* --- 3. Création -------------------------------------------------- */
  const requestId = stableRequestId(wantedName, config.domain);

  // Vérification préalable : ce compte a-t-il seulement le droit de créer un
  // Drive partagé ? Un compte personnel (@gmail.com) ne l'a pas, et l'option
  // peut aussi être désactivée pour l'unité organisationnelle du compte.
  await checkCanCreateDrives({ driveApi, config, log, warnings, apply });

  if (!apply) {
    log.plan(
      `Créer le Drive partagé « ${wantedName} » (identifiant de requête stable ${requestId} — ` +
        'relancer après une coupure ne créera pas de doublon).',
    );
    return { drive: null, action: 'planned', asAdmin };
  }

  log.info(`Création du Drive partagé « ${wantedName} »…`);

  try {
    const { data } = await withRetry(
      () =>
        driveApi.drives.create({
          requestId, // clé d'idempotence : STABLE, jamais régénérée entre deux essais
          // Les restrictions ne peuvent PAS être posées ici : Google les refuse
          // à la création. Elles arrivent à l'étape suivante, via drives.update.
          requestBody: { name: wantedName },
          fields: 'id,name',
        }),
      { tries: 4, propagation: false, label: `création du Drive partagé « ${wantedName} »` },
    );

    setStateKey(state, 'driveId', data.id);
    log.ok(`Drive partagé « ${data.name} » créé — identifiant ${data.id}`);
    const full = (await getSharedDriveOrNull(driveApi, data.id, asAdmin)) ?? data;
    return { drive: full, action: 'created', asAdmin };
  } catch (error) {
    if (!isConflict(error)) throw error;

    // 409 : Google dit que ce requestId a DÉJÀ servi à créer ce Drive. C'est
    // exactement le cas « la création est passée, mais la réponse s'est perdue
    // en chemin ». On ne recrée rien : on retrouve le Drive et on continue.
    log.info(
      "Google signale que ce Drive partagé a déjà été créé par une exécution précédente (c'est le " +
        "propre de l'identifiant de requête stable). On le retrouve au lieu d'en créer un deuxième.",
    );
    const again = await listAllSharedDrives(driveApi);
    const found = again.drives.find((d) => lower(d?.name) === lower(wantedName));
    if (!found) throw error;
    setStateKey(state, 'driveId', found.id);
    const full = (await getSharedDriveOrNull(driveApi, found.id, again.asAdmin)) ?? found;
    return { drive: full, action: 'reused', asAdmin: again.asAdmin };
  }
}

/**
 * Vérifie que le compte utilisé a le droit de créer un Drive partagé, AVANT
 * d'essayer. Ça transforme un « 403 » incompréhensible en explication utile.
 */
async function checkCanCreateDrives({ driveApi, config, log, warnings, apply }) {
  let canCreate = null;
  try {
    const { data } = await withRetry(
      () => driveApi.about.get({ fields: 'canCreateDrives,user(emailAddress)' }),
      { tries: 3, propagation: false, label: 'vérification des droits Drive' },
    );
    canCreate = data?.canCreateDrives ?? null;
  } catch (error) {
    log.info(
      `Impossible de vérifier à l'avance le droit de créer un Drive partagé (${errorInfo(error).message}). ` +
        'On continue quand même.',
    );
    return;
  }

  if (canCreate === false) {
    const message =
      `Le compte ${config.adminEmail} n'a pas le droit de créer un Drive partagé. Trois causes possibles :\n` +
      "  - ce n'est pas un compte Google Workspace (les comptes @gmail.com n'ont pas les Drive partagés) ;\n" +
      "  - la création de Drive partagés est désactivée pour son unité organisationnelle\n" +
      '    (console d\'administration → Applications → Google Workspace → Drive et Docs → Paramètres de partage) ;\n' +
      "  - la délégation à l'échelle du domaine n'inclut pas la portée « .../auth/drive ».";
    log.err(message);
    warnings.push(message);
    if (apply) {
      throw new Error(message);
    }
  }
}

/* ================================================================== *
 * 2. Les restrictions de partage
 * ================================================================== */

/**
 * Applique les restrictions décrites dans config.json, et seulement celles qui
 * diffèrent de l'état actuel (pour ne rien réécrire inutilement).
 *
 * Deux subtilités :
 *   - `adminManagedRestrictions` est traité EN DERNIER, et à part. Une fois
 *     activé, seul un administrateur du domaine peut modifier les restrictions —
 *     y compris la trousse elle-même. C'est une porte à sens unique.
 *   - Google expose des « capacités » (capabilities) qui disent si le compte
 *     courant a le droit de changer telle restriction. On les lit d'abord :
 *     mieux vaut un avertissement clair qu'un 403 en pleine exécution.
 *
 * @returns {Promise<{ changed: string[], already: string[], refused: string[] }>}
 */
async function applyRestrictions({ driveApi, drive, config, apply, log, warnings, asAdmin }) {
  const wanted = config.sharedDrive.restrictions ?? {};
  const current = drive?.restrictions ?? {};
  const capabilities = drive?.capabilities ?? {};

  /** @type {string[]} */ const changed = [];
  /** @type {string[]} */ const already = [];
  /** @type {string[]} */ const refused = [];

  /** @type {Record<string, boolean>} */ const patch = {};
  let wantsAdminManaged = false;

  for (const [key, value] of Object.entries(wanted)) {
    if (typeof value !== 'boolean') continue;

    if (key === 'adminManagedRestrictions') {
      wantsAdminManaged = value;
      continue;
    }

    if (current[key] === value) {
      already.push(`${RESTRICTION_LABELS[key] ?? key}`);
      continue;
    }

    // La capacité n'est connue que si le Drive existe déjà. En simulation sur
    // un Drive à créer, on ne bloque pas : on annonce simplement le plan.
    const capability = RESTRICTION_CAPABILITIES[key];
    if (drive && capability && capabilities[capability] === false) {
      const message =
        `Le réglage « ${RESTRICTION_LABELS[key] ?? key} » ne peut pas être modifié par ${config.adminEmail} : ` +
        'Google refuse ce changement à ce compte. Cause la plus fréquente : les restrictions du Drive sont ' +
        "déjà verrouillées par un administrateur (« adminManagedRestrictions »). À faire à la main dans " +
        'Google Drive → le Drive partagé → Paramètres, avec un compte administrateur.';
      log.warn(message);
      warnings.push(message);
      refused.push(RESTRICTION_LABELS[key] ?? key);
      continue;
    }

    patch[key] = value;
  }

  /* --- Les restrictions ordinaires, en un seul appel ---------------- */
  if (Object.keys(patch).length > 0) {
    const description = Object.keys(patch)
      .map((k) => `${RESTRICTION_LABELS[k] ?? k} → ${patch[k] ? 'activé' : 'désactivé'}`)
      .join(' ; ');

    if (!apply) {
      log.plan(`Appliquer les réglages de partage du Drive : ${description}.`);
      changed.push(...Object.keys(patch).map((k) => RESTRICTION_LABELS[k] ?? k));
    } else {
      await withRetry(
        () =>
          driveApi.drives.update({
            driveId: drive.id,
            useDomainAdminAccess: asAdmin,
            requestBody: { restrictions: patch },
            fields: `id,name,restrictions(${RESTRICTION_FIELDS})`,
          }),
        { tries: 4, propagation: true, label: 'application des réglages de partage du Drive' },
      );
      log.ok(`Réglages de partage appliqués : ${description}.`);
      changed.push(...Object.keys(patch).map((k) => RESTRICTION_LABELS[k] ?? k));
    }
  }

  /* --- Le verrou administrateur, en dernier ------------------------- */
  if (wantsAdminManaged && current.adminManagedRestrictions !== true) {
    const message =
      "Le réglage « seul un administrateur du domaine peut modifier ces réglages » va être activé. " +
      "ATTENTION : c'est une porte à sens unique. Après ça, la trousse elle-même ne pourra plus " +
      'modifier les restrictions de ce Drive si le compte utilisé perd son statut d\'administrateur.';

    if (!apply) {
      log.plan(`${message} (rien n'est fait en mode simulation)`);
      changed.push(RESTRICTION_LABELS.adminManagedRestrictions);
    } else {
      log.warn(message);
      warnings.push(message);
      try {
        await withRetry(
          () =>
            driveApi.drives.update({
              driveId: drive.id,
              useDomainAdminAccess: asAdmin,
              requestBody: { restrictions: { adminManagedRestrictions: true } },
              fields: `id,restrictions(${RESTRICTION_FIELDS})`,
            }),
          { tries: 3, propagation: false, label: 'verrouillage administrateur des réglages du Drive' },
        );
        log.ok('Réglages du Drive verrouillés : seuls les administrateurs du domaine peuvent les changer.');
        changed.push(RESTRICTION_LABELS.adminManagedRestrictions);
      } catch (error) {
        const context = 'verrouillage administrateur des réglages du Drive';
        log.warn(explain(error, context));
        warnings.push(`${context} : ${errorInfo(error).message}`);
        refused.push(RESTRICTION_LABELS.adminManagedRestrictions);
      }
    }
  } else if (wantsAdminManaged) {
    already.push(RESTRICTION_LABELS.adminManagedRestrictions);
  }

  if (changed.length === 0 && refused.length === 0) {
    log.skip(`Réglages de partage du Drive déjà conformes (${already.length} réglage(s) vérifié(s)).`);
  }

  return { changed, already, refused };
}

/* ================================================================== *
 * 3. Les membres du Drive
 * ================================================================== */

/**
 * Construit la liste des accès voulus.
 *
 * Si un groupe est configuré, c'est LUI qu'on inscrit, et lui seul : quand
 * quelqu'un arrive ou part, on modifie le groupe et l'accès au Drive suit tout
 * seul. Sinon, chaque adresse de l'équipe est inscrite individuellement.
 *
 * @returns {Array<{ type: 'group'|'user', email: string, role: string, label: string }>}
 */
function buildDesiredMembers(config, log, warnings) {
  const personal = lower(config.personalEmail);

  if (config.group?.email) {
    return [
      {
        type: 'group',
        email: config.group.email,
        role: 'organizer',
        label: `${config.group.email} (groupe d'équipe)`,
      },
    ];
  }

  /** @type {Array<{ type: 'user', email: string, role: string, label: string }>} */
  const out = [];
  const seen = new Set();

  for (const member of config.team ?? []) {
    const email = typeof member?.email === 'string' ? member.email.trim() : '';
    if (email === '' || seen.has(lower(email))) continue;

    // Garde : l'adresse personnelle du propriétaire n'a rien à faire dans le
    // Drive de l'entreprise. C'est justement ce qu'on cherche à détacher.
    if (personal && lower(email) === personal) {
      const message =
        `L'adresse personnelle ${email} figure dans « team » : elle ne sera PAS inscrite au Drive partagé. ` +
        "Le Drive de l'entreprise ne doit contenir que des comptes du domaine.";
      log.warn(message);
      warnings.push(message);
      continue;
    }

    seen.add(lower(email));
    out.push({
      type: 'user',
      email,
      // « organizer » gère le Drive (membres compris), « fileOrganizer » gère
      // le contenu sans pouvoir changer qui a accès.
      role: member?.role === 'organizer' ? 'organizer' : 'fileOrganizer',
      label: member?.name ? `${member.name} <${email}>` : email,
    });
  }

  return out;
}

/** Toutes les permissions d'un Drive partagé. Pagination gérée. */
async function listDrivePermissions(driveApi, driveId, asAdmin) {
  return collectPages(
    (pageToken) =>
      driveApi.permissions.list({
        fileId: driveId, // l'identifiant du Drive partagé EST celui de son dossier racine
        supportsAllDrives: true, // OBLIGATOIRE sur un Drive partagé
        useDomainAdminAccess: asAdmin,
        pageSize: PERMISSIONS_PAGE_SIZE,
        pageToken,
        fields: PERMISSION_LIST_FIELDS,
      }),
    { itemsKey: 'permissions', label: 'lecture des membres du Drive partagé' },
  );
}

/**
 * Inscrit les membres voulus, sans jamais rien retirer ni rétrograder.
 *
 * IMPORTANT — les appels sont SÉRIALISÉS (pas de Promise.all). Google le
 * documente noir sur blanc : « les opérations concurrentes de permissions sur
 * un même fichier ne sont pas prises en charge ; seule la dernière est
 * appliquée ». En parallèle, on perdrait des membres au hasard.
 *
 * @returns {Promise<{ added: string[], upgraded: string[], already: string[], failed: string[] }>}
 */
async function reconcileMembers({ driveApi, driveId, desired, apply, log, warnings, asAdmin }) {
  /** @type {string[]} */ const added = [];
  /** @type {string[]} */ const upgraded = [];
  /** @type {string[]} */ const already = [];
  /** @type {string[]} */ const failed = [];

  // En simulation sur un Drive qui n'existe pas encore : tout est à faire.
  if (!driveId) {
    for (const want of desired) {
      log.plan(`Inscrire ${want.label} au Drive partagé comme ${roleLabel(want.role)}.`);
      added.push(want.label);
    }
    return { added, upgraded, already, failed };
  }

  const existing = await listDrivePermissions(driveApi, driveId, asAdmin);
  const byKey = new Map();
  for (const permission of existing) {
    if (permission?.deleted === true) continue;
    byKey.set(permissionKey(permission.type, permission.emailAddress ?? permission.domain), permission);
  }

  for (const want of desired) {
    const key = permissionKey(want.type, want.email);
    const current = byKey.get(key);

    /* --- Déjà membre ---------------------------------------------- */
    if (current) {
      const currentRank = ROLE_RANK[current.role] ?? 0;
      const wantedRank = ROLE_RANK[want.role] ?? 0;

      if (currentRank >= wantedRank) {
        // On ne rétrograde JAMAIS : si quelqu'un a plus d'accès que prévu,
        // c'est peut-être voulu, et lui retirer un droit derrière son dos
        // serait la pire surprise possible.
        if (currentRank > wantedRank) {
          log.skip(
            `${want.label} est déjà ${roleLabel(current.role)} — plus que les ${roleLabel(want.role)} ` +
              "demandés par config.json. La trousse ne retire jamais un accès : rien n'est changé.",
          );
        } else {
          log.skip(`${want.label} est déjà ${roleLabel(current.role)} du Drive.`);
        }
        already.push(`${want.label} — ${roleLabel(current.role)}`);
        continue;
      }

      /* --- Rehaussement de rôle ------------------------------------ */
      if (!apply) {
        log.plan(`Faire passer ${want.label} de ${roleLabel(current.role)} à ${roleLabel(want.role)}.`);
        upgraded.push(`${want.label} — ${current.role} → ${want.role}`);
        continue;
      }

      try {
        await withRetry(
          () =>
            driveApi.permissions.update({
              fileId: driveId,
              permissionId: current.id,
              supportsAllDrives: true,
              useDomainAdminAccess: asAdmin,
              requestBody: { role: want.role },
              fields: PERMISSION_FIELDS,
            }),
          { tries: 4, propagation: true, label: `mise à jour de l'accès de ${want.email}` },
        );
        log.ok(`${want.label} passe de ${roleLabel(current.role)} à ${roleLabel(want.role)}.`);
        upgraded.push(`${want.label} — ${current.role} → ${want.role}`);
      } catch (error) {
        const context = `mise à jour de l'accès de ${want.email} au Drive partagé`;
        log.err(explain(error, context));
        warnings.push(`${context} : ${errorInfo(error).message}`);
        failed.push(want.label);
      }
      continue;
    }

    /* --- Nouveau membre ------------------------------------------- */
    if (!apply) {
      log.plan(`Inscrire ${want.label} au Drive partagé comme ${roleLabel(want.role)}.`);
      added.push(want.label);
      continue;
    }

    try {
      await withRetry(
        () =>
          driveApi.permissions.create({
            fileId: driveId,
            supportsAllDrives: true, // OBLIGATOIRE : sans ça, Google répond 404
            // Aucun courriel : l'accès apparaît tout seul dans le Drive de la
            // personne. C'est justement la manipulation manuelle qu'on évite.
            sendNotificationEmail: false,
            useDomainAdminAccess: asAdmin,
            requestBody: {
              type: want.type, // 'group' ou 'user'
              role: want.role,
              emailAddress: want.email, // requis pour 'group' comme pour 'user'
            },
            fields: PERMISSION_FIELDS,
          }),
        // propagation: true — un groupe fraîchement créé par la commande
        // « group » n'est pas immédiatement visible de Drive. Google documente
        // ce délai ; réessayer est la seule bonne réponse.
        { tries: 6, propagation: true, label: `inscription de ${want.email} au Drive partagé` },
      );
      log.ok(`${want.label} inscrit au Drive partagé comme ${roleLabel(want.role)}.`);
      added.push(want.label);
    } catch (error) {
      const context = `inscription de ${want.email} au Drive partagé`;
      log.err(explain(error, context));
      warnings.push(`${context} : ${errorInfo(error).message}`);
      failed.push(want.label);
    }
  }

  return { added, upgraded, already, failed };
}

/* ================================================================== *
 * 4. L'arborescence de dossiers
 * ================================================================== */

/**
 * Cherche un dossier par son nom, sous un parent précis, DANS le Drive partagé.
 *
 * La requête impose `trashed = false` : sans ça, un dossier mis à la corbeille
 * serait retrouvé, réutilisé, et l'équipe déposerait ses fichiers dans un
 * dossier promis à la suppression définitive.
 *
 * @returns {Promise<object|null>} le dossier, ou null s'il n'existe pas
 */
async function findFolder({ driveApi, driveId, name, parentId, log, warnings }) {
  const q = [
    `name = '${escapeQuery(name)}'`,
    `mimeType = '${FOLDER_MIME}'`,
    `'${escapeQuery(parentId)}' in parents`,
    'trashed = false',
  ].join(' and ');

  const files = await listFilesInSharedDrive(driveApi, driveId, q, `recherche du dossier « ${name} »`);

  // Drive compare les noms sans tenir compte de la casse. On préfère la
  // correspondance exacte quand elle existe, pour ne pas confondre
  // « Archives » et « ARCHIVES ».
  const exact = files.filter((f) => f.name === name);
  const candidates = exact.length > 0 ? exact : files;

  if (candidates.length > 1) {
    const chosen = [...candidates].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
    const message =
      `${candidates.length} dossiers nommés « ${name} » existent déjà au même endroit dans le Drive partagé. ` +
      `La trousse utilise toujours le même (${chosen.id}) et n'en crée aucun autre. À corriger à la main : ` +
      'fusionner ou supprimer les doublons, sinon les documents vont se répartir au hasard entre les deux.';
    log.warn(message);
    warnings.push(message);
    return chosen;
  }

  return candidates[0] ?? null;
}

/**
 * Crée l'arborescence complète, récursivement, de haut en bas.
 *
 * Sérialisé volontairement : chaque niveau a besoin de l'identifiant du niveau
 * du dessus. Et créer deux dossiers frères en parallèle n'empêcherait pas les
 * doublons — rien chez Google n'interdit deux dossiers du même nom au même
 * endroit.
 *
 * @param {object} params
 * @param {Array<{name: string, children?: Array}>} params.folders spécification
 * @param {string|null} params.parentId parent réel, ou null en simulation
 * @param {string} params.parentPath chemin lisible du parent, pour le cache et les messages
 * @param {{ created: string[], existing: string[], failed: string[] }} params.stats compteurs
 */
async function ensureFolderTree({
  driveApi,
  driveId,
  folders,
  parentId,
  parentPath,
  apply,
  state,
  log,
  warnings,
  stats,
}) {
  for (const spec of folders ?? []) {
    const name = spec?.name;
    if (typeof name !== 'string' || name.trim() === '') continue;

    const path = `${parentPath}/${name}`;
    let folderId = null;

    if (parentId) {
      /* --- On sait où chercher : on cherche AVANT de créer ---------- */
      let existing = null;
      try {
        existing = await findFolder({ driveApi, driveId, name, parentId, log, warnings });
      } catch (error) {
        const context = `recherche du dossier « ${path} »`;
        log.err(explain(error, context));
        warnings.push(`${context} : ${errorInfo(error).message}`);
        stats.failed.push(path);
        continue; // on n'essaie SURTOUT pas de créer « au cas où » : ce serait le doublon assuré
      }

      if (existing) {
        // Garde de sécurité : même retrouvé, on revérifie qu'il est bien dans
        // le Drive partagé avant de s'en servir comme parent.
        assertInSharedDrive(existing, driveId, { action: `utiliser le dossier « ${path} »` });
        log.skip(`Dossier « ${path} » déjà présent.`);
        stats.existing.push(path);
        folderId = existing.id;
        setStateKey(state, ['folders', path], existing.id);
      } else if (!apply) {
        log.plan(`Créer le dossier « ${path} ».`);
        stats.created.push(path);
      } else {
        try {
          const created = await safeCreateFile({
            driveApi,
            driveId,
            parentId,
            requestBody: { name, mimeType: FOLDER_MIME },
            label: path,
          });
          log.ok(`Dossier « ${path} » créé.`);
          stats.created.push(path);
          folderId = created.id;
          setStateKey(state, ['folders', path], created.id);
        } catch (error) {
          const context = `création du dossier « ${path} »`;
          log.err(explain(error, context));
          warnings.push(`${context} : ${errorInfo(error).message}`);
          stats.failed.push(path);
        }
      }
    } else {
      /* --- Simulation d'un parent qui n'existe pas encore ----------- */
      log.plan(`Créer le dossier « ${path} ».`);
      stats.created.push(path);
    }

    if (spec.children?.length) {
      await ensureFolderTree({
        driveApi,
        driveId,
        folders: spec.children,
        parentId: folderId, // null en simulation : les enfants seront simplement annoncés
        parentPath: path,
        apply,
        state,
        log,
        warnings,
        stats,
      });
    }
  }
}

/* ================================================================== *
 * 5. Le mode d'emploi du classement
 * ================================================================== */

/**
 * Repère le dossier d'archives dans la configuration, pour que le mode d'emploi
 * cite le VRAI nom du dossier plutôt qu'un nom inventé.
 */
function findArchiveFolderName(folders) {
  for (const folder of folders ?? []) {
    const name = String(folder?.name ?? '');
    if (/archiv/i.test(name)) return name;
  }
  return '90 — Archives';
}

/**
 * Compose le mode d'emploi en HTML. Google convertit ce HTML en Google Doc à
 * l'envoi : titres, listes et tableaux sont conservés.
 *
 * Le contenu est fabriqué À PARTIR de config.json : la liste des dossiers
 * décrite dans le document est donc toujours celle qui existe réellement.
 */
function buildReadmeHtml(config) {
  const drive = config.sharedDrive;
  const folders = drive.folders ?? [];
  const archive = findArchiveFolderName(folders);
  const today = new Date().toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' });

  const rows = folders
    .map((folder) => {
      const name = escapeHtml(folder.name);
      const children = (folder.children ?? []).map((c) => escapeHtml(c.name));

      let purpose;
      if (/archiv/i.test(folder.name)) {
        purpose =
          "Ce qui ne sert plus au quotidien, et tout document dont on ne sait pas où le mettre. " +
          "Rien ne se perd : on le sort d'ici le jour où on en a besoin.";
      } else if (/mod[èe]le|template/i.test(folder.name)) {
        purpose =
          'Les gabarits vierges : contrats types, lettres types, chiffriers de base. ' +
          "On les DUPLIQUE, on ne travaille jamais directement dedans.";
      } else if (children.length > 0) {
        purpose = `On y trouve : ${children.join(', ')}.`;
      } else {
        purpose = 'Dossier simple : les documents y vont directement, sans sous-dossier.';
      }

      return `<tr><td><b>${name}</b></td><td>${purpose}</td></tr>`;
    })
    .join('');

  const folderTable =
    rows === ''
      ? '<p><i>Aucun dossier n\'est encore décrit dans la configuration de la trousse.</i></p>'
      : `<table border="1" cellpadding="6" cellspacing="0">
           <tr><td><b>Dossier</b></td><td><b>À quoi il sert</b></td></tr>
           ${rows}
         </table>`;

  return `<!doctype html>
<html lang="fr-CA">
<head><meta charset="utf-8"><title>${escapeHtml(README_NAME)}</title></head>
<body>
  <h1>Comment on range nos affaires</h1>

  <p>
    Ce Drive partagé, c'est le classeur de <b>${escapeHtml(drive.name)}</b>. Tout ce qui appartient à
    l'entreprise vit ici, et nulle part ailleurs. Personne n'a besoin de demander à qui que ce soit
    pour retrouver un document : il est là, au même endroit pour tout le monde.
  </p>

  <p>
    Ce document tient en cinq minutes de lecture. Le lire une fois évite des heures à chercher
    « la dernière version » d'un fichier.
  </p>

  <h2>1. Les dossiers, et à quoi ils servent</h2>
  ${folderTable}

  <h2>2. Comment on nomme un fichier</h2>
  <p>Toujours la même forme, sans exception&nbsp;:</p>
  <p style="font-size:14pt"><b>${escapeHtml(NAMING_CONVENTION)}</b></p>
  <ul>
    <li><b>AAAA-MM-JJ</b> — la date du document, pas celle où on l'a classé. Écrite comme ça, le
      classement par nom donne automatiquement l'ordre chronologique.</li>
    <li><b>Type</b> — Facture, Contrat, Bail, Devis, Procès-verbal, Rapport, Politique…</li>
    <li><b>Sujet</b> — de qui ou de quoi il s'agit, en clair.</li>
  </ul>
  <p>Exemples&nbsp;:</p>
  <ul>
    <li>2026-03-14 — Facture — Hydro-Québec</li>
    <li>2026-01-31 — Bail — 245 rue Principale, logement 3</li>
    <li>2026-02-08 — Procès-verbal — Réunion d'équipe</li>
  </ul>
  <p>
    Pas de «&nbsp;final&nbsp;», pas de «&nbsp;v2&nbsp;», pas de «&nbsp;final_vraiment_final&nbsp;».
    Google Docs conserve tout l'historique des versions&nbsp;: un seul fichier suffit, toujours.
  </p>

  <h2>3. Les trois règles</h2>
  <ol>
    <li>
      <b>Dans le doute entre deux dossiers, choisis le plus précis.</b>
      Un contrat d'assurance va dans «&nbsp;Assurances&nbsp;», pas dans «&nbsp;Administration&nbsp;».
      Le dossier général est un fourre-tout&nbsp;: plus il se remplit, moins il sert.
    </li>
    <li>
      <b>Rien de personnel dans ce Drive.</b>
      Ni relevés bancaires personnels, ni photos de famille, ni papiers d'impôt personnels. Ce Drive
      appartient à l'entreprise&nbsp;: tout le monde y a accès, et il reste à l'entreprise même si
      quelqu'un s'en va. Les affaires personnelles restent dans le «&nbsp;Mon Drive&nbsp;» de chacun.
    </li>
    <li>
      <b>On ne travaille jamais depuis son bureau ou ses téléchargements.</b>
      Un document qui n'est pas ici n'existe pas pour l'équipe.
    </li>
  </ol>

  <h2>4. Un document qui n'a sa place nulle part</h2>
  <p>
    Ça arrive. La réponse est simple, et elle n'est pas «&nbsp;créer un nouveau dossier&nbsp;»&nbsp;:
    dépose-le dans <b>${escapeHtml(archive)}</b>, avec un nom clair selon la convention ci-dessus.
  </p>
  <p>
    Rien n'est perdu&nbsp;: la recherche de Google Drive retrouve un document par son contenu, pas
    seulement par son nom. Si le même genre de document revient trois ou quatre fois, c'est le signe
    qu'il mérite son propre dossier&nbsp;— on en parle à l'équipe et on l'ajoute pour de bon.
  </p>
  <p>
    Créer un dossier sur un coup de tête, par contre, c'est ce qui transforme un classeur en grenier.
  </p>

  <h2>5. Ce qu'il ne faut pas faire</h2>
  <ul>
    <li>Partager un fichier de ce Drive avec quelqu'un de l'extérieur sans en parler avant.</li>
    <li>Déplacer un dossier complet «&nbsp;pour mieux ranger&nbsp;»&nbsp;: les liens des autres cassent.</li>
    <li>Supprimer un document&nbsp;: le mettre dans <b>${escapeHtml(archive)}</b> à la place.</li>
    <li>Garder l'unique copie d'un document important dans un courriel.</li>
  </ul>

  <hr>
  <p>
    <i>
      Document créé automatiquement par la trousse de mise en place du Google Workspace, le ${escapeHtml(today)}.
      Il peut être modifié à la main&nbsp;: la trousse ne l'écrase jamais une fois qu'il existe.
    </i>
  </p>
</body>
</html>`;
}

/**
 * Dépose le mode d'emploi à la racine du Drive partagé, en Google Doc.
 *
 * Idempotent : si un document du même nom est déjà à la racine, on n'y touche
 * pas — surtout pas pour l'écraser, parce que l'équipe l'a peut-être annoté.
 *
 * @returns {Promise<{ action: 'created'|'existing'|'planned'|'failed', file: object|null }>}
 */
async function ensureReadme({ driveApi, driveId, config, apply, log, warnings }) {
  if (!driveId) {
    log.plan(`Déposer le mode d'emploi « ${README_NAME} » à la racine du Drive partagé.`);
    return { action: 'planned', file: null };
  }

  /* --- Existe-t-il déjà ? ------------------------------------------ */
  // On ne filtre pas sur le type MIME : si quelqu'un l'a remplacé par un PDF
  // ou un fichier Word, c'est quand même le mode d'emploi, et on le laisse.
  const q = [
    `name = '${escapeQuery(README_NAME)}'`,
    `'${escapeQuery(driveId)}' in parents`,
    'trashed = false',
  ].join(' and ');

  let existing = [];
  try {
    existing = await listFilesInSharedDrive(driveApi, driveId, q, "recherche du mode d'emploi");
  } catch (error) {
    const context = "recherche du mode d'emploi à la racine du Drive";
    log.err(explain(error, context));
    warnings.push(`${context} : ${errorInfo(error).message}`);
    return { action: 'failed', file: null };
  }

  if (existing.length > 0) {
    const file = existing[0];
    assertInSharedDrive(file, driveId, { action: "vérifier le mode d'emploi" });
    log.skip(`Mode d'emploi « ${README_NAME} » déjà à la racine du Drive. Il n'est jamais écrasé.`);
    return { action: 'existing', file };
  }

  if (!apply) {
    log.plan(
      `Déposer le mode d'emploi « ${README_NAME} » à la racine du Drive (Google Doc, ` +
        "explique le rôle de chaque dossier et la convention de nommage).",
    );
    return { action: 'planned', file: null };
  }

  /* --- Création ----------------------------------------------------- */
  try {
    log.info("Rédaction et dépôt du mode d'emploi…");
    const file = await safeCreateFile({
      driveApi,
      driveId,
      // La racine du Drive partagé : son identifiant de Drive est AUSSI
      // l'identifiant de son dossier racine. C'est la même valeur.
      parentId: driveId,
      requestBody: {
        name: README_NAME,
        // mimeType du CORPS de la requête = la CIBLE. Le déclarer en Google
        // Doc demande à Google de convertir le HTML téléversé en document.
        mimeType: GOOGLE_DOC_MIME,
      },
      media: {
        // mimeType du média = la SOURCE, celle du contenu qu'on envoie.
        mimeType: 'text/html',
        body: Readable.from([buildReadmeHtml(config)]),
      },
      label: README_NAME,
    });

    log.ok(`Mode d'emploi déposé à la racine du Drive : ${file.webViewLink ?? file.id}`);
    return { action: 'created', file };
  } catch (error) {
    const context = "dépôt du mode d'emploi à la racine du Drive";
    log.err(explain(error, context));
    warnings.push(`${context} : ${errorInfo(error).message}`);
    return { action: 'failed', file: null };
  }
}

/* ================================================================== *
 * Point d'entrée
 * ================================================================== */

/**
 * @param {{ config: object, apply: boolean, state: object, log: object }} params
 * @returns {Promise<{ created: string[], updated: string[], unchanged: string[], warnings: string[] }>}
 */
export async function run({ config, apply, state, log }) {
  /** @type {string[]} */ const created = [];
  /** @type {string[]} */ const updated = [];
  /** @type {string[]} */ const unchanged = [];
  /** @type {string[]} */ const warnings = [];

  const spec = config?.sharedDrive;
  if (!spec || typeof spec.name !== 'string' || spec.name.trim() === '') {
    log.info(
      "Aucun Drive partagé n'est décrit dans config.json (champ « sharedDrive ») : cette étape n'a rien à faire.",
    );
    return { created, updated, unchanged, warnings };
  }

  const folderSpecs = Array.isArray(spec.folders) ? spec.folders : [];
  const plannedFolders = flattenFolders(folderSpecs);

  log.step('Drive partagé');
  log.info(
    `Drive visé : « ${spec.name} ». ${plannedFolders.length} dossier(s) prévus, ` +
      `${folderSpecs.length} à la racine.`,
  );
  log.info(
    "Rappel : la trousse ne touche à AUCUN document existant. Elle ne déplace rien, ne copie rien et " +
      "ne partage rien. Elle crée des dossiers neufs dans le Drive partagé de l'entreprise, un point c'est tout.",
  );

  /* --- Client Drive, au nom du compte administrateur ---------------- */
  const { drive: driveApi } = await getClients({
    config,
    subject: config.adminEmail,
    scopes: DRIVE_SCOPES,
  });

  /* --- 1. Le Drive partagé ------------------------------------------ */
  let ensured;
  try {
    ensured = await ensureSharedDrive({ driveApi, config, state, apply, log, warnings });
  } catch (error) {
    const context = `création du Drive partagé « ${spec.name} »`;
    log.err(explain(error, context));
    warnings.push(`${context} : échec. ${errorInfo(error).message}`);
    return { created, updated, unchanged, warnings };
  }

  const drive = ensured.drive;
  const driveId = drive?.id ?? null;
  const asAdmin = ensured.asAdmin;

  if (ensured.action === 'created') created.push(`Drive partagé « ${spec.name} » (${driveId})`);
  else if (ensured.action === 'reused') unchanged.push(`Drive partagé « ${drive?.name ?? spec.name} » (${driveId})`);

  /* --- 2. Les restrictions ------------------------------------------ */
  log.step('Réglages de partage du Drive');
  let restrictions = { changed: [], already: [], refused: [] };
  try {
    restrictions = await applyRestrictions({ driveApi, drive, config, apply, log, warnings, asAdmin });
  } catch (error) {
    const context = 'application des réglages de partage du Drive';
    log.err(explain(error, context));
    warnings.push(`${context} : ${errorInfo(error).message}`);
  }
  for (const item of restrictions.changed) updated.push(`Réglage du Drive : ${item}`);
  for (const item of restrictions.already) unchanged.push(`Réglage du Drive : ${item}`);

  /* --- 3. Les membres ------------------------------------------------ */
  log.step('Membres du Drive');
  const desired = buildDesiredMembers(config, log, warnings);

  if (config.group?.email) {
    log.info(
      `L'accès est accordé au groupe ${config.group.email} plutôt qu'à chaque adresse : quand quelqu'un ` +
        "arrive ou part, il suffira de modifier le groupe et l'accès au Drive suivra tout seul.",
    );
  } else {
    log.info(
      "Aucun groupe n'est configuré : l'accès est accordé directement à chacune des adresses de l'équipe.",
    );
  }

  if (desired.length === 0) {
    const message =
      "Personne à inscrire au Drive partagé : la liste « team » est vide et aucun groupe n'est configuré " +
      `dans config.json. Le Drive n'aura que ${config.adminEmail} comme gestionnaire.`;
    log.warn(message);
    warnings.push(message);
  }

  if (!desired.some((d) => d.role === 'organizer')) {
    const message =
      "Aucun gestionnaire (« organizer ») n'est prévu pour le Drive partagé. Un Drive sans gestionnaire " +
      "devient ingérable si le compte qui l'a créé disparaît. À corriger : donner le rôle « organizer » à " +
      "au moins une personne dans config.json, ou configurer un groupe d'équipe.";
    log.warn(message);
    warnings.push(message);
  }

  let members = { added: [], upgraded: [], already: [], failed: [] };
  if (desired.length > 0) {
    try {
      members = await reconcileMembers({ driveApi, driveId, desired, apply, log, warnings, asAdmin });
    } catch (error) {
      const context = "inscription des membres du Drive partagé";
      log.err(explain(error, context));
      warnings.push(`${context} : ${errorInfo(error).message}`);
    }
  }
  for (const item of members.added) created.push(`Membre du Drive : ${item}`);
  for (const item of members.upgraded) updated.push(`Membre du Drive : ${item}`);
  for (const item of members.already) unchanged.push(`Membre du Drive : ${item}`);

  /* --- 4. L'arborescence --------------------------------------------- */
  log.step('Arborescence des dossiers');
  const stats = { created: [], existing: [], failed: [] };

  if (folderSpecs.length === 0) {
    log.info("Aucun dossier n'est décrit dans config.json (sharedDrive.folders) : le Drive restera vide.");
  } else {
    await ensureFolderTree({
      driveApi,
      driveId,
      folders: folderSpecs,
      // La racine du Drive partagé : l'identifiant du Drive EST celui de son
      // dossier racine. En simulation sans Drive, on passe null et tout est
      // simplement annoncé.
      parentId: driveId,
      parentPath: '',
      apply,
      state,
      log,
      warnings,
      stats,
    });

    if (stats.created.length === 0 && stats.failed.length === 0) {
      log.ok(`Arborescence déjà complète : ${stats.existing.length} dossier(s) en place, aucun à créer.`);
    } else if (apply) {
      log.ok(
        `Arborescence à jour : ${stats.created.length} dossier(s) créé(s), ` +
          `${stats.existing.length} déjà présent(s).`,
      );
    }
  }

  for (const path of stats.created) created.push(`Dossier « ${path} »`);
  for (const path of stats.existing) unchanged.push(`Dossier « ${path} »`);

  /* --- 5. Le mode d'emploi -------------------------------------------- */
  let readme = { action: 'skipped', file: null };
  if (spec.createReadme !== false) {
    log.step("Mode d'emploi du classement");
    log.info(
      "Un document déposé à la racine explique à quoi sert chaque dossier et comment nommer les fichiers. " +
        "C'est ce qui fait qu'un classement tient dans le temps au lieu de se défaire en trois mois.",
    );
    readme = await ensureReadme({ driveApi, driveId, config, apply, log, warnings });
    if (readme.action === 'created') created.push(`Mode d'emploi « ${README_NAME} »`);
    else if (readme.action === 'existing') unchanged.push(`Mode d'emploi « ${README_NAME} »`);
    else if (readme.action === 'planned' && !apply) created.push(`Mode d'emploi « ${README_NAME} »`);
  } else {
    log.info("Le mode d'emploi est désactivé dans config.json (sharedDrive.createReadme = false).");
  }

  /* ================================================================ *
   * Récapitulatif
   * ================================================================ */
  log.step('Récapitulatif du Drive partagé');

  const memberSummary =
    desired.length === 0
      ? '—'
      : desired.map((d) => `${d.email} (${d.role === 'organizer' ? 'gestionnaire' : 'gestionnaire de contenu'})`).join(', ');

  const restrictionSummary = (() => {
    const parts = [];
    if (restrictions.changed.length > 0) parts.push(`${restrictions.changed.length} appliqué(s)`);
    if (restrictions.already.length > 0) parts.push(`${restrictions.already.length} déjà conforme(s)`);
    if (restrictions.refused.length > 0) parts.push(`${restrictions.refused.length} refusé(s) par Google`);
    return parts.length > 0 ? parts.join(', ') : 'aucun';
  })();

  const folderSummary = apply
    ? `${stats.created.length} créé(s), ${stats.existing.length} déjà présent(s)` +
      (stats.failed.length > 0 ? `, ${stats.failed.length} en échec` : '')
    : `${stats.created.length} à créer, ${stats.existing.length} déjà présent(s)`;

  log.table([
    { Élément: 'Nom du Drive', Valeur: drive?.name ?? spec.name },
    { Élément: 'Identifiant', Valeur: driveId ?? PLANNED_ID },
    { Élément: 'Adresse à ouvrir', Valeur: driveId ? driveUrl(driveId) : '(disponible après la création)' },
    { Élément: 'Membres', Valeur: memberSummary },
    { Élément: 'Réglages de partage', Valeur: restrictionSummary },
    { Élément: 'Dossiers', Valeur: folderSummary },
    {
      Élément: "Mode d'emploi",
      Valeur:
        readme.action === 'created'
          ? 'déposé à la racine'
          : readme.action === 'existing'
            ? 'déjà à la racine'
            : readme.action === 'planned'
              ? 'à déposer'
              : readme.action === 'failed'
                ? 'échec — voir les avertissements'
                : 'désactivé',
    },
  ]);

  if (members.failed.length > 0) {
    log.warn(
      `Inscription impossible pour : ${members.failed.join(', ')}. Vérifier que ces adresses existent ` +
        'bien dans le domaine (commande « audit ») puis relancer.',
    );
  }

  if (stats.failed.length > 0) {
    log.warn(
      `Dossiers non créés : ${stats.failed.join(', ')}. Relancer la commande : elle reprendra exactement ` +
        'là où elle en est, sans rien créer en double.',
    );
  }

  if (apply && driveId) {
    log.ok(`Le Drive est prêt. À ouvrir ici : ${driveUrl(driveId)}`);
    log.info(
      "Rien à faire pour l'équipe : le Drive partagé apparaît tout seul dans leur Google Drive, section " +
        '« Drive partagés ». Aucun courriel à accepter.',
    );
  } else if (!apply) {
    log.plan("Rien n'a été modifié. Relance avec --apply pour créer le Drive pour de vrai.");
  }

  return { created, updated, unchanged, warnings };
}

export default { meta, run, assertInSharedDrive };
