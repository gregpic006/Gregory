/**
 * group.mjs — Crée le groupe d'équipe et y met exactement les bonnes personnes.
 *
 * POURQUOI UN GROUPE ?
 * Parce qu'on accorde ensuite les accès (calendriers, Drive partagé) AU GROUPE
 * plutôt qu'à chacune des quatre adresses. Quand quelqu'un arrive ou part, on
 * modifie une seule chose — le groupe — et tous les accès suivent
 * automatiquement. Sans groupe, il faudrait repasser sur chaque calendrier et
 * chaque Drive à la main, à chaque changement d'équipe.
 *
 * Si « group » vaut null dans config.json, on accorde les accès directement à
 * chaque adresse : cette commande n'a alors rien à faire et le dit clairement.
 *
 * TROIS ÉTAPES :
 *   1. le groupe existe-t-il ? sinon on le crée (Admin SDK Directory) ;
 *   2. on verrouille ses réglages (Groups Settings API — API distincte) ;
 *   3. on synchronise ses membres à partir de « team ».
 *
 * IDEMPOTENCE : on cherche toujours avant de créer, et on ne réécrit un
 * réglage que s'il diffère. Relancer la commande dix fois donne le même
 * résultat qu'une seule fois.
 *
 * PRUDENCE : on AJOUTE et on PROMEUT, on ne retire jamais personne et on ne
 * rétrograde jamais personne automatiquement. Retirer un membre ou un
 * propriétaire par erreur coupe des accès en cascade (Drive, calendriers) et
 * c'est pénible à reconstruire. Tout ce qui est « en trop » est signalé dans
 * les avertissements, avec la commande exacte à lancer pour le corriger.
 */

import { getClients, withRetry, collectPages, isNotFound, isConflict, errorInfo, explainGoogleError } from '../lib/google.mjs';
import { setStateKey } from '../lib/state.mjs';

export const meta = {
  name: 'group',
  summary: "Crée le groupe d'équipe, verrouille ses réglages et y met exactement les membres de « team ».",
};

/* ------------------------------------------------------------------ *
 * Réglages visés pour le groupe
 * ------------------------------------------------------------------ */

/**
 * Réglages appliqués au groupe, avec l'explication en clair de chacun.
 *
 * ⚠️ PIÈGE DE L'API GROUPS SETTINGS : dans cette API, TOUS les booléens sont
 * des CHAÎNES de caractères. Écrire `allowExternalMembers: false` (booléen)
 * ne fonctionne pas — il faut `'false'` (texte). Vérifié dans le document de
 * découverte de l'API : seul `maxMessageBytes` est un vrai nombre, tout le
 * reste est typé « string ».
 *
 * ⚠️ DEUXIÈME PIÈGE : `whoCanInvite` et `whoCanAdd` sont DÉPRÉCIÉS et fusionnés
 * dans `whoCanModerateMembers`. On utilise donc uniquement le nouveau réglage.
 *
 * @type {Array<{ key: string, value: string, why: string, external?: boolean }>}
 */
const DESIRED_SETTINGS = [
  {
    key: 'allowExternalMembers',
    value: 'false',
    why: "Personne d'extérieur au domaine ne peut être membre du groupe.",
    // Marqué : ce réglage entre en conflit avec un membre hors domaine dans « team ».
    external: true,
  },
  {
    key: 'whoCanJoin',
    value: 'INVITED_CAN_JOIN',
    why: "Personne ne peut s'inscrire de lui-même : il faut être ajouté par un gestionnaire.",
  },
  {
    key: 'whoCanViewGroup',
    value: 'ALL_IN_DOMAIN_CAN_VIEW',
    why: "Seules les personnes du domaine peuvent lire les messages du groupe.",
  },
  {
    key: 'whoCanViewMembership',
    value: 'ALL_IN_DOMAIN_CAN_VIEW',
    why: "Seules les personnes du domaine peuvent voir qui fait partie du groupe.",
  },
  {
    key: 'whoCanPostMessage',
    value: 'ALL_IN_DOMAIN_CAN_POST',
    why: "Seules les personnes du domaine peuvent écrire au groupe — ça bloque le pourriel externe.",
  },
  {
    key: 'whoCanContactOwner',
    value: 'ALL_IN_DOMAIN_CAN_CONTACT',
    why: "Seules les personnes du domaine peuvent contacter les propriétaires du groupe.",
  },
  {
    key: 'whoCanDiscoverGroup',
    value: 'ALL_IN_DOMAIN_CAN_DISCOVER',
    why: "Le groupe n'apparaît pas dans un annuaire public : il reste interne.",
  },
  {
    key: 'whoCanLeaveGroup',
    value: 'ALL_MANAGERS_CAN_LEAVE',
    why: "Personne ne peut se retirer tout seul et perdre ses accès Drive et calendriers par accident.",
  },
  {
    key: 'whoCanModerateMembers',
    value: 'OWNERS_AND_MANAGERS',
    why: "Seuls les propriétaires et gestionnaires ajoutent ou retirent des membres (remplace whoCanInvite/whoCanAdd, dépréciés).",
  },
  {
    key: 'includeInGlobalAddressList',
    value: 'true',
    why: "Le groupe apparaît dans le carnet d'adresses interne : l'équipe peut lui écrire sans retenir l'adresse par cœur.",
  },
];

