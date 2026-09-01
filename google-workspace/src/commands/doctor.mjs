/**
 * doctor.mjs — Commande « doctor » : diagnostic de la configuration.
 *
 * C'EST LA PREMIÈRE COMMANDE À LANCER quand quelque chose ne marche pas.
 * Elle répond à une seule question, en cinq contrôles : « qu'est-ce qui bloque,
 * et qu'est-ce que je dois aller faire, exactement, pour débloquer ? »
 *
 * LECTURE SEULE, SANS EXCEPTION.
 * Aucun appel d'écriture n'est fait. L'option --apply est sans effet : cli.mjs
 * marque déjà la commande « readOnly » et force apply=false (ceinture ET
 * bretelles). Les seuls appels réseau sont des `get` et des `list`.
 *
 * RÈGLE DE SÉCURITÉ NUMÉRO UN — on ne touche JAMAIS au « Mon Drive » personnel.
 * Ce fichier n'appelle JAMAIS `drive.files.*`. Aucun fichier n'est énuméré,
 * ni dans un Drive partagé, ni — surtout — dans le « Mon Drive » de qui que ce
 * soit. Côté Drive, le seul appel est `drives.list` (la liste des Drive
 * PARTAGÉS), qui ne révèle aucun document.
 *
 * Les cinq contrôles :
 *   1. config.json est présent, lisible et valide.
 *   2. Le fichier d'identifiants existe (clé de compte de service, ou client
 *      OAuth). En mode compte de service : affichage de l'identifiant client
 *      NUMÉRIQUE et de la liste de portées, prêts à coller dans la console.
 *   3. Google accepte d'émettre un jeton pour ce compte.
 *   4. Un vrai appel de lecture par API, pour prouver que chacune des quatre
 *      API est ACTIVÉE dans le projet Cloud et accessible.
 *   5. Le compte emprunté (adminEmail) est bien super-administrateur.
 *
 * Chaque contrôle est isolé : un échec n'interrompt pas le diagnostic, il
 * marque simplement les contrôles qui en dépendent comme « non testés ».
 * Le rapport se termine par un verdict et 1 à 3 actions concrètes.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  SCOPES,
  authMode,
  delegationInstructions,
  getAuthClient,
  scopeLine,
  scopesFor,
} from '../lib/auth.mjs';
import { errorInfo, explainGoogleError, getClients, isNotFound, withRetry } from '../lib/google.mjs';
import { loadConfig, validateConfig } from '../lib/config.mjs';
import { raw as ecrireBrut } from '../lib/log.mjs';

export const meta = {
  name: 'doctor',
  summary:
    "Diagnostic complet de l'accès à Google : configuration, identifiants, délégation, " +
    "API activées, droits d'administration. Ne modifie rien — à lancer en premier quand ça bloque.",
};

/* ================================================================== *
 * Constantes
 * ================================================================== */

/** Alias littéral accepté par l'Admin SDK pour « mon compte client ». */
const CUSTOMER_KEY = 'my_customer';

/**
 * Les quatre API du projet Cloud, avec leur NOM EXACT tel qu'il apparaît dans
 * la bibliothèque d'API, et l'URL d'activation directe.
 *
 * Piège documenté : le nom technique de l'API Agenda est
 * « calendar-json.googleapis.com » et non « calendar.googleapis.com ».
 * Chercher le second dans la bibliothèque ne donne AUCUN résultat.
 */
const APIS = {
  admin: {
    nom: 'Admin SDK API',
    service: 'admin.googleapis.com',
    url: 'https://console.cloud.google.com/apis/library/admin.googleapis.com',
    usage: 'usagers, groupes et membres',
  },
  calendar: {
    nom: 'Google Calendar API',
    service: 'calendar-json.googleapis.com',
    url: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
    usage: 'calendriers partagés et partages (ACL)',
    piege:
      "Le nom technique est « calendar-json.googleapis.com », PAS « calendar.googleapis.com » : " +
      "chercher le second dans la bibliothèque d'API ne donne aucun résultat.",
  },
  drive: {
    nom: 'Google Drive API',
    service: 'drive.googleapis.com',
    url: 'https://console.cloud.google.com/apis/library/drive.googleapis.com',
    usage: 'Drive partagé, dossiers et membres',
  },
  groupsSettings: {
    nom: 'Groups Settings API',
    service: 'groupssettings.googleapis.com',
    url: 'https://console.cloud.google.com/apis/library/groupssettings.googleapis.com',
    usage: 'réglages fins du groupe (qui publie, qui voit les membres)',
  },
};

/** Raccourci et chemin de menu exact pour la délégation à l'échelle du domaine. */
const DELEGATION_URL = 'https://admin.google.com/ac/owl/domainwidedelegation';
const DELEGATION_MENU = [
  'Chemin exact dans la console d\'administration (admin.google.com) :',
  '  Menu > Sécurité > Contrôle des accès et des données > Commandes des API',
  '       > Délégation à l\'échelle du domaine > Gérer la délégation à l\'échelle du domaine',
  '       > Ajouter',
];

/** Chemin de menu pour accorder le rôle de super-administrateur. */
const ROLES_MENU = [
  'Chemin exact dans la console d\'administration (admin.google.com) :',
  '  Menu > Annuaire > Utilisateurs > (cliquer sur la personne)',
  '       > Rôles et privilèges d\'administrateur > Attribuer des rôles',
];

/** Masques `fields` explicites : on ne rapatrie que ce qu'on affiche. */
const USER_LIST_FIELDS = 'nextPageToken,users(primaryEmail)';
const USER_GET_FIELDS =
  'primaryEmail,name(fullName),isAdmin,isDelegatedAdmin,suspended,suspensionReason,archived,' +
  'agreedToTerms,isMailboxSetup,isEnrolledIn2Sv,isEnforcedIn2Sv,lastLoginTime,creationTime,orgUnitPath';
const CALENDAR_LIST_FIELDS = 'nextPageToken,items(id,summary,accessRole,primary)';
const DRIVE_LIST_FIELDS = 'nextPageToken,drives(id,name)';
const GROUP_SETTINGS_FIELDS = 'email,name,whoCanJoin,whoCanPostMessage,allowExternalMembers';

/** Libellés affichés pour chaque état de contrôle. */
const LIBELLE_STATUT = {
  ok: 'RÉUSSI',
  avertissement: 'À SURVEILLER',
  echec: 'ÉCHEC',
  ignore: 'NON TESTÉ',
};

/** Titre court de chaque contrôle, pour le tableau récapitulatif. */
const TITRES_CONTROLES = {
  1: 'configuration',
  2: 'identifiants',
  3: 'jeton',
  4: 'API activées',
  5: 'super-admin',
};

/** Horodatage renvoyé par Google pour un compte qui ne s'est JAMAIS connecté. */
const JAMAIS_CONNECTE = '1970-01-01T00:00:00.000Z';

/* ================================================================== *
 * Petits utilitaires, aucun ne lève jamais d'exception
 * ================================================================== */

/**
 * Décrit un fichier sur disque sans jamais échouer.
 * @param {string|null} chemin
 * @returns {{ chemin: string|null, existe: boolean, estDossier?: boolean, taille?: number,
 *             mode?: number, tropOuvert?: boolean, erreur?: string }}
 */
function inspecterFichier(chemin) {
  if (!chemin) return { chemin: null, existe: false };
  try {
    if (!existsSync(chemin)) return { chemin, existe: false };
    const st = statSync(chemin);
    const permissions = st.mode & 0o777;
    return {
      chemin,
      existe: true,
      estDossier: st.isDirectory(),
      taille: st.size,
      mode: permissions,
      // Sur Windows les bits de permission ne veulent rien dire : on ne juge pas.
      tropOuvert: process.platform !== 'win32' && (permissions & 0o077) !== 0,
    };
  } catch (e) {
    return { chemin, existe: false, erreur: e?.message ?? String(e) };
  }
}

/** Lit et analyse un JSON sans jamais lever. */
function lireJson(chemin) {
  try {
    const texte = readFileSync(chemin, 'utf8').replace(/^\uFEFF/, '');
    return { ok: true, valeur: JSON.parse(texte) };
  } catch (e) {
    return { ok: false, erreur: e?.message ?? String(e) };
  }
}

/** Permissions en notation octale lisible (ex. « 600 »). */
function modeOctal(mode) {
  return typeof mode === 'number' ? mode.toString(8).padStart(3, '0') : '???';
}

