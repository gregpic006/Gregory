/**
 * detach.mjs — Commande « detach » : détacher l'adresse Gmail personnelle.
 *
 * C'EST LA COMMANDE LA PLUS DÉLICATE DE LA TROUSSE.
 * Mal utilisée, elle peut barrer le propriétaire hors de son propre Google
 * Workspace : l'adresse personnelle est, dans un compte fraîchement créé, à la
 * fois l'adresse de récupération, le contact de facturation et souvent la
 * propriétaire du projet Google Cloud. On ne retire jamais une porte de secours
 * sans en avoir installé une autre AVANT.
 *
 * D'où trois principes appliqués partout dans ce fichier :
 *
 *   1. VÉRIFICATIONS BLOQUANTES D'ABORD. Elles s'appliquent même avec --apply.
 *      Tant qu'elles ne passent pas, aucune écriture n'est tentée. Ce n'est pas
 *      une erreur de programme : c'est un refus motivé, expliqué en français.
 *
 *   2. ON AJOUTE AVANT DE RETIRER. L'adresse de remplacement (--recovery) doit
 *      être connue avant qu'on efface quoi que ce soit.
 *
 *   3. ON NE TOUCHE JAMAIS AU « MON DRIVE » PERSONNEL. Côté Drive, ce fichier
 *      n'appelle QUE `drives.get`, `drives.list` et `permissions.*` sur
 *      l'identifiant du Drive PARTAGÉ. Aucun `files.list`, aucun `files.get`,
 *      aucun `files.delete` : les documents personnels ne sont ni lus, ni
 *      listés, ni déplacés, ni partagés. Une garde explicite
 *      (assertRacineDrivePartage) refuse tout appel dont la cible n'est pas
 *      exactement la racine du Drive partagé attendu.
 *
 * Ce que la commande fait, chaque étape idempotente :
 *   A. retire l'adresse personnelle des `emails[]` secondaires des usagers ;
 *   B. remplace l'adresse de récupération là où elle vaut l'adresse personnelle ;
 *   C. retire l'adresse personnelle des groupes dont elle est membre ;
 *   D. retire les règles d'accès de calendrier qui la visent ;
 *   E. retire les permissions du Drive partagé qui la visent ;
 *   F. (si la portée est disponible) remplace l'adresse secondaire du compte client.
 *
 * Ce qu'aucune API ne permet — facturation, profil de paiement, administrateur
 * principal, préférences de communication… — est imprimé à la fin sous
 * « À FAIRE À LA MAIN », avec les chemins EXACTS de la console.
 */

import { getClients, withRetry, collectPages, isNotFound, isForbidden, explainGoogleError } from '../lib/google.mjs';
import { ALL_SCOPES } from '../lib/auth.mjs';
import { getStateKey } from '../lib/state.mjs';

export const meta = {
  name: 'detach',
  summary:
    "Retire l'adresse personnelle de partout où l'API le permet (usagers, groupes, calendriers, " +
    "Drive partagé), après des vérifications de sécurité bloquantes, puis liste ce qui reste à " +
    'faire à la main.',
};

/* ================================================================== *
 * Constantes d'API
 * ================================================================== */

/** Alias accepté par l'Admin SDK pour « mon compte client ». */
const CUSTOMER_KEY = 'my_customer';

/**
 * Plafonds documentés. Ce sont TROIS valeurs différentes : les confondre fait
 * silencieusement tronquer une liste, et un script « idempotent » qui ne voit
 * pas tout finit par recréer ou par oublier.
 */
const USERS_PAGE_SIZE = 500; // admin.users.list    : max 500 (défaut 100)
const GROUPS_PAGE_SIZE = 200; // admin.groups.list  : max 200
const MEMBERS_PAGE_SIZE = 200; // admin.members.list: max 200
const CALENDAR_PAGE_SIZE = 250; // calendarList/acl : max 250
const DRIVE_PAGE_SIZE = 100; // drives/permissions  : max 100 (défaut 10 !)

/** Masques `fields` explicites : on ne rapatrie que ce qu'on utilise. */
const USER_FIELDS =
  'nextPageToken,users(id,primaryEmail,name(fullName),isAdmin,isDelegatedAdmin,suspended,archived,' +
  'isEnrolledIn2Sv,isEnforcedIn2Sv,recoveryEmail,recoveryPhone,emails,aliases,nonEditableAliases)';

const GROUP_FIELDS = 'nextPageToken,groups(id,email,name,directMembersCount)';

const MEMBER_FIELDS = 'nextPageToken,members(id,email,role,type,status)';

const CALENDAR_LIST_FIELDS =
  'nextPageToken,items(id,summary,summaryOverride,primary,accessRole,deleted)';

const ACL_FIELDS = 'nextPageToken,items(id,role,scope)';

const DRIVE_LIST_FIELDS = 'nextPageToken,drives(id,name)';

const PERMISSION_FIELDS =
  'nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,deleted,' +
  'permissionDetails(role,permissionType,inherited))';

/**
 * Portée nécessaire pour lire et modifier l'adresse secondaire du compte client
 * (`customers.alternateEmail`). Elle ne fait PAS partie des portées de la
 * trousse : l'ajouter obligerait à refaire la liste de délégation à l'échelle
 * du domaine, et une liste qui ne correspond plus EXACTEMENT casse tout le
 * reste. On teste donc sa présence à l'exécution : si elle est là, on agit ;
 * sinon on renvoie proprement l'opération vers la section manuelle.
 */
const CUSTOMER_SCOPE = 'https://www.googleapis.com/auth/admin.directory.customer';