/* ------------------------------------------------------------------ *
 * Petits utilitaires
 * ------------------------------------------------------------------ */

/** Normalise une adresse pour la comparaison (Google ne fait pas la différence entre majuscules et minuscules). */
function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** Domaine d'une adresse courriel, en minuscules. */
function domainOf(email) {
  const at = normalizeEmail(email).lastIndexOf('@');
  return at === -1 ? '' : normalizeEmail(email).slice(at + 1);
}

/**
 * Rôle attendu dans le groupe pour un membre de « team ».
 * « organizer » dans config.json = OWNER dans le groupe (peut gérer le groupe).
 * @param {string} teamRole
 * @returns {'OWNER'|'MEMBER'}
 */
function groupRoleFor(teamRole) {
  return teamRole === 'organizer' ? 'OWNER' : 'MEMBER';
}

/** Puissance relative des rôles Google, pour ne jamais rétrograder quelqu'un par erreur. */
const ROLE_RANK = { MEMBER: 0, MANAGER: 1, OWNER: 2 };

/**
 * Commande à copier-coller pour retirer un membre du groupe.
 * On ne le fait JAMAIS automatiquement : retirer quelqu'un coupe ses accès au
 * Drive partagé et aux calendriers. C'est une décision humaine.
 *
 * @param {string} groupEmail
 * @param {string} memberEmail
 * @returns {string}
 */
function removalCommand(groupEmail, memberEmail) {
  return (
    'node --input-type=module -e "' +
    "import{loadConfig}from'./src/lib/config.mjs';" +
    "import{getClients}from'./src/lib/google.mjs';" +
    "const c=await loadConfig('./config.json');" +
    'const{admin}=await getClients({config:c});' +
    `await admin.members.delete({groupKey:'${groupEmail}',memberKey:'${memberEmail}'});` +
    `console.log('Retiré : ${memberEmail}');" ` +
    '   # à lancer depuis la racine de la trousse'
  );
}

/* ------------------------------------------------------------------ *
 * Étape 1 — trouver ou créer le groupe
 * ------------------------------------------------------------------ */

/** Champs demandés à Google pour un groupe. On demande toujours explicitement ce dont on a besoin. */
const GROUP_FIELDS = 'id,email,name,description,adminCreated,directMembersCount';

/**
 * Cherche un groupe par son adresse. Retourne null s'il n'existe pas.
 *
 * `propagation: false` est essentiel ici : un 404 est une RÉPONSE ATTENDUE
 * (« le groupe n'existe pas encore »), pas une erreur temporaire. Sans ça,
 * chaque première exécution attendrait deux minutes pour rien.
 *
 * @param {object} admin client Admin SDK Directory
 * @param {string} groupEmail
 * @returns {Promise<object|null>}
 */