/**
 * Vérifie qu'un fichier secret est bien exclu du versionnage.
 *
 * Remonte jusqu'à quatre niveaux de dossiers à la recherche d'un .gitignore
 * qui nomme le fichier, et d'un dossier .git. Si aucun dépôt Git n'est trouvé,
 * la question ne se pose pas : on retourne null (« sans objet »).
 *
 * @param {string|null} chemin
 * @returns {boolean|null} true = ignoré, false = versionnable, null = pas un dépôt
 */
function estIgnoreParGit(chemin) {
  if (!chemin) return null;
  const nom = basename(chemin);
  let dossier = dirname(chemin);
  let depotTrouve = false;
  let ignore = false;

  for (let i = 0; i < 4; i += 1) {
    if (existsSync(join(dossier, '.git'))) depotTrouve = true;
    const gitignore = join(dossier, '.gitignore');
    if (existsSync(gitignore)) {
      try {
        const lignes = readFileSync(gitignore, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '' && !l.startsWith('#'));
        if (lignes.some((l) => l === nom || l === `/${nom}` || l === `**/${nom}`)) ignore = true;
      } catch {
        /* un .gitignore illisible ne doit pas faire échouer le diagnostic */
      }
    }
    const parent = dirname(dossier);
    if (parent === dossier) break;
    dossier = parent;
  }

  if (!depotTrouve) return null;
  return ignore;
}

/** Vrai si l'erreur signifie « cette API n'est pas activée dans le projet Cloud ». */
function apiDesactivee(e) {
  const { status, reasons, message } = errorInfo(e);
  if (status !== 403 && status !== 404) return false;
  const motifs = reasons.map((r) => r.toLowerCase());
  if (motifs.includes('accessnotconfigured') || motifs.includes('servicedisabled')) return true;
  return /has not been used in project|SERVICE_DISABLED|accessNotConfigured|API .* is disabled/i.test(message);
}

/** Vrai si l'erreur signifie « le jeton n'a pas la portée nécessaire ». */
function porteeManquante(e) {
  const { status, reasons, message } = errorInfo(e);
  if (status !== 403 && status !== 401) return false;
  const motifs = reasons.map((r) => r.toLowerCase());
  if (motifs.includes('insufficientpermissions')) return true;
  return /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(message);
}

/** Vrai si l'erreur signifie « le compte emprunté n'a pas le droit ». */
function droitsInsuffisants(e) {
  const { status, message } = errorInfo(e);
  return status === 403 && /Not Authorized to access this resource|forbidden/i.test(message);
}

/**
 * Message brut renvoyé par Google, extrait d'une AuthError ou d'une erreur d'API.
 * @param {unknown} e
 * @returns {string}
 */
function messageGoogle(e) {
  const source = e?.cause ?? e;
  const { message } = errorInfo(source);
  return String(message ?? '').trim();
}

/**
 * Écrit un texte multiligne : les lignes pleines passent par le journal (avec
 * sa puce), les lignes vides sont écrites telles quelles. Sans cela, un
 * paragraphe aéré se transforme en une suite de puces vides.
 */
function ecrireLignes(log, sortie, texte) {
  for (const ligne of String(texte).split('\n')) {
    if (ligne.trim() === '') sortie('');
    else log.info(ligne);
  }
}

/* ================================================================== *
 * Rapport : accumule les résultats et les affiche au fil de l'eau
 * ================================================================== */

/**
 * Crée l'accumulateur de résultats.
 * @param {object} log journal fourni par le CLI
 */
function nouveauRapport(log) {
  /** @type {Array<{ id: number, titre: string, statut: string, resume: string }>} */
  const controles = [];
  /** @type {Array<{ priorite: number, texte: string }>} */
  const actions = [];

  return {
    controles,
    actions,

    /**
     * Enregistre le verdict d'un contrôle et l'affiche.
     * @param {number} id
     * @param {string} titre
     * @param {'ok'|'avertissement'|'echec'|'ignore'} statut
     * @param {string} resume phrase courte, compréhensible sans contexte
     */
    verdict(id, titre, statut, resume) {
      controles.push({ id, titre, statut, resume });
      const ligne = `Contrôle ${id} (${titre}) : ${resume}`;
      if (statut === 'ok') log.ok(ligne);
      else if (statut === 'avertissement') log.warn(ligne);
      else if (statut === 'echec') log.err(ligne);
      else log.info(`[NON TESTÉ] ${ligne}`);
      return statut;
    },

    /**
     * Ajoute une action concrète à proposer à la fin.
     * @param {number} priorite plus petit = plus urgent
     * @param {string} texte
     */
    action(priorite, texte) {
      actions.push({ priorite, texte });
    },
  };
}

/* ================================================================== *
 * Contrôle 1 — config.json présent, lisible et valide
 * ================================================================== */

/**
 * @param {{ configEntrant: object|null, state: object, log: object, sortie: (t: string) => void, rapport: object }} ctx
 * @returns {{ config: object|null }}
 */
function controleConfig({ configEntrant, state, log, sortie, rapport }) {
  log.step('Contrôle 1 sur 5 — le fichier de configuration');

  let config = configEntrant && typeof configEntrant === 'object' ? configEntrant : null;

  // Cas normal : cli.mjs a déjà chargé et validé la configuration avant
  // d'appeler la commande. Cas de secours : doctor est appelé directement
  // (test, script), on charge alors nous-mêmes pour que le contrôle ait un sens.
  if (!config) {
    log.info('Aucune configuration reçue : chargement de ./config.json.');
    try {
      config = loadConfig('./config.json', { onWarn: (m) => log.warn(m) });
    } catch (e) {
      ecrireLignes(log, sortie, e?.message ?? String(e));
      rapport.verdict(1, TITRES_CONTROLES[1], 'echec', 'config.json est absent ou invalide.');
      rapport.action(
        1,
        'Corriger config.json en suivant les messages ci-dessus, puis relancer : node src/cli.mjs doctor',
      );
      return { config: null };
    }
  }

  const cheminConfig = config.__configFile ?? '(chemin inconnu — configuration fournie en mémoire)';
  log.info(`Fichier                 : ${cheminConfig}`);
  log.info(`Domaine                 : ${config.domain}`);
  log.info(`Compte à emprunter      : ${config.adminEmail}`);
  log.info(`Adresse personnelle     : ${config.personalEmail ?? '(aucune — rien à détacher)'}`);
  log.info(`Mode d'authentification : ${config.auth?.mode ?? '(non défini — « oauth » par défaut)'}`);
  log.info(
    `Contenu prévu           : ${config.team?.length ?? 0} personne(s), ` +
      `${config.group ? `groupe ${config.group.email}` : 'aucun groupe (accès accordés adresse par adresse)'}, ` +
      `${config.calendars?.length ?? 0} calendrier(s), Drive partagé « ${config.sharedDrive?.name ?? '?'} »`,
  );

  /** @type {string[]} */
  const remarques = [];

  // Le fichier est-il toujours là et toujours lisible ? Il a pu être modifié
  // entre le chargement par le CLI et maintenant, ou pointer sur un montage
  // réseau capricieux.
  if (config.__configFile) {
    const relu = lireJson(config.__configFile);
    if (!relu.ok) {
      remarques.push(
        `Le fichier ${config.__configFile} n'est plus lisible ou n'est plus du JSON valide (${relu.erreur}). ` +
          'La configuration en mémoire reste utilisable, mais la prochaine exécution échouera.',
      );
    } else {
      // Deuxième passe de validation : elle remonte les AVERTISSEMENTS
      // (clés inconnues, réglages douteux) que le CLI a déjà pu afficher,
      // mais qui méritent d'être rassemblés ici, dans le diagnostic.
      try {
        const { errors, warnings } = validateConfig(relu.valeur);
        for (const err of errors) remarques.push(`champ « ${err.field} » : ${err.msg.split('\n')[0]}`);
        for (const w of warnings) remarques.push(w);
      } catch (e) {
        remarques.push(`La revalidation du fichier a échoué : ${e?.message ?? String(e)}`);
      }

      // Valeurs du modèle laissées telles quelles : erreur la plus fréquente
      // au premier lancement.
      const texte = JSON.stringify(relu.valeur);
      if (/REMPLACER/i.test(texte) || /exemple\.ca/i.test(texte)) {
        remarques.push(
          'Le fichier contient encore des valeurs du modèle (« REMPLACER » ou « exemple.ca »). ' +
            'Remplacer ces valeurs par les vraies avant de continuer.',
        );
      }
    }

    const ignore = estIgnoreParGit(config.__configFile);
    if (ignore === false) {
      remarques.push(
        `${basename(config.__configFile)} n'est pas exclu par .gitignore : il contient le domaine et ` +
          'les adresses réelles. Ajouter son nom au .gitignore avant de committer.',
      );
    }
  }

  // Cache local des identifiants déjà créés. Ce n'est qu'une optimisation :
  // s'il est absent ou périmé, tout est redécouvert via l'API. On l'affiche
  // parce qu'un cache périmé explique bien des « ça ne trouve plus rien ».
  const cache = state && typeof state === 'object' ? state : {};
  const nbCalendriers = Object.keys(cache.calendars ?? {}).length;
  const nbDossiers = Object.keys(cache.folders ?? {}).length;
  if (cache.driveId || nbCalendriers > 0 || nbDossiers > 0) {
    log.info(
      `Cache local (.state.json) : Drive partagé ${cache.driveId ?? 'inconnu'}, ` +
        `${nbCalendriers} calendrier(s), ${nbDossiers} dossier(s) déjà connus. ` +
        "Ce n'est qu'une optimisation : le supprimer force une redécouverte complète.",
    );
  } else {
    log.info("Cache local (.state.json) : vide ou absent. Normal avant la première exécution de « setup ».");
  }

  if (remarques.length > 0) {
    for (const r of remarques) ecrireLignes(log, sortie, r);
    rapport.verdict(1, TITRES_CONTROLES[1], 'avertissement', `${remarques.length} point(s) à corriger dans config.json.`);
    rapport.action(2, `Relire les points signalés dans ${cheminConfig}.`);
  } else {
    rapport.verdict(1, TITRES_CONTROLES[1], 'ok', 'config.json est présent, lisible et cohérent.');
  }

  return { config };
}