/** Validation d'adresse courriel, alignée sur celle de config.mjs. */
const EMAIL_RE = /^[^\s@,;:<>"'\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/* ================================================================== *
 * Petits utilitaires
 * ================================================================== */

const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const sameEmail = (a, b) => lower(a) !== '' && lower(a) === lower(b);
const isEmail = (v) => typeof v === 'string' && EMAIL_RE.test(v.trim());
const domainOf = (email) => String(email).split('@').pop().trim().toLowerCase();
const tiret = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

/** Coupe un texte trop long pour tenir dans un tableau console. */
function couper(texte, max = 46) {
  const s = String(texte ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Le point d'entrée de la trousse ne garantit que neuf fonctions de journal
 * (step, info, ok, warn, err, plan, skip, table, banner). Cette commande a
 * besoin d'écrire des lignes brutes pour la liste à cocher et pour la feuille
 * de route manuelle : on complète ce qui manque plutôt que de planter.
 *
 * @param {object} journal
 */
function renforcerLog(journal) {
  const base = journal ?? {};
  return {
    ...base,
    raw: typeof base.raw === 'function' ? base.raw : (m) => console.log(String(m ?? '')),
    blank: typeof base.blank === 'function' ? base.blank : () => console.log(''),
    bold: typeof base.bold === 'function' ? base.bold : (m) => String(m ?? ''),
  };
}

/** Traduit une erreur Google en français, sans jamais lever à son tour. */
function expliquer(error, contexte) {
  try {
    const texte = explainGoogleError(error, contexte ? { context: contexte } : {});
    if (typeof texte === 'string' && texte.trim() !== '') return texte.trim();
  } catch {
    /* on retombe sur le message brut */
  }
  return error?.message ? String(error.message) : String(error);
}

/**
 * Lecture avec reprise sur erreur passagère seulement.
 * `propagation: false` est volontaire : ici, un 404 est une RÉPONSE (« cette
 * personne n'est pas membre de ce groupe »), pas un délai de propagation. Sans
 * ça, chaque non-appartenance coûterait deux minutes d'attente pour rien.
 */
function lire(label, fn) {
  return withRetry(fn, { tries: 3, label, propagation: false });
}

/** Écriture avec reprise : là, un 429 ou un 5xx mérite vraiment un deuxième essai. */
function ecrire(label, fn) {
  return withRetry(fn, { tries: 4, label, propagation: false });
}

/**
 * Exécute une lecture et retourne un résultat au lieu de lever. Sert à isoler
 * chaque section : si les calendriers sont illisibles, le Drive doit quand même
 * être traité.
 */
async function tenter(fn) {
  try {
    return { ok: true, valeur: await fn(), erreur: null };
  } catch (error) {
    return { ok: false, valeur: null, erreur: error };
  }
}

/* ================================================================== *
 * Option --recovery : l'adresse de remplacement
 * ================================================================== */

/**
 * Retrouve l'adresse de récupération de remplacement.
 *
 * Trois sources, dans l'ordre de priorité :
 *   1. l'option de ligne de commande --recovery <courriel> ;
 *   2. une variable d'environnement (RECOVERY_EMAIL, PORTAIL_RECOVERY_EMAIL) ;
 *   3. le champ « recoveryEmail » de config.json.
 *
 * Note d'implantation : les commandes de la trousse reçoivent
 * { config, apply, state, log } et PAS les arguments bruts. On relit donc
 * process.argv ici. Si la version de cli.mjs en place refuse les options
 * qu'elle ne connaît pas, la variable d'environnement fonctionne, elle, sans
 * aucune modification — c'est le chemin proposé dans les messages d'erreur.
 *
 * @param {object} config
 * @returns {{ value: string|null, source: string|null, erreur: string|null }}
 */
function lireOptionRecovery(config) {
  const argv = Array.isArray(process.argv) ? process.argv.slice(2) : [];
  const noms = ['--recovery', '--recuperation', '--récupération'];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    for (const nom of noms) {
      if (arg === nom) {
        const suivant = argv[i + 1];
        if (typeof suivant === 'string' && suivant !== '' && !suivant.startsWith('-')) {
          return { value: suivant.trim(), source: `option ${nom}`, erreur: null };
        }
        return {
          value: null,
          source: `option ${nom}`,
          erreur: `L'option ${nom} attend une adresse courriel juste après. Exemple : ${nom} secours@exemple.com`,
        };
      }
      if (arg.startsWith(`${nom}=`)) {
        const valeur = arg.slice(nom.length + 1).trim();
        if (valeur !== '') return { value: valeur, source: `option ${nom}`, erreur: null };
        return { value: null, source: `option ${nom}`, erreur: `L'option ${nom} est vide.` };
      }
    }
  }

  for (const nom of ['RECOVERY_EMAIL', 'PORTAIL_RECOVERY_EMAIL', 'COURRIEL_RECUPERATION']) {
    const valeur = process.env[nom];
    if (typeof valeur === 'string' && valeur.trim() !== '') {
      return { value: valeur.trim(), source: `variable d'environnement ${nom}`, erreur: null };
    }
  }

  const depuisConfig = config?.recoveryEmail ?? config?.detach?.recoveryEmail ?? null;
  if (typeof depuisConfig === 'string' && depuisConfig.trim() !== '') {
    return { value: depuisConfig.trim(), source: 'champ « recoveryEmail » de config.json', erreur: null };
  }

  return { value: null, source: null, erreur: null };
}

/** Les trois façons de fournir l'adresse, telles qu'on les affiche à l'usager. */
function commentFournirRecovery() {
  return [
    "Comment fournir l'adresse de remplacement (une seule des trois suffit) :",
    '',
    '  a) Variable d\'environnement — fonctionne avec n\'importe quelle version de la trousse :',
    '',
    '       RECOVERY_EMAIL="secours@exemple.com" node src/cli.mjs detach --apply',
    '',
    '  b) Option de ligne de commande :',
    '',
    '       node src/cli.mjs detach --recovery secours@exemple.com --apply',
    '',
    '  c) Champ « recoveryEmail » dans config.json :',
    '',
    '       "recoveryEmail": "secours@exemple.com"',
  ].join('\n');
}

/** Pourquoi Google veut une adresse de secours HORS du domaine. */
function pourquoiAdresseExterne(domain) {
  return [
    'Pourquoi une adresse de récupération, et pourquoi hors du domaine :',
    '',
    "  · Le jour où le mot de passe est perdu, où le téléphone est volé, ou où le compte est",
    '    verrouillé, c\'est l\'adresse de récupération qui sert à reprendre la main.',
    "  · Un compte protégé par la validation en deux étapes ne peut être réinitialisé QU'AVEC",
    '    une adresse de récupération. Un numéro de téléphone ne suffit pas dans ce cas.',
    `  · Une adresse de secours dans « ${domain} » vit DANS le système qu'elle est censée`,
    "    secourir : si le domaine, le DNS ou le Workspace deviennent inaccessibles, la porte de",
    '    secours l\'est aussi. Google impose d\'ailleurs une adresse hors domaine pour l\'adresse',
    "    secondaire du COMPTE (« alternateEmail ») : l'API refuse une adresse du domaine.",
    '',
    "  Sans adresse de récupération valide, il ne reste que deux chemins, tous deux lents :",
    '    1. le formulaire https://toolbox.googleapps.com/apps/recovery/form, qui exige de publier',
    "       un enregistrement DNS — non trouvé sous 48 h, la demande échoue et il faut recommencer ;",
    '    2. la récupération assistée par le soutien Google, avec preuves de propriété du domaine',
    '       et délai non garanti.',
    '',
    '  Bon choix : une boîte neutre et pérenne que l\'entreprise contrôle (autre fournisseur, ou',
    "  une adresse dédiée à l'administration), PAS la boîte personnelle qu'on est en train de",
    '  détacher.',
  ].join('\n');
}

/* ================================================================== *
 * Inventaire (lecture seule)
 * ================================================================== */

/**
 * Liste tous les usagers du domaine.
 * `customer: 'my_customer'` et non `domain` : dans un compte multi-domaines,
 * `domain` n'en couvre qu'un seul et on raterait des comptes.
 */
async function listerUsagers(admin) {
  return collectPages(
    (pageToken) =>
      admin.users.list({
        customer: CUSTOMER_KEY,
        maxResults: USERS_PAGE_SIZE,
        projection: 'full',
        orderBy: 'email',
        fields: USER_FIELDS,
        pageToken,
      }),
    { itemsKey: 'users', label: 'lecture des usagers du domaine' },
  );
}

/** Liste tous les groupes du domaine. */
async function listerGroupes(admin) {
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

/** Liste les membres d'un groupe, éventuellement filtrés par rôle. */
async function listerMembres(admin, groupKey, roles) {
  return collectPages(
    (pageToken) =>
      admin.members.list({
        groupKey,
        maxResults: MEMBERS_PAGE_SIZE,
        includeDerivedMembership: false,
        ...(roles ? { roles } : {}),
        fields: MEMBER_FIELDS,
        pageToken,
      }),
    { itemsKey: 'members', label: `lecture des membres de ${groupKey}` },
  );
}

/* ================================================================== *
 * VÉRIFICATIONS DE SÉCURITÉ (bloquantes, même avec --apply)
 * ================================================================== */

/**
 * Analyse la population de super-administrateurs.
 *
 * Rappel de l'API : `isAdmin` signifie SUPER-administrateur ; `isDelegatedAdmin`
 * signifie administrateur délégué (droits partiels). Les deux sont en lecture
 * seule et ne se modifient que par `users.makeAdmin`.
 * Un compte suspendu ou archivé ne peut pas se connecter : il ne compte pas
 * comme filet de sécurité.
 *
 * @param {Array<object>} users
 */
function analyserSuperAdmins(users) {
  const superAdmins = users.filter((u) => u?.isAdmin === true);
  const actifs = superAdmins.filter((u) => u?.suspended !== true && u?.archived !== true);
  return { superAdmins, actifs };
}

/**
 * Construit la liste des vérifications de sécurité et décide si on a le droit
 * d'agir. Aucune écriture n'a lieu tant que `bloquant` n'est pas vide.
 *
 * @returns {{ items: Array<{etat:'ok'|'ko'|'info', texte:string, detail?:string}>, bloquants: string[] }}
 */
function verificationsSecurite({ config, users, cibles, recovery, recoveryErreur }) {
  const items = [];
  const bloquants = [];

  const { superAdmins, actifs } = analyserSuperAdmins(users);

  /* --- 1. Filet de sécurité administrateur --------------------------- */

  // Les super-administrateurs que CETTE commande s'apprête à modifier
  // (adresse de récupération ou adresses secondaires).
  const cibleSuperAdmins = cibles.filter((c) => c.user?.isAdmin === true);
  const cibleEmails = new Set(cibleSuperAdmins.map((c) => lower(c.user.primaryEmail)));
  const autresActifs = actifs.filter((u) => !cibleEmails.has(lower(u.primaryEmail)));

  if (actifs.length === 0) {
    items.push({
      etat: 'ko',
      texte: 'Au moins un super-administrateur actif existe dans le domaine',
      detail:
        "Aucun super-administrateur actif n'a été trouvé. C'est anormal : soit la lecture de " +
        "l'annuaire est incomplète, soit le seul compte administrateur est suspendu. On " +
        "n'écrit rien tant que ce n'est pas éclairci.",
    });
    bloquants.push('aucun super-administrateur actif détecté');
  } else if (cibleSuperAdmins.length === 0) {
    items.push({
      etat: 'ok',
      texte: 'Aucun compte super-administrateur ne sera modifié par cette commande',
      detail:
        `${actifs.length} super-administrateur(s) actif(s) dans le domaine : ` +
        `${actifs.map((u) => u.primaryEmail).join(', ')}. ` +
        "Les modifications prévues ne touchent pas leurs informations de récupération.",
    });
  } else if (autresActifs.length > 0) {
    items.push({
      etat: 'ok',
      texte: "Un autre super-administrateur actif existe et pourra rouvrir la porte",
      detail:
        `Compte(s) de secours : ${autresActifs.map((u) => u.primaryEmail).join(', ')}.\n` +
        `Compte(s) modifié(s) : ${cibleSuperAdmins.map((c) => c.user.primaryEmail).join(', ')}.\n` +
        "Un autre super-administrateur peut réinitialiser le mot de passe du premier depuis la " +
        'console : le risque de verrouillage total est écarté.',
    });
  } else {
    const sans2Sv = cibleSuperAdmins.filter((c) => c.user?.isEnrolledIn2Sv !== true);
    if (sans2Sv.length === 0) {
      items.push({
        etat: 'ok',
        texte: 'Le super-administrateur modifié a la validation en deux étapes activée',
        detail:
          `${cibleSuperAdmins.map((c) => c.user.primaryEmail).join(', ')} — validation en deux étapes : oui.\n` +
          "C'est le seul super-administrateur actif du domaine : après cette commande, générer ses " +
          'codes de secours et les ranger hors ligne (myaccount.google.com > Sécurité > Validation ' +
          'en deux étapes > Codes de secours).',
      });
    } else {
      items.push({
        etat: 'ko',
        texte: "Filet de sécurité administrateur",
        detail:
          [
            `Le ou les comptes à modifier sont les SEULS super-administrateurs actifs du domaine :`,
            `  ${sans2Sv.map((c) => c.user.primaryEmail).join(', ')}`,
            'et la validation en deux étapes n\'y est pas activée.',
            '',
            'RISQUE : en modifiant les informations de récupération du seul administrateur, sans',
            'deuxième administrateur pour rouvrir la porte et sans deuxième facteur, une erreur de',
            'frappe dans l\'adresse de remplacement suffit à barrer définitivement l\'accès au',
            'Workspace. La récupération passerait alors par un défi DNS de 48 h ou par le soutien',
            'Google, avec preuves de propriété du domaine.',
            '',
            'Corriger AVANT de relancer, au choix :',
            '  1. Créer un deuxième super-administrateur :',
            '     console.admin.google.com > Annuaire > Utilisateurs > Ajouter un utilisateur,',
            "     puis ouvrir sa fiche > Rôles et privilèges d'administrateur > Super Admin.",
            '     Compter jusqu\'à 24 h de propagation. Ne pas s\'en servir au quotidien.',
            '  2. OU activer la validation en deux étapes sur le compte administrateur :',
            '     myaccount.google.com > Sécurité > Validation en deux étapes,',
            '     puis générer et ranger les codes de secours.',
          ].join('\n'),
      });
      bloquants.push('pas de deuxième super-administrateur actif, ni de validation en deux étapes');
    }
  }

  /* --- 2. Adresse de récupération de remplacement -------------------- */

  const remplacements = cibles.filter((c) => c.recoveryAChanger);

  if (recoveryErreur) {
    items.push({ etat: 'ko', texte: "Adresse de récupération de remplacement", detail: recoveryErreur });
    bloquants.push('option --recovery mal formée');
  } else if (remplacements.length === 0) {
    items.push({
      etat: 'ok',
      texte: "Aucune adresse de récupération n'est retirée par cette commande",
      detail:
        "Aucun compte du domaine n'a l'adresse personnelle comme adresse de récupération. " +
        "L'option --recovery n'est donc pas exigée pour cette exécution.",
    });
  } else if (!recovery.value) {
    items.push({
      etat: 'ko',
      texte: 'Adresse de récupération de remplacement fournie',
      detail:
        [
          `${remplacements.length} compte(s) utilisent encore l'adresse personnelle comme adresse de`,
          'récupération :',
          ...remplacements.map((c) => `  · ${c.user.primaryEmail}`),
          '',
          'REFUS : retirer une adresse de récupération sans en fournir une autre laisserait ces',
          'comptes sans porte de secours.',
          '',
          commentFournirRecovery(),
        ].join('\n'),
    });
    bloquants.push('adresse de récupération de remplacement manquante (--recovery)');
  } else if (!isEmail(recovery.value)) {
    items.push({
      etat: 'ko',
      texte: 'Adresse de récupération de remplacement fournie',
      detail:
        `« ${recovery.value} » (${recovery.source}) n'est pas une adresse courriel valide.\n` +
        'Corriger la valeur et relancer.',
    });
    bloquants.push('adresse de remplacement invalide');
  } else if (sameEmail(recovery.value, config.personalEmail)) {
    items.push({
      etat: 'ko',
      texte: 'Adresse de récupération de remplacement fournie',
      detail:
        `L'adresse de remplacement (${recovery.value}) est exactement celle qu'on cherche à ` +
        'détacher. Il faut une AUTRE adresse.',
    });
    bloquants.push("adresse de remplacement identique à l'adresse personnelle");
  } else {
    const memeDomaine = domainOf(recovery.value) === lower(config.domain);
    items.push({
      etat: 'ok',
      texte: `Adresse de récupération de remplacement fournie : ${recovery.value}`,
      detail:
        `Source : ${recovery.source}.\n` +
        (memeDomaine
          ? `ATTENTION : cette adresse est dans le domaine « ${config.domain} ». Google l'acceptera ` +
            "peut-être comme adresse de récupération d'un USAGER, mais elle ne protège de rien : " +
            'si le domaine devient inaccessible, la porte de secours l\'est aussi. Et elle sera ' +
            "REFUSÉE pour l'adresse secondaire du COMPTE (Google impose une adresse hors domaine). " +
            'Utiliser plutôt une boîte chez un autre fournisseur.'
          : `Adresse hors du domaine « ${config.domain} » : c'est ce que Google recommande.`),
    });
  }

  /* --- 3. Renseignements complémentaires (non bloquants) ------------- */

  const admin = users.find((u) => sameEmail(u.primaryEmail, config.adminEmail)) ?? null;
  if (admin) {
    items.push({
      etat: admin.isEnrolledIn2Sv === true ? 'ok' : 'info',
      texte: `Validation en deux étapes sur ${config.adminEmail} : ${admin.isEnrolledIn2Sv === true ? 'activée' : 'non activée'}`,
      detail:
        admin.isEnrolledIn2Sv === true
          ? 'Penser aux codes de secours : sans eux, un téléphone perdu redevient un verrouillage.'
          : "Ce n'est pas bloquant ici, mais c'est la protection la plus rentable d'un compte " +
            'administrateur. myaccount.google.com > Sécurité > Validation en deux étapes.',
    });
    items.push({
      etat: admin.recoveryPhone ? 'ok' : 'info',
      texte: `Téléphone de récupération sur ${config.adminEmail} : ${admin.recoveryPhone ? 'présent' : 'absent'}`,
      detail: admin.recoveryPhone
        ? null
        : "Ajouter un numéro mobile (format international, ex. +15145551212) : console.admin.google.com > " +
          'Annuaire > Utilisateurs > [le compte] > Sécurité > Informations de récupération. ' +
          'Rappel : avec la validation en deux étapes, le téléphone SEUL ne permet pas de ' +
          "réinitialiser le mot de passe — l'adresse de récupération reste indispensable.",
    });
  } else {
    items.push({
      etat: 'info',
      texte: `Le compte ${config.adminEmail} n'a pas été retrouvé dans l'annuaire`,
      detail:
        "C'est inattendu : le compte impersonné devrait figurer parmi les usagers du domaine. " +
        'Vérifier « adminEmail » dans config.json.',
    });
  }

  return { items, bloquants };
}

/** Affiche la liste à cocher des vérifications. */
function afficherChecklist(log, items) {
  log.step('Vérifications de sécurité (bloquantes, même avec --apply)');
  log.info(
    "Ces vérifications existent pour une seule raison : ne jamais retirer une porte de secours " +
      "avant d'en avoir installé une autre.",
  );
  log.blank();

  let numero = 0;
  for (const item of items) {
    numero += 1;
    const marque = item.etat === 'ok' ? '[X]' : item.etat === 'ko' ? '[ ]' : '[i]';
    log.raw(`    ${marque} ${numero}. ${item.texte}`);
    if (item.detail) {
      for (const ligne of String(item.detail).split('\n')) {
        log.raw(`          ${ligne}`);
      }
    }
    log.blank();
  }
}

/* ================================================================== *
 * A. Adresses secondaires — emails[]
 * ================================================================== */

/**
 * Prépare le retrait de l'adresse personnelle du tableau `emails[]` d'un usager.
 *
 * PIÈGE CENTRAL DE L'ADMIN SDK : `emails[]` est un REMPLACEMENT INTÉGRAL, même
 * avec `patch`. Envoyer `{ emails: [{ address: 'x' }] }` efface toutes les
 * autres adresses, y compris la principale. Le seul motif sûr est donc
 * relire → filtrer → réécrire le tableau COMPLET, ce que fait cette fonction.
 *
 * Deux refus intégrés :
 *   - on ne retire jamais l'entrée marquée `primary` ;
 *   - on ne retire jamais une entrée qui est un ALIAS : `aliases` est en
 *     lecture seule, un alias se supprime par `users.aliases.delete`. Retirer
 *     l'entrée de `emails[]` ne supprimerait pas l'alias et Google le
 *     remettrait.
 *
 * @returns {{ change: boolean, avant: string[], apres: string[], refus: string[] }}
 */
function preparerEmails(user, personalEmail) {
  const courant = Array.isArray(user?.emails) ? user.emails : [];
  const cible = lower(personalEmail);

  const alias = new Set(
    [...(user?.aliases ?? []), ...(user?.nonEditableAliases ?? [])].map((a) => lower(a)),
  );

  const refus = [];
  const apresEntrees = [];

  for (const entree of courant) {
    const adresse = lower(entree?.address);

    if (adresse !== cible) {
      apresEntrees.push(entree);
      continue;
    }

    if (entree?.primary === true) {
      refus.push(
        `${user.primaryEmail} : l'adresse personnelle est l'adresse PRINCIPALE de ce compte. ` +
          'Refus de la retirer — ce serait détruire le compte. Vérifier config.json.',
      );
      apresEntrees.push(entree);
      continue;
    }

    if (alias.has(adresse)) {
      refus.push(
        `${user.primaryEmail} : ${entree.address} est un ALIAS du compte. Un alias ne se retire pas ` +
          "par le tableau des adresses ; il faut le supprimer comme alias (console.admin.google.com > " +
          "Annuaire > Utilisateurs > [le compte] > Informations utilisateur > Adresses e-mail alias).",
      );
      apresEntrees.push(entree);
      continue;
    }

    // Entrée retirée : on ne la remet pas dans le tableau.
  }

  const avant = courant.map((e) => `${e?.address ?? '(vide)'}${e?.primary === true ? ' (principale)' : ''}`);
  const apres = apresEntrees.map((e) => `${e?.address ?? '(vide)'}${e?.primary === true ? ' (principale)' : ''}`);
  const change = apresEntrees.length !== courant.length;

  // Garde-fou : on refuse de vider complètement le tableau. Le cas ne devrait
  // pas se produire (Google y met toujours l'adresse principale), mais s'il se
  // produisait, réécrire un tableau vide serait la pire chose à faire.
  if (change && apresEntrees.length === 0) {
    return {
      change: false,
      avant,
      apres: avant,
      entrees: courant,
      refus: [
        `${user.primaryEmail} : retirer l'adresse personnelle viderait complètement le tableau des ` +
          "adresses. Refus par prudence — à traiter à la main dans la console.",
      ],
    };
  }

  return { change, avant, apres, entrees: apresEntrees, refus };
}

/* ================================================================== *
 * Garde de sécurité Drive
 * ================================================================== */

/**
 * GARDE DE SÉCURITÉ — exigence numéro un du client.
 *
 * Cette commande ne doit JAMAIS agir ailleurs que sur la racine du Drive
 * PARTAGÉ attendu. Concrètement : le seul `fileId` que l'on a le droit de
 * passer à `permissions.*` est l'identifiant du Drive partagé lui-même (chez
 * Google, l'identifiant d'un Drive partagé est aussi celui de son dossier
 * racine). Tout autre identifiant serait, au mieux, un fichier — potentiellement
 * un document personnel du « Mon Drive ».
 *
 * @param {string|null} fileId identifiant que l'on s'apprête à utiliser
 * @param {string|null} driveIdAttendu identifiant du Drive partagé cible
 * @param {string} action description de l'opération, pour le message
 */
function assertRacineDrivePartage(fileId, driveIdAttendu, action) {
  if (!driveIdAttendu) {
    throw new Error(
      `REFUS DE SÉCURITÉ : aucun Drive partagé cible n'est connu, impossible de ${action}.\n` +
        'Aucune opération Drive ne sera tentée.',
    );
  }
  if (!fileId || fileId !== driveIdAttendu) {
    throw new Error(
      [
        `REFUS DE SÉCURITÉ : la trousse a failli ${action} en dehors du Drive partagé.`,
        '',
        `  Cible demandée : ${fileId ?? '(vide)'}`,
        `  Drive attendu  : ${driveIdAttendu}`,
        '',
        "Aucune modification n'a été faite. Cette trousse ne touche JAMAIS aux documents",
        'personnels : côté Drive, elle n\'agit que sur la racine du Drive partagé.',
        '',
        "Cause probable : un identifiant périmé dans le cache d'état. Supprimer le fichier",
        '.state.json et relancer en mode simulation.',
      ].join('\n'),
    );
  }
}

/**
 * Retrouve le Drive partagé de l'entreprise.
 * Cache d'abord (simple optimisation), puis redécouverte par le nom.
 */
async function trouverDrivePartage(drive, config, state, log) {
  const cache = getStateKey(state, 'driveId', null);

  if (typeof cache === 'string' && cache !== '') {
    const essai = await tenter(() =>
      lire('lecture du Drive partagé (cache)', () => drive.drives.get({ driveId: cache, fields: 'id,name' })),
    );
    if (essai.ok && essai.valeur?.data?.id) {
      return { drive: essai.valeur.data, source: 'cache local' };
    }
    if (essai.erreur && isNotFound(essai.erreur)) {
      log.warn(
        `Le cache local pointe vers un Drive partagé (${cache}) qui n'existe plus. On redécouvre par le nom.`,
      );
    }
  }

  const nomAttendu = config?.sharedDrive?.name ?? null;
  if (!nomAttendu) return { drive: null, source: null };

  const drives = await collectPages(
    (pageToken) => drive.drives.list({ pageSize: DRIVE_PAGE_SIZE, fields: DRIVE_LIST_FIELDS, pageToken }),
    { itemsKey: 'drives', label: 'lecture des Drive partagés' },
  );

  const correspondances = drives.filter((d) => lower(d?.name) === lower(nomAttendu));

  if (correspondances.length === 0) return { drive: null, source: null, candidats: drives };
  if (correspondances.length > 1) {
    return {
      drive: null,
      source: null,
      ambigu: correspondances.map((d) => `${d.name} (${d.id})`),
    };
  }
  return { drive: correspondances[0], source: 'recherche par nom' };
}

/* ================================================================== *
 * À FAIRE À LA MAIN
 * ================================================================== */

/**
 * Tout ce qu'AUCUNE API cliente ne permet de changer, plus ce que la trousse a
 * volontairement laissé de côté. Numéroté, dans l'ordre où il faut le faire.
 *
 * Sources : la facturation Google Workspace en direct n'a aucune API cliente
 * (la Cloud Billing API ne couvre que Google Cloud ; les API Reseller et Cloud
 * Channel sont réservées aux revendeurs). Le reste (administrateur principal,
 * préférences de communication, responsable de la protection des données,
 * comptes non gérés, Search Console) n'a pas non plus d'API publique.
 */
function etapesManuelles({ config, personalEmail, recovery, alternateEmailFait }) {
  const remplacement = recovery?.value ?? '<ton adresse de secours>';
  const etapes = [];

  etapes.push({
    titre: "Vérifier l'interrupteur de récupération du super-administrateur (à faire EN PREMIER)",
    chemin:
      'console.admin.google.com > Sécurité > Authentification > Récupération du compte > ' +
      'Récupération du compte super-administrateur',
    quoi: [
      "Mettre le réglage sur « Activé » pour l'unité organisationnelle racine.",
      "Sur plusieurs éditions (dont Business Plus), il est DÉSACTIVÉ par défaut : l'adresse de",
      'récupération ne servirait alors à rien le jour où il faudrait s\'en servir.',
    ],
  });

  if (!alternateEmailFait) {
    etapes.push({
      titre: "Remplacer l'adresse e-mail secondaire du COMPTE (le point le plus important)",
      chemin:
        'console.admin.google.com > Compte > Paramètres du compte > Profil > Coordonnées > ' +
        'Adresse e-mail secondaire',
      quoi: [
        `Remplacer « ${personalEmail} » par « ${remplacement} ».`,
        "C'est littéralement l'adresse fournie lors de l'inscription à Google Workspace. Google y",
        'envoie les avis critiques de compte, de sécurité et de facturation, et le soutien peut la',
        'demander comme preuve de propriété.',
        `Contrainte imposée par Google : cette adresse DOIT être hors du domaine « ${config.domain} ».`,
        "Une adresse du domaine sera refusée.",
        '(Techniquement modifiable par API — champ « alternateEmail » de customers.patch — mais la',
        "portée admin.directory.customer ne fait pas partie de la délégation de cette trousse.)",
      ],
    });
  }

  etapes.push({
    titre: "Vérifier le champ « Administrateur principal »",
    chemin:
      'console.admin.google.com > Compte > Paramètres du compte > Profil > Coordonnées > ' +
      'Administrateur principal',
    quoi: [
      `Il doit pointer sur un compte réel du domaine — normalement ${config.adminEmail} — et jamais`,
      'sur un alias. C\'est ce compte qui reçoit les messages produit et les avis critiques.',
      'Aucune API ne permet de le changer.',
    ],
  });

  etapes.push({
    titre: 'Contacts de facturation — ajouter, VÉRIFIER, promouvoir, puis seulement retirer',
    chemin:
      'console.admin.google.com > Facturation > Comptes de paiement > (à côté de l\'abonnement) ' +
      '⋮ Plus > Afficher les paramètres de paiement > Contacts de paiement',
    quoi: [
      `1. « Ajouter un nouveau contact » avec une adresse du domaine (ex. ${config.adminEmail}).`,
      '2. Ouvrir le courriel « Google Billing: Verify your email address » et CLIQUER le lien.',
      '   Tant que ce n\'est pas fait, le contact reste « En attente » et ne reçoit RIEN —',
      '   y compris les avis d\'échec de paiement, qui mènent à la suspension du compte.',
      '3. Promouvoir ce nouveau contact comme contact principal.',
      `4. Seulement ensuite : retirer « ${personalEmail} ».`,
      'Le contact PRINCIPAL ne se modifie pas : il faut en ajouter un nouveau puis supprimer',
      "l'ancien. Il n'existe aucune API cliente pour la facturation Google Workspace.",
      'Privilège requis : « Gestion de la facturation ».',
    ],
  });

  etapes.push({
    titre: 'Utilisateurs du profil de paiement (couche différente des contacts)',
    chemin: 'payments.google.com > Paramètres > Utilisateurs de paiement',
    quoi: [
      `Ce sont les comptes Google qui ont des PERMISSIONS sur le profil de paiement.`,
      `${personalEmail} en est probablement l'administratrice.`,
      `1. Donner le niveau « Administrateur » à ${config.adminEmail}.`,
      `2. Seulement ensuite : retirer ${personalEmail}.`,
      "NE JAMAIS se retirer soi-même en premier : si l'adresse personnelle est le seul",
      'administrateur, on perd la main sur les moyens de paiement et les factures, et il faut',
      'passer par le soutien Google.',
      'À savoir : le pays, la devise et l\'entité juridique d\'un profil de paiement sont',
      'IMMUABLES. S\'ils sont mauvais, il faut un nouveau profil, pas une modification.',
    ],
  });

  etapes.push({
    titre: 'Préférences de communication',
    chemin:
      'console.admin.google.com > Compte > Paramètres du compte > Préférences > ' +
      'Préférences de communication > E-mail',
    quoi: [
      'Vérifier qui reçoit quoi (sécurité, facturation, nouveautés).',
      'Demande le privilège « Paramètres du domaine ». Aucune API.',
    ],
  });

  etapes.push({
    titre: 'Responsable de la protection des données / représentant en confidentialité',
    chemin: 'console.admin.google.com > Compte > Paramètres du compte > Aspects juridiques et conformité',
    quoi: [
      `Si quelque chose y a été saisi à l'inscription, « ${personalEmail} » peut s'y trouver.`,
      'Super-administrateur requis. Aucune API.',
    ],
  });

  etapes.push({
    titre: 'Comptes en conflit / usagers non gérés',
    chemin:
      "console.admin.google.com > Annuaire > Utilisateurs > Plus d'options > " +
      'Outil de transfert pour les utilisateurs non gérés',
    quoi: [
      `Cherche un compte Google PERSONNEL qui aurait été créé avec une adresse du domaine`,
      `« ${config.domain} » AVANT l'inscription à Workspace (YouTube, Analytics, Ads, Search`,
      'Console…). Très fréquent sur un domaine qui servait déjà au courriel.',
      '« Mise à jour groupée » > « Télécharger tous les usagers non gérés en CSV » pour l\'inventaire.',
      'Deux issues : inviter la personne à transférer son compte, ou lui demander de le renommer.',
      "Il n'existe AUCUN outil Google pour fusionner deux comptes — ne pas le promettre.",
      `(L'adresse ${personalEmail} elle-même n'est PAS un compte en conflit : une adresse`,
      '@gmail.com est dans un espace de noms séparé et ne peut pas être un usager du Workspace.)',
    ],
  });

  etapes.push({
    titre: 'Projets Google Cloud possédés par l\'adresse personnelle',
    chemin: 'console.cloud.google.com > IAM et administration > Gérer les ressources',
    quoi: [
      `Le projet qui héberge la clé du compte de service a probablement été créé avec`,
      `${personalEmail} : il reste sa propriété, sous « Aucune organisation », et ne migre pas`,
      'tout seul.',
      `1. Donner le rôle « Propriétaire » à ${config.adminEmail} sur le projet.`,
      "2. Déplacer le projet vers l'organisation du domaine.",
      `3. Seulement ensuite : retirer ${personalEmail}.`,
      "Une demande de migration vers l'organisation EXPIRE après 30 jours si personne ne l'accepte.",
    ],
  });

  etapes.push({
    titre: 'Google Search Console',
    chemin: 'search.google.com/search-console > Paramètres > Utilisateurs et autorisations',
    quoi: [
      `Si le domaine a déjà été validé avec ${personalEmail}, ce compte détient un jeton de`,
      'propriété du site indépendant de Workspace.',
      "Ajouter le compte du domaine comme propriétaire AVANT de retirer l'ancien.",
    ],
  });

  etapes.push({
    titre: 'Compte chez le registraire du domaine',
    chemin: 'Site du registraire (là où le domaine a été acheté)',
    quoi: [
      "Hors Google, mais c'est la clé maîtresse : en récupération assistée, Google exige une",
      'preuve de propriété du domaine (enregistrement DNS à publier, valable 48 h).',
      `Si le compte du registraire est lui-même ouvert sous ${personalEmail}, il faut le régler`,
      'aussi — sinon le détachement n\'est qu\'apparent.',
    ],
  });

  etapes.push({
    titre: 'Documents d\'entreprise restés dans un « Mon Drive » personnel',
    chemin: 'drive.google.com > Mon Drive (vérification à l\'œil, par la personne elle-même)',
    quoi: [
      'Par choix de conception, cette trousse ne regarde JAMAIS le contenu d\'un « Mon Drive ».',
      "C'est l'exigence numéro un : aucun document personnel n'est listé, déplacé ni partagé.",
      "Si des documents d'entreprise vivent encore dans un « Mon Drive », les déplacer à la main",
      'vers le Drive partagé. Jamais par script.',
    ],
  });

  etapes.push({
    titre: 'Après 24 à 48 h : tout revalider',
    chemin: 'node src/cli.mjs audit',
    quoi: [
      'Les changements de la console Google mettent jusqu\'à 24 h à se propager partout.',
      'Relancer l\'audit pour confirmer que plus rien ne pointe vers l\'adresse personnelle.',
      `NE PAS supprimer le compte ${personalEmail} : le garder actif et accessible au moins`,
      '30 jours après la bascule complète, le temps de rattraper une chaîne oubliée.',
    ],
  });

  return etapes;
}

function afficherAFaireALaMain(log, etapes) {
  log.banner('À FAIRE À LA MAIN — aucune API ne permet de le faire');
  log.info(
    "Les points ci-dessous sont, dans l'ordre, ce qui reste après le passage de la trousse. " +
      'Règle d\'or, valable pour chacun : AJOUTER, VÉRIFIER, PROMOUVOIR, puis seulement RETIRER. ' +
      'Jamais « supprimer puis remplacer ».',
  );

  let numero = 0;
  for (const etape of etapes) {
    numero += 1;
    log.blank();
    log.raw(`  ${numero}. ${log.bold(etape.titre)}`);
    log.raw(`     Chemin : ${etape.chemin}`);
    for (const ligne of etape.quoi) {
      log.raw(`     ${ligne}`);
    }
  }
  log.blank();
}

/* ================================================================== *
 * Commande
 * ================================================================== */

/**
 * @param {object} params
 * @param {object} params.config configuration validée
 * @param {boolean} params.apply false = simulation (défaut)
 * @param {object} params.state cache local des identifiants
 * @param {object} params.log journal console
 * @returns {Promise<{created: string[], updated: string[], unchanged: string[], warnings: string[]}>}
 */
export async function run({ config, apply = false, state = {}, log }) {
  // Complète les fonctions de journal absentes (raw / blank / bold).
  log = renforcerLog(log);

  /** @type {{created: string[], updated: string[], unchanged: string[], warnings: string[]}} */
  const summary = { created: [], updated: [], unchanged: [], warnings: [] };

  const personalEmail = lower(config?.personalEmail ?? '');

  /* --- Cas « rien à détacher » : ce n'est pas une erreur -------------- */
  if (!personalEmail) {
    log.step('Aucune adresse personnelle à détacher');
    log.info(
      'Le champ « personalEmail » de config.json vaut null. C\'est un choix valide : la commande ' +
        "« detach » n'a rien à faire.\n" +
        "Pour l'utiliser plus tard, y mettre l'adresse personnelle (ex. une adresse @gmail.com) " +
        "qui a servi à créer le compte Google Workspace.",
    );
    log.skip('Rien à faire pour la commande « detach ».');
    return summary;
  }

  log.step(`Adresse à détacher : ${personalEmail}`);
  log.info(
    [
      "Ce qu'on cherche : toutes les places où cette adresse personnelle est encore accrochée au",
      "Workspace de l'entreprise. Bonne nouvelle d'abord — une adresse @gmail.com ne peut PAS être",
      "un usager ni un administrateur d'un Google Workspace : les deux vivent dans des espaces de",
      "noms séparés. Il n'y a donc rien à « expulser » de l'annuaire, seulement des références à",
      'réaiguiller : adresse de récupération, adresses secondaires, appartenance à des groupes,',
      'partages de calendrier et de Drive.',
    ].join('\n'),
  );

  const recovery = lireOptionRecovery(config);
  if (recovery.value) {
    log.info(`Adresse de récupération de remplacement : ${recovery.value} (${recovery.source}).`);
  }

  /* --- Clients ------------------------------------------------------- */
  const scopes = Array.isArray(ALL_SCOPES) && ALL_SCOPES.length > 0 ? [...ALL_SCOPES] : undefined;
  const { admin, calendar, drive } = await getClients({ config, scopes });

  /* ================================================================ *
   * Inventaire préalable — LECTURE SEULE
   * ================================================================ */

  log.step('1/8 — Inventaire des usagers du domaine');
  log.info(
    'On lit tout avant de toucher à quoi que ce soit : les vérifications de sécurité ont besoin ' +
      'de savoir combien de super-administrateurs actifs existent, et lesquels seraient modifiés.',
  );

  const lectureUsagers = await tenter(() => listerUsagers(admin));
  if (!lectureUsagers.ok) {
    log.err(
      "Impossible de lire la liste des usagers du domaine. Sans elle, il est impossible de " +
        'vérifier qu\'un filet de sécurité administrateur existe.',
    );
    log.err(expliquer(lectureUsagers.erreur, "lecture des usagers"));
    log.warn(
      "REFUS D'AGIR : aucune modification n'a été tentée. Une commande qui peut barrer le " +
        'propriétaire hors de son compte ne s\'exécute pas « à l\'aveugle ».',
    );
    summary.warnings.push(
      "Détachement refusé : la liste des usagers est illisible, les vérifications de sécurité " +
        "n'ont pas pu être faites.",
    );
    return summary;
  }

  const users = lectureUsagers.valeur;
  log.ok(`${users.length} compte(s) lus dans l'annuaire.`);

  const { actifs } = analyserSuperAdmins(users);
  log.info(
    `Super-administrateur(s) actif(s) : ${actifs.length === 0 ? 'aucun' : actifs.map((u) => u.primaryEmail).join(', ')}.`,
  );

  /* --- Ce que l'on modifierait chez les usagers ---------------------- */
  const cibles = [];
  for (const user of users) {
    const emails = preparerEmails(user, personalEmail);
    const recoveryAChanger = sameEmail(user?.recoveryEmail, personalEmail);
    if (emails.change || recoveryAChanger || emails.refus.length > 0) {
      cibles.push({ user, emails, recoveryAChanger });
    }
  }

  /* ================================================================ *
   * Vérifications de sécurité
   * ================================================================ */

  const { items, bloquants } = verificationsSecurite({
    config,
    users,
    cibles,
    recovery,
    recoveryErreur: recovery.erreur,
  });

  afficherChecklist(log, items);

  if (bloquants.length > 0) {
    log.banner("REFUS D'AGIR — le détachement est bloqué");
    log.err(
      `Vérification(s) non satisfaite(s) : ${bloquants.join(' ; ')}.\n` +
        "AUCUNE modification n'a été envoyée à Google, ni maintenant ni plus loin dans cette " +
        'exécution — même avec --apply.',
    );
    log.blank();
    log.raw(pourquoiAdresseExterne(config.domain));
    log.blank();
    log.info(
      'Corriger les points marqués [ ] ci-dessus, puis relancer. La commande est idempotente : ' +
        'rien de ce qui est déjà fait ne sera refait.',
    );

    for (const raison of bloquants) summary.warnings.push(`Détachement bloqué : ${raison}`);

    // On imprime quand même la feuille de route manuelle : elle est utile
    // immédiatement, et plusieurs de ses points sont précisément ce qui
    // débloque les vérifications.
    afficherAFaireALaMain(
      log,
      etapesManuelles({ config, personalEmail, recovery, alternateEmailFait: false }),
    );
    return summary;
  }

  log.ok('Toutes les vérifications bloquantes sont satisfaites. On peut continuer.');

  if (!apply) {
    log.info(
      'MODE SIMULATION : ce qui suit est le détail exact de ce qui SERAIT changé, valeur avant ' +
        '-> valeur après. Rien n\'est envoyé à Google.',
    );
  }

  /* ================================================================ *
   * A. Adresses secondaires — emails[]
   * ================================================================ */

  log.step('2/8 — Adresses secondaires des usagers (emails[])');
  log.info(
    "Rappel technique : chez Google, le tableau des adresses d'un usager se remplace EN ENTIER, " +
      'même avec une modification partielle. La trousse relit donc le tableau complet, en retire ' +
      "la seule adresse visée, et réécrit le reste à l'identique — l'adresse principale et les " +
      'autres adresses sont préservées.',
  );

  const aTraiterEmails = cibles.filter((c) => c.emails.change);
  const refusEmails = cibles.flatMap((c) => c.emails.refus);

  for (const refus of refusEmails) {
    log.warn(refus);
    summary.warnings.push(refus);
  }

  if (aTraiterEmails.length === 0) {
    log.skip(`Aucun compte n'a « ${personalEmail} » comme adresse secondaire.`);
    summary.unchanged.push('Adresses secondaires des usagers : rien à retirer');
  } else {
    log.table(
      aTraiterEmails.map((c) => ({
        Compte: couper(c.user.primaryEmail, 34),
        Avant: couper(c.emails.avant.join(', ')),
        Après: couper(c.emails.apres.join(', ')),
      })),
    );

    for (const cible of aTraiterEmails) {
      const courriel = cible.user.primaryEmail;
      const avant = cible.emails.avant.join(', ');
      const apres = cible.emails.apres.join(', ');

      if (!apply) {
        log.plan(`${courriel} — adresses secondaires :\n  avant : ${avant}\n  après : ${apres}`);
        summary.updated.push(`Adresses de ${courriel} : retirer ${personalEmail}`);
        continue;
      }

      const res = await tenter(() =>
        ecrire(`mise à jour des adresses de ${courriel}`, () =>
          admin.users.update({
            userKey: courriel,
            // `update` (PUT) plutôt que `patch` : sur les tableaux, PUT est le
            // seul comportement fiable pour RÉDUIRE une liste.
            requestBody: { emails: cible.emails.entrees },
            fields: 'primaryEmail,emails',
          }),
        ),
      );

      if (res.ok) {
        log.ok(`${courriel} — « ${personalEmail} » retirée des adresses secondaires.`);
        log.info(`  avant : ${avant}\n  après : ${apres}`);
        summary.updated.push(`Adresses de ${courriel} : ${personalEmail} retirée`);
      } else {
        const msg = expliquer(res.erreur, `mise à jour des adresses de ${courriel}`);
        log.warn(`${courriel} — échec du retrait de l'adresse secondaire.\n${msg}`);
        summary.warnings.push(`Adresses de ${courriel} : échec (${res.erreur?.message ?? 'erreur'})`);
      }
    }
  }

  /* ================================================================ *
   * B. Adresse de récupération
   * ================================================================ */

  log.step('3/8 — Adresses de récupération');

  const aTraiterRecovery = cibles.filter((c) => c.recoveryAChanger);

  if (aTraiterRecovery.length === 0) {
    log.skip(`Aucun compte n'a « ${personalEmail} » comme adresse de récupération.`);
    summary.unchanged.push('Adresses de récupération : rien à remplacer');
  } else {
    log.info(
      `On REMPLACE (on ne vide pas) : « ${personalEmail} » -> « ${recovery.value} ». ` +
        'À aucun moment un compte ne se retrouve sans adresse de récupération.',
    );
    log.table(
      aTraiterRecovery.map((c) => ({
        Compte: couper(c.user.primaryEmail, 34),
        Avant: couper(tiret(c.user.recoveryEmail), 30),
        Après: couper(recovery.value, 30),
      })),
    );

    for (const cible of aTraiterRecovery) {
      const courriel = cible.user.primaryEmail;

      // Google exige que l'adresse de récupération soit DIFFÉRENTE de l'adresse
      // du compte lui-même : une porte de secours qui mène à la porte d'entrée
      // ne sert à rien.
      if (sameEmail(recovery.value, courriel)) {
        const msg =
          `${courriel} — l'adresse de remplacement est celle du compte lui-même. Refus : une ` +
          'adresse de récupération doit être différente de l\'adresse du compte. Fournir une ' +
          'autre adresse avec --recovery.';
        log.warn(msg);
        summary.warnings.push(msg);
        continue;
      }

      if (!apply) {
        log.plan(
          `${courriel} — adresse de récupération :\n  avant : ${tiret(cible.user.recoveryEmail)}\n  après : ${recovery.value}`,
        );
        summary.updated.push(`Récupération de ${courriel} : ${personalEmail} -> ${recovery.value}`);
        continue;
      }

      const res = await tenter(() =>
        ecrire(`mise à jour de l'adresse de récupération de ${courriel}`, () =>
          admin.users.patch({
            userKey: courriel,
            requestBody: { recoveryEmail: recovery.value },
            fields: 'primaryEmail,recoveryEmail',
          }),
        ),
      );

      if (res.ok) {
        const apres = res.valeur?.data?.recoveryEmail ?? recovery.value;
        log.ok(`${courriel} — adresse de récupération remplacée.`);
        log.info(`  avant : ${tiret(cible.user.recoveryEmail)}\n  après : ${apres}`);
        summary.updated.push(`Récupération de ${courriel} : ${personalEmail} -> ${apres}`);
      } else {
        const msg = expliquer(res.erreur, `adresse de récupération de ${courriel}`);
        log.warn(
          `${courriel} — échec du remplacement de l'adresse de récupération.\n${msg}\n` +
            'À savoir : selon les cas, Google exige d\'être connecté EN TANT QUE ce super-' +
            'administrateur pour modifier ses informations de récupération. Chemin manuel : ' +
            'console.admin.google.com > Annuaire > Utilisateurs > [le compte] > Sécurité > ' +
            'Informations de récupération.',
        );
        summary.warnings.push(`Récupération de ${courriel} : échec, à faire à la main`);
      }
    }
  }

  /* ================================================================ *
   * C. Groupes
   * ================================================================ */

  log.step('4/8 — Appartenance à des groupes');
  log.info(
    "Une adresse externe peut être membre d'un groupe Google même si elle n'est pas un usager du " +
      'domaine. On vérifie chaque groupe un par un.',
  );

  const lectureGroupes = await tenter(() => listerGroupes(admin));

  if (!lectureGroupes.ok) {
    const msg = expliquer(lectureGroupes.erreur, 'lecture des groupes');
    log.warn(`Groupes illisibles — cette section est ignorée, le reste continue.\n${msg}`);
    summary.warnings.push('Groupes : liste illisible, section ignorée');
  } else {
    const groupes = lectureGroupes.valeur;
    log.info(`${groupes.length} groupe(s) dans le domaine.`);

    const appartenances = [];
    for (const groupe of groupes) {
      const res = await tenter(() =>
        lire(`vérification de ${personalEmail} dans ${groupe.email}`, () =>
          admin.members.get({
            groupKey: groupe.email,
            memberKey: personalEmail,
            fields: 'id,email,role,type,status',
          }),
        ),
      );

      if (res.ok && res.valeur?.data) {
        appartenances.push({ groupe, membre: res.valeur.data });
        continue;
      }
      if (res.erreur && isNotFound(res.erreur)) continue; // pas membre : réponse normale
      if (res.erreur) {
        const msg = expliquer(res.erreur, `groupe ${groupe.email}`);
        log.warn(`Groupe ${groupe.email} — appartenance invérifiable.\n${msg}`);
        summary.warnings.push(`Groupe ${groupe.email} : appartenance invérifiable`);
      }
    }

    if (appartenances.length === 0) {
      log.skip(`« ${personalEmail} » n'est membre d'aucun groupe du domaine.`);
      summary.unchanged.push('Groupes : aucune appartenance à retirer');
    } else {
      log.table(
        appartenances.map((a) => ({
          Groupe: couper(a.groupe.email, 34),
          Rôle: a.membre.role ?? '—',
          Avant: 'membre',
          Après: 'retiré',
        })),
      );

      for (const { groupe, membre } of appartenances) {
        // Si l'adresse personnelle est propriétaire du groupe, on le dit : le
        // groupe se retrouvera sans propriétaire. Ce n'est PAS un verrouillage
        // (les super-administrateurs gardent la main sur tous les groupes),
        // mais ça mérite d'être nommé.
        if (lower(membre.role) === 'owner') {
          const proprietaires = await tenter(() => listerMembres(admin, groupe.email, 'OWNER'));
          const nb = proprietaires.ok ? proprietaires.valeur.length : null;
          if (nb === 1) {
            const msg =
              `Groupe ${groupe.email} : « ${personalEmail} » en est le SEUL propriétaire. Après ` +
              'son retrait, le groupe n\'aura plus de propriétaire. Les super-administrateurs ' +
              'gardent le contrôle du groupe, mais il vaut mieux nommer un propriétaire du ' +
              'domaine : console.admin.google.com > Annuaire > Groupes > [le groupe] > Membres.';
            log.warn(msg);
            summary.warnings.push(msg);
          }
        }

        if (!apply) {
          log.plan(
            `Groupe ${groupe.email} — appartenance de ${personalEmail} :\n` +
              `  avant : membre (rôle ${membre.role ?? 'MEMBER'})\n  après : retirée`,
          );
          summary.updated.push(`Groupe ${groupe.email} : retirer ${personalEmail}`);
          continue;
        }

        const res = await tenter(() =>
          ecrire(`retrait de ${personalEmail} du groupe ${groupe.email}`, () =>
            admin.members.delete({ groupKey: groupe.email, memberKey: personalEmail }),
          ),
        );

        if (res.ok) {
          log.ok(`Groupe ${groupe.email} — « ${personalEmail} » retirée (était ${membre.role ?? 'MEMBER'}).`);
          summary.updated.push(`Groupe ${groupe.email} : ${personalEmail} retirée`);
        } else if (res.erreur && isNotFound(res.erreur)) {
          log.skip(`Groupe ${groupe.email} — l'adresse n'y est déjà plus.`);
          summary.unchanged.push(`Groupe ${groupe.email} : déjà retirée`);
        } else {
          const msg = expliquer(res.erreur, `groupe ${groupe.email}`);
          log.warn(`Groupe ${groupe.email} — échec du retrait.\n${msg}`);
          summary.warnings.push(`Groupe ${groupe.email} : échec du retrait`);
        }
      }
    }
  }

  /* ================================================================ *
   * D. Règles d'accès de calendrier (ACL)
   * ================================================================ */

  log.step('5/8 — Règles d\'accès des calendriers');
  log.info(
    `On parcourt les calendriers dont ${config.adminEmail} est PROPRIÉTAIRE (les seuls dont on ` +
      "peut lire et modifier les autorisations), y compris son agenda principal, et on retire " +
      'les règles qui visent nommément l\'adresse personnelle.',
  );

  const lectureCalendriers = await tenter(() =>
    collectPages(
      (pageToken) =>
        calendar.calendarList.list({
          maxResults: CALENDAR_PAGE_SIZE,
          showHidden: true, // sinon un calendrier masqué serait invisible… et oublié
          showDeleted: false,
          minAccessRole: 'owner',
          fields: CALENDAR_LIST_FIELDS,
          pageToken,
        }),
      { itemsKey: 'items', label: 'lecture de la liste des calendriers' },
    ),
  );

  if (!lectureCalendriers.ok) {
    const msg = expliquer(lectureCalendriers.erreur, 'lecture des calendriers');
    log.warn(`Calendriers illisibles — cette section est ignorée, le reste continue.\n${msg}`);
    summary.warnings.push('Calendriers : liste illisible, section ignorée');
  } else {
    const calendriers = lectureCalendriers.valeur.filter((c) => c?.deleted !== true);
    log.info(`${calendriers.length} calendrier(s) dont ce compte est propriétaire.`);

    let regleTrouvee = 0;

    for (const cal of calendriers) {
      const nom = cal.summaryOverride ?? cal.summary ?? cal.id;

      const lectureAcl = await tenter(() =>
        collectPages(
          (pageToken) =>
            calendar.acl.list({
              calendarId: cal.id,
              maxResults: CALENDAR_PAGE_SIZE,
              fields: ACL_FIELDS,
              pageToken,
            }),
          { itemsKey: 'items', label: `lecture des autorisations de « ${nom} »` },
        ),
      );

      if (!lectureAcl.ok) {
        const msg = expliquer(lectureAcl.erreur, `autorisations du calendrier « ${nom} »`);
        log.warn(`Calendrier « ${nom} » — autorisations illisibles.\n${msg}`);
        summary.warnings.push(`Calendrier « ${nom} » : autorisations illisibles`);
        continue;
      }

      const regles = lectureAcl.valeur;

      // On ne vise QUE les règles de type « user » pointant exactement sur
      // l'adresse personnelle. Aucune règle de groupe, de domaine ou publique
      // n'est touchée ici : ce n'est pas le travail de cette commande.
      const visees = regles.filter(
        (r) => lower(r?.scope?.type) === 'user' && sameEmail(r?.scope?.value, personalEmail),
      );

      if (visees.length === 0) continue;

      const proprietaires = regles.filter((r) => lower(r?.role) === 'owner');

      for (const regle of visees) {
        regleTrouvee += 1;

        if (lower(regle.role) === 'owner' && proprietaires.length <= 1) {
          const msg =
            `Calendrier « ${nom} » : « ${personalEmail} » en est le SEUL propriétaire. Refus de ` +
            'retirer cette règle — le calendrier deviendrait ingérable. Accorder d\'abord le rôle ' +
            `« Apporter des modifications et gérer le partage » à ${config.adminEmail} ` +
            '(Google Agenda > Paramètres du calendrier > Partager avec des personnes précises), ' +
            'puis relancer.';
          log.warn(msg);
          summary.warnings.push(msg);
          continue;
        }

        if (!apply) {
          log.plan(
            `Calendrier « ${nom} » — règle d'accès de ${personalEmail} :\n` +
              `  avant : ${regle.role}\n  après : (règle supprimée)`,
          );
          summary.updated.push(`Calendrier « ${nom} » : retirer l'accès de ${personalEmail}`);
          continue;
        }

        // On utilise l'identifiant RETOURNÉ par l'API, jamais un identifiant
        // reconstruit à la main : sa forme n'est pas garantie par la doc.
        const res = await tenter(() =>
          ecrire(`retrait de l'accès au calendrier « ${nom} »`, () =>
            calendar.acl.delete({ calendarId: cal.id, ruleId: regle.id }),
          ),
        );

        if (res.ok) {
          log.ok(`Calendrier « ${nom} » — accès de ${personalEmail} retiré (était ${regle.role}).`);
          summary.updated.push(`Calendrier « ${nom} » : accès de ${personalEmail} retiré`);
        } else if (res.erreur && isNotFound(res.erreur)) {
          log.skip(`Calendrier « ${nom} » — la règle n'existe déjà plus.`);
          summary.unchanged.push(`Calendrier « ${nom} » : accès déjà retiré`);
        } else {
          const msg = expliquer(res.erreur, `calendrier « ${nom} »`);
          log.warn(`Calendrier « ${nom} » — échec du retrait de la règle.\n${msg}`);
          summary.warnings.push(`Calendrier « ${nom} » : échec du retrait`);
        }
      }
    }

    if (regleTrouvee === 0) {
      log.skip(`Aucun calendrier ne donne d'accès nominatif à « ${personalEmail} ».`);
      summary.unchanged.push("Calendriers : aucune règle d'accès à retirer");
    }
  }

  /* ================================================================ *
   * E. Drive partagé
   * ================================================================ */

  log.step('6/8 — Permissions du Drive partagé');
  log.info(
    'Rappel de sécurité : cette section ne regarde QUE la racine du Drive PARTAGÉ. Aucun fichier ' +
      "n'est listé, aucun « Mon Drive » n'est ouvert. Les documents personnels ne sont ni lus, ni " +
      'déplacés, ni partagés.',
  );

  const recherche = await tenter(() => trouverDrivePartage(drive, config, state, log));

  if (!recherche.ok) {
    const msg = expliquer(recherche.erreur, 'recherche du Drive partagé');
    log.warn(`Drive partagé introuvable — cette section est ignorée.\n${msg}`);
    summary.warnings.push('Drive partagé : recherche impossible, section ignorée');
  } else if (recherche.valeur?.ambigu) {
    const msg =
      `Plusieurs Drive partagés portent le nom « ${config.sharedDrive.name} » : ` +
      `${recherche.valeur.ambigu.join(', ')}. Refus d'agir au hasard — renommer les doublons dans ` +
      'drive.google.com, ou vider le fichier .state.json puis relancer.';
    log.warn(msg);
    summary.warnings.push(msg);
  } else if (!recherche.valeur?.drive) {
    log.skip(
      `Aucun Drive partagé nommé « ${config.sharedDrive?.name ?? '(non configuré)'} ». ` +
        'Rien à faire ici — il sera créé par « node src/cli.mjs drive --apply ».',
    );
    summary.unchanged.push('Drive partagé : inexistant, rien à détacher');
  } else {
    const sharedDrive = recherche.valeur.drive;
    const driveId = sharedDrive.id;
    log.info(`Drive partagé : « ${sharedDrive.name} » (id ${driveId}, retrouvé par ${recherche.valeur.source}).`);

    const lecturePermissions = await tenter(() => {
      // GARDE : on ne passe à l'API que l'identifiant du Drive partagé lui-même.
      assertRacineDrivePartage(driveId, driveId, 'lire les membres du Drive partagé');
      return collectPages(
        (pageToken) =>
          drive.permissions.list({
            fileId: driveId,
            supportsAllDrives: true, // sans ça : 404 sur un Drive partagé
            pageSize: DRIVE_PAGE_SIZE,
            fields: PERMISSION_FIELDS,
            pageToken,
          }),
        { itemsKey: 'permissions', label: 'lecture des membres du Drive partagé' },
      );
    });

    if (!lecturePermissions.ok) {
      const msg = expliquer(lecturePermissions.erreur, 'membres du Drive partagé');
      log.warn(`Membres du Drive partagé illisibles.\n${msg}`);
      summary.warnings.push('Drive partagé : membres illisibles');
    } else {
      const permissions = lecturePermissions.valeur.filter((p) => p?.deleted !== true);
      const visees = permissions.filter((p) => sameEmail(p?.emailAddress, personalEmail));
      const organisateurs = permissions.filter((p) => lower(p?.role) === 'organizer');

      if (visees.length === 0) {
        log.skip(`« ${personalEmail} » n'est pas membre du Drive partagé.`);
        summary.unchanged.push('Drive partagé : aucune permission à retirer');
      } else {
        log.table(
          visees.map((p) => ({
            Adresse: couper(p.emailAddress, 34),
            Type: p.type ?? '—',
            Avant: p.role ?? '—',
            Après: 'retirée',
          })),
        );

        for (const permission of visees) {
          if (lower(permission.role) === 'organizer' && organisateurs.length <= 1) {
            const msg =
              `Drive partagé « ${sharedDrive.name} » : « ${personalEmail} » en est le SEUL ` +
              'gestionnaire (organizer). Refus de retirer cette permission — le Drive deviendrait ' +
              'ingérable. Ajouter d\'abord un gestionnaire du domaine, par exemple avec ' +
              '« node src/cli.mjs drive --apply », puis relancer « detach ».';
            log.warn(msg);
            summary.warnings.push(msg);
            continue;
          }

          if (!apply) {
            log.plan(
              `Drive partagé « ${sharedDrive.name} » — accès de ${personalEmail} :\n` +
                `  avant : ${permission.role}\n  après : (permission supprimée)`,
            );
            summary.updated.push(`Drive partagé : retirer l'accès de ${personalEmail}`);
            continue;
          }

          const res = await tenter(() => {
            // GARDE, une deuxième fois, juste avant l'écriture.
            assertRacineDrivePartage(driveId, driveId, 'retirer un membre du Drive partagé');
            return ecrire(`retrait de ${personalEmail} du Drive partagé`, () =>
              drive.permissions.delete({
                fileId: driveId,
                permissionId: permission.id,
                supportsAllDrives: true,
              }),
            );
          });

          if (res.ok) {
            log.ok(
              `Drive partagé « ${sharedDrive.name} » — accès de ${personalEmail} retiré ` +
                `(était ${permission.role}).`,
            );
            summary.updated.push(`Drive partagé : accès de ${personalEmail} retiré`);
          } else if (res.erreur && isNotFound(res.erreur)) {
            log.skip('Drive partagé — la permission n\'existe déjà plus.');
            summary.unchanged.push('Drive partagé : accès déjà retiré');
          } else {
            const msg = expliquer(res.erreur, 'Drive partagé');
            log.warn(`Drive partagé — échec du retrait de la permission.\n${msg}`);
            summary.warnings.push('Drive partagé : échec du retrait');
          }
        }
      }
    }
  }

  /* ================================================================ *
   * F. Adresse secondaire du compte client (alternateEmail)
   * ================================================================ */

  log.step('7/8 — Adresse e-mail secondaire du compte (alternateEmail)');

  const porteeClientDisponible = Array.isArray(ALL_SCOPES) && ALL_SCOPES.includes(CUSTOMER_SCOPE);
  let alternateEmailFait = false;

  if (!porteeClientDisponible) {
    log.info(
      [
        "C'est l'endroit le plus important de tout ce dossier : l'adresse e-mail secondaire du",
        "COMPTE est littéralement celle fournie lors de l'inscription à Google Workspace, et Google",
        'y envoie les avis critiques de sécurité, de compte et de facturation.',
        '',
        `Elle EST modifiable par l'API (champ « alternateEmail »), mais cela demande la portée`,
        `  ${CUSTOMER_SCOPE}`,
        "qui ne fait pas partie de la délégation de cette trousse. L'ajouter obligerait à refaire la",
        "liste de portées dans la console d'administration — et une liste qui ne correspond plus",
        'EXACTEMENT fait échouer TOUTES les autres commandes. On ne prend pas ce risque tout seul.',
        '',
        'Cette étape est donc renvoyée à la section « À FAIRE À LA MAIN » ci-dessous (2 minutes).',
        "Pour l'automatiser plus tard : ajouter la portée ci-dessus dans src/lib/auth.mjs ET dans",
        "la délégation à l'échelle du domaine, puis relancer « detach ». Le code s'activera seul.",
      ].join('\n'),
    );
    summary.warnings.push(
      "Adresse secondaire du compte (alternateEmail) : à changer à la main — portée admin.directory.customer absente",
    );
  } else {
    const lectureClient = await tenter(() =>
      lire('lecture des paramètres du compte client', () =>
        admin.customers.get({ customerKey: CUSTOMER_KEY, fields: 'id,customerDomain,alternateEmail' }),
      ),
    );

    if (!lectureClient.ok) {
      const msg = expliquer(lectureClient.erreur, 'paramètres du compte client');
      log.warn(`Paramètres du compte illisibles — étape renvoyée au manuel.\n${msg}`);
      summary.warnings.push('Adresse secondaire du compte : illisible, à faire à la main');
    } else {
      const client = lectureClient.valeur?.data ?? {};
      const actuelle = client.alternateEmail ?? null;

      if (!sameEmail(actuelle, personalEmail)) {
        log.skip(
          `L'adresse secondaire du compte est « ${tiret(actuelle)} » : ce n'est pas l'adresse ` +
            'personnelle, rien à faire.',
        );
        summary.unchanged.push('Adresse secondaire du compte : déjà détachée');
        alternateEmailFait = true;
      } else if (domainOf(recovery.value) === lower(config.domain)) {
        const msg =
          `L'adresse de remplacement « ${recovery.value} » est dans le domaine « ${config.domain} ». ` +
          "Google REFUSE une adresse du domaine comme adresse secondaire du compte : la porte de " +
          'secours ne doit pas vivre dans le système qu\'elle secourt. Fournir une adresse externe ' +
          'avec --recovery, ou faire ce changement à la main.';
        log.warn(msg);
        summary.warnings.push(msg);
      } else if (!apply) {
        log.plan(
          `Adresse e-mail secondaire du compte :\n  avant : ${tiret(actuelle)}\n  après : ${recovery.value}`,
        );
        summary.updated.push(`Adresse secondaire du compte : ${personalEmail} -> ${recovery.value}`);
      } else {
        const res = await tenter(() =>
          ecrire("mise à jour de l'adresse secondaire du compte", () =>
            admin.customers.patch({
              customerKey: CUSTOMER_KEY,
              requestBody: { alternateEmail: recovery.value },
              fields: 'id,alternateEmail',
            }),
          ),
        );

        if (res.ok) {
          const apres = res.valeur?.data?.alternateEmail ?? recovery.value;
          log.ok('Adresse e-mail secondaire du compte remplacée.');
          log.info(`  avant : ${tiret(actuelle)}\n  après : ${apres}`);
          summary.updated.push(`Adresse secondaire du compte : ${personalEmail} -> ${apres}`);
          alternateEmailFait = true;
        } else {
          const msg = expliquer(res.erreur, 'adresse secondaire du compte');
          log.warn(`Échec — étape renvoyée au manuel.\n${msg}`);
          summary.warnings.push('Adresse secondaire du compte : échec, à faire à la main');
        }
      }
    }
  }

  /* ================================================================ *
   * Rappel final + feuille de route manuelle
   * ================================================================ */

  log.step('8/8 — Ce que la trousse ne peut pas faire');

  if (!apply) {
    log.info(
      "Rien n'a été modifié : c'était une simulation. Quand le plan ci-dessus est satisfaisant, " +
        'relancer avec --apply' +
        (recovery.source && recovery.source.startsWith('option')
          ? ' (en gardant l\'option --recovery).'
          : recovery.source
            ? ` (en gardant ${recovery.source}).`
            : '.'),
    );
  }

  afficherAFaireALaMain(log, etapesManuelles({ config, personalEmail, recovery, alternateEmailFait }));

  log.warn(
    `Dernier rappel, le plus important : NE PAS supprimer le compte ${personalEmail}. Le garder ` +
      'actif et accessible au moins 30 jours après la bascule complète — le temps de découvrir ' +
      'une chaîne oubliée. Une adresse supprimée casse silencieusement tout ce qui pointait ' +
      'encore vers elle.',
  );

  return summary;
}

export default { meta, run };