async function findGroup(admin, groupEmail) {
  try {
    const res = await withRetry(() => admin.groups.get({ groupKey: groupEmail, fields: GROUP_FIELDS }), {
      label: `recherche du groupe ${groupEmail}`,
      propagation: false,
      tries: 4,
    });
    return res?.data ?? null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * Étape 2 — réglages du groupe
 * ------------------------------------------------------------------ */

/**
 * Traduit une erreur de la Groups Settings API en avertissement français.
 * Cette API est SÉPARÉE de l'Admin SDK : elle s'active à part et exige sa
 * propre portée (apps.groups.settings). Elle échoue donc souvent alors que
 * tout le reste fonctionne — et ce n'est pas bloquant : le groupe fonctionne
 * quand même, seuls ses réglages fins restent aux valeurs par défaut.
 *
 * @param {unknown} e
 * @param {string} groupEmail
 * @returns {string} message d'avertissement, prêt à afficher
 */
function explainSettingsFailure(e, groupEmail) {
  const { status, reasons, message } = errorInfo(e);
  const lowered = reasons.map((r) => r.toLowerCase());
  const notEnabled =
    lowered.includes('accessnotconfigured') ||
    lowered.includes('servicedisabled') ||
    /has not been used in project|is disabled|has not enabled/i.test(message);
  const missingScope =
    lowered.includes('insufficientpermissions') || /insufficient authentication scopes/i.test(message);

  const head = `Les réglages fins du groupe ${groupEmail} n'ont pas pu être appliqués.`;
  const tail =
    "\nCe n'est PAS bloquant : le groupe existe, ses membres sont en place, et les accès\n" +
    "au Drive partagé et aux calendriers fonctionneront. Seuls les réglages de\n" +
    'confidentialité restent aux valeurs par défaut de Google. Corrige le point\n' +
    'ci-dessus puis relance : node src/cli.mjs group --apply';

  if (notEnabled) {
    return (
      `${head}\n` +
      "Cause : l'API « Groups Settings » n'est pas activée dans le projet Cloud.\n" +
      "C'est une API DISTINCTE de l'Admin SDK : l'activer séparément.\n" +
      'Quoi faire : ouvrir cette page, cliquer « Activer », attendre 1 à 2 minutes :\n' +
      '  https://console.cloud.google.com/apis/library/groupssettings.googleapis.com' +
      tail
    );
  }

  if (missingScope || status === 401) {
    return (
      `${head}\n` +
      "Cause : la portée « https://www.googleapis.com/auth/apps.groups.settings » n'est pas\n" +
      'autorisée pour ce compte.\n' +
      'Quoi faire :\n' +
      '  - compte de service : ajouter cette portée dans la délégation à l\'échelle du\n' +
      '    domaine (https://admin.google.com/ac/owl/domainwidedelegation), puis attendre\n' +
      '    quelques minutes ;\n' +
      '  - OAuth : supprimer le fichier de jetons (auth.tokenFile) et se reconnecter.' +
      tail
    );
  }

  if (status === 403) {
    return (
      `${head}\n` +
      "Cause : Google a refusé l'accès aux réglages (403).\n" +
      "Quoi faire : vérifier que « adminEmail » est bien super-administrateur du domaine.\n" +
      `Message de Google : ${message}` +
      tail
    );
  }

  if (status === 404) {
    return (
      `${head}\n` +
      "Cause : Google ne voit pas encore ce groupe du côté des réglages (404). C'est de la\n" +
      "propagation : un groupe fraîchement créé met parfois quelques minutes à être visible\n" +
      'partout.\n' +
      'Quoi faire : relancer dans 2 à 3 minutes — node src/cli.mjs group --apply' +
      tail
    );
  }

  return `${head}\n${explainGoogleError(e, { context: 'réglages du groupe' })}${tail}`;
}

/**
 * Lit les réglages actuels, calcule ce qui diffère, et n'écrit que la différence.
 *
 * @param {object} params
 * @param {object} params.groupsSettings client Groups Settings
 * @param {string} params.groupEmail
 * @param {Array<{key: string, value: string, why: string}>} params.desired
 * @param {boolean} params.apply
 * @param {boolean} params.groupJustCreated le groupe vient d'être créé (donc réglages inconnus)
 * @param {object} params.log
 * @returns {Promise<{ changed: string[], unchanged: string[], warnings: string[] }>}
 */
async function syncGroupSettings({ groupsSettings, groupEmail, desired, apply, groupJustCreated, log }) {
  const out = { changed: [], unchanged: [], warnings: [] };

  // On ne demande pas de « fields » à cette API : elle date de 2022, l'objet est
  // petit, et un filtrage partiel y est une source d'ennuis silencieux.
  let current = null;
  try {
    const res = await withRetry(
      () => groupsSettings.groups.get({ groupUniqueId: groupEmail }),
      {
        label: `lecture des réglages du groupe ${groupEmail}`,
        // Juste après une création, un 404 est de la propagation : on patiente.
        // Sinon, on veut la réponse tout de suite.
        propagation: groupJustCreated,
        tries: groupJustCreated ? 6 : 3,
      },
    );
    current = res?.data ?? {};
  } catch (e) {
    // En simulation, si le groupe n'existe pas encore, l'échec est normal.
    if (!apply && isNotFound(e)) {
      for (const item of desired) log.plan(`Réglage ${item.key} = « ${item.value} » — ${item.why}`);
      out.changed.push(...desired.map((d) => d.key));
      return out;
    }
    out.warnings.push(explainSettingsFailure(e, groupEmail));
    return out;
  }

  /** @type {Record<string, string>} */
  const patch = {};
  for (const item of desired) {
    // Toutes les valeurs sont comparées en texte : dans cette API, même les
    // booléens sont des chaînes ('true' / 'false').
    const actual = current[item.key] === undefined || current[item.key] === null ? null : String(current[item.key]);
    if (actual === item.value) {
      out.unchanged.push(item.key);
      continue;
    }
    patch[item.key] = item.value;
    const from = actual === null ? '(non défini)' : `« ${actual} »`;
    if (apply) {
      log.info(`Réglage ${item.key} : ${from} -> « ${item.value} » — ${item.why}`);
    } else {
      log.plan(`Réglage ${item.key} : ${from} -> « ${item.value} » — ${item.why}`);
    }
    out.changed.push(item.key);
  }

  if (out.changed.length === 0) {
    log.skip(`Réglages du groupe ${groupEmail} : déjà tous conformes (${out.unchanged.length} réglages vérifiés).`);
    return out;
  }

  if (!apply) return out;

  try {
    await withRetry(() => groupsSettings.groups.patch({ groupUniqueId: groupEmail, requestBody: patch }), {
      label: `application des réglages du groupe ${groupEmail}`,
      propagation: groupJustCreated,
      tries: groupJustCreated ? 6 : 3,
    });
    log.ok(`Réglages appliqués au groupe ${groupEmail} (${out.changed.length} réglage(s) ajusté(s)).`);
  } catch (e) {
    out.warnings.push(explainSettingsFailure(e, groupEmail));
    out.changed = [];
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Étape 3 — membres
 * ------------------------------------------------------------------ */

/**
 * Liste TOUS les membres directs du groupe, page par page.
 *
 * `maxResults` plafonne à 200 pour les membres (ce n'est pas 500 comme pour les
 * usagers — trois valeurs différentes selon la ressource chez Google).
 * `includeDerivedMembership: false` : on veut les membres DIRECTS, pas ceux
 * hérités d'un groupe imbriqué, sinon on croirait devoir « retirer » des gens
 * qu'on ne peut pas retirer d'ici.
 *
 * @param {object} admin
 * @param {string} groupEmail
 * @returns {Promise<Array<{id?: string, email?: string, role?: string, type?: string, status?: string}>>}
 */
async function listGroupMembers(admin, groupEmail) {
  return collectPages(
    (pageToken) =>
      admin.members.list({
        groupKey: groupEmail,
        maxResults: 200,
        includeDerivedMembership: false,
        pageToken,
        // Note : « delivery_settings » n'est jamais retourné par members.list
        // (l'API ne l'expose que sur insert/update/get). On ne peut donc pas le
        // comparer ici, et on ne cherche pas à le faire.
        fields: 'nextPageToken,members(id,email,role,type,status)',
      }),
    { itemsKey: 'members', label: `lecture des membres du groupe ${groupEmail}` },
  );
}

/**
 * Synchronise les membres : ajoute les manquants, promeut ceux dont le rôle est
 * insuffisant, SIGNALE (sans rien faire) tout le reste.
 *
 * @param {object} params
 * @returns {Promise<{ created: object[], updated: object[], unchanged: object[], warnings: string[] }>}
 */
async function syncMembers({ admin, groupEmail, team, existing, apply, groupJustCreated, personalEmail, adminEmail, log }) {
  const out = { created: [], updated: [], unchanged: [], warnings: [] };

  /** @type {Map<string, {role: string, status?: string, type?: string}>} */
  const byEmail = new Map();
  for (const member of existing) {
    const email = normalizeEmail(member.email);
    if (!email) continue;
    byEmail.set(email, {
      role: String(member.role ?? 'MEMBER').toUpperCase(),
      status: member.status ?? undefined,
      type: member.type ?? undefined,
    });
  }

  /* --- a) les personnes de « team » qui doivent être dans le groupe ---- */
  for (const person of team) {
    const email = normalizeEmail(person.email);
    const wantedRole = groupRoleFor(person.role);
    const found = byEmail.get(email);

    if (!found) {
      if (!apply) {
        log.plan(`Ajouter ${person.name} <${email}> au groupe comme ${wantedRole}.`);
        out.created.push({ label: `${email} (${wantedRole})` });
        continue;
      }
      try {
        await withRetry(
          () =>
            admin.members.insert({
              groupKey: groupEmail,
              requestBody: {
                email,
                role: wantedRole,
                type: 'USER',
                // ⚠️ PIÈGE : ce champ s'écrit en snake_case dans l'API Google.
                // Écrit « deliverySettings », il est IGNORÉ EN SILENCE — aucune
                // erreur, mais le réglage n'est pas appliqué.
                delivery_settings: 'ALL_MAIL',
              },
              fields: 'id,email,role,type',
            }),
          {
            label: `ajout de ${email} au groupe`,
            // Juste après la création du groupe, Google peut répondre 404 le
            // temps que le groupe se propage. C'est documenté et attendu.
            propagation: true,
            tries: groupJustCreated ? 8 : 5,
          },
        );
        log.ok(`${person.name} <${email}> ajouté au groupe comme ${wantedRole}.`);
        out.created.push({ label: `${email} (${wantedRole})` });
      } catch (e) {
        if (isConflict(e)) {
          // Déjà membre (course entre deux exécutions, ou membre via un alias) :
          // c'est le résultat voulu, donc ce n'est pas une erreur.
          log.skip(`${email} était déjà membre du groupe.`);
          out.unchanged.push({ label: `${email} (déjà membre)` });
          continue;
        }
        throw new Error(
          `Impossible d'ajouter ${email} au groupe ${groupEmail}.\n` +
            explainGoogleError(e, { context: `ajout de ${email}` }) +
            "\n\nVérifie aussi que ce compte existe bien dans le domaine (une faute de frappe\n" +
            "dans config.json donne exactement cette erreur) : node src/cli.mjs audit",
        );
      }
      continue;
    }

    /* Le membre est là. Son rôle est-il suffisant ? */
    const actualRank = ROLE_RANK[found.role] ?? 0;
    const wantedRank = ROLE_RANK[wantedRole] ?? 0;

    if (found.role === wantedRole) {
      log.skip(`${email} est déjà membre du groupe avec le rôle ${wantedRole}.`);
      out.unchanged.push({ label: `${email} (${wantedRole})` });
      continue;
    }

    if (actualRank > wantedRank) {
      // Rôle PLUS élevé que demandé. On ne rétrograde jamais tout seul : c'est
      // le genre de « correction » qui retire des droits à quelqu'un qui en a
      // besoin. On le signale, l'humain tranche.
      out.warnings.push(
        `${email} est ${found.role} dans le groupe ${groupEmail}, alors que config.json le déclare ` +
          `« ${person.role} » (soit ${wantedRole}). La trousse ne rétrograde JAMAIS personne toute seule.\n` +
          `  Si c'est voulu, corrige config.json (team[].role).\n` +
          `  Si tu veux vraiment le rétrograder : https://admin.google.com/ac/groups (chercher ${groupEmail}).`,
      );
      out.unchanged.push({ label: `${email} (${found.role}, non rétrogradé)` });
      continue;
    }

    // Rôle insuffisant : on promeut, c'est ce que la configuration demande.
    if (!apply) {
      log.plan(`Passer ${email} de ${found.role} à ${wantedRole} dans le groupe.`);
      out.updated.push({ label: `${email} : ${found.role} -> ${wantedRole}` });
      continue;
    }
    try {
      await withRetry(
        () =>
          admin.members.patch({
            groupKey: groupEmail,
            memberKey: email,
            requestBody: { role: wantedRole },
            fields: 'id,email,role',
          }),
        { label: `changement de rôle de ${email}`, propagation: true, tries: 5 },
      );
      log.ok(`${email} passe de ${found.role} à ${wantedRole}.`);
      out.updated.push({ label: `${email} : ${found.role} -> ${wantedRole}` });
    } catch (e) {
      out.warnings.push(
        `Le rôle de ${email} n'a pas pu passer à ${wantedRole}.\n` +
          explainGoogleError(e, { context: `rôle de ${email}` }),
      );
    }
  }

  /* --- b) les membres présents qui ne sont PAS dans « team » ---------- */
  const wantedEmails = new Set(team.map((p) => normalizeEmail(p.email)));
  const extras = [...byEmail.keys()].filter((email) => !wantedEmails.has(email));

  if (extras.length > 0) {
    const lines = [
      `Le groupe ${groupEmail} contient ${extras.length} membre(s) qui ne sont PAS dans « team » ` +
        'de config.json. La trousse ne retire JAMAIS personne automatiquement : retirer ' +
        "quelqu'un lui coupe d'un coup l'accès au Drive partagé et aux calendriers.",
      '',
      'Membres concernés :',
    ];

    for (const email of extras) {
      const info = byEmail.get(email);
      let note = '';
      if (personalEmail && email === normalizeEmail(personalEmail)) {
        note = "   <- c'est l'adresse personnelle ; la commande « detach » s'en occupe";
      } else if (adminEmail && email === normalizeEmail(adminEmail)) {
        note = "   <- c'est le compte administrateur ; c'est souvent normal";
      }
      lines.push(`  - ${email} (${info?.role ?? 'MEMBER'})${note}`);
    }

    lines.push('');
    lines.push('Deux façons de corriger, au choix :');
    lines.push('  1. Si ces personnes DOIVENT rester : ajoute-les dans « team » de config.json.');
    lines.push('  2. Si elles doivent partir, retire-les une par une. Pour chacune :');
    lines.push('');
    for (const email of extras) {
      lines.push(`     ${removalCommand(groupEmail, email)}`);
    }
    lines.push('');
    lines.push(`  (ou à la souris : https://admin.google.com/ac/groups — chercher ${groupEmail})`);

    out.warnings.push(lines.join('\n'));
  }

  /* --- c) filet de sécurité : il faut au moins un propriétaire -------- */
  const willHaveOwner =
    team.some((p) => groupRoleFor(p.role) === 'OWNER') || [...byEmail.values()].some((m) => m.role === 'OWNER');
  if (!willHaveOwner) {
    out.warnings.push(
      `Le groupe ${groupEmail} n'aura aucun propriétaire (OWNER). Personne ne pourra gérer ` +
        "ses membres depuis l'interface Google.\n" +
        '  Quoi faire : mettre « "role": "organizer" » sur au moins une personne dans ' +
        '« team » de config.json (typiquement le propriétaire de l\'entreprise), puis relancer.',
    );
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Commande
 * ------------------------------------------------------------------ */

/**
 * @param {object} params
 * @param {object} params.config configuration validée
 * @param {boolean} params.apply false = simulation (défaut), true = on écrit chez Google
 * @param {object} params.state cache local des identifiants (optimisation seulement)
 * @param {object} params.log
 * @returns {Promise<{created: object[], updated: object[], unchanged: object[], warnings: string[]}>}
 */
export async function run({ config, apply = false, state = {}, log }) {
  /** @type {{created: object[], updated: object[], unchanged: object[], warnings: string[]}} */
  const summary = { created: [], updated: [], unchanged: [], warnings: [] };

  /* --- Cas « pas de groupe » : ce n'est pas une erreur ---------------- */
  if (!config.group) {
    log.step('Aucun groupe d\'équipe à créer.');
    log.info(
      'Le champ « group » de config.json vaut null : c\'est un choix valide, pas un oubli.\n' +
        'Les accès (calendriers, Drive partagé) seront accordés DIRECTEMENT à chacune des ' +
        `${config.team.length} adresses de « team » :`,
    );
    log.table(
      config.team.map((m) => ({ Adresse: m.email, Nom: m.name, Rôle: m.role })),
    );
    log.info(
      'Conséquence à connaître : quand quelqu\'un arrivera ou partira, il faudra repasser sur ' +
        'chaque calendrier et sur le Drive partagé pour ajuster les accès. Avec un groupe, une ' +
        'seule modification suffirait.\n' +
        `Pour passer au groupe plus tard : remplir « group » dans config.json (ex. equipe@${config.domain}) ` +
        'puis relancer « node src/cli.mjs setup --apply ».',
    );
    log.skip('Rien à faire pour la commande « group ».');
    return summary;
  }

  const groupEmail = normalizeEmail(config.group.email);
  const groupName = config.group.name;
  const groupDescription = config.group.description ?? '';

  log.step(`Groupe d'équipe : ${groupName} <${groupEmail}>`);
  log.info(
    `Ce groupe portera les accès de l'équipe (${config.team.length} personne(s)). Les calendriers et ` +
      'le Drive partagé seront partagés AVEC LUI plutôt qu\'avec chaque adresse.',
  );

  // On demande toutes les portées de la trousse en une seule fois. En mode
  // OAuth, ça évite à l'administrateur de repasser par le navigateur à chaque
  // commande : une seule autorisation couvre groupe, calendriers et Drive.
  const { admin, groupsSettings } = await getClients({ config });

  /* --- Étape 1 : le groupe existe-t-il ? ------------------------------ */
  log.step('1/3 — Vérification du groupe');
  let group = await findGroup(admin, groupEmail);
  let groupJustCreated = false;

  if (group) {
    log.skip(`Le groupe ${groupEmail} existe déjà (id ${group.id}). On le réutilise, on n'en crée pas un deuxième.`);
    summary.unchanged.push({ label: `Groupe ${groupEmail}`, id: group.id });

    // Le nom affiché ou la description ont-ils dérivé par rapport à config.json ?
    // On réaligne : c'est du texte, c'est sans risque, et un nom qui ne
    // correspond plus à la config sème la confusion.
    const patch = {};
    if (groupName && group.name !== groupName) patch.name = groupName;
    if (groupDescription && (group.description ?? '') !== groupDescription) patch.description = groupDescription;

    if (Object.keys(patch).length > 0) {
      const what = Object.keys(patch).join(' et ');
      if (!apply) {
        log.plan(`Mettre à jour ${what} du groupe pour correspondre à config.json.`);
        summary.updated.push({ label: `Groupe ${groupEmail} (${what})` });
      } else {
        try {
          const res = await withRetry(
            () => admin.groups.patch({ groupKey: groupEmail, requestBody: patch, fields: GROUP_FIELDS }),
            { label: `mise à jour du groupe ${groupEmail}`, propagation: false, tries: 3 },
          );
          group = res?.data ?? group;
          log.ok(`${what} du groupe mis à jour d'après config.json.`);
          summary.updated.push({ label: `Groupe ${groupEmail} (${what})` });
        } catch (e) {
          summary.warnings.push(
            `Le nom ou la description du groupe n'ont pas pu être mis à jour.\n` +
              explainGoogleError(e, { context: `mise à jour de ${groupEmail}` }),
          );
        }
      }
    }
  } else if (!apply) {
    log.plan(`Créer le groupe « ${groupName} » <${groupEmail}>.`);
    if (groupDescription) log.plan(`  Description : ${groupDescription}`);
    summary.created.push({ label: `Groupe ${groupEmail}` });
  } else {
    log.info(`Le groupe ${groupEmail} n'existe pas. Création…`);
    try {
      const res = await withRetry(
        () =>
          admin.groups.insert({
            requestBody: {
              email: groupEmail,
              name: groupName,
              ...(groupDescription ? { description: groupDescription } : {}),
            },
            fields: GROUP_FIELDS,
          }),
        { label: `création du groupe ${groupEmail}`, propagation: false, tries: 4 },
      );
      group = res?.data ?? null;
      groupJustCreated = true;
      log.ok(`Groupe ${groupEmail} créé (id ${group?.id ?? 'inconnu'}).`);
      summary.created.push({ label: `Groupe ${groupEmail}`, id: group?.id });
    } catch (e) {
      if (!isConflict(e)) {
        throw new Error(
          `La création du groupe ${groupEmail} a échoué.\n` + explainGoogleError(e, { context: 'création du groupe' }),
        );
      }
      // 409 « Entity already exists » : chez Google, ce message est le MÊME que
      // l'adresse soit déjà prise par un groupe, par un utilisateur ou par un
      // alias. Impossible de trancher sans relire — on relit.
      log.info(`Google répond que ${groupEmail} existe déjà. Vérification de ce que c'est exactement…`);
      group = await findGroup(admin, groupEmail);
      if (group) {
        log.skip(`C'était bien un groupe, créé entre-temps. On le réutilise (id ${group.id}).`);
        summary.unchanged.push({ label: `Groupe ${groupEmail}`, id: group.id });
      } else {
        throw new Error(
          `L'adresse ${groupEmail} est déjà utilisée, mais PAS par un groupe.\n` +
            "C'est presque toujours un compte utilisateur ou un alias qui porte déjà cette adresse.\n" +
            'Une adresse ne peut pas être à la fois une personne et un groupe.\n\n' +
            'Quoi faire :\n' +
            `  1. Chercher ${groupEmail} dans https://admin.google.com/ac/users et /ac/groups ;\n` +
            `  2. soit libérer l'adresse, soit choisir une autre adresse dans config.json\n` +
            `     (champ « group.email », par exemple equipe-portail@${config.domain}).`,
        );
      }
    }
  }

  /* --- Barrière de propagation --------------------------------------- */
  // Les commandes suivantes (calendar, drive) vont partager des ressources AVEC
  // ce groupe. Si Google ne le voit pas encore partout, ces partages échouent
  // avec un 404 déroutant. On attend donc qu'il soit réellement lisible avant
  // de rendre la main.
  if (groupJustCreated) {
    log.info(
      "Attente de la propagation chez Google : un groupe fraîchement créé n'est pas visible " +
        'partout instantanément. Les commandes « calendar » et « drive » en dépendent.',
    );
    try {
      const res = await withRetry(() => admin.groups.get({ groupKey: groupEmail, fields: GROUP_FIELDS }), {
        label: `propagation du groupe ${groupEmail}`,
        propagation: true,
        tries: 8,
      });
      group = res?.data ?? group;
      log.ok(`Le groupe ${groupEmail} est maintenant visible par l'API. On peut continuer.`);
    } catch (e) {
      summary.warnings.push(
        `Le groupe ${groupEmail} a été créé, mais Google ne le voit pas encore partout après ` +
          "plusieurs minutes d'attente.\n" +
          "Ce n'est pas une erreur de configuration. Quoi faire : attendre 5 minutes puis relancer\n" +
          '« node src/cli.mjs setup --apply » — la trousse est idempotente et reprendra où elle en est.\n' +
          explainGoogleError(e, { context: 'propagation du groupe' }),
      );
    }
  }

  /* --- Cache local (optimisation seulement) --------------------------- */
  if (apply && group?.id) {
    setStateKey(state, 'group', { email: groupEmail, id: group.id, name: group.name ?? groupName });
  }

  /* --- Étape 2 : réglages -------------------------------------------- */
  log.step('2/3 — Réglages de confidentialité du groupe');
  log.info(
    'Objectif : aucun membre externe, seules les personnes du domaine peuvent voir et écrire, ' +
      "et personne ne peut s'inscrire tout seul.",
  );

  // Cas particulier : si « team » contient une adresse hors domaine, interdire
  // les membres externes rendrait son ajout impossible. On préfère laisser le
  // réglage tel quel et le dire, plutôt que de casser la synchronisation.
  const externalMembers = config.team.filter((m) => domainOf(m.email) !== config.domain);
  let desiredSettings = DESIRED_SETTINGS;
  if (externalMembers.length > 0) {
    desiredSettings = DESIRED_SETTINGS.filter((s) => !s.external);
    summary.warnings.push(
      `« team » contient ${externalMembers.length} adresse(s) hors du domaine ${config.domain} : ` +
        `${externalMembers.map((m) => m.email).join(', ')}.\n` +
        "Le réglage « aucun membre externe » (allowExternalMembers = false) n'a donc PAS été appliqué :\n" +
        'il empêcherait justement ces personnes de faire partie du groupe.\n' +
        'Quoi faire :\n' +
        "  - si ce sont des fautes de frappe, corrige-les dans config.json et relance ;\n" +
        '  - si ces personnes sont bien des externes assumés, il n\'y a rien à faire, mais sache\n' +
        '    que le groupe accepte les membres hors domaine.',
    );
  }

  const settingsResult = await syncGroupSettings({
    groupsSettings,
    groupEmail,
    desired: desiredSettings,
    apply,
    groupJustCreated,
    log,
  });

  if (settingsResult.changed.length > 0) {
    summary.updated.push({
      label: `Réglages du groupe ${groupEmail} (${settingsResult.changed.join(', ')})`,
    });
  } else if (settingsResult.unchanged.length > 0) {
    summary.unchanged.push({ label: `Réglages du groupe ${groupEmail}` });
  }
  summary.warnings.push(...settingsResult.warnings);

  /* --- Étape 3 : membres --------------------------------------------- */
  log.step(`3/3 — Membres du groupe (${config.team.length} attendu(s))`);

  /** @type {Array<object>} */
  let existingMembers = [];
  if (groupJustCreated) {
    // Un groupe créé par l'API naît vide (contrairement à l'interface web, qui
    // ajoute le créateur). Inutile de le demander à Google, et ça évite un 404
    // de propagation de plus.
    log.info('Groupe tout neuf : il est vide, on ajoute les quatre membres.');
  } else if (!group) {
    // Simulation avec un groupe qui n'existe pas encore : rien à lire.
    log.plan("Le groupe n'existe pas encore : tous les membres seront ajoutés à sa création.");
  } else {
    existingMembers = await listGroupMembers(admin, groupEmail);
    log.info(
      `Le groupe compte actuellement ${existingMembers.length} membre(s) direct(s).` +
        (existingMembers.length > 0
          ? ` (${existingMembers.map((m) => `${m.email} ${m.role ?? 'MEMBER'}`).join(', ')})`
          : ''),
    );
  }

  const membersResult = await syncMembers({
    admin,
    groupEmail,
    team: config.team,
    existing: existingMembers,
    apply,
    groupJustCreated,
    personalEmail: config.personalEmail,
    adminEmail: config.adminEmail,
    log,
  });

  summary.created.push(...membersResult.created);
  summary.updated.push(...membersResult.updated);
  summary.unchanged.push(...membersResult.unchanged);
  summary.warnings.push(...membersResult.warnings);

  /* --- Mot de la fin -------------------------------------------------- */
  if (apply) {
    log.ok(
      `Le groupe ${groupEmail} est prêt. Les prochaines commandes (calendar, drive) accorderont ` +
        'les accès à CE groupe : plus besoin de toucher aux adresses une par une.',
    );
  } else {
    log.plan(
      `Rien n'a été envoyé à Google. Pour exécuter pour de vrai : node src/cli.mjs group --apply`,
    );
  }

  return summary;
}

export default { meta, run };