/* ================================================================== *
 * Contrôle 2 — le fichier d'identifiants
 * ================================================================== */

/**
 * Affiche les deux textes à copier-coller dans la console d'administration :
 * l'identifiant client numérique, et la liste de portées sur une seule ligne.
 *
 * Ces deux blocs sont écrits SANS INDENTATION ni puce, pour qu'un
 * copier-coller ne ramasse rien d'autre que la valeur.
 */
function afficherBlocsACopier({ log, sortie, clientId, mode, portees }) {
  if (clientId) {
    log.info(
      "À coller dans le champ « ID client » de la délégation à l'échelle du domaine " +
        '(le nombre à 21 chiffres, PAS le courriel du compte de service) :',
    );
    sortie('');
    sortie(clientId);
    sortie('');
  }

  // SCOPES contient à la fois des jeux d'ensemble (« delegation », « oauth ») et
  // des groupes par API. On attribue chaque portée au groupe le PLUS PRÉCIS qui
  // la contient : sinon les jeux d'ensemble raflent tout et la liste devient
  // illisible, avec chaque portée affichée trois fois.
  log.info('Portées demandées par la trousse, groupées par usage :');
  const groupes = Object.entries(SCOPES)
    .map(([nom, liste]) => [nom, [...liste]])
    .sort((a, b) => a[1].length - b[1].length);
  const vues = new Set();
  for (const [nom, liste] of groupes) {
    for (const portee of liste) {
      if (!portees.includes(portee) || vues.has(portee)) continue;
      vues.add(portee);
      log.info(`  [${nom}] ${portee}`);
    }
  }
  for (const portee of portees) {
    if (!vues.has(portee)) log.info(`  [autre] ${portee}`);
  }

  if (mode === 'service-account') {
    log.info(
      "À coller dans le champ « Champs d'application OAuth » de la délégation — une seule " +
        'ligne, séparée par des virgules, correspondance EXACTE exigée :',
    );
  } else {
    log.info("Portées qui seront demandées à l'écran de consentement, en une seule ligne :");
  }
  sortie('');
  // scopeLine(mode) rend le BON jeu : strict pour la délégation, jeu OAuth
  // (une portée d'identité en plus) pour le consentement dans le navigateur.
  sortie(scopeLine(mode));
  sortie('');
}

/**
 * @returns {{ ok: boolean, mode: string, clientId: string|null, serviceAccountEmail: string|null }}
 */
function controleIdentifiants({ config, mode, portees, log, sortie, rapport }) {
  log.step("Contrôle 2 sur 5 — le fichier d'identifiants");

  const ctx = { config, mode, portees, resolus: config.auth?.resolved ?? {}, log, sortie, rapport };
  if (mode === 'oauth') return controleIdentifiantsOAuth(ctx);
  return controleIdentifiantsCompteDeService(ctx);
}

/** Mode « compte de service » : clé JSON + délégation à l'échelle du domaine. */
function controleIdentifiantsCompteDeService({ config, mode, portees, resolus, log, sortie, rapport }) {
  const chemin = resolus.keyFile ?? config.auth?.keyFile ?? null;
  const fichier = inspecterFichier(chemin);

  log.info(`Mode          : compte de service (tourne sans intervention humaine).`);
  log.info(`Fichier de clé: ${chemin ?? '(non configuré)'}`);

  if (!fichier.existe || fichier.estDossier) {
    log.info("Ce fichier est la clé privée du compte de service. Il n'existe pas encore ici.");
    log.info('Quoi faire — le créer une seule fois :');
    log.info('  1. Ouvrir https://console.cloud.google.com/iam-admin/serviceaccounts');
    log.info('  2. Choisir le projet, puis « Créer un compte de service ».');
    log.info("     Aucun rôle IAM n'est nécessaire : un compte de service ne tire pas son pouvoir");
    log.info('     d\'un rôle Google Cloud, mais de la délégation autorisée côté Workspace.');
    log.info('  3. Onglet « Clés » > Ajouter une clé > Créer une clé > JSON.');
    log.info(`  4. Déposer le fichier téléchargé ici : ${chemin ?? './service-account.json'}`);
    log.info('Autre possibilité, sans clé privée sur disque : passer en mode OAuth');
    log.info('  ("auth": { "mode": "oauth" } dans config.json).');
    rapport.verdict(2, TITRES_CONTROLES[2], 'echec', 'le fichier de clé du compte de service est introuvable.');
    rapport.action(1, `Déposer la clé JSON du compte de service ici : ${chemin ?? './service-account.json'}`);
    return { ok: false, mode: 'service-account', clientId: null, serviceAccountEmail: null };
  }

  const lu = lireJson(chemin);
  if (!lu.ok) {
    log.info(`Le fichier existe mais n'est pas du JSON lisible : ${lu.erreur}`);
    log.info("Quoi faire : re-télécharger la clé JSON depuis la console Cloud sans l'ouvrir");
    log.info("dans un éditeur qui reformate le texte.");
    rapport.verdict(2, TITRES_CONTROLES[2], 'echec', 'le fichier de clé est illisible ou corrompu.');
    rapport.action(1, `Re-télécharger la clé JSON du compte de service vers ${chemin}`);
    return { ok: false, mode: 'service-account', clientId: null, serviceAccountEmail: null };
  }

  const cle = lu.valeur ?? {};

  // Piège fréquent : les deux fichiers JSON se ressemblent.
  if (cle.installed || cle.web) {
    log.info(`Ce fichier est un CLIENT OAUTH, pas une clé de compte de service.`);
    log.info('  - clé de compte de service : contient "type": "service_account" et "private_key"');
    log.info('  - client OAuth             : contient "installed" ou "web"');
    log.info('Quoi faire, au choix :');
    log.info('  a) déclarer ce fichier dans auth.oauthClientFile et mettre auth.mode = "oauth" ;');
    log.info('  b) télécharger une vraie clé de compte de service (console Cloud > IAM et');
    log.info('     administration > Comptes de service > Clés > Ajouter une clé > JSON).');
    rapport.verdict(2, TITRES_CONTROLES[2], 'echec', "le fichier de clé est en réalité un client OAuth.");
    rapport.action(1, 'Corriger auth.mode / auth.keyFile dans config.json (voir ci-dessus).');
    return { ok: false, mode: 'service-account', clientId: null, serviceAccountEmail: null };
  }

  /** @type {string[]} */
  const remarques = [];

  if (cle.type !== 'service_account') {
    remarques.push(
      `Le champ "type" vaut ${JSON.stringify(cle.type ?? null)} au lieu de "service_account". ` +
        'Re-télécharger la clé depuis la console Cloud.',
    );
  }
  for (const champ of ['client_email', 'private_key']) {
    if (typeof cle[champ] !== 'string' || cle[champ].trim() === '') {
      remarques.push(`Le champ "${champ}" est absent du fichier de clé : la clé est incomplète.`);
    }
  }
  if (typeof cle.private_key === 'string' && !cle.private_key.includes('PRIVATE KEY')) {
    remarques.push(
      'La clé privée ne ressemble pas à un bloc PEM : elle a probablement été abîmée par un ' +
        'copier-coller ou un éditeur qui reformate le texte.',
    );
  }

  const clientId = typeof cle.client_id === 'string' ? cle.client_id.trim() : null;
  const serviceAccountEmail = typeof cle.client_email === 'string' ? cle.client_email.trim() : null;

  log.info(`Projet Cloud  : ${cle.project_id ?? '(absent du fichier)'}`);
  log.info(`Compte de svc : ${serviceAccountEmail ?? '(absent du fichier)'}`);
  log.info(`Permissions   : ${modeOctal(fichier.mode)} (${fichier.taille ?? 0} octets)`);

  if (fichier.tropOuvert) {
    remarques.push(
      `Le fichier de clé est lisible par d'autres comptes de cette machine (permissions ${modeOctal(fichier.mode)}). ` +
        `Cette clé donne un accès administrateur complet au Workspace : exécuter « chmod 600 ${chemin} ».`,
    );
  }
  const ignore = estIgnoreParGit(chemin);
  if (ignore === false) {
    remarques.push(
      `${basename(chemin)} n'est pas exclu par .gitignore. Cette clé ne doit JAMAIS être versionnée : ` +
        'ajouter son nom au .gitignore immédiatement.',
    );
  }

  if (!clientId) {
    remarques.push(
      'Le champ "client_id" est absent du fichier de clé : impossible d\'afficher l\'identifiant à ' +
        'coller dans la délégation. Le récupérer dans la console Cloud > IAM et administration > ' +
        'Comptes de service > (le compte) > champ « ID unique ».',
    );
  } else if (!/^\d+$/.test(clientId)) {
    remarques.push(
      `L'identifiant client lu (« ${clientId} ») n'est pas entièrement numérique. La console ` +
        "d'administration n'accepte QUE le nombre à 21 chiffres.",
    );
  } else if (clientId.length !== 21) {
    remarques.push(
      `L'identifiant client lu compte ${clientId.length} chiffres au lieu des 21 attendus. ` +
        'Vérifier le champ « ID unique » du compte de service dans la console Cloud.',
    );
  }

  afficherBlocsACopier({ log, sortie, clientId, mode, portees });

  log.info(`Où coller ces deux valeurs : ${DELEGATION_URL}`);
  for (const ligne of DELEGATION_MENU) log.info(ligne);

  if (remarques.length > 0) {
    for (const r of remarques) ecrireLignes(log, sortie, r);
    const bloquant = remarques.some((r) => /incomplète|PEM|"type"/.test(r));
    rapport.verdict(
      2,
      TITRES_CONTROLES[2],
      bloquant ? 'echec' : 'avertissement',
      `clé de compte de service lue, ${remarques.length} point(s) à corriger.`,
    );
    if (bloquant) rapport.action(1, `Re-télécharger une clé JSON complète vers ${chemin}`);
    return { ok: !bloquant, mode: 'service-account', clientId, serviceAccountEmail };
  }

  rapport.verdict(2, TITRES_CONTROLES[2], 'ok', `clé du compte de service ${serviceAccountEmail} lue et complète.`);
  return { ok: true, mode: 'service-account', clientId, serviceAccountEmail };
}

