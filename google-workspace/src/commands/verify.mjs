/**
 * verify.mjs — Commande « verify » : le contrôle final.
 *
 * LECTURE SEULE, SANS EXCEPTION. Cette commande n'appelle que des méthodes
 * `get` et `list`. Elle ignore volontairement l'option --apply (cli.mjs la
 * marque déjà « readOnly » — ceinture ET bretelles).
 *
 * Ce que « verify » répond, en une phrase : « est-ce que ce que config.json
 * décrit existe VRAIMENT chez Google, en ce moment ? » On ne fait jamais
 * confiance au cache local (.state.json) : il sert de raccourci pour trouver
 * les identifiants, et chaque identifiant trouvé est ensuite RELU via l'API.
 * Si le cache est absent, périmé ou faux, tout est redécouvert par le nom.
 *
 * RÈGLE DE SÉCURITÉ NUMÉRO UN — on ne touche JAMAIS au « Mon Drive » personnel.
 * Côté Drive, cette commande lit uniquement :
 *   - drives.get / drives.list  → le Drive PARTAGÉ ;
 *   - permissions.list          → ses membres ;
 *   - files.list                → ses dossiers, avec les quatre paramètres
 *                                 obligatoires (corpora:'drive', driveId,
 *                                 includeItemsFromAllDrives, supportsAllDrives)
 *                                 SANS lesquels Google interrogerait le
 *                                 « Mon Drive » personnel — c'est son défaut.
 * Tout résultat est refiltré sur `driveId`, et la garde assertInSharedDrive()
 * est posée avant de descendre dans un dossier.
 *
 * Les huit contrôles :
 *   1. Les usagers de l'équipe existent et ne sont pas suspendus.
 *   2. Le groupe existe et contient exactement l'équipe.
 *   3. Chaque calendrier existe et l'équipe y a le rôle attendu.
 *   4. Chaque personne a le calendrier DANS son Google Agenda (le « zéro
 *      manipulation » : c'est le seul contrôle qui le prouve).
 *   5. Le Drive partagé existe, avec les bonnes restrictions et les bons membres.
 *   6. L'arborescence de dossiers est complète, sans doublon.
 *   7. Le mode d'emploi est à la racine du Drive partagé.
 *   8. L'adresse personnelle n'apparaît plus nulle part où l'API peut voir.
 *
 * Verdict et code de sortie : 0 si tout est [OK] ou seulement des [AVERT],
 * 1 dès qu'il y a un [ÉCHEC]. Voir forcerCodeDeSortie() plus bas.
 */

import {
  getClients,
  withRetry,
  collectPages,
  isNotFound,
  isForbidden,
  errorInfo,
  explainGoogleError,
  assertInSharedDrive,
  sleep,
} from '../lib/google.mjs';
import { SCOPES, ALL_SCOPES } from '../lib/auth.mjs';
import { getStateKey } from '../lib/state.mjs';
import { raw as ligneBrute, isColorEnabled } from '../lib/log.mjs';

export const meta = {
  name: 'verify',
  summary:
    "Relit tout via l'API et rend un verdict : usagers, groupe, calendriers, agendas de chacun, " +
    "Drive partagé, dossiers, mode d'emploi et adresse personnelle. Ne modifie rien.",
};

/* ================================================================== *
 * Constantes d'API
 * ================================================================== */

/** Alias accepté par l'Admin SDK pour « mon compte client ». */
const CUSTOMER_KEY = 'my_customer';

/** Plafonds documentés — trois valeurs différentes, ne pas les confondre. */
const USERS_PAGE_SIZE = 500; // admin.users.list       : max 500 (défaut 100)
const GROUPS_PAGE_SIZE = 200; // admin.groups.list     : max 200
const MEMBERS_PAGE_SIZE = 200; // admin.members.list   : max 200
const CALENDAR_PAGE_SIZE = 250; // calendarList / acl  : max 250
const DRIVE_PAGE_SIZE = 100; // drives / permissions   : max 100 (défaut 10 !)
const FILES_PAGE_SIZE = 100; // files.list             : max 1000, 100 suffit

/** Pause entre deux emprunts d'identité, pour ne pas déclencher les quotas. */
const IMPERSONATION_DELAY_MS = 120;

/** Masques `fields` explicites : on ne rapatrie que ce qu'on vérifie. */
const USER_FIELDS =
  'primaryEmail,name(fullName),suspended,suspensionReason,archived,orgUnitPath,' +
  'aliases,nonEditableAliases,emails,recoveryEmail';

const USER_LIST_FIELDS =
  'nextPageToken,users(primaryEmail,name(fullName),suspended,archived,aliases,nonEditableAliases,emails,recoveryEmail)';

const GROUP_FIELDS = 'id,email,name,description,directMembersCount';
const GROUP_LIST_FIELDS = 'nextPageToken,groups(id,email,name)';
const MEMBER_LIST_FIELDS = 'nextPageToken,members(id,email,role,type,status)';

const CALENDAR_FIELDS = 'id,summary,description,timeZone';
const CALENDAR_LIST_FIELDS = 'nextPageToken,items(id,summary,primary,accessRole,selected,hidden,deleted)';
const CALENDAR_LIST_ENTRY_FIELDS = 'id,summary,summaryOverride,selected,hidden,accessRole';
const ACL_FIELDS = 'nextPageToken,items(id,role,scope)';

const RESTRICTION_FIELDS = [
  'adminManagedRestrictions',
  'copyRequiresWriterPermission',
  'domainUsersOnly',
  'driveMembersOnly',
  'sharingFoldersRequiresOrganizerPermission',
].join(',');

const DRIVE_FIELDS = `id,name,createdTime,restrictions(${RESTRICTION_FIELDS})`;
const DRIVE_LIST_FIELDS = `nextPageToken,drives(id,name,createdTime,restrictions(${RESTRICTION_FIELDS}))`;
const PERMISSION_LIST_FIELDS =
  'nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,deleted,' +
  'permissionDetails(role,permissionType,inherited))';

/**
 * Masque minimal de TOUT fichier lu. `driveId` en fait partie OBLIGATOIREMENT :
 * c'est le seul champ qui distingue un élément d'un Drive partagé d'un élément
 * du « Mon Drive » personnel. Sans lui dans le masque, Google ne le renvoie pas
 * et la garde de sécurité lirait `undefined`.
 */
const FILE_FIELDS = 'id,name,mimeType,driveId,parents,trashed';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Nom exact du mode d'emploi déposé par la commande « drive ». */
const README_NAME = '000 — LISEZ-MOI — Comment on range nos affaires';

/** Fragment reconnaissable, au cas où le mode d'emploi aurait été renommé. */
const README_FRAGMENT = 'LISEZ-MOI';

/**
 * Rôles de partage d'un calendrier, du plus petit au plus grand.
 * Six valeurs — « writerWithoutPrivateAccess » est souvent oublié.
 */
const CALENDAR_ROLE_RANK = {
  none: 0,
  freeBusyReader: 1,
  reader: 2,
  writerWithoutPrivateAccess: 3,
  writer: 4,
  owner: 5,
};

/** Rôles Drive, du plus petit au plus grand. */
const DRIVE_ROLE_RANK = { reader: 1, commenter: 2, writer: 3, fileOrganizer: 4, organizer: 5 };

/** Rôles de groupe, du plus petit au plus grand. */
const GROUP_ROLE_RANK = { MEMBER: 0, MANAGER: 1, OWNER: 2 };

/** Traductions, pour des messages lisibles par un non-programmeur. */
const CALENDAR_ROLE_LABELS = {
  none: 'aucun accès',
  freeBusyReader: 'voit seulement les disponibilités',
  reader: 'lecture',
  writerWithoutPrivateAccess: 'écriture (sans les événements privés)',
  writer: 'écriture',
  owner: 'propriétaire',
};

const DRIVE_ROLE_LABELS = {
  reader: 'lecture',
  commenter: 'commentaire',
  writer: 'écriture',
  fileOrganizer: 'gestionnaire de contenu',
  organizer: 'gestionnaire',
};

const RESTRICTION_LABELS = {
  domainUsersOnly: 'Accès limité aux usagers du domaine',
  driveMembersOnly: 'Accès limité aux membres du Drive',
  copyRequiresWriterPermission: 'Copie / impression / téléchargement bloqués pour les lecteurs',
  sharingFoldersRequiresOrganizerPermission: 'Seuls les gestionnaires peuvent partager un dossier',
  adminManagedRestrictions: 'Restrictions verrouillées par un administrateur du domaine',
};

/* ================================================================== *
 * Statuts, couleurs et affichage
 * ================================================================== */

const STATUT = {
  OK: 'OK',
  ECHEC: 'ÉCHEC',
  AVERT: 'AVERT',
  SO: 'S.O.',
};

/**
 * Ordre de gravité. Le statut d'un contrôle est le plus grave de ses détails.
 * « S.O. » (sans objet) est le plus bas : dès qu'un vrai résultat existe, il
 * prend le dessus.
 */
const GRAVITE = { [STATUT.SO]: 0, [STATUT.OK]: 1, [STATUT.AVERT]: 2, [STATUT.ECHEC]: 3 };

const ESC = '\u001b';
const COULEURS = {
  [STATUT.OK]: `${ESC}[32m`,
  [STATUT.ECHEC]: `${ESC}[31m`,
  [STATUT.AVERT]: `${ESC}[33m`,
  [STATUT.SO]: `${ESC}[90m`,
};
const GRIS = `${ESC}[90m`;
const GRAS = `${ESC}[1m`;
const RESET = `${ESC}[0m`;

