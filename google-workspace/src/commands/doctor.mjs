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
  ALL_SCOPES,
  SCOPES,
  delegationInstructions,
  formatScopeList,
  getAuthClient,
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
    const texte = readFileSync(chemin, 'utf8').replace(/^﻿/, '');
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

/** Découpe un texte multiligne et l'envoie ligne par ligne à `sortie`. */
function ecrireLignes(sortie, texte) {
  for (const ligne of String(texte).split('\n')) sortie(ligne);
}