/** Mode « OAuth » : client de bureau + jeton de rafraîchissement en cache. */
function controleIdentifiantsOAuth({ config, mode, portees, resolus, log, sortie, rapport }) {
  const chemin = resolus.oauthClientFile ?? config.auth?.oauthClientFile ?? null;
  const cheminJetons = resolus.tokenFile ?? config.auth?.tokenFile ?? null;
  const fichier = inspecterFichier(chemin);

  log.info('Mode          : OAuth (application de bureau). Aucune clé privée sur disque.');
  log.info(`Client OAuth  : ${chemin ?? '(non configuré)'}`);

  if (!fichier.existe || fichier.estDossier) {
    log.info("Le fichier de client OAuth n'existe pas encore ici.");
    log.info('Quoi faire — le créer une seule fois :');
    log.info('  1. Ouvrir https://console.cloud.google.com/apis/credentials');
    log.info('  2. Créer des identifiants > ID client OAuth > Type : Application de bureau.');
    log.info("     Aucun URI de redirection n'est à déclarer pour ce type de client.");
    log.info("  3. Sur l'écran de consentement, choisir « Interne » : pas de vérification");
    log.info("     Google à subir, et le jeton de rafraîchissement n'expire pas au bout de 7 jours.");
    log.info(`  4. Télécharger le JSON et le déposer ici : ${chemin ?? './oauth-client.json'}`);
    rapport.verdict(2, TITRES_CONTROLES[2], 'echec', 'le fichier de client OAuth est introuvable.');
    rapport.action(1, `Déposer le client OAuth « Application de bureau » ici : ${chemin ?? './oauth-client.json'}`);
    return { ok: false, mode: 'oauth', clientId: null, serviceAccountEmail: null };
  }

  const lu = lireJson(chemin);
  if (!lu.ok) {
    log.info(`Le fichier existe mais n'est pas du JSON lisible : ${lu.erreur}`);
    rapport.verdict(2, TITRES_CONTROLES[2], 'echec', 'le fichier de client OAuth est illisible.');
    rapport.action(1, `Re-télécharger le client OAuth vers ${chemin}`);
    return { ok: false, mode: 'oauth', clientId: null, serviceAccountEmail: null };
  }

  const contenu = lu.valeur ?? {};
  /** @type {string[]} */
  const remarques = [];

  if (contenu.type === 'service_account') {
    log.info('Ce fichier est une CLÉ DE COMPTE DE SERVICE, pas un client OAuth.');
    log.info('Quoi faire : mettre auth.mode = "service-account" dans config.json, ou');
    log.info('télécharger un vrai client OAuth de type « Application de bureau ».');
    rapport.verdict(2, TITRES_CONTROLES[2], 'echec', 'le client OAuth est en réalité une clé de compte de service.');
    rapport.action(1, 'Corriger auth.mode / auth.oauthClientFile dans config.json.');
    return { ok: false, mode: 'oauth', clientId: null, serviceAccountEmail: null };
  }

  const bloc = contenu.installed ?? contenu.web ?? null;
  if (!bloc) {
    remarques.push(
      'Le fichier ne contient ni bloc "installed" ni bloc "web" : ce n\'est pas un client OAuth ' +
        'téléchargé depuis la console Cloud.',
    );
  } else if (contenu.web) {
    remarques.push(
      'Ce client est de type « Application Web ». La trousse ouvre un serveur local sur ' +
        '127.0.0.1 : avec un client Web, il faut déclarer l\'URI de redirection exact dans la ' +
        'console. Un client de type « Application de bureau » évite complètement ce problème.',
    );
  }

  const clientId = typeof bloc?.client_id === 'string' ? bloc.client_id : null;
  log.info(`ID client     : ${clientId ?? '(absent du fichier)'}`);
  log.info(`Type          : ${contenu.installed ? 'Application de bureau (recommandé)' : contenu.web ? 'Application Web' : 'inconnu'}`);

  // État du cache de jetons : c'est lui qui évite de redemander l'autorisation.
  const jetons = inspecterFichier(cheminJetons);
  if (!jetons.existe) {
    log.info(`Cache de jetons : absent (${cheminJetons ?? 'non configuré'}). Une autorisation sera demandée`);
    log.info('  dans le navigateur au prochain appel réel. C\'est normal la première fois.');
  } else {
    const contenuJetons = lireJson(cheminJetons);
    if (!contenuJetons.ok) {
      remarques.push(
        `Le cache de jetons ${cheminJetons} est illisible (${contenuJetons.erreur}). ` +
          'Le supprimer : une nouvelle autorisation sera demandée.',
      );
    } else {
      const t = contenuJetons.valeur ?? {};
      log.info(`Cache de jetons : présent (permissions ${modeOctal(jetons.mode)}).`);
      if (!t.refresh_token) {
        remarques.push(
          "Le cache ne contient pas de jeton de rafraîchissement : l'autorisation sera redemandée " +
            'à chaque exécution. Pour repartir à neuf : révoquer l\'accès sur ' +
            'https://myaccount.google.com/permissions, supprimer le cache, relancer.',
        );
      }
      const accordees = typeof t.scope === 'string' ? t.scope.split(/\s+/).filter(Boolean) : [];
      const manquantes = portees.filter((s) => !accordees.includes(s));
      if (accordees.length > 0 && manquantes.length > 0) {
        remarques.push(
          `L'autorisation en cache ne couvre pas ${manquantes.length} portée(s) nécessaire(s) : ` +
            `${manquantes.join(', ')}. Supprimer ${cheminJetons} et relancer pour les accorder.`,
        );
      }
      if (jetons.tropOuvert) {
        remarques.push(
          `Le cache de jetons est lisible par d'autres comptes de la machine (${modeOctal(jetons.mode)}) : ` +
            `exécuter « chmod 600 ${cheminJetons} ».`,
        );
      }
    }
    const ignoreJetons = estIgnoreParGit(cheminJetons);
    if (ignoreJetons === false) {
      remarques.push(`${basename(cheminJetons)} n'est pas exclu par .gitignore : l'ajouter avant de committer.`);
    }
  }

  const ignore = estIgnoreParGit(chemin);
  if (ignore === false) {
    remarques.push(`${basename(chemin)} n'est pas exclu par .gitignore : l'ajouter avant de committer.`);
  }

  afficherBlocsACopier({ log, sortie, clientId: null, mode, portees });
  log.info(
    "En mode OAuth, la délégation à l'échelle du domaine n'est PAS utilisée : c'est " +
      "l'administrateur lui-même qui autorise l'application dans son navigateur. La liste " +
      'ci-dessus sert à vérifier ce qui sera demandé à l\'écran de consentement.',
  );

  if (remarques.length > 0) {
    for (const r of remarques) ecrireLignes(log, sortie, r);
    rapport.verdict(2, TITRES_CONTROLES[2], 'avertissement', `client OAuth lu, ${remarques.length} point(s) à corriger.`);
    return { ok: true, mode: 'oauth', clientId, serviceAccountEmail: null };
  }

  rapport.verdict(2, TITRES_CONTROLES[2], 'ok', 'client OAuth « Application de bureau » lu et complet.');
  return { ok: true, mode: 'oauth', clientId, serviceAccountEmail: null };
}