/**
 * Fabrique le marqueur `[OK]` / `[ÉCHEC]` / `[AVERT]` / `[S.O.]`, coloré si la
 * sortie est un terminal. On réutilise la décision de log.mjs (NO_COLOR, TTY)
 * plutôt que de la refaire, pour que toute la trousse se comporte pareil.
 */
function marqueur(statut) {
  const texte = `[${statut}]`.padEnd(8, ' ');
  if (!isColorEnabled()) return texte;
  return `${GRAS}${COULEURS[statut] ?? ''}${texte}${RESET}`;
}

/** Met un texte en gris, si la couleur est active. */
function gris(texte) {
  return isColorEnabled() ? `${GRIS}${texte}${RESET}` : texte;
}

/**
 * Écrit une ligne telle quelle.
 * Le `log` que cli.mjs passe aux commandes n'expose que banner/step/info/ok/
 * warn/err/plan/skip/table : pas raw(). On importe donc raw() directement,
 * avec un repli sur console.log si jamais il venait à disparaître.
 */
function ecrire(texte) {
  try {
    ligneBrute(texte);
  } catch {
    console.log(texte);
  }
}

/* ================================================================== *
 * Petits utilitaires
 * ================================================================== */

/** Minuscule + trim, pour comparer des adresses sans se faire avoir. */
function lower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Explication française d'une erreur Google, avec sa ligne de contexte. */
function expliquer(error, contexte) {
  try {
    return explainGoogleError(error, { context: contexte });
  } catch {
    return `${contexte} — ${error?.message ?? String(error)}`;
  }
}

/** Message court d'une erreur Google, pour une ligne de rapport. */
function messageCourt(error) {
  try {
    return errorInfo(error).message ?? String(error);
  } catch {
    return error?.message ?? String(error);
  }
}

/**
 * Normalise un fuseau horaire IANA.
 * « America/Montreal » est un alias déprécié d'« America/Toronto » : Google le
 * réécrit silencieusement. Sans cette normalisation, on croirait voir un écart
 * à chaque exécution.
 */