/* ================================================================== *
 * Contrôle 3 — Google accepte-t-il d'émettre un jeton ?
 * ================================================================== */

/**
 * Demande un jeton à Google. C'est ici que se manifeste une délégation
 * manquante ou mal configurée : le jeton n'est JAMAIS émis, aucun appel d'API
 * n'a encore eu lieu.
 *
 * @returns {Promise<{ ok: boolean, auth: object|null }>}
 */
async function controleJeton({ config, mode, portees, identifiants, log, sortie, rapport }) {
  log.step("Contrôle 3 sur 5 — obtention d'un jeton auprès de Google");

  if (!identifiants.ok) {
    log.info("Le contrôle 2 a échoué : sans fichier d'identifiants utilisable, il n'y a rien à tenter.");
    rapport.verdict(3, TITRES_CONTROLES[3], 'ignore', "non testé — le fichier d'identifiants est inutilisable.");
    return { ok: false, auth: null };
  }

  log.info(`Compte emprunté : ${config.adminEmail}`);
  log.info(`Portées demandées : ${portees.length}`);
  if (identifiants.mode === 'oauth') {
    log.info("Si aucune autorisation n'est en cache, le navigateur va s'ouvrir maintenant.");
  }

  try {
    const auth = await getAuthClient({ config, scopes: portees, subject: config.adminEmail });

    const expiration = auth?.credentials?.expiry_date;
    if (typeof expiration === 'number' && Number.isFinite(expiration)) {
      const restant = Math.max(0, Math.round((expiration - Date.now()) / 60000));
      log.info(`Jeton obtenu, valide encore ${restant} minute(s).`);
    } else {
      log.info('Jeton obtenu.');
    }

    const meta = auth?.__portail ?? {};
    if (meta.mode === 'oauth') {
      log.info(meta.reused ? "Autorisation reprise du cache : rien n'a été redemandé." : 'Nouvelle autorisation enregistrée.');
    } else if (meta.serviceAccount) {
      log.info(`Le compte de service ${meta.serviceAccount} emprunte bien l'identité de ${meta.subject}.`);
    }

    rapport.verdict(3, TITRES_CONTROLES[3], 'ok', "Google a émis un jeton : l'authentification fonctionne.");
    return { ok: true, auth };
  } catch (e) {
    return { ok: false, auth: null, ...diagnostiquerEchecJeton({ e, config, portees, identifiants, log, sortie, rapport }) };
  }
}

/** Met en forme l'échec d'obtention de jeton, code par code. */
function diagnostiquerEchecJeton({ e, config, portees, identifiants, log, sortie, rapport }) {
  const code = e?.code ?? 'AUTH_FAILED';
  const brut = messageGoogle(e);

  if (code === 'AUTH_UNAUTHORIZED_CLIENT') {
    log.info('Google a REFUSÉ d\'émettre un jeton (unauthorized_client).');
    log.info(`Message de Google : ${brut}`);
    sortie('');
    log.info(
      "Traduction : la délégation à l'échelle du domaine n'est pas configurée, ou elle " +
        "ne couvre pas exactement les portées demandées. Aucun appel d'API n'a eu lieu : " +
        'le blocage est en amont, au moment de la signature du jeton.',
    );
    sortie('');
    ecrireLignes(
      log,
      sortie,
      // Sans « scopes », la fonction utilise le jeu STRICT de la délégation —
      // celui qu'il faut coller, sans la portée d'identité du mode OAuth.
      delegationInstructions({
        clientId: identifiants.clientId,
        serviceAccountEmail: identifiants.serviceAccountEmail,
      }),
    );
    sortie('');
    log.info('Les deux valeurs à coller, une dernière fois, sans indentation :');
    afficherBlocsACopier({ log, sortie, clientId: identifiants.clientId, mode: 'service-account', portees });
    for (const ligne of DELEGATION_MENU) log.info(ligne);
    sortie('');
    log.info('Si la délégation semble déjà en place, vérifier dans cet ordre :');
    log.info("  1. l'ID client collé est bien le nombre à 21 chiffres, PAS le courriel du compte de service ;");
    log.info('  2. la liste de portées est IDENTIQUE (une portée en moins et Google refuse tout) ;');
    log.info(`  3. la délégation a été ajoutée sur le bon domaine Workspace (${config.domain}) ;`);
    log.info("  4. l'ajout date de moins de 10 minutes — la propagation prend de 1 à 10 minutes ;");
    log.info("  5. sur certains domaines, une modification de la délégation exige l'approbation");
    log.info("     d'un DEUXIÈME super-administrateur. Un ajout resté « en attente », c'est ça.");

    rapport.verdict(3, TITRES_CONTROLES[3], 'echec', "la délégation à l'échelle du domaine n'autorise pas ce compte de service.");
    rapport.action(
      1,
      `Autoriser l'ID client ${identifiants.clientId ?? '(voir ci-dessus)'} avec la liste de portées ci-dessus : ${DELEGATION_URL}`,
    );
    return {};
  }

  if (code === 'AUTH_INVALID_GRANT') {
    ecrireLignes(log, sortie, e.message);
    rapport.verdict(3, TITRES_CONTROLES[3], 'echec', `Google a refusé le jeton signé (invalid_grant) pour ${config.adminEmail}.`);
    rapport.action(
      1,
      `Vérifier que ${config.adminEmail} existe, n'est pas suspendu, et s'est connecté au moins une fois ` +
        "(un compte qui n'a jamais accepté les conditions d'utilisation ne peut pas être emprunté).",
    );
    return {};
  }

  if (code === 'AUTH_API_DISABLED') {
    ecrireLignes(log, sortie, e.message);
    rapport.verdict(3, TITRES_CONTROLES[3], 'echec', "une API nécessaire n'est pas activée dans le projet Cloud.");
    rapport.action(1, `Activer les quatre API du projet Cloud (voir les liens ci-dessus).`);
    return {};
  }

  if (code === 'AUTH_NETWORK') {
    ecrireLignes(log, sortie, e.message);
    rapport.verdict(3, TITRES_CONTROLES[3], 'echec', 'impossible de joindre les serveurs de Google.');
    rapport.action(1, 'Vérifier la connexion Internet (et les variables HTTPS_PROXY / NO_PROXY derrière un proxy).');
    return {};
  }

  // Tous les autres cas : le message d'auth.mjs est déjà rédigé pour un humain.
  ecrireLignes(log, sortie, e?.message ?? String(e));
  rapport.verdict(3, TITRES_CONTROLES[3], 'echec', `Google a refusé l'authentification (${code}).`);
  rapport.action(1, "Suivre les instructions du contrôle 3 ci-dessus, puis relancer : node src/cli.mjs doctor");
  return {};
}

/* ================================================================== *
 * Contrôle 4 — une lecture réelle par API, pour prouver qu'elle est activée
 * ================================================================== */

/**
 * Un appel de lecture par API. Un jeton valide ne prouve RIEN sur l'activation
 * des API : l'activation est par projet Cloud, la délégation est par domaine
 * Workspace, et les deux sont indépendantes.
 */
function appelsDeLecture(config) {
  return [
    {
      api: APIS.admin,
      titre: "Admin SDK — lire un usager de l'annuaire",
      appel: 'admin.users.list (limité à 1)',
      async executer(clients) {
        const res = await withRetry(
          () =>
            clients.admin.users.list({
              customer: CUSTOMER_KEY,
              maxResults: 1,
              projection: 'basic',
              orderBy: 'email',
              fields: USER_LIST_FIELDS,
            }),
          { tries: 3, propagation: false, label: 'admin.users.list' },
        );
        const usagers = res?.data?.users ?? [];
        return usagers.length > 0
          ? `annuaire lisible (premier usager : ${usagers[0].primaryEmail}).`
          : "annuaire lisible, mais aucun usager retourné — c'est inhabituel, vérifier le domaine.";
      },
    },
    {
      api: APIS.calendar,
      titre: "Agenda — lire la liste des calendriers du compte emprunté",
      appel: 'calendar.calendarList.list (limité à 1)',
      async executer(clients) {
        const res = await withRetry(
          () => clients.calendar.calendarList.list({ maxResults: 1, fields: CALENDAR_LIST_FIELDS }),
          { tries: 3, propagation: false, label: 'calendarList.list' },
        );
        const items = res?.data?.items ?? [];
        return items.length > 0
          ? `agenda lisible (premier calendrier : ${items[0].summary ?? items[0].id}).`
          : 'agenda lisible (aucun calendrier listé pour ce compte).';
      },
    },
    {
      api: APIS.drive,
      titre: 'Drive — lire la liste des Drive PARTAGÉS',
      appel: 'drive.drives.list (limité à 1)',
      async executer(clients) {
        // SÉCURITÉ : `drives.list` ne liste que les Drive partagés, jamais des
        // fichiers. Aucun appel drive.files.* n'est fait par doctor : le
        // « Mon Drive » personnel n'est ni lu, ni énuméré, ni touché.
        const res = await withRetry(
          () => clients.drive.drives.list({ pageSize: 1, fields: DRIVE_LIST_FIELDS }),
          { tries: 3, propagation: false, label: 'drives.list' },
        );
        const drives = res?.data?.drives ?? [];
        return drives.length > 0
          ? `Drive lisible (premier Drive partagé visible : ${drives[0].name}).`
          : "Drive lisible (le compte emprunté n'est encore membre d'aucun Drive partagé — normal avant « setup »).";
      },
    },
    {
      api: APIS.groupsSettings,
      titre: 'Groups Settings — lire les réglages du groupe configuré',
      appel: `groupsSettings.groups.get (${config.group?.email ?? 'aucun groupe'})`,
      ignorer: config.group
        ? null
        : "aucun groupe dans config.json (group: null) : les accès seront accordés adresse par adresse. " +
          "La portée apps.groups.settings doit tout de même rester dans la liste autorisée.",
      async executer(clients) {
        try {
          const res = await withRetry(
            () =>
              clients.groupsSettings.groups.get({
                groupUniqueId: config.group.email,
                fields: GROUP_SETTINGS_FIELDS,
              }),
            { tries: 3, propagation: false, label: 'groupsSettings.groups.get' },
          );
          const reglages = res?.data ?? {};
          return `réglages lisibles (adhésion : ${reglages.whoCanJoin ?? 'inconnu'}, publication : ${reglages.whoCanPostMessage ?? 'inconnu'}).`;
        } catch (e) {
          // Le groupe n'existe pas encore : c'est l'état NORMAL avant « setup ».
          // L'API a répondu, donc elle est bien activée et accessible.
          if (isNotFound(e)) {
            return (
              `API joignable et activée. Le groupe ${config.group.email} n'existe pas encore — ` +
              "c'est normal avant « node src/cli.mjs group --apply »."
            );
          }
          throw e;
        }
      },
    },
  ];
}

/**
 * @returns {Promise<{ admin: boolean, echecs: number }>}
 */
async function controleApis({ config, mode, portees, log, sortie, rapport }) {
  log.step('Contrôle 4 sur 5 — chaque API répond-elle vraiment ?');
  log.info(
    "Un jeton valide ne prouve rien sur l'activation des API : l'activation se fait par PROJET " +
      "Cloud, la délégation par DOMAINE Workspace. Les deux sont indépendantes. On fait donc un " +
      'vrai appel de lecture par API.',
  );

  let clients;
  try {
    clients = await getClients({ config, subject: config.adminEmail, scopes: portees });
  } catch (e) {
    ecrireLignes(log, sortie, explainGoogleError(e, { context: 'préparation des clients' }));
    rapport.verdict(4, TITRES_CONTROLES[4], 'echec', 'impossible de préparer les clients Google.');
    return { admin: false, echecs: 4 };
  }

  const resultats = [];
  let echecs = 0;
  let adminOk = false;

  for (const controle of appelsDeLecture(config)) {
    if (controle.ignorer) {
      log.info(`[SANS OBJET] ${controle.titre} — ${controle.ignorer}`);
      resultats.push({ API: controle.api.nom, Appel: controle.appel, Résultat: 'NON TESTÉ' });
      continue;
    }

    try {
      const resume = await controle.executer(clients);
      log.ok(`${controle.api.nom} — ${resume}`);
      resultats.push({ API: controle.api.nom, Appel: controle.appel, Résultat: 'OK' });
      if (controle.api === APIS.admin) adminOk = true;
    } catch (e) {
      echecs += 1;
      resultats.push({ API: controle.api.nom, Appel: controle.appel, Résultat: 'ÉCHEC' });
      expliquerEchecApi({ e, controle, config, mode, log, sortie, rapport });
    }
  }

  log.table(resultats);

  if (echecs === 0) {
    rapport.verdict(4, TITRES_CONTROLES[4], 'ok', 'les quatre API répondent (ou sont sans objet ici).');
  } else {
    rapport.verdict(4, TITRES_CONTROLES[4], 'echec', `${echecs} API sur 4 ne répondent pas.`);
  }

  return { admin: adminOk, echecs, clients };
}

/** Explique l'échec d'un appel de lecture, avec le correctif exact. */
function expliquerEchecApi({ e, controle, config, mode, log, sortie, rapport }) {
  const api = controle.api;
  const { status, activationUrl } = errorInfo(e);
  const brut = messageGoogle(e);

  log.err(`${api.nom} — l'appel « ${controle.appel} » a échoué (${status ?? 'erreur réseau'}).`);
  log.info(`Message de Google : ${brut}`);

  if (apiDesactivee(e)) {
    log.info("Traduction : cette API n'est pas activée dans le projet Google Cloud.");
    sortie('');
    log.info(`  API à activer  : ${api.nom}`);
    log.info(`  Nom technique  : ${api.service}`);
    log.info('  URL directe    :');
    sortie('');
    sortie(api.url);
    sortie('');
    if (activationUrl && activationUrl !== api.url) {
      log.info(`  Lien fourni par Google (même chose, avec le projet pré-sélectionné) :`);
      sortie(activationUrl);
      sortie('');
    }
    if (api.piege) log.info(`  Attention : ${api.piege}`);
    log.info('  En une commande, si l\'outil gcloud est installé :');
    sortie('');
    sortie(`gcloud services enable ${api.service} --project=MON_PROJET`);
    sortie('');
    log.info('  Compter 1 à 2 minutes après activation avant de relancer doctor.');
    rapport.action(1, `Activer « ${api.nom} » (${api.service}) : ${api.url}`);
    return;
  }

  if (porteeManquante(e)) {
    log.info(
      "Traduction : le jeton a bien été émis, mais il ne porte pas la portée nécessaire à cette API. " +
        "En mode compte de service, cela veut dire que la liste de portées enregistrée dans la " +
        'délégation est incomplète.',
    );
    log.info('Liste à recoller, telle quelle, dans la délégation :');
    sortie('');
    sortie(scopeLine(mode));
    sortie('');
    for (const ligne of DELEGATION_MENU) log.info(ligne);
    rapport.action(1, `Recoller la liste complète de portées dans la délégation : ${DELEGATION_URL}`);
    return;
  }

  if (droitsInsuffisants(e)) {
    log.info(
      `Traduction : le jeton est valide, mais ${config.adminEmail} n'a pas le droit de faire cet appel. ` +
        "C'est un problème de privilèges d'administration, pas d'API. Voir le contrôle 5.",
    );
    for (const ligne of ROLES_MENU) log.info(ligne);
    rapport.action(2, `Vérifier que ${config.adminEmail} est bien super-administrateur du domaine.`);
    return;
  }

  ecrireLignes(log, sortie, explainGoogleError(e, { context: `appel ${controle.appel}` }));
  rapport.action(2, `Corriger l'échec de « ${api.nom} » signalé au contrôle 4.`);
}