function canonTz(tz) {
  try {
    return new Intl.DateTimeFormat('fr-CA', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return String(tz ?? '');
  }
}

/**
 * Échappe une valeur avant de l'insérer dans une requête `q` de Drive. Sans ça,
 * un nom de dossier contenant une apostrophe (« L'équipe ») casse la requête.
 */
function escapeQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Clé de comparaison d'une règle d'accès de calendrier : « type:valeur ». */
function aclKey(type, value) {
  return `${type}:${lower(value)}`;
}

/** Clé de comparaison d'une permission Drive. */
function permKey(permission) {
  const type = permission?.type ?? '';
  const valeur = permission?.emailAddress ?? permission?.domain ?? 'anyone';
  return `${type}:${lower(valeur)}`;
}

/** « organizer » dans config.json = OWNER dans le groupe. */
function roleGroupeAttendu(roleEquipe) {
  return roleEquipe === 'organizer' ? 'OWNER' : 'MEMBER';
}

/** Rôle Drive attendu pour une personne, quand il n'y a pas de groupe. */
function roleDriveAttendu(roleEquipe) {
  return roleEquipe === 'organizer' ? 'organizer' : 'fileOrganizer';
}

/** Tronque un texte long pour garder le rapport lisible. */
function couper(texte, max = 400) {
  const s = String(texte ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Liste lisible, tronquée au-delà de `max` éléments. */
function enumerer(items, max = 6) {
  const liste = [...items];
  if (liste.length <= max) return liste.join(', ');
  return `${liste.slice(0, max).join(', ')} … (+${liste.length - max})`;
}

/* ================================================================== *
 * Le rapport
 * ================================================================== */

/**
 * Accumule les résultats et les affiche au fur et à mesure.
 *
 * Chaque détail est une ligne « [STATUT] explication », suivie au besoin d'une
 * ligne « → » qui dit EXACTEMENT quoi lancer pour corriger. Le statut d'un
 * contrôle est le plus grave de ses détails.
 */
function creerRapport(log) {
  /** @type {Array<{ numero: number, titre: string, statut: string }>} */
  const controles = [];
  /** @type {string[]} */ const echecs = [];
  /** @type {string[]} */ const averts = [];
  let courant = null;

  function detail(statut, texte, correction) {
    ecrire(`  ${marqueur(statut)} ${couper(texte)}`);
    if (correction) ecrire(`           ${gris(`→ ${correction}`)}`);

    if (courant && GRAVITE[statut] > GRAVITE[courant.statut]) courant.statut = statut;

    const entree = courant ? `Contrôle ${courant.numero} (${courant.titre}) : ${texte}` : texte;
    if (statut === STATUT.ECHEC) echecs.push(correction ? `${entree} → ${correction}` : entree);
    else if (statut === STATUT.AVERT) averts.push(correction ? `${entree} → ${correction}` : entree);
  }

  return {
    controles,
    echecs,
    averts,

    /** Ouvre un contrôle. Son statut démarre à « S.O. » et monte avec les détails. */
    ouvrir(numero, titre) {
      log.step(`Contrôle ${numero} — ${titre}`);
      courant = { numero, titre, statut: STATUT.SO };
      controles.push(courant);
    },

    /** Ferme le contrôle courant et affiche son verdict. */
    fermer() {
      if (!courant) return;
      ecrire(`  ${marqueur(courant.statut)} ${gris(`Contrôle ${courant.numero} : ${courant.titre}`)}`);
      courant = null;
    },

    /** Contexte neutre, sans effet sur le verdict. */
    note(texte) {
      log.info(texte);
    },

    ok: (texte) => detail(STATUT.OK, texte),
    echec: (texte, correction) => detail(STATUT.ECHEC, texte, correction),
    avert: (texte, correction) => detail(STATUT.AVERT, texte, correction),
    so: (texte) => detail(STATUT.SO, texte),
  };
}

/* ================================================================== *
 * Code de sortie
 * ================================================================== */

let sortieDejaForcee = false;

/**
 * Force le code de sortie du processus.
 *
 * Pourquoi ce détour : cli.mjs se termine par `process.exit(exitCode)` où
 * `exitCode` vaut 0 quand la commande n'a pas levé d'exception. Un simple
 * `process.exitCode = 1` serait donc écrasé. En revanche, un gestionnaire
 * `process.on('exit')` s'exécute APRÈS l'appel à process.exit() et peut encore
 * changer le code — comportement vérifié sur Node 22.
 *
 * On ne lève surtout pas d'exception à la place : « verify » qui trouve un
 * écart n'est pas un plantage de la trousse, et une exception afficherait un
 * message de panne à la place du verdict.
 */
function forcerCodeDeSortie(code) {
  if (!code) return;
  process.exitCode = code;
  if (sortieDejaForcee) return;
  sortieDejaForcee = true;
  process.on('exit', () => {
    process.exitCode = code;
  });
}

/* ================================================================== *
 * Lectures Drive (bornées au Drive partagé)
 * ================================================================== */

/**
 * Liste des fichiers d'un Drive partagé.
 *
 * Les quatre paramètres ci-dessous vont ensemble, toujours, sans exception :
 *   corpora: 'drive'          → sinon Google interroge le « Mon Drive »
 *                               personnel (c'est son défaut !) et répond
 *                               « aucun résultat » sans la moindre erreur ;
 *   driveId                   → obligatoire dès que corpora vaut 'drive' ;
 *   includeItemsFromAllDrives → sinon les Drive partagés sont ignorés ;
 *   supportsAllDrives         → sans lui, le paramètre précédent est inerte.
 */
async function listerFichiersDuDrive(driveApi, driveId, q, label) {
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

/** Tous les sous-dossiers directs d'un dossier, dans le Drive partagé. */
async function listerSousDossiers(driveApi, driveId, parentId, label) {
  const q = [
    `mimeType = '${FOLDER_MIME}'`,
    `'${escapeQuery(parentId)}' in parents`,
    'trashed = false',
  ].join(' and ');
  return listerFichiersDuDrive(driveApi, driveId, q, label);
}

/* ================================================================== *
 * Contrôle 1 — Les usagers
 * ================================================================== */

async function controleUsagers({ admin, config, rapport }) {
  rapport.ouvrir(1, "Les usagers de l'équipe");

  const equipe = Array.isArray(config.team) ? config.team : [];
  rapport.note(`${equipe.length} personne(s) déclarée(s) dans config.json (champ « team »).`);

  let actifs = 0;

  for (const membre of equipe) {
    const email = typeof membre?.email === 'string' ? membre.email.trim() : '';
    if (email === '') continue;

    let user = null;
    try {
      const { data } = await withRetry(
        () => admin.users.get({ userKey: email, projection: 'basic', fields: USER_FIELDS }),
        // propagation: false — ici un 404 est une RÉPONSE (« ce compte n'existe
        // pas »), pas une panne. Sans ça, chaque absence attendrait des minutes.
        { tries: 3, propagation: false, label: `lecture du compte ${email}` },
      );
      user = data;
    } catch (error) {
      if (isNotFound(error)) {
        rapport.echec(
          `${email} n'existe pas dans l'annuaire du domaine.`,
          'Créer le compte : console.admin.google.com > Annuaire > Utilisateurs > Ajouter. ' +
            'La trousse ne crée pas les comptes (chacun consomme une licence payante). ' +
            'Puis relancer : node src/cli.mjs setup --apply',
        );
        continue;
      }
      rapport.echec(`${email} — lecture impossible. ${messageCourt(error)}`, 'node src/cli.mjs doctor');
      continue;
    }

    const nom = user?.name?.fullName ?? membre?.name ?? '';
    const etiquette = nom ? `${email} (${nom})` : email;

    if (user?.suspended === true) {
      const raison = user?.suspensionReason ? ` Motif indiqué par Google : ${user.suspensionReason}.` : '';
      rapport.echec(
        `${etiquette} — compte SUSPENDU : cette personne n'a accès à rien.${raison}`,
        `Réactiver : console.admin.google.com > Annuaire > Utilisateurs > ${email} > Autres options > Réactiver`,
      );
      continue;
    }

    if (user?.archived === true) {
      rapport.avert(
        `${etiquette} — compte ARCHIVÉ : les données sont conservées, mais la personne ne peut pas se connecter.`,
        'Désarchiver dans la console si cette personne doit travailler : ' +
          'console.admin.google.com > Annuaire > Utilisateurs',
      );
      continue;
    }

    actifs += 1;
    rapport.ok(`${etiquette} — compte actif.`);
  }

  if (equipe.length > 0 && actifs === equipe.length) {
    rapport.note(`Les ${actifs} comptes de l'équipe sont en règle.`);
  }

  rapport.fermer();
}

/* ================================================================== *
 * Contrôle 2 — Le groupe
 * ================================================================== */

async function listerMembresDuGroupe(admin, groupKey) {
  return collectPages(
    (pageToken) =>
      admin.members.list({
        groupKey,
        maxResults: MEMBERS_PAGE_SIZE,
        includeDerivedMembership: false,
        pageToken,
        fields: MEMBER_LIST_FIELDS,
      }),
    { itemsKey: 'members', label: `lecture des membres de ${groupKey}` },
  );
}

async function controleGroupe({ admin, config, rapport }) {
  rapport.ouvrir(2, "Le groupe d'équipe");

  if (!config.group?.email) {
    rapport.so(
      "Aucun groupe n'est configuré (« group » vaut null dans config.json) : les accès sont accordés " +
        "directement aux adresses de l'équipe. Les contrôles 3 et 5 les vérifient une par une.",
    );
    rapport.fermer();
    return { membres: null };
  }

  const groupEmail = config.group.email;

  let groupe = null;
  try {
    const { data } = await withRetry(() => admin.groups.get({ groupKey: groupEmail, fields: GROUP_FIELDS }), {
      tries: 3,
      propagation: false,
      label: `lecture du groupe ${groupEmail}`,
    });
    groupe = data;
  } catch (error) {
    if (isNotFound(error)) {
      rapport.echec(`Le groupe ${groupEmail} n'existe pas.`, 'node src/cli.mjs group --apply');
    } else {
      rapport.echec(
        `Groupe ${groupEmail} — lecture impossible. ${messageCourt(error)}`,
        'node src/cli.mjs doctor',
      );
    }
    rapport.fermer();
    return { membres: null };
  }

  rapport.ok(`Le groupe ${groupEmail} existe (« ${groupe?.name ?? groupEmail} »).`);

  /** @type {Array<object>} */
  let membres = [];
  try {
    membres = await listerMembresDuGroupe(admin, groupEmail);
  } catch (error) {
    rapport.echec(
      `Impossible de lire les membres de ${groupEmail}. ${messageCourt(error)}`,
      'node src/cli.mjs doctor',
    );
    rapport.fermer();
    return { membres: null };
  }

  /** @type {Map<string, object>} */
  const parAdresse = new Map();
  for (const membre of membres) {
    const email = lower(membre?.email);
    if (email) parAdresse.set(email, membre);
  }

  const attendues = new Set();
  let conformes = 0;

  for (const personne of config.team ?? []) {
    const email = typeof personne?.email === 'string' ? personne.email.trim() : '';
    if (email === '') continue;
    attendues.add(lower(email));

    const trouve = parAdresse.get(lower(email));
    if (!trouve) {
      rapport.echec(
        `${email} ne fait PAS partie du groupe ${groupEmail} : cette personne n'a donc ni le calendrier, ` +
          'ni le Drive partagé.',
        'node src/cli.mjs group --apply',
      );
      continue;
    }

    const statutMembre = String(trouve.status ?? '').toUpperCase();
    if (statutMembre && statutMembre !== 'ACTIVE') {
      rapport.avert(
        `${email} est dans le groupe mais son statut est « ${statutMembre} » et non « ACTIVE ».`,
        'Vérifier le compte dans console.admin.google.com > Annuaire > Utilisateurs',
      );
      continue;
    }

    const roleActuel = String(trouve.role ?? 'MEMBER').toUpperCase();
    const roleVoulu = roleGroupeAttendu(personne?.role);
    const rangActuel = GROUP_ROLE_RANK[roleActuel] ?? 0;
    const rangVoulu = GROUP_ROLE_RANK[roleVoulu] ?? 0;

    if (roleActuel === roleVoulu) {
      conformes += 1;
      rapport.ok(`${email} est membre du groupe avec le rôle attendu (${roleActuel}).`);
    } else if (rangActuel > rangVoulu) {
      conformes += 1;
      rapport.avert(
        `${email} est ${roleActuel} dans le groupe, alors que config.json le déclare « ${personne?.role} » ` +
          `(soit ${roleVoulu}). C'est PLUS de droits que prévu — la trousse ne rétrograde jamais personne.`,
        `Si c'est voulu, corriger « role » pour ${email} dans config.json. Sinon, rétrograder à la main : ` +
          'console.admin.google.com > Annuaire > Groupes',
      );
    } else {
      rapport.echec(
        `${email} est ${roleActuel} dans le groupe, alors qu'il devrait être ${roleVoulu} ` +
          `(config.json le déclare « ${personne?.role} »).`,
        'node src/cli.mjs group --apply',
      );
    }
  }

  /* --- Les membres en trop : signalés, jamais retirés automatiquement --- */
  const extras = [];
  for (const [email, membre] of parAdresse) {
    if (attendues.has(email)) continue;
    extras.push({ email, role: String(membre?.role ?? 'MEMBER').toUpperCase(), type: membre?.type ?? 'USER' });
  }

  if (extras.length === 0) {
    rapport.ok(`Le groupe contient exactement les ${attendues.size} personne(s) de config.json, ni plus ni moins.`);
  } else {
    for (const extra of extras) {
      const personnel = lower(config.personalEmail) !== '' && lower(config.personalEmail) === extra.email;
      const quoi = extra.type === 'GROUP' ? 'un autre groupe' : 'une adresse';
      rapport.avert(
        `${extra.email} est membre du groupe (${extra.role}, ${quoi}) mais n'apparaît pas dans « team » ` +
          `de config.json.${personnel ? " C'est l'adresse personnelle — voir le contrôle 8." : ''}`,
        personnel
          ? 'node src/cli.mjs detach --apply'
          : "Soit l'ajouter à « team » dans config.json, soit la retirer à la main : " +
            `console.admin.google.com > Annuaire > Groupes > ${groupEmail} > Membres. ` +
            "La trousse ne retire JAMAIS personne d'un groupe toute seule.",
      );
    }
  }

  rapport.note(
    `${membres.length} membre(s) au total dans le groupe · ${conformes}/${attendues.size} attendu(s) présent(s) · ` +
      `${extras.length} en trop.`,
  );

  rapport.fermer();
  return { membres };
}

/* ================================================================== *
 * Contrôle 3 — Les calendriers et leurs partages
 * ================================================================== */

/** Relit un calendrier par son identifiant. null s'il n'existe plus. */
async function lireCalendrier(calendarApi, calendarId) {
  try {
    const { data } = await withRetry(() => calendarApi.calendars.get({ calendarId, fields: CALENDAR_FIELDS }), {
      tries: 3,
      propagation: false,
      label: `lecture du calendrier ${calendarId}`,
    });
    return data ?? null;
  } catch (error) {
    const status = errorInfo(error)?.status;
    if (isNotFound(error) || status === 410) return null;
    throw error;
  }
}

/**
 * Cherche un calendrier par son nom dans la liste du compte propriétaire.
 * showHidden: true est impératif — une entrée masquée existe quand même, et
 * sans ce paramètre on croirait le calendrier disparu.
 */
async function chercherCalendriersParNom(calendarApi, summary) {
  const items = await collectPages(
    (pageToken) =>
      calendarApi.calendarList.list({
        maxResults: CALENDAR_PAGE_SIZE,
        showHidden: true,
        showDeleted: false,
        minAccessRole: 'owner',
        fields: CALENDAR_LIST_FIELDS,
        pageToken,
      }),
    { itemsKey: 'items', label: 'lecture de la liste des calendriers' },
  );

  const voulu = lower(summary);
  return items.filter((entry) => !entry?.primary && !entry?.deleted && lower(entry?.summary) === voulu);
}

/** Les accès attendus sur un calendrier : le groupe, ou chaque adresse. */
function accesAttendus(config, spec) {
  if (config.group?.email) {
    return [{ type: 'group', value: config.group.email, role: spec.role }];
  }
  return (config.team ?? [])
    .map((membre) => (typeof membre?.email === 'string' ? membre.email.trim() : ''))
    .filter((email) => email !== '')
    .map((email) => ({ type: 'user', value: email, role: spec.role }));
}

async function controleCalendriers({ calendarApi, config, state, rapport }) {
  rapport.ouvrir(3, 'Les calendriers partagés et leurs accès');

  /** @type {Array<{ spec: object, id: string|null }>} */
  const resolus = [];
  const calendriers = Array.isArray(config.calendars) ? config.calendars : [];

  if (calendriers.length === 0) {
    rapport.so("Aucun calendrier n'est décrit dans config.json (« calendars » est vide).");
    rapport.fermer();
    return { resolus };
  }

  for (const spec of calendriers) {
    let calendrier = null;

    /* --- 1. Raccourci par le cache, puis RELECTURE via l'API --------- */
    const idCache = getStateKey(state, ['calendars', spec.key], null);
    if (typeof idCache === 'string' && idCache !== '') {
      try {
        calendrier = await lireCalendrier(calendarApi, idCache);
      } catch (error) {
        rapport.echec(
          `Calendrier « ${spec.summary} » — lecture impossible. ${messageCourt(error)}`,
          'node src/cli.mjs doctor',
        );
        resolus.push({ spec, id: null });
        continue;
      }
      if (!calendrier) {
        rapport.note(
          `Le cache local pointait sur ${idCache} pour « ${spec.summary} », mais ce calendrier n'existe ` +
            'plus chez Google. On repart de la recherche par nom.',
        );
      }
    }

    /* --- 2. Sinon, recherche par nom --------------------------------- */
    if (!calendrier) {
      let correspondances = [];
      try {
        correspondances = await chercherCalendriersParNom(calendarApi, spec.summary);
      } catch (error) {
        rapport.echec(
          `Calendrier « ${spec.summary} » — recherche impossible. ${messageCourt(error)}`,
          'node src/cli.mjs doctor',
        );
        resolus.push({ spec, id: null });
        continue;
      }

      if (correspondances.length > 1) {
        const choisi = [...correspondances].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
        rapport.avert(
          `${correspondances.length} calendriers portent le nom « ${spec.summary} » ` +
            `(${enumerer(correspondances.map((c) => c.id))}). Une partie de l'équipe pourrait regarder le mauvais.`,
          'À corriger à la main : supprimer les calendriers en trop dans Google Agenda ' +
            "(la trousse n'en supprime jamais aucun).",
        );
        calendrier = await lireCalendrier(calendarApi, choisi.id).catch(() => null);
      } else if (correspondances.length === 1) {
        calendrier = await lireCalendrier(calendarApi, correspondances[0].id).catch(() => null);
      }
    }

    if (!calendrier?.id) {
      rapport.echec(`Le calendrier « ${spec.summary} » n'existe pas.`, 'node src/cli.mjs calendar --apply');
      resolus.push({ spec, id: null });
      continue;
    }

    rapport.ok(`Le calendrier « ${spec.summary} » existe (${calendrier.id}).`);
    resolus.push({ spec, id: calendrier.id });

    /* --- Le fuseau horaire ------------------------------------------- */
    const tzVoulu = canonTz(spec.timeZone);
    const tzActuel = canonTz(calendrier.timeZone);
    if (tzVoulu && tzActuel && tzVoulu !== tzActuel) {
      rapport.avert(
        `« ${spec.summary} » est réglé sur le fuseau ${tzActuel} au lieu de ${tzVoulu} : ` +
          'les heures affichées peuvent être décalées.',
        'node src/cli.mjs calendar --apply',
      );
    }

    /* --- Les partages (ACL) ------------------------------------------ */
    let regles = [];
    try {
      regles = await collectPages(
        (pageToken) =>
          calendarApi.acl.list({
            calendarId: calendrier.id,
            maxResults: CALENDAR_PAGE_SIZE,
            fields: ACL_FIELDS,
            pageToken,
          }),
        { itemsKey: 'items', label: `lecture des partages de « ${spec.summary} »` },
      );
    } catch (error) {
      rapport.echec(
        `Partages de « ${spec.summary} » illisibles. ${messageCourt(error)}`,
        'node src/cli.mjs doctor',
      );
      continue;
    }

    /** @type {Map<string, object>} */
    const parScope = new Map();
    for (const regle of regles) {
      parScope.set(aclKey(regle?.scope?.type, regle?.scope?.value ?? ''), regle);
    }

    for (const voulu of accesAttendus(config, spec)) {
      const trouve = parScope.get(aclKey(voulu.type, voulu.value));
      const qui = voulu.type === 'group' ? `le groupe ${voulu.value}` : voulu.value;

      if (!trouve) {
        rapport.echec(
          `${qui} n'a AUCUN accès au calendrier « ${spec.summary} ».`,
          'node src/cli.mjs calendar --apply',
        );
        continue;
      }

      const rangActuel = CALENDAR_ROLE_RANK[trouve.role] ?? 0;
      const rangVoulu = CALENDAR_ROLE_RANK[voulu.role] ?? 0;
      const libelleActuel = CALENDAR_ROLE_LABELS[trouve.role] ?? trouve.role;
      const libelleVoulu = CALENDAR_ROLE_LABELS[voulu.role] ?? voulu.role;

      if (trouve.role === voulu.role) {
        rapport.ok(`${qui} a bien l'accès « ${libelleVoulu} » sur « ${spec.summary} ».`);
      } else if (rangActuel > rangVoulu) {
        rapport.avert(
          `${qui} a « ${libelleActuel} » sur « ${spec.summary} », soit PLUS que le « ${libelleVoulu} » prévu. ` +
            "La trousse ne retire jamais un accès à personne.",
          `Si c'est voulu, ajuster « role » du calendrier « ${spec.key} » dans config.json. ` +
            'Sinon, corriger à la main dans Google Agenda > Paramètres du calendrier > Partager.',
        );
      } else {
        rapport.echec(
          `${qui} n'a que « ${libelleActuel} » sur « ${spec.summary} », alors qu'il faut « ${libelleVoulu} ».`,
          'node src/cli.mjs calendar --apply',
        );
      }
    }

    /* --- Le calendrier est-il public ? -------------------------------- */
    const publique = parScope.get(aclKey('default', ''));
    if (publique && publique.role && publique.role !== 'none') {
      rapport.avert(
        `« ${spec.summary} » est partagé avec la portée « default », c'est-à-dire avec TOUT INTERNET ` +
          `(rôle : ${CALENDAR_ROLE_LABELS[publique.role] ?? publique.role}).`,
        'À retirer à la main : Google Agenda > Paramètres du calendrier > ' +
          '« Rendre disponible publiquement » à décocher.',
      );
    }
  }

  rapport.fermer();
  return { resolus };
}

/* ================================================================== *
 * Contrôle 4 — Le calendrier est-il DANS l'agenda de chacun ?
 * ================================================================== */

/**
 * C'est LE contrôle qui prouve le « zéro manipulation ».
 *
 * Deux ressources différentes, souvent confondues :
 *   - l'ACL (contrôle 3)  = l'autorisation, côté calendrier ;
 *   - la calendarList     = l'abonnement, côté personne.
 * Avoir le droit de voir un calendrier ne le fait PAS apparaître dans Google
 * Agenda. Sans cet abonnement, chaque personne devrait l'ajouter à la main —
 * exactement ce que le client ne veut pas.
 */
async function controleAgendas({ config, calendriersResolus, rapport }) {
  rapport.ouvrir(4, "Le calendrier apparaît dans l'agenda de chaque personne");

  const mode = config?.auth?.mode ?? 'service-account';
  if (mode !== 'service-account') {
    rapport.so(
      `Mode d'authentification « ${mode} » : impossible de regarder l'agenda de quelqu'un d'autre. ` +
        "Seul le mode « compte de service » (avec délégation à l'échelle du domaine) permet de le vérifier — " +
        "et de le faire, d'ailleurs.",
    );
    rapport.note("Pour obtenir le « zéro manipulation », passer auth.mode à « service-account » dans config.json.");
    rapport.fermer();
    return;
  }

  const existants = (calendriersResolus ?? []).filter((c) => c.id);
  if (existants.length === 0) {
    rapport.so("Aucun calendrier n'a pu être retrouvé au contrôle 3 : rien à vérifier ici.");
    rapport.fermer();
    return;
  }

  const personnes = (config.team ?? [])
    .map((membre) => (typeof membre?.email === 'string' ? membre.email.trim() : ''))
    .filter((email) => email !== '');

  if (personnes.length === 0) {
    rapport.so("Aucune personne dans « team » : rien à vérifier.");
    rapport.fermer();
    return;
  }

  rapport.note(
    `${personnes.length} personne(s) × ${existants.length} calendrier(s) : on emprunte l'identité de chacun ` +
      "pour lire sa liste d'agendas.",
  );

  for (const email of personnes) {
    /** @type {object|null} */
    let calendarAsUser = null;
    try {
      const clients = await getClients({ config, subject: email, scopes: SCOPES.calendar });
      calendarAsUser = clients.calendar;
    } catch (error) {
      rapport.echec(
        `Impossible d'agir au nom de ${email}. ${messageCourt(error)}`,
        "Vérifier que la délégation à l'échelle du domaine inclut " +
          '« https://www.googleapis.com/auth/calendar » (copie exacte, sans espace), ' +
          'puis : node src/cli.mjs doctor',
      );
      continue;
    }

    for (const { spec, id } of existants) {
      try {
        const { data } = await withRetry(
          () => calendarAsUser.calendarList.get({ calendarId: id, fields: CALENDAR_LIST_ENTRY_FIELDS }),
          { tries: 3, propagation: false, label: `lecture de l'agenda de ${email}` },
        );

        const visible = data?.selected === true && data?.hidden !== true;
        if (visible) {
          rapport.ok(`${email} voit « ${spec.summary} » dans son Google Agenda (coché et visible).`);
        } else {
          const cause = data?.hidden === true ? 'il est MASQUÉ' : 'il est DÉCOCHÉ';
          rapport.avert(
            `${email} a bien « ${spec.summary} » dans sa liste, mais ${cause} : les événements ` +
              "n'apparaissent pas dans sa grille.",
            'node src/cli.mjs calendar --apply',
          );
        }
      } catch (error) {
        const info = errorInfo(error);
        if (isNotFound(error)) {
          rapport.echec(
            `${email} n'a PAS « ${spec.summary} » dans son Google Agenda : cette personne devrait ` +
              "l'ajouter à la main, c'est exactement ce qu'on veut éviter.",
            'node src/cli.mjs calendar --apply',
          );
        } else if (isForbidden(error)) {
          rapport.echec(
            `Google refuse de lire l'agenda de ${email}. ${info.message}`,
            "Vérifier que ce compte existe, n'est pas suspendu, appartient bien au domaine, et que la " +
              'délégation inclut « https://www.googleapis.com/auth/calendar ». Puis : node src/cli.mjs doctor',
          );
        } else {
          rapport.echec(
            `Agenda de ${email} — vérification impossible pour « ${spec.summary} ». ${info.message}`,
            'node src/cli.mjs doctor',
          );
        }
      }

      await sleep(IMPERSONATION_DELAY_MS);
    }
  }

  rapport.fermer();
}

/* ================================================================== *
 * Contrôle 5 — Le Drive partagé
 * ================================================================== */

/**
 * Liste tous les Drive partagés visibles.
 * On tente d'abord en accès administrateur de domaine, qui voit TOUS les Drive.
 * Sans ce mode, on ne voit que ceux dont le compte impersonné est membre — et
 * un Drive créé par quelqu'un d'autre resterait invisible.
 */
async function listerDrivesPartages(driveApi) {
  const lire = (useDomainAdminAccess) =>
    collectPages(
      (pageToken) =>
        driveApi.drives.list({
          pageSize: DRIVE_PAGE_SIZE,
          useDomainAdminAccess,
          pageToken,
          fields: DRIVE_LIST_FIELDS,
        }),
      { itemsKey: 'drives', label: 'lecture de la liste des Drive partagés' },
    );

  try {
    return { drives: await lire(true), asAdmin: true };
  } catch (error) {
    if (!isForbidden(error)) throw error;
    return { drives: await lire(false), asAdmin: false };
  }
}

/** Relit un Drive partagé par son identifiant. null s'il n'existe plus. */
async function lireDrivePartage(driveApi, driveId, asAdmin) {
  try {
    const { data } = await withRetry(
      () => driveApi.drives.get({ driveId, useDomainAdminAccess: asAdmin, fields: DRIVE_FIELDS }),
      { tries: 3, propagation: false, label: `lecture du Drive partagé ${driveId}` },
    );
    return data ?? null;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (isForbidden(error) && asAdmin) return lireDrivePartage(driveApi, driveId, false);
    throw error;
  }
}

/** Les membres attendus du Drive partagé : le groupe, ou chaque adresse. */
/**
 * Cette adresse est-elle celle d'un membre de l'équipe décrite dans config.json ?
 *
 * Sert à distinguer « quelqu'un d'inconnu a un accès » (à signaler) de « une
 * personne de l'équipe a un accès direct en plus de celui du groupe » (normal).
 * Comparaison insensible à la casse : Google renvoie l'adresse avec la casse
 * saisie à l'inscription (« Greg@... »), alors que l'annuaire la normalise en
 * minuscules — les deux désignent le même compte.
 */
function estDansEquipe(config, adresse) {
  const cible = lower(adresse);
  if (cible === '') return false;
  return (config?.team ?? []).some((membre) => lower(membre?.email) === cible);
}

function membresDriveAttendus(config) {
  if (config.group?.email) {
    return [
      {
        type: 'group',
        email: config.group.email,
        role: 'organizer',
        label: `le groupe ${config.group.email}`,
      },
    ];
  }

  const personnel = lower(config.personalEmail);
  const vus = new Set();
  const out = [];

  for (const membre of config.team ?? []) {
    const email = typeof membre?.email === 'string' ? membre.email.trim() : '';
    if (email === '' || vus.has(lower(email))) continue;
    // L'adresse personnelle n'a rien à faire dans le Drive de l'entreprise : la
    // commande « drive » ne l'inscrit pas, donc on ne l'attend pas non plus.
    if (personnel !== '' && lower(email) === personnel) continue;
    vus.add(lower(email));
    out.push({
      type: 'user',
      email,
      role: roleDriveAttendu(membre?.role),
      label: membre?.name ? `${membre.name} <${email}>` : email,
    });
  }

  return out;
}

async function controleDrive({ driveApi, config, state, rapport }) {
  rapport.ouvrir(5, 'Le Drive partagé, ses réglages et ses membres');

  const nomVoulu = config?.sharedDrive?.name;
  let asAdmin = true;
  let drive = null;

  /* --- 1. Raccourci par le cache, puis RELECTURE via l'API ----------- */
  const idCache = getStateKey(state, 'driveId', null);
  if (typeof idCache === 'string' && idCache !== '') {
    try {
      drive = await lireDrivePartage(driveApi, idCache, true);
      if (!drive) {
        rapport.note(
          `Le cache local pointait sur le Drive ${idCache}, mais il n'existe plus chez Google. ` +
            'On repart de la recherche par nom.',
        );
      }
    } catch (error) {
      rapport.note(`Vérification du Drive du cache impossible (${messageCourt(error)}). Recherche par nom.`);
    }
  }

  /* --- 2. Sinon, recherche par nom ----------------------------------- */
  if (!drive) {
    let listing;
    try {
      listing = await listerDrivesPartages(driveApi);
    } catch (error) {
      rapport.echec(
        `Impossible de lister les Drive partagés. ${messageCourt(error)}`,
        'node src/cli.mjs doctor',
      );
      rapport.fermer();
      return { driveId: null, asAdmin: true, permissions: [] };
    }

    asAdmin = listing.asAdmin;
    if (!asAdmin) {
      rapport.note(
        `${config.adminEmail} n'a pas l'accès administrateur Drive : on ne voit que les Drive dont ce ` +
          'compte est déjà membre. La vérification reste valable, mais elle est partielle.',
      );
    }

    const correspondances = listing.drives.filter((d) => lower(d?.name) === lower(nomVoulu));

    if (correspondances.length > 1) {
      const choisi = [...correspondances].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
      rapport.avert(
        `${correspondances.length} Drive partagés portent le nom « ${nomVoulu} » ` +
          `(${enumerer(correspondances.map((d) => d.id))}). L'équipe risque de déposer ses documents ` +
          'dans le mauvais.',
        'À corriger à la main dans Google Drive : fusionner ou supprimer les Drive en trop ' +
          "(la trousse n'en supprime jamais aucun).",
      );
      drive = choisi;
    } else if (correspondances.length === 1) {
      drive = correspondances[0];
    }
  }

  if (!drive?.id) {
    rapport.echec(`Le Drive partagé « ${nomVoulu} » n'existe pas.`, 'node src/cli.mjs drive --apply');
    rapport.fermer();
    return { driveId: null, asAdmin, permissions: [] };
  }

  const driveId = drive.id;
  rapport.ok(`Le Drive partagé « ${drive.name ?? nomVoulu} » existe (${driveId}).`);

  /* --- Les restrictions de partage ----------------------------------- */
  const voulues = config?.sharedDrive?.restrictions ?? {};
  const actuelles = drive?.restrictions ?? null;

  if (!actuelles) {
    rapport.avert(
      "Google n'a pas retourné les réglages de partage du Drive : impossible de les vérifier.",
      'node src/cli.mjs audit',
    );
  } else {
    for (const [cle, valeurVoulue] of Object.entries(voulues)) {
      if (typeof valeurVoulue !== 'boolean') continue;
      const libelle = RESTRICTION_LABELS[cle] ?? cle;
      const valeurActuelle = actuelles[cle];

      if (valeurActuelle === valeurVoulue) {
        rapport.ok(`Réglage « ${libelle} » : ${valeurVoulue ? 'activé' : 'désactivé'}, comme prévu.`);
      } else {
        const etat =
          valeurActuelle === true ? 'activé' : valeurActuelle === false ? 'désactivé' : 'non défini';
        rapport.echec(
          `Réglage « ${libelle} » : ${etat} alors que config.json demande ` +
            `${valeurVoulue ? 'activé' : 'désactivé'}.`,
          'node src/cli.mjs drive --apply',
        );
      }
    }
  }

  /* --- Les membres du Drive ------------------------------------------ */
  /** @type {Array<object>} */
  let permissions = [];
  try {
    permissions = await collectPages(
      (pageToken) =>
        driveApi.permissions.list({
          fileId: driveId, // l'id du Drive partagé est aussi celui de son dossier racine
          supportsAllDrives: true, // OBLIGATOIRE : sans lui, 404 sur un Drive partagé
          useDomainAdminAccess: asAdmin,
          pageSize: DRIVE_PAGE_SIZE,
          pageToken,
          fields: PERMISSION_LIST_FIELDS,
        }),
      { itemsKey: 'permissions', label: 'lecture des membres du Drive partagé' },
    );
  } catch (error) {
    rapport.echec(
      `Impossible de lire les membres du Drive partagé. ${messageCourt(error)}`,
      'node src/cli.mjs doctor',
    );
    rapport.fermer();
    return { driveId, asAdmin, permissions: [] };
  }

  /** @type {Map<string, object>} */
  const parCle = new Map();
  for (const permission of permissions) {
    if (permission?.deleted === true) continue;
    parCle.set(permKey(permission), permission);
  }

  const attendus = membresDriveAttendus(config);
  const clesAttendues = new Set(attendus.map((a) => `${a.type}:${lower(a.email)}`));

  for (const voulu of attendus) {
    const trouve = parCle.get(`${voulu.type}:${lower(voulu.email)}`);
    if (!trouve) {
      rapport.echec(`${voulu.label} n'est PAS membre du Drive partagé.`, 'node src/cli.mjs drive --apply');
      continue;
    }

    const rangActuel = DRIVE_ROLE_RANK[trouve.role] ?? 0;
    const rangVoulu = DRIVE_ROLE_RANK[voulu.role] ?? 0;
    const libelleActuel = DRIVE_ROLE_LABELS[trouve.role] ?? trouve.role;
    const libelleVoulu = DRIVE_ROLE_LABELS[voulu.role] ?? voulu.role;

    if (trouve.role === voulu.role) {
      rapport.ok(`${voulu.label} est membre du Drive comme « ${libelleVoulu} », comme prévu.`);
    } else if (rangActuel > rangVoulu) {
      rapport.avert(
        `${voulu.label} est « ${libelleActuel} » sur le Drive, soit PLUS que le « ${libelleVoulu} » prévu. ` +
          'La trousse ne rétrograde jamais personne.',
        "Si c'est voulu, ne rien faire. Sinon, corriger à la main dans Google Drive > le Drive partagé > " +
          'Gérer les membres.',
      );
    } else {
      rapport.echec(
        `${voulu.label} n'est que « ${libelleActuel} » sur le Drive, alors qu'il faut « ${libelleVoulu} ».`,
        'node src/cli.mjs drive --apply',
      );
    }
  }

  /* --- Les membres en trop -------------------------------------------- */
  const personnel = lower(config.personalEmail);
  for (const [cle, permission] of parCle) {
    if (clesAttendues.has(cle)) continue;

    const adresse = permission?.emailAddress ?? permission?.domain ?? '(tout le monde)';
    const libelleRole = DRIVE_ROLE_LABELS[permission?.role] ?? permission?.role;

    if (permission?.type === 'anyone') {
      rapport.avert(
        `Le Drive partagé est accessible à « tout le monde » (rôle : ${libelleRole}). ` +
          "C'est le contraire de ce que config.json demande.",
        'À retirer à la main : Google Drive > le Drive partagé > Gérer les membres.',
      );
      continue;
    }

    if (permission?.type === 'domain') {
      rapport.avert(
        `Tout le domaine ${adresse} a accès au Drive partagé (rôle : ${libelleRole}), alors que ` +
          "config.json ne prévoit que l'équipe.",
        'À retirer à la main : Google Drive > le Drive partagé > Gérer les membres.',
      );
      continue;
    }

    if (personnel !== '' && lower(adresse) === personnel) {
      rapport.echec(
        `L'adresse personnelle ${adresse} est membre du Drive partagé de l'entreprise (rôle : ${libelleRole}).`,
        'node src/cli.mjs detach --apply',
      );
      continue;
    }

    // Cas courant et parfaitement normal : les accès de l'équipe passent par le
    // groupe, donc seul le groupe est « attendu » comme membre. Mais Google fait
    // AUTOMATIQUEMENT gestionnaire la personne qui crée le Drive partagé, et ce
    // droit direct s'ajoute à celui qu'elle a déjà via le groupe. Cette personne
    // est bien dans config.json (dans « team ») : dire qu'elle n'y est pas serait
    // faux et inquiétant pour rien.
    if (permission?.type === 'user' && estDansEquipe(config, adresse)) {
      rapport.ok(
        `${adresse} a aussi un accès direct au Drive (rôle : ${libelleRole}), en plus de celui ` +
          "qu'il a par le groupe. C'est normal : Google donne ce droit à la personne qui crée le " +
          'Drive partagé. Sans conséquence, rien à faire.',
      );
      continue;
    }

    rapport.avert(
      `${adresse} est membre du Drive partagé (rôle : ${libelleRole}) mais ne fait partie ` +
        "ni du groupe d'équipe, ni de « team » dans config.json.",
      "Soit l'ajouter à « team » dans config.json, soit le retirer à la main : " +
        'Google Drive > le Drive partagé > Gérer les membres. La trousse ne retire JAMAIS un accès.',
    );
  }

  rapport.fermer();
  return { driveId, asAdmin, permissions };
}

/* ================================================================== *
 * Contrôle 6 — L'arborescence de dossiers
 * ================================================================== */

/** Compte les descendants d'un dossier manquant, sans appeler l'API. */
function compterDescendants(children, cheminParent, stats) {
  for (const enfant of children ?? []) {
    const nom = enfant?.name;
    if (typeof nom !== 'string' || nom.trim() === '') continue;
    const chemin = `${cheminParent}/${nom}`;
    stats.attendus += 1;
    stats.manquants.push(chemin);
    compterDescendants(enfant?.children, chemin, stats);
  }
}

/**
 * Parcourt l'arborescence décrite dans config.json, niveau par niveau.
 *
 * Une seule requête par dossier parent (on liste TOUS ses sous-dossiers d'un
 * coup), ce qui permet de repérer les DOUBLONS — impossible à voir avec une
 * recherche par nom, qui ne retourne que le premier résultat.
 */
async function parcourirArborescence({ driveApi, driveId, specs, parentId, cheminParent, stats, rapport }) {
  /** @type {Array<object>} */
  let enfants = [];
  try {
    enfants = await listerSousDossiers(
      driveApi,
      driveId,
      parentId,
      `lecture du contenu de « ${cheminParent || 'la racine'} »`,
    );
  } catch (error) {
    for (const spec of specs ?? []) {
      stats.illisibles.push(`${cheminParent}/${spec?.name}`);
    }
    rapport.echec(
      `Impossible de lire le contenu de « ${cheminParent || 'la racine du Drive'} ». ${messageCourt(error)}`,
      'node src/cli.mjs doctor',
    );
    return;
  }

  /** @type {Map<string, object[]>} regroupement par nom exact */
  const parNom = new Map();
  for (const enfant of enfants) {
    const nom = String(enfant?.name ?? '');
    if (!parNom.has(nom)) parNom.set(nom, []);
    parNom.get(nom).push(enfant);
  }

  const nomsAttendus = new Set();

  for (const spec of specs ?? []) {
    const nom = spec?.name;
    if (typeof nom !== 'string' || nom.trim() === '') continue;
    nomsAttendus.add(nom);

    const chemin = `${cheminParent}/${nom}`;
    stats.attendus += 1;

    // Drive compare les noms sans tenir compte de la casse : on cherche
    // d'abord la correspondance exacte, puis on élargit.
    let candidats = parNom.get(nom) ?? [];
    let casseDifferente = false;
    if (candidats.length === 0) {
      candidats = enfants.filter((e) => lower(e?.name) === lower(nom));
      casseDifferente = candidats.length > 0;
    }

    if (candidats.length === 0) {
      stats.manquants.push(chemin);
      // On ne descend pas : les sous-dossiers sont forcément manquants aussi.
      compterDescendants(spec?.children, chemin, stats);
      continue;
    }

    const choisi = [...candidats].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];

    if (candidats.length > 1) {
      stats.doublons.push({ chemin, ids: candidats.map((c) => c.id) });
    } else if (casseDifferente) {
      stats.casse.push({ chemin, trouve: choisi.name });
    } else {
      stats.presents += 1;
    }

    // GARDE DE SÉCURITÉ : on ne descend jamais dans un dossier qui ne serait
    // pas dans le Drive partagé visé.
    try {
      assertInSharedDrive(choisi, driveId, { action: `inspecter le dossier « ${chemin} »` });
    } catch {
      stats.illisibles.push(chemin);
      rapport.echec(
        `Refus de sécurité sur « ${chemin} » : ce dossier n'est pas dans le Drive partagé attendu.`,
        'Supprimer le cache local (.state.json) puis relancer : node src/cli.mjs verify',
      );
      continue;
    }

    if (Array.isArray(spec?.children) && spec.children.length > 0) {
      await parcourirArborescence({
        driveApi,
        driveId,
        specs: spec.children,
        parentId: choisi.id,
        cheminParent: chemin,
        stats,
        rapport,
      });
    }
  }

  // Les dossiers ajoutés par l'équipe : c'est normal et souhaitable, on les
  // compte sans en faire un reproche.
  for (const enfant of enfants) {
    if (!nomsAttendus.has(String(enfant?.name ?? ''))) {
      stats.enPlus.push(`${cheminParent}/${enfant?.name}`);
    }
  }
}

async function controleArborescence({ driveApi, driveId, config, rapport }) {
  rapport.ouvrir(6, "L'arborescence de dossiers du Drive partagé");

  if (!driveId) {
    rapport.so("Le Drive partagé n'a pas été retrouvé (contrôle 5) : impossible de vérifier ses dossiers.");
    rapport.fermer();
    return;
  }

  const specs = config?.sharedDrive?.folders ?? [];
  if (specs.length === 0) {
    rapport.so("Aucun dossier n'est décrit dans config.json (« sharedDrive.folders » est vide).");
    rapport.fermer();
    return;
  }

  const stats = {
    attendus: 0,
    presents: 0,
    manquants: [],
    doublons: [],
    casse: [],
    enPlus: [],
    illisibles: [],
  };

  // L'identifiant du Drive partagé est AUSSI celui de son dossier racine.
  await parcourirArborescence({
    driveApi,
    driveId,
    specs,
    parentId: driveId,
    cheminParent: '',
    stats,
    rapport,
  });

  /* --- Les manquants --------------------------------------------------- */
  if (stats.manquants.length === 0) {
    rapport.ok(`Les ${stats.attendus} dossier(s) prévu(s) dans config.json existent tous.`);
  } else {
    rapport.echec(
      `${stats.manquants.length} dossier(s) manquant(s) sur ${stats.attendus} : ${enumerer(stats.manquants, 8)}`,
      'node src/cli.mjs drive --apply',
    );
  }

  /* --- Les doublons : exactement ce que le client veut éviter ---------- */
  if (stats.doublons.length === 0) {
    rapport.ok('Aucun doublon : chaque dossier prévu existe en un seul exemplaire.');
  } else {
    for (const doublon of stats.doublons) {
      rapport.avert(
        `DOUBLON : ${doublon.ids.length} dossiers nommés « ${doublon.chemin} » au même endroit ` +
          `(${enumerer(doublon.ids, 4)}). Les documents vont se répartir au hasard entre les deux.`,
        'À corriger à la main dans Google Drive : déplacer le contenu dans un seul dossier, puis supprimer ' +
          "l'autre. La trousse ne supprime JAMAIS un dossier toute seule — elle réutilise toujours le même " +
          "et n'en crée pas un troisième.",
      );
    }
  }

  /* --- Les noms qui ne diffèrent que par la casse ----------------------- */
  for (const item of stats.casse) {
    rapport.avert(
      `Le dossier « ${item.chemin} » existe sous le nom « ${item.trouve} » : même dossier, casse différente.`,
      "Renommer à la main pour qu'il corresponde exactement à config.json, ou ajuster config.json.",
    );
  }

  /* --- Les dossiers ajoutés par l'équipe : neutre ------------------------ */
  if (stats.enPlus.length > 0) {
    rapport.note(
      `${stats.enPlus.length} dossier(s) présent(s) en plus de config.json : ${enumerer(stats.enPlus, 5)}. ` +
        "C'est normal — l'équipe crée ses propres dossiers. La trousse n'y touche pas.",
    );
  }

  if (stats.illisibles.length > 0) {
    rapport.note(`${stats.illisibles.length} dossier(s) n'ont pas pu être inspectés (voir les erreurs ci-dessus).`);
  }

  rapport.fermer();
}

/* ================================================================== *
 * Contrôle 7 — Le mode d'emploi
 * ================================================================== */

async function controleModeDEmploi({ driveApi, driveId, config, rapport }) {
  rapport.ouvrir(7, "Le mode d'emploi à la racine du Drive partagé");

  if (config?.sharedDrive?.createReadme === false) {
    rapport.so("config.json demande de ne pas déposer de mode d'emploi (« createReadme » vaut false).");
    rapport.fermer();
    return;
  }

  if (!driveId) {
    rapport.so("Le Drive partagé n'a pas été retrouvé (contrôle 5) : impossible de chercher le mode d'emploi.");
    rapport.fermer();
    return;
  }

  /** @type {Array<object>} */
  let racine = [];
  try {
    const q = [`'${escapeQuery(driveId)}' in parents`, 'trashed = false'].join(' and ');
    racine = await listerFichiersDuDrive(driveApi, driveId, q, 'lecture de la racine du Drive partagé');
  } catch (error) {
    rapport.echec(
      `Impossible de lire la racine du Drive partagé. ${messageCourt(error)}`,
      'node src/cli.mjs doctor',
    );
    rapport.fermer();
    return;
  }

  const exacts = racine.filter((f) => f?.name === README_NAME);

  if (exacts.length === 1) {
    rapport.ok(`Le mode d'emploi « ${README_NAME} » est bien à la racine du Drive partagé.`);
    rapport.fermer();
    return;
  }

  if (exacts.length > 1) {
    rapport.avert(
      `${exacts.length} copies du mode d'emploi « ${README_NAME} » à la racine ` +
        `(${enumerer(exacts.map((f) => f.id), 4)}).`,
      "À corriger à la main : n'en garder qu'une dans Google Drive.",
    );
    rapport.fermer();
    return;
  }

  // Pas de correspondance exacte : peut-être a-t-il simplement été renommé.
  const approchants = racine.filter(
    (f) => f?.mimeType !== FOLDER_MIME && String(f?.name ?? '').toUpperCase().includes(README_FRAGMENT),
  );

  if (approchants.length > 0) {
    rapport.avert(
      "Le mode d'emploi n'a pas son nom d'origine, mais un document ressemblant existe à la racine : " +
        `« ${approchants[0].name} ». Il a probablement été renommé.`,
      `Le renommer « ${README_NAME} », ou le laisser tel quel en sachant que ` +
        '« node src/cli.mjs drive --apply » en déposera un nouveau à côté.',
    );
    rapport.fermer();
    return;
  }

  rapport.echec(
    `Le mode d'emploi « ${README_NAME} » n'est pas à la racine du Drive partagé : personne ne sait ` +
      'où ranger quoi.',
    'node src/cli.mjs drive --apply',
  );
  rapport.fermer();
}

/* ================================================================== *
 * Contrôle 8 — L'adresse personnelle
 * ================================================================== */

/**
 * Adresses secondaires « vraies » d'un usager : ni l'adresse principale, ni un
 * alias (un alias se retire avec users.aliases.delete, pas via emails[]).
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
    out.push(String(entree.address).trim());
  }
  return out;
}

async function controlePersonnelle({
  admin,
  calendarApi,
  config,
  calendriersResolus,
  permissionsDrive,
  rapport,
}) {
  rapport.ouvrir(8, "L'adresse personnelle ne traîne plus nulle part");

  const personnel = lower(config.personalEmail);
  if (personnel === '') {
    rapport.so(
      "Aucune adresse personnelle n'est déclarée dans config.json (« personalEmail » vaut null) : " +
        'rien à chercher.',
    );
    rapport.fermer();
    return;
  }

  rapport.note(`Adresse recherchée : ${config.personalEmail}`);

  /** @type {Array<{ ou: string, quoi: string, correction: string }>} */
  const occurrences = [];

  /* --- a) L'adresse secondaire du compte client ---------------------- */
  try {
    const { data } = await withRetry(
      () => admin.customers.get({ customerKey: CUSTOMER_KEY, fields: 'alternateEmail,customerDomain' }),
      { tries: 3, propagation: false, label: 'lecture du compte client' },
    );
    if (lower(data?.alternateEmail) === personnel) {
      occurrences.push({
        ou: 'Adresse secondaire du compte Google Workspace',
        quoi: `alternateEmail = ${data.alternateEmail}`,
        correction: 'node src/cli.mjs detach --apply',
      });
    } else {
      rapport.ok(
        `L'adresse secondaire du compte est ${data?.alternateEmail ?? '(non définie)'} — ce n'est pas ` +
          "l'adresse personnelle.",
      );
    }
  } catch (error) {
    if (isForbidden(error)) {
      rapport.avert(
        "Impossible de lire l'adresse secondaire du compte : la portée « admin.directory.customer » n'est " +
          "pas déléguée au compte de service. C'est pourtant un endroit probable où dort encore l'adresse " +
          'personnelle.',
        'Ajouter « https://www.googleapis.com/auth/admin.directory.customer » à la délégation ' +
          "(console.admin.google.com > Sécurité > Contrôle des API > Délégation à l'échelle du domaine), " +
          'ou vérifier à la main : console.admin.google.com > Compte > Paramètres du compte > Profil.',
      );
    } else {
      rapport.avert(`Lecture du compte client impossible. ${messageCourt(error)}`, 'node src/cli.mjs audit');
    }
  }

  /* --- b) Les usagers du domaine ------------------------------------- */
  try {
    const usagers = await collectPages(
      (pageToken) =>
        admin.users.list({
          customer: CUSTOMER_KEY, // et non « domain » : sinon un seul domaine
          maxResults: USERS_PAGE_SIZE,
          projection: 'full',
          orderBy: 'email',
          pageToken,
          fields: USER_LIST_FIELDS,
        }),
      { itemsKey: 'users', label: "lecture de l'annuaire" },
    );

    for (const user of usagers) {
      const qui = user?.primaryEmail ?? '(usager inconnu)';

      if (lower(user?.recoveryEmail) === personnel) {
        occurrences.push({
          ou: `Adresse de récupération de ${qui}`,
          quoi: `recoveryEmail = ${user.recoveryEmail}`,
          correction: 'node src/cli.mjs detach --apply',
        });
      }

      for (const secondaire of adressesSecondaires(user)) {
        if (lower(secondaire) === personnel) {
          occurrences.push({
            ou: `Adresse secondaire du compte ${qui}`,
            quoi: `emails[] contient ${secondaire}`,
            correction: 'node src/cli.mjs detach --apply',
          });
        }
      }

      for (const a of [...(user?.aliases ?? []), ...(user?.nonEditableAliases ?? [])]) {
        if (lower(a) === personnel) {
          occurrences.push({
            ou: `Alias du compte ${qui}`,
            quoi: `alias ${a}`,
            correction:
              'Un alias ne se retire pas comme une adresse secondaire. À faire à la main : ' +
              `console.admin.google.com > Annuaire > Utilisateurs > ${qui} > ` +
              "Informations sur l'utilisateur > Alias.",
          });
        }
      }
    }
    rapport.note(`${usagers.length} compte(s) du domaine passés en revue.`);
  } catch (error) {
    rapport.avert(
      `Lecture de l'annuaire impossible : la recherche est incomplète. ${messageCourt(error)}`,
      'node src/cli.mjs doctor',
    );
  }

  /* --- c) Les groupes du domaine -------------------------------------- */
  try {
    const groupes = await collectPages(
      (pageToken) =>
        admin.groups.list({
          customer: CUSTOMER_KEY,
          maxResults: GROUPS_PAGE_SIZE,
          pageToken,
          fields: GROUP_LIST_FIELDS,
        }),
      { itemsKey: 'groups', label: 'lecture des groupes' },
    );

    for (const groupe of groupes) {
      if (lower(groupe?.email) === personnel) {
        occurrences.push({
          ou: 'Adresse du groupe',
          quoi: `le groupe ${groupe.email} porte l'adresse personnelle`,
          correction: 'À corriger à la main : console.admin.google.com > Annuaire > Groupes.',
        });
        continue;
      }
      try {
        const membres = await listerMembresDuGroupe(admin, groupe.email);
        for (const membre of membres) {
          if (lower(membre?.email) === personnel) {
            occurrences.push({
              ou: `Membre du groupe ${groupe.email}`,
              quoi: `${membre.email} (${membre.role ?? 'MEMBER'})`,
              correction: 'node src/cli.mjs detach --apply',
            });
          }
        }
      } catch (error) {
        rapport.note(`Membres de ${groupe.email} illisibles (${messageCourt(error)}) : recherche incomplète.`);
      }
    }
    rapport.note(`${groupes.length} groupe(s) du domaine passés en revue.`);
  } catch (error) {
    rapport.avert(
      `Lecture des groupes impossible : la recherche est incomplète. ${messageCourt(error)}`,
      'node src/cli.mjs doctor',
    );
  }

  /* --- d) Les partages de calendrier ----------------------------------- */
  for (const { spec, id } of calendriersResolus ?? []) {
    if (!id) continue;
    try {
      const regles = await collectPages(
        (pageToken) =>
          calendarApi.acl.list({ calendarId: id, maxResults: CALENDAR_PAGE_SIZE, fields: ACL_FIELDS, pageToken }),
        { itemsKey: 'items', label: `lecture des partages de « ${spec.summary} »` },
      );
      for (const regle of regles) {
        if (lower(regle?.scope?.value) === personnel) {
          occurrences.push({
            ou: `Partage du calendrier « ${spec.summary} »`,
            quoi: `${regle.scope.value} a l'accès « ${CALENDAR_ROLE_LABELS[regle.role] ?? regle.role} »`,
            correction: 'node src/cli.mjs detach --apply',
          });
        }
      }
    } catch (error) {
      rapport.note(`Partages de « ${spec.summary} » illisibles (${messageCourt(error)}) : recherche incomplète.`);
    }
  }

  /* --- e) Les membres du Drive partagé ---------------------------------- */
  for (const permission of permissionsDrive ?? []) {
    if (permission?.deleted === true) continue;
    if (lower(permission?.emailAddress) === personnel) {
      occurrences.push({
        ou: 'Membre du Drive partagé',
        quoi: `${permission.emailAddress} (${DRIVE_ROLE_LABELS[permission.role] ?? permission.role})`,
        correction: 'node src/cli.mjs detach --apply',
      });
    }
  }

  /* --- Verdict du contrôle 8 --------------------------------------------- */
  if (occurrences.length === 0) {
    rapport.ok(
      `${config.personalEmail} n'apparaît nulle part dans ce que l'API peut voir : ni sur le compte, ` +
        'ni dans les comptes du domaine, ni dans les groupes, ni sur les calendriers, ni sur le Drive partagé.',
    );
  } else {
    for (const occurrence of occurrences) {
      rapport.echec(`${occurrence.ou} — ${occurrence.quoi}`, occurrence.correction);
    }
  }

  /* --- Ce que l'API ne voit PAS ------------------------------------------- */
  rapport.note(
    "Attention : « nulle part » veut dire « nulle part où l'API peut regarder ». Aucune API cliente " +
      "n'existe pour la facturation Google Workspace. À vérifier à la main, une fois : " +
      'console.admin.google.com > Facturation > Comptes de paiement > Contacts de paiement, et ' +
      'payments.google.com > Paramètres > Utilisateurs de paiement. ' +
      'Le détail complet est dans : node src/cli.mjs audit',
  );

  rapport.fermer();
}

/* ================================================================== *
 * La commande
 * ================================================================== */

/**
 * @param {{ config: any, apply: boolean, state: any, log: any }} ctx
 * @returns {Promise<{created: string[], updated: string[], unchanged: string[], warnings: string[]}>}
 */
export async function run({ config, apply, state, log }) {
  if (apply) {
    log.info("L'option --apply n'a aucun effet ici : « verify » est en lecture seule et ne modifie jamais rien.");
  }

  log.info(
    'On relit tout chez Google et on compare avec config.json. Le cache local ne sert que de raccourci : ' +
      "chaque identifiant trouvé est vérifié via l'API, et tout ce qui manque est recherché par son nom.",
  );

  const rapport = creerRapport(log);

  /* --- Un seul jeu de clients, en empruntant le compte administrateur --- */
  let clients;
  try {
    clients = await getClients({ config, subject: config.adminEmail, scopes: ALL_SCOPES });
  } catch (error) {
    log.err(expliquer(error, `connexion à Google en tant que ${config.adminEmail}`));
    log.info("Aucun contrôle n'a pu être fait. Commence par : node src/cli.mjs doctor");
    forcerCodeDeSortie(1);
    return {
      created: [],
      updated: [],
      unchanged: [],
      warnings: [`ÉCHEC — connexion à Google impossible : ${messageCourt(error)} → node src/cli.mjs doctor`],
    };
  }

  const { admin, calendar: calendarApi, drive: driveApi } = clients;

  /* --- Les huit contrôles, dans l'ordre ---------------------------------- */
  await controleUsagers({ admin, config, rapport });
  await controleGroupe({ admin, config, rapport });

  const { resolus: calendriersResolus } = await controleCalendriers({ calendarApi, config, state, rapport });

  await controleAgendas({ config, calendriersResolus, rapport });

  const { driveId, permissions } = await controleDrive({ driveApi, config, state, rapport });

  await controleArborescence({ driveApi, driveId, config, rapport });
  await controleModeDEmploi({ driveApi, driveId, config, rapport });
  await controlePersonnelle({
    admin,
    calendarApi,
    config,
    calendriersResolus,
    permissionsDrive: permissions,
    rapport,
  });

  /* --- Le verdict --------------------------------------------------------- */
  log.banner('Verdict');

  log.table(
    rapport.controles.map((c) => ({
      '#': c.numero,
      Contrôle: c.titre,
      Résultat: `[${c.statut}]`,
    })),
  );

  const nbEchecs = rapport.controles.filter((c) => c.statut === STATUT.ECHEC).length;
  const nbAverts = rapport.controles.filter((c) => c.statut === STATUT.AVERT).length;
  const nbOk = rapport.controles.filter((c) => c.statut === STATUT.OK).length;
  const nbSo = rapport.controles.filter((c) => c.statut === STATUT.SO).length;

  log.info(
    `${nbOk} contrôle(s) conforme(s) · ${nbAverts} avec avertissement · ${nbEchecs} en échec` +
      (nbSo > 0 ? ` · ${nbSo} sans objet` : ''),
  );

  const code = nbEchecs > 0 ? 1 : 0;

  if (nbEchecs > 0) {
    log.err(
      `VERDICT : NON CONFORME. ${rapport.echecs.length} problème(s) bloquant(s). Chaque ligne [${STATUT.ECHEC}] ` +
        'ci-dessus dit quoi lancer pour corriger — la plupart se règlent avec ' +
        '« node src/cli.mjs setup --apply ».',
    );
    log.info(
      "Ordre conseillé : corriger, relancer setup --apply, puis relancer verify jusqu'à ce que tout soit vert.",
    );
  } else if (nbAverts > 0) {
    log.ok(
      `VERDICT : CONFORME, avec ${rapport.averts.length} point(s) à surveiller. Tout ce que config.json ` +
        'demande est en place. Les avertissements ne bloquent rien, mais lis-les : ils signalent ce qui ' +
        'demande une décision humaine (un doublon à fusionner, un accès en trop).',
    );
  } else {
    log.ok(
      'VERDICT : TOUT EST CONFORME. Le groupe, les calendriers, les agendas de chacun, le Drive partagé, ' +
        "ses dossiers et son mode d'emploi correspondent exactement à config.json. " +
        "Personne n'a de manipulation à faire.",
    );
  }

  log.info(`Code de sortie : ${code} (0 = conforme ou simples avertissements, 1 = au moins un échec).`);
  forcerCodeDeSortie(code);

  /* --- Résumé rendu à cli.mjs --------------------------------------------- */
  return {
    created: [],
    updated: [],
    unchanged: rapport.controles
      .filter((c) => c.statut === STATUT.OK)
      .map((c) => `Contrôle ${c.numero} — ${c.titre} : conforme`),
    warnings: [
      ...rapport.echecs.map((m) => `${STATUT.ECHEC} — ${m}`),
      ...rapport.averts.map((m) => `${STATUT.AVERT} — ${m}`),
    ],
  };
}

export default { meta, run };