/* ================================================================== *
 * Contrôle 5 — le compte emprunté est-il super-administrateur ?
 * ================================================================== */

/**
 * Le compte de service n'est pas — et ne peut pas être — administrateur : il
 * n'existe pas dans l'annuaire Workspace. Tout son pouvoir vient de la
 * délégation PLUS l'identité qu'il emprunte. C'est donc `adminEmail` qui doit
 * être privilégié, et c'est ce que ce contrôle vérifie.
 */
async function controleSuperAdmin({ config, clients, apisOk, log, sortie, rapport }) {
  log.step('Contrôle 5 sur 5 — le compte emprunté est-il super-administrateur ?');

  if (!clients) {
    rapport.verdict(5, TITRES_CONTROLES[5], 'ignore', "non testé — aucun client Google n'a pu être préparé.");
    return;
  }

  if (!apisOk) {
    log.info(
      "Le contrôle 4 a déjà échoué sur l'Admin SDK : ce contrôle risque d'échouer pour la même " +
        'raison. Le résultat ci-dessous est à lire en gardant cela en tête.',
    );
  }

  log.info(
    "Rappel : le compte de service n'est pas administrateur et ne peut pas l'être — il n'existe " +
      "pas dans l'annuaire. Le pouvoir vient de la délégation PLUS l'identité empruntée. C'est " +
      `donc ${config.adminEmail} qui doit avoir les privilèges.`,
  );

  let usager;
  try {
    const res = await withRetry(
      () =>
        clients.admin.users.get({
          userKey: config.adminEmail,
          projection: 'basic',
          fields: USER_GET_FIELDS,
        }),
      { tries: 3, propagation: false, label: 'admin.users.get' },
    );
    usager = res?.data ?? {};
  } catch (e) {
    if (apiDesactivee(e)) {
      log.info("L'Admin SDK n'est pas activée : impossible de vérifier les privilèges (voir le contrôle 4).");
      rapport.verdict(5, TITRES_CONTROLES[5], 'ignore', "non testé — l'Admin SDK API n'est pas activée.");
      return;
    }
    if (isNotFound(e)) {
      log.err(`Le compte ${config.adminEmail} n'existe pas dans ce domaine Workspace.`);
      log.info("Quoi faire : corriger « adminEmail » dans config.json, ou créer le compte dans");
      log.info('la console d\'administration > Annuaire > Utilisateurs > Ajouter un utilisateur.');
      rapport.verdict(5, TITRES_CONTROLES[5], 'echec', `${config.adminEmail} est introuvable dans l'annuaire.`);
      rapport.action(1, `Corriger « adminEmail » dans config.json, ou créer le compte ${config.adminEmail}.`);
      return;
    }
    if (droitsInsuffisants(e) || porteeManquante(e)) {
      log.err(`Lecture de ${config.adminEmail} refusée par Google.`);
      log.info(`Message de Google : ${messageGoogle(e)}`);
      log.info(
        "Traduction la plus probable : ce compte n'a AUCUN privilège d'administration. " +
          "Un compte ordinaire ne peut pas lire l'annuaire.",
      );
      for (const ligne of ROLES_MENU) log.info(ligne);
      log.info(`  Rôle à attribuer : « Super administrateur » à ${config.adminEmail}.`);
      rapport.verdict(5, TITRES_CONTROLES[5], 'echec', `${config.adminEmail} ne semble avoir aucun privilège d'administration.`);
      rapport.action(1, `Attribuer le rôle « Super administrateur » à ${config.adminEmail} (console d'administration > Annuaire > Utilisateurs).`);
      return;
    }
    ecrireLignes(log, sortie, explainGoogleError(e, { context: `lecture de ${config.adminEmail}` }));
    rapport.verdict(5, TITRES_CONTROLES[5], 'echec', "impossible de vérifier les privilèges du compte emprunté.");
    return;
  }

  const nom = usager.name?.fullName ?? '(nom inconnu)';
  log.info(`Compte        : ${usager.primaryEmail} — ${nom}`);
  log.info(`Unité org.    : ${usager.orgUnitPath ?? '/'}`);
  log.info(`Super-admin   : ${usager.isAdmin ? 'OUI' : 'non'}`);
  log.info(`Admin délégué : ${usager.isDelegatedAdmin ? 'oui' : 'non'}`);
  log.info(`Suspendu      : ${usager.suspended ? `OUI (${usager.suspensionReason ?? 'raison inconnue'})` : 'non'}`);
  log.info(`Archivé       : ${usager.archived ? 'OUI' : 'non'}`);
  log.info(`Validation 2 étapes : ${usager.isEnrolledIn2Sv ? 'activée' : 'NON activée'}`);
  log.info(`Dernière connexion  : ${usager.lastLoginTime === JAMAIS_CONNECTE ? 'jamais' : usager.lastLoginTime ?? 'inconnue'}`);

  /** @type {string[]} */
  const remarques = [];

  if (usager.suspended) {
    remarques.push(
      `Le compte est SUSPENDU : Google refusera de l'emprunter (invalid_grant). ` +
        'Le réactiver dans la console d\'administration > Annuaire > Utilisateurs.',
    );
  }
  if (usager.archived) {
    remarques.push("Le compte est ARCHIVÉ : il ne peut pas être emprunté. Le restaurer avant de continuer.");
  }
  if (usager.lastLoginTime === JAMAIS_CONNECTE || usager.agreedToTerms === false) {
    remarques.push(
      "Ce compte ne s'est jamais connecté et n'a jamais accepté les conditions d'utilisation. " +
        "Un compte jamais utilisé ne peut PAS être emprunté par un compte de service : se connecter " +
        `une fois sur https://mail.google.com avec ${config.adminEmail}, puis relancer.`,
    );
  }
  if (usager.isEnrolledIn2Sv === false) {
    remarques.push(
      "La validation en deux étapes n'est pas activée sur ce compte super-administrateur. " +
        "Ce n'est pas bloquant pour la trousse, mais c'est le compte le plus sensible du domaine : " +
        "l'activer sur https://myaccount.google.com/signinoptions/two-step-verification.",
    );
  }

  if (usager.isAdmin) {
    if (remarques.length > 0) {
      for (const r of remarques) ecrireLignes(log, sortie, r);
      const bloquant = Boolean(usager.suspended || usager.archived);
      rapport.verdict(
        5,
        TITRES_CONTROLES[5],
        bloquant ? 'echec' : 'avertissement',
        `${config.adminEmail} est super-administrateur, mais ${remarques.length} point(s) demandent attention.`,
      );
      if (bloquant) rapport.action(1, `Réactiver le compte ${config.adminEmail} dans la console d'administration.`);
      return;
    }
    rapport.verdict(5, TITRES_CONTROLES[5], 'ok', `${config.adminEmail} est bien super-administrateur du domaine.`);
    return;
  }

  if (usager.isDelegatedAdmin) {
    log.info(
      "Ce compte a un rôle d'administrateur DÉLÉGUÉ, pas le rôle de super-administrateur. " +
        'Selon les privilèges de ce rôle, certaines opérations passeront et d\'autres non : ' +
        "création de groupes, réglages de groupe et gestion des Drive partagés exigent en pratique " +
        'un rôle couvrant explicitement ces privilèges.',
    );
    for (const ligne of ROLES_MENU) log.info(ligne);
    log.info(
      "Deux options : (a) attribuer « Super administrateur » à ce compte ; (b) garder le rôle " +
        'personnalisé, mais vérifier qu\'il couvre les privilèges Annuaire (utilisateurs et groupes), ' +
        'Groupes, et Drive et Docs.',
    );
    for (const r of remarques) ecrireLignes(log, sortie, r);
    rapport.verdict(
      5,
      TITRES_CONTROLES[5],
      'avertissement',
      `${config.adminEmail} est administrateur délégué, pas super-administrateur.`,
    );
    rapport.action(2, `Vérifier que le rôle délégué de ${config.adminEmail} couvre Annuaire, Groupes, Drive et Docs.`);
    return;
  }

  log.err(`${config.adminEmail} n'a aucun privilège d'administration.`);
  log.info(
    "La trousse doit créer des groupes, des calendriers et un Drive partagé au nom de ce compte : " +
      'sans privilèges, tout échouera avec « Not Authorized to access this resource/api ».',
  );
  for (const ligne of ROLES_MENU) log.info(ligne);
  log.info(`  Rôle à attribuer : « Super administrateur » à ${config.adminEmail}.`);
  log.info(
    "Bonne pratique de sécurité, une fois que tout fonctionne : plutôt que d'emprunter en " +
      "permanence un super-administrateur, créer un rôle d'administrateur personnalisé limité " +
      'au strict nécessaire et l\'attribuer à un compte de service dédié.',
  );
  for (const r of remarques) ecrireLignes(log, sortie, r);
  rapport.verdict(5, TITRES_CONTROLES[5], 'echec', `${config.adminEmail} n'est pas administrateur.`);
  rapport.action(1, `Attribuer le rôle « Super administrateur » à ${config.adminEmail} dans la console d'administration.`);
}

/* ================================================================== *
 * Verdict final
 * ================================================================== */

/** Affiche le tableau récapitulatif, le verdict et les prochaines actions. */
function afficherVerdict({ rapport, config, log, sortie }) {
  log.banner('Verdict du diagnostic');

  log.table(
    rapport.controles.map((c) => ({
      '#': String(c.id),
      Contrôle: c.titre,
      Résultat: LIBELLE_STATUT[c.statut] ?? c.statut,
      Détail: c.resume.length > 58 ? `${c.resume.slice(0, 55)}...` : c.resume,
    })),
  );

  const echecs = rapport.controles.filter((c) => c.statut === 'echec');
  const avertissements = rapport.controles.filter((c) => c.statut === 'avertissement');
  const nonTestes = rapport.controles.filter((c) => c.statut === 'ignore');

  log.step('Prochaines actions');

  if (echecs.length === 0 && avertissements.length === 0 && nonTestes.length === 0) {
    log.ok("Tout est en place : la trousse peut travailler. Rien à corriger.");
    log.info('  1. node src/cli.mjs audit               voir ce qui existe déjà dans le domaine');
    log.info('  2. node src/cli.mjs setup               simulation : montre ce qui serait fait');
    log.info('  3. node src/cli.mjs setup --apply       exécute pour de vrai');
    return;
  }

  if (echecs.length === 0) {
    log.warn(
      `L'accès à Google fonctionne, mais ${avertissements.length + nonTestes.length} point(s) demandent attention.`,
    );
  } else {
    log.err(`${echecs.length} contrôle(s) en échec : la trousse ne peut pas encore travailler.`);
  }

  // Les actions ont été accumulées par les contrôles, dans l'ordre où le
  // problème doit être réglé. On garde les trois plus urgentes : au-delà,
  // personne ne lit.
  const vues = new Set();
  const actions = rapport.actions
    .filter((a) => {
      if (vues.has(a.texte)) return false;
      vues.add(a.texte);
      return true;
    })
    .sort((a, b) => a.priorite - b.priorite)
    .slice(0, 3);

  if (actions.length === 0) {
    log.info('  1. Relire les messages ci-dessus : ils indiquent le champ ou le réglage à corriger.');
  } else {
    actions.forEach((a, i) => ecrireLignes(log, sortie, `  ${i + 1}. ${a.texte}`));
  }

  sortie('');
  log.info('Puis relancer : node src/cli.mjs doctor');
  log.info(`Domaine visé : ${config.domain} · compte emprunté : ${config.adminEmail}`);
}

/* ================================================================== *
 * Point d'entrée de la commande
 * ================================================================== */

/**
 * @param {{ config: object, apply: boolean, state: object, log: object }} params
 * @returns {Promise<{ created: string[], updated: string[], unchanged: string[], warnings: string[] }>}
 */
export async function run({ config: configEntrant, apply, state, log }) {
  // `log.raw` écrit une ligne telle quelle, sans puce ni indentation : c'est ce
  // qu'il faut pour les valeurs à copier-coller. Le CLI peut fournir un journal
  // réduit : on retombe alors sur la fonction du module.
  const sortie = typeof log?.raw === 'function' ? log.raw : ecrireBrut;

  const rapport = nouveauRapport(log);

  log.info(
    "Diagnostic en LECTURE SEULE : uniquement des appels get et list. Rien n'est créé, " +
      'modifié ni supprimé, ni chez Google, ni sur le disque.',
  );
  log.info(
    "Sécurité : aucun appel drive.files.* n'est fait. Aucun document n'est lu ni listé, " +
      'ni dans un Drive partagé, ni dans un « Mon Drive » personnel.',
  );
  if (apply) {
    log.warn("L'option --apply est sans effet sur « doctor » : cette commande ne modifie jamais rien.");
  }

  const { config } = controleConfig({ configEntrant, state, log, sortie, rapport });

  if (!config) {
    // Sans configuration, aucun autre contrôle n'a de sens.
    for (const id of [2, 3, 4, 5]) {
      rapport.verdict(id, TITRES_CONTROLES[id], 'ignore', 'non testé — la configuration est inutilisable.');
    }
    afficherVerdict({ rapport, config: { domain: '?', adminEmail: '?' }, log, sortie });
    return resumer(rapport);
  }

  // Le mode dicte le jeu de portées : la délégation exige un jeu STRICT, le
  // mode OAuth demande en plus de quoi lire le courriel du compte connecté.
  let mode;
  let portees;
  try {
    mode = authMode(config);
    portees = scopesFor(mode);
  } catch (e) {
    ecrireLignes(log, sortie, e?.message ?? String(e));
    rapport.verdict(2, TITRES_CONTROLES[2], 'echec', "le champ auth.mode de config.json ne contient pas une valeur acceptée.");
    for (const id of [3, 4, 5]) {
      rapport.verdict(id, TITRES_CONTROLES[id], 'ignore', "non testé — le mode d'authentification est invalide.");
    }
    rapport.action(1, 'Mettre auth.mode à "oauth" ou à "service-account" dans config.json.');
    afficherVerdict({ rapport, config, log, sortie });
    return resumer(rapport);
  }

  const identifiants = controleIdentifiants({ config, mode, portees, log, sortie, rapport });
  const jeton = await controleJeton({ config, mode, portees, identifiants, log, sortie, rapport });

  let apis = { admin: false, echecs: 4, clients: null };
  if (jeton.ok) {
    apis = await controleApis({ config, mode, portees, log, sortie, rapport });
  } else {
    log.step('Contrôle 4 sur 5 — chaque API répond-elle vraiment ?');
    log.info("Sans jeton, aucun appel d'API n'est possible : ce contrôle est reporté.");
    rapport.verdict(4, TITRES_CONTROLES[4], 'ignore', "non testé — aucun jeton n'a pu être obtenu.");
  }

  if (jeton.ok) {
    await controleSuperAdmin({
      config,
      clients: apis.clients ?? null,
      apisOk: apis.admin,
      log,
      sortie,
      rapport,
    });
  } else {
    log.step('Contrôle 5 sur 5 — le compte emprunté est-il super-administrateur ?');
    log.info("Sans jeton, l'annuaire n'est pas lisible : ce contrôle est reporté.");
    rapport.verdict(5, TITRES_CONTROLES[5], 'ignore', "non testé — aucun jeton n'a pu être obtenu.");
  }

  afficherVerdict({ rapport, config, log, sortie });

  return resumer(rapport);
}

/**
 * Convertit le rapport au format de résumé attendu par le CLI.
 * `doctor` ne crée ni ne modifie rien : « unchanged » liste les contrôles
 * réussis, « warnings » tout ce qui demande une intervention.
 */
function resumer(rapport) {
  return {
    created: [],
    updated: [],
    unchanged: rapport.controles
      .filter((c) => c.statut === 'ok')
      .map((c) => `Contrôle ${c.id} (${c.titre}) : ${c.resume}`),
    warnings: rapport.controles
      .filter((c) => c.statut !== 'ok')
      .map((c) => `Contrôle ${c.id} (${c.titre}) — ${LIBELLE_STATUT[c.statut]} : ${c.resume}`),
  };
}

export default { meta, run };
