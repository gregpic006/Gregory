/**
 * calendar.mjs — Commande « calendar » : les calendriers partagés de l'équipe.
 *
 * Ce que la commande fait, dans l'ordre :
 *
 *   1. crée (ou retrouve) chaque calendrier décrit dans config.calendars,
 *      au nom de config.adminEmail — c'est lui le propriétaire des données ;
 *   2. accorde l'accès : au GROUPE d'équipe si un groupe est configuré,
 *      sinon directement à chacune des adresses de config.team ;
 *   3. ABONNE chaque personne au calendrier — c'est LE point qui fait la
 *      différence entre « le calendrier existe » et « le calendrier est déjà
 *      là quand j'ouvre mon Agenda ».
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ Pourquoi l'étape 3 est indispensable                                 │
 * │                                                                      │
 * │ Chez Google, « avoir le droit de voir un calendrier » et « voir le   │
 * │ calendrier dans son Agenda » sont DEUX choses distinctes :           │
 * │                                                                      │
 * │   - l'ACL  (calendars/{id}/acl)   = l'autorisation, côté calendrier  │
 * │   - la calendarList (users/me/…)  = l'abonnement, côté personne      │
 * │                                                                      │
 * │ Accorder l'ACL ne remplit PAS la liste de personne. Sans l'étape 3,  │
 * │ chaque membre de l'équipe reçoit un courriel et doit cliquer dessus  │
 * │ pour voir le calendrier apparaître. C'est exactement la manipulation │
 * │ manuelle qu'on veut éviter.                                          │
 * │                                                                      │
 * │ En mode « compte de service », on peut emprunter l'identité de       │
 * │ chaque personne et remplir sa liste à sa place. En mode OAuth, non : │
 * │ la commande le dit clairement au lieu de faire semblant.             │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Idempotence : rien n'est jamais créé en double. Un calendrier est retrouvé
 * d'abord par l'identifiant mis en cache (validé via l'API — il a pu être
 * supprimé à la main), puis par son nom dans la liste du propriétaire.
 *
 * Prudence : la commande n'ENLÈVE jamais un accès existant qu'elle n'a pas
 * demandé, et ne rétrograde jamais un propriétaire. Elle ajoute et ajuste,
 * elle ne fait pas le ménage à la place de l'humain.
 */

import { getClients, withRetry, collectPages, isNotFound, isConflict, explainGoogleError, errorInfo, sleep } from '../lib/google.mjs';
import { SCOPES } from '../lib/auth.mjs';
import { setStateKey, getStateKey } from '../lib/state.mjs';

export const meta = {
  name: 'calendar',
  summary:
    "Crée les calendriers partagés, accorde l'accès à l'équipe et fait apparaître le calendrier " +
    "tout seul dans le Google Agenda de chaque personne (aucun courriel à accepter).",
};

/* ================================================================== *
 * Constantes d'API
 * ================================================================== */

/**
 * Portées utilisées. On demande la portée large « calendar » plutôt que les
 * portées fines : c'est celle qui est déjà inscrite dans la délégation à
 * l'échelle du domaine (voir la commande « scopes »). Demander une portée qui
 * n'y figure pas au caractère près échoue avec unauthorized_client.
 */
const CALENDAR_SCOPES = SCOPES.calendar;

/** Plafond documenté de calendarList.list et acl.list : 250 (défaut 100). */
const CALENDAR_PAGE_SIZE = 250;

/**
 * Petite pause entre deux abonnements. Les quotas d'écriture de l'API Calendar
 * sont serrés ; enchaîner 4 appels en rafale n'apporte rien et risque un 403
 * rateLimitExceeded. Avec une équipe de 4 personnes, c'est une demi-seconde.
 */
const SUBSCRIBE_DELAY_MS = 150;

/** Masques `fields` explicites : on ne rapatrie que ce qu'on utilise. */
const CALENDAR_FIELDS = 'id,summary,description,timeZone';
const CALENDAR_LIST_FIELDS = 'nextPageToken,items(id,summary,primary,accessRole,selected,hidden,deleted)';
const CALENDAR_LIST_ENTRY_FIELDS = 'id,summary,summaryOverride,selected,hidden,accessRole';
const ACL_FIELDS = 'nextPageToken,items(id,role,scope)';

/** Traduction des rôles de partage Calendar, pour les messages. */
const ROLE_LABELS = {
  none: 'aucun accès',
  freeBusyReader: 'voit seulement les disponibilités (libre / occupé)',
  reader: 'consulte les événements',
  writerWithoutPrivateAccess: 'crée et modifie les événements, sans voir le détail des événements privés',
  writer: 'crée et modifie les événements',
  owner: 'gère le calendrier et ses partages',
};

/** Identifiant fictif utilisé en simulation, quand le calendrier n'existe pas encore. */
const PLANNED_ID = '(identifiant attribué par Google à la création)';

/* ================================================================== *
 * Petites fonctions utilitaires
 * ================================================================== */

/** Minuscules sûres, pour comparer des adresses courriel. */
function lower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Normalise un fuseau horaire IANA.
 *
 * « America/Montreal » est un alias déprécié d'« America/Toronto » : Google le
 * réécrit silencieusement. Sans cette normalisation, on croirait voir un écart
 * à chaque exécution et on modifierait le calendrier pour rien.
 */
function canonTz(tz) {
  try {
    return new Intl.DateTimeFormat('fr-CA', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return String(tz ?? '');
  }
}

/** Libellé français d'un rôle de partage. */
function roleLabel(role) {
  return ROLE_LABELS[role] ?? role;
}

/** Clé de comparaison d'une règle d'accès : « type:valeur ». */
function aclKey(type, value) {
  return `${type}:${lower(value)}`;
}

/** Explication française d'une erreur Google, sur une ligne de contexte donnée. */
function explain(error, context) {
  try {
    return explainGoogleError(error, { context });
  } catch {
    return `${context} — ${error?.message ?? String(error)}`;
  }
}

/** Vrai si l'erreur est un 410 « Gone » (ressource supprimée définitivement). */
function isGone(error) {
  return errorInfo(error).status === 410;
}

/* ================================================================== *
 * Découverte et création du calendrier
 * ================================================================== */

/**
 * Vérifie qu'un identifiant de calendrier mis en cache pointe encore sur un
 * calendrier réel. Le cache est une optimisation, jamais une vérité : le
 * calendrier a pu être supprimé à la main dans l'interface de Google.
 *
 * @param {object} calendarApi client Calendar du propriétaire
 * @param {string} calendarId
 * @returns {Promise<object|null>} la ressource Calendar, ou null si périmée
 */
async function getCalendarOrNull(calendarApi, calendarId) {
  try {
    const { data } = await withRetry(
      () => calendarApi.calendars.get({ calendarId, fields: CALENDAR_FIELDS }),
      // propagation: false — ici un 404 est une RÉPONSE, pas une panne. Sans
      // ça, chaque vérification négative attendrait deux minutes pour rien.
      { tries: 3, propagation: false, label: `lecture du calendrier ${calendarId}` },
    );
    return data ?? null;
  } catch (error) {
    if (isNotFound(error) || isGone(error)) return null;
    throw error;
  }
}

/**
 * Cherche un calendrier par son nom dans la liste du compte propriétaire.
 *
 * Deux précautions non négociables :
 *   - showHidden: true — une entrée masquée existe quand même ; sans ce
 *     paramètre on ne la verrait pas et on créerait un doublon à chaque run ;
 *   - minAccessRole: 'owner' — on ne veut retrouver que ce que ce compte
 *     possède, pas un calendrier d'un tiers qui porterait le même nom.
 *
 * @param {object} calendarApi client Calendar du propriétaire
 * @param {string} summary nom exact recherché
 * @returns {Promise<object[]>} toutes les correspondances (0, 1 ou plusieurs)
 */
async function findCalendarsBySummary(calendarApi, summary) {
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

  const wanted = String(summary).trim().toLowerCase();
  return items.filter((entry) => !entry?.primary && !entry?.deleted && lower(entry?.summary) === wanted);
}

/**
 * Retrouve ou crée le calendrier décrit par `spec`. Ne crée JAMAIS de doublon.
 *
 * @param {object} params
 * @returns {Promise<{ id: string|null, calendar: object|null, action: 'created'|'reused'|'planned'|'failed' }>}
 */
async function ensureCalendar({ calendarApi, spec, state, apply, log, warnings }) {
  const wantedTz = canonTz(spec.timeZone);

  /* --- 1. Raccourci : l'identifiant connu du cache ------------------ */
  const cachedId = getStateKey(state, ['calendars', spec.key], null);
  if (typeof cachedId === 'string' && cachedId !== '') {
    const existing = await getCalendarOrNull(calendarApi, cachedId);
    if (existing) {
      log.skip(`Calendrier « ${spec.summary} » déjà créé (${existing.id}).`);
      return { id: existing.id, calendar: existing, action: 'reused' };
    }
    log.warn(
      `Le cache local pointait sur le calendrier ${cachedId} pour « ${spec.summary} », mais ce ` +
        "calendrier n'existe plus chez Google (supprimé à la main ?). On repart de la recherche par nom.",
    );
    setStateKey(state, ['calendars', spec.key], null);
  }

  /* --- 2. Recherche par nom dans la liste du propriétaire ----------- */
  const matches = await findCalendarsBySummary(calendarApi, spec.summary);

  if (matches.length > 1) {
    // Google accepte dix calendriers du même nom. On ne devine pas : on prend
    // toujours le même (tri par identifiant, donc stable d'une exécution à
    // l'autre) et on demande à l'humain de faire le ménage.
    const chosen = [...matches].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
    const message =
      `${matches.length} calendriers portent déjà le nom « ${spec.summary} » ` +
      `(${matches.map((m) => m.id).join(', ')}). ` +
      `La trousse utilise toujours le même (${chosen.id}) et n'en crée aucun autre. ` +
      'À corriger à la main : supprimer les calendriers en trop dans Google Agenda, ' +
      'sinon une partie de l\'équipe pourrait regarder le mauvais.';
    log.warn(message);
    warnings.push(message);
    setStateKey(state, ['calendars', spec.key], chosen.id);
    const full = await getCalendarOrNull(calendarApi, chosen.id);
    return { id: chosen.id, calendar: full ?? { id: chosen.id, summary: chosen.summary }, action: 'reused' };
  }

  if (matches.length === 1) {
    const found = matches[0];
    log.skip(`Calendrier « ${spec.summary} » retrouvé par son nom (${found.id}). Aucune création.`);
    setStateKey(state, ['calendars', spec.key], found.id);
    const full = await getCalendarOrNull(calendarApi, found.id);
    return { id: found.id, calendar: full ?? { id: found.id, summary: found.summary }, action: 'reused' };
  }

  /* --- 3. Création ------------------------------------------------- */
  if (!apply) {
    log.plan(
      `Créer le calendrier « ${spec.summary} » (fuseau ${wantedTz}), propriétaire : le compte administrateur.`,
    );
    return { id: null, calendar: null, action: 'planned' };
  }

  log.info(`Création du calendrier « ${spec.summary} »…`);
  const { data } = await withRetry(
    () =>
      calendarApi.calendars.insert({
        requestBody: {
          summary: spec.summary,
          description: spec.description || undefined,
          timeZone: wantedTz,
        },
        fields: CALENDAR_FIELDS,
      }),
    { tries: 4, propagation: false, label: `création du calendrier « ${spec.summary} »` },
  );

  setStateKey(state, ['calendars', spec.key], data.id);
  log.ok(`Calendrier « ${spec.summary} » créé — identifiant ${data.id}`);
  return { id: data.id, calendar: data, action: 'created' };
}

/**
 * Aligne la description et le fuseau horaire d'un calendrier existant sur
 * config.json. Le NOM n'est jamais modifié : c'est lui qui sert à retrouver le
 * calendrier, le renommer casserait la découverte à la prochaine exécution.
 *
 * @returns {Promise<string[]>} liste des champs ajustés (vide si rien à faire)
 */
async function syncCalendarFields({ calendarApi, calendar, spec, apply, log }) {
  if (!calendar) return [];

  /** @type {Record<string, unknown>} */
  const patch = {};
  /** @type {string[]} */
  const changes = [];

  const wantedDescription = spec.description || '';
  const actualDescription = calendar.description || '';
  if (wantedDescription !== actualDescription) {
    patch.description = wantedDescription;
    changes.push('description');
  }

  const wantedTz = canonTz(spec.timeZone);
  const actualTz = canonTz(calendar.timeZone);
  if (wantedTz && wantedTz !== actualTz) {
    patch.timeZone = wantedTz;
    changes.push(`fuseau horaire (${actualTz || 'non défini'} → ${wantedTz})`);
  }

  if (changes.length === 0) return [];

  if (!apply) {
    log.plan(`Mettre à jour le calendrier « ${spec.summary} » : ${changes.join(', ')}.`);
    return changes;
  }

  await withRetry(
    () => calendarApi.calendars.patch({ calendarId: calendar.id, requestBody: patch, fields: CALENDAR_FIELDS }),
    { tries: 4, propagation: false, label: `mise à jour du calendrier « ${spec.summary} »` },
  );
  log.ok(`Calendrier « ${spec.summary} » mis à jour : ${changes.join(', ')}.`);
  return changes;
}

/* ================================================================== *
 * Partages (ACL)
 * ================================================================== */

/**
 * Construit la liste des accès voulus.
 *
 * Avec un groupe : UNE seule règle, et l'appartenance est évaluée en direct.
 * Ajouter ou retirer quelqu'un de l'équipe se fait alors dans le groupe, sans
 * jamais retoucher au calendrier. C'est le bon réflexe.
 *
 * Sans groupe : une règle par adresse.
 *
 * @returns {Array<{ type: 'group'|'user', value: string, role: string }>}
 */
function buildDesiredAcl(config, spec) {
  if (config.group?.email) {
    return [{ type: 'group', value: config.group.email, role: spec.role }];
  }
  return (config.team ?? [])
    .map((member) => member?.email)
    .filter((email) => typeof email === 'string' && email !== '')
    .map((email) => ({ type: 'user', value: email, role: spec.role }));
}

/** Lit toutes les règles d'accès d'un calendrier (pagination comprise). */
async function listAcl(calendarApi, calendarId) {
  return collectPages(
    (pageToken) =>
      calendarApi.acl.list({ calendarId, maxResults: CALENDAR_PAGE_SIZE, fields: ACL_FIELDS, pageToken }),
    { itemsKey: 'items', label: 'lecture des partages du calendrier' },
  );
}

/**
 * Accorde les accès voulus, sans jamais retirer un accès existant.
 *
 * @returns {Promise<{ granted: string[], adjusted: string[], already: string[], failed: string[] }>}
 */
async function reconcileAcl({ calendarApi, calendarId, spec, desired, config, apply, log, warnings }) {
  const result = { granted: [], adjusted: [], already: [], failed: [] };

  // En simulation sans calendrier existant, il n'y a rien à lire : on annonce
  // simplement tous les partages à venir.
  if (!calendarId) {
    for (const want of desired) {
      log.plan(`Partager « ${spec.summary} » avec ${want.value} — ${roleLabel(want.role)}.`);
      result.granted.push(`${want.value} (${want.role})`);
    }
    return result;
  }

  const current = await listAcl(calendarApi, calendarId);
  const byScope = new Map();
  for (const rule of current) {
    const type = rule?.scope?.type;
    const value = rule?.scope?.value;
    if (!type) continue;
    byScope.set(aclKey(type, value ?? ''), rule);
  }

  const ownerEmail = lower(config.adminEmail);

  for (const want of desired) {
    const label = `${want.value} — ${roleLabel(want.role)}`;
    const existing = byScope.get(aclKey(want.type, want.value));

    // Le propriétaire des données ne se partage pas à lui-même : lui accorder
    // « writer » reviendrait à tenter de rétrograder son propre accès.
    if (want.type === 'user' && lower(want.value) === ownerEmail) {
      log.skip(`${want.value} est le propriétaire du calendrier : il y a déjà tous les droits.`);
      result.already.push(`${want.value} (propriétaire)`);
      continue;
    }

    if (existing && existing.role === want.role) {
      log.skip(`Accès déjà accordé : ${label}.`);
      result.already.push(`${want.value} (${want.role})`);
      continue;
    }

    if (existing && existing.role === 'owner') {
      const message =
        `${want.value} est déjà co-propriétaire du calendrier « ${spec.summary} ». La trousse ne ` +
        `rétrograde jamais un propriétaire vers « ${want.role} » : accès laissé tel quel.`;
      log.warn(message);
      warnings.push(message);
      result.already.push(`${want.value} (owner)`);
      continue;
    }

    if (!apply) {
      if (existing) {
        log.plan(`Changer l'accès de ${want.value} sur « ${spec.summary} » : ${existing.role} → ${want.role}.`);
        result.adjusted.push(`${want.value} (${existing.role} → ${want.role})`);
      } else {
        log.plan(`Partager « ${spec.summary} » avec ${want.value} — ${roleLabel(want.role)}.`);
        result.granted.push(`${want.value} (${want.role})`);
      }
      continue;
    }

    try {
      await withRetry(
        () =>
          calendarApi.acl.insert({
            calendarId,
            // sendNotifications: le défaut de l'API est TRUE. Laissé tel quel,
            // Google enverrait un courriel d'invitation à tout le monde — alors
            // qu'on va justement abonner chaque personne automatiquement.
            sendNotifications: false,
            requestBody: { role: want.role, scope: { type: want.type, value: want.value } },
            fields: 'id,role,scope',
          }),
        {
          // propagation: true — un groupe créé il y a quelques secondes n'est
          // pas encore résolvable par l'API Calendar. Le 404 est temporaire.
          tries: 6,
          propagation: true,
          label: `partage de « ${spec.summary} » avec ${want.value}`,
        },
      );

      if (existing) {
        log.ok(`Accès ajusté : ${want.value} passe de ${existing.role} à ${want.role} sur « ${spec.summary} ».`);
        result.adjusted.push(`${want.value} (${existing.role} → ${want.role})`);
      } else {
        log.ok(`Accès accordé : ${label} sur « ${spec.summary} ».`);
        result.granted.push(`${want.value} (${want.role})`);
      }
    } catch (error) {
      const context = `partage de « ${spec.summary} » avec ${want.value}`;
      const message = explain(error, context);
      log.err(message);
      warnings.push(`${context} : échec. ${errorInfo(error).message}`);
      result.failed.push(want.value);

      if (want.type === 'group' && isNotFound(error)) {
        const hint =
          `Le groupe ${want.value} reste introuvable pour l'API Agenda. Deux causes possibles : ` +
          'il vient tout juste d\'être créé et Google ne l\'a pas encore répercuté partout ' +
          '(relancer dans quelques minutes règle le problème), ou il n\'existe pas encore — ' +
          'dans ce cas, lancer « node src/cli.mjs group --apply » avant cette commande.';
        log.warn(hint);
        warnings.push(hint);
      }
    }
  }

  // On signale les autres accès sans y toucher : le ménage reste une décision
  // humaine, jamais un effet de bord d'un script de mise en place.
  const desiredKeys = new Set(desired.map((d) => aclKey(d.type, d.value)));
  for (const rule of current) {
    const type = rule?.scope?.type;
    const value = rule?.scope?.value ?? '';
    if (!type) continue;
    if (desiredKeys.has(aclKey(type, value))) continue;
    if (rule.role === 'owner') continue; // le propriétaire, c'est normal
    if (type === 'default') {
      const message =
        `Le calendrier « ${spec.summary} » est partagé avec « tout le monde sur Internet » ` +
        `(rôle ${rule.role}). La trousse n'y touche pas, mais c'est presque sûrement une erreur : ` +
        'à retirer dans Google Agenda > Paramètres du calendrier > Autorisations d\'accès.';
      log.warn(message);
      warnings.push(message);
      continue;
    }
    log.info(
      `Autre accès déjà en place sur « ${spec.summary} » : ${type} ${value} (${rule.role}). ` +
        'Laissé tel quel — la trousse ne retire jamais un accès qu\'elle n\'a pas accordé.',
    );
  }

  return result;
}

/* ================================================================== *
 * Abonnement automatique (le cœur du « zéro manipulation »)
 * ================================================================== */

/**
 * Ajoute le calendrier dans la liste personnelle d'UNE personne, coché.
 *
 * Emprunte l'identité de cette personne : `users/me/calendarList` désigne
 * toujours le compte authentifié, il n'existe pas d'appel « en lot ».
 *
 * @returns {Promise<{ status: 'inserted'|'updated'|'already'|'failed', detail: string }>}
 */
async function subscribeUser({ config, userEmail, calendarId, summary, log }) {
  const { calendar: calendarAsUser } = await getClients({
    config,
    subject: userEmail,
    scopes: CALENDAR_SCOPES,
  });

  /* --- Déjà abonné ? On lit avant d'écrire. ------------------------ */
  let entry = null;
  try {
    const { data } = await withRetry(
      () => calendarAsUser.calendarList.get({ calendarId, fields: CALENDAR_LIST_ENTRY_FIELDS }),
      { tries: 2, propagation: false, label: `vérification de l'agenda de ${userEmail}` },
    );
    entry = data ?? null;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  if (entry) {
    const visible = entry.selected === true && entry.hidden !== true;
    if (visible) {
      log.skip(`${userEmail} : « ${summary} » est déjà dans son Agenda et affiché.`);
      return { status: 'already', detail: userEmail };
    }
    // Présent mais décoché ou masqué : les événements n'apparaissent pas dans
    // la grille. C'est le piège classique — on force l'état voulu.
    await withRetry(
      () =>
        calendarAsUser.calendarList.patch({
          calendarId,
          requestBody: { selected: true, hidden: false },
          fields: CALENDAR_LIST_ENTRY_FIELDS,
        }),
      { tries: 4, propagation: false, label: `affichage de « ${summary} » chez ${userEmail}` },
    );
    log.ok(`${userEmail} : « ${summary} » était présent mais décoché — il est maintenant affiché.`);
    return { status: 'updated', detail: userEmail };
  }

  /* --- Pas encore abonné : on l'ajoute ----------------------------- */
  try {
    await withRetry(
      () =>
        calendarAsUser.calendarList.insert({
          requestBody: {
            id: calendarId,
            // selected vaut false par défaut : sans ce true, le calendrier
            // apparaît dans la barre latérale mais DÉCOCHÉ, donc invisible.
            selected: true,
            hidden: false,
          },
          fields: CALENDAR_LIST_ENTRY_FIELDS,
        }),
      {
        // propagation: true — juste après l'ACL, Google peut encore répondre
        // 404 « ce calendrier n'existe pas pour vous ». C'est temporaire.
        tries: 6,
        propagation: true,
        label: `ajout de « ${summary} » dans l'Agenda de ${userEmail}`,
      },
    );
    log.ok(`${userEmail} : « ${summary} » ajouté à son Google Agenda, coché et visible.`);
    return { status: 'inserted', detail: userEmail };
  } catch (error) {
    // Un doublon signifie que l'entrée est apparue entre-temps : on force
    // seulement son affichage, et c'est un succès.
    if (isConflict(error)) {
      await withRetry(
        () =>
          calendarAsUser.calendarList.patch({
            calendarId,
            requestBody: { selected: true, hidden: false },
            fields: CALENDAR_LIST_ENTRY_FIELDS,
          }),
        { tries: 4, propagation: false, label: `affichage de « ${summary} » chez ${userEmail}` },
      );
      log.ok(`${userEmail} : « ${summary} » était déjà là — affichage confirmé.`);
      return { status: 'updated', detail: userEmail };
    }
    throw error;
  }
}

/**
 * Abonne toute l'équipe, une personne à la fois. L'échec d'une personne
 * n'interrompt jamais les autres : on note un avertissement et on continue.
 */
async function subscribeTeam({ config, audience, calendarId, summary, apply, log, warnings }) {
  const result = { inserted: [], updated: [], already: [], failed: [] };

  for (const userEmail of audience) {
    if (!apply) {
      log.plan(`Ajouter « ${summary} » directement dans le Google Agenda de ${userEmail} (coché, visible).`);
      result.inserted.push(userEmail);
      continue;
    }

    try {
      const outcome = await subscribeUser({ config, userEmail, calendarId, summary, log });
      if (outcome.status === 'inserted') result.inserted.push(outcome.detail);
      else if (outcome.status === 'updated') result.updated.push(outcome.detail);
      else result.already.push(outcome.detail);
    } catch (error) {
      const context = `ajout de « ${summary} » dans l'Agenda de ${userEmail}`;
      const info = errorInfo(error);
      log.err(explain(error, context));

      let hint;
      if (info.status === 404) {
        hint =
          `${userEmail} n'a pas encore « vu » le calendrier au moment de l'ajout. Le partage vient ` +
          'peut-être tout juste d\'être accordé : relancer la commande dans quelques minutes suffit ' +
          'généralement.';
      } else if (info.status === 403) {
        hint =
          `Google refuse d'agir au nom de ${userEmail}. Vérifier que ce compte existe, n'est pas ` +
          'suspendu, appartient bien au domaine, et que la délégation à l\'échelle du domaine ' +
          'inclut la portée « https://www.googleapis.com/auth/calendar » (copie exacte, sans espace).';
      } else {
        hint = `Ajout impossible pour ${userEmail}. ${info.message}`;
      }

      log.warn(
        `${hint} En attendant, ${userEmail} peut ajouter le calendrier à la main : ` +
          'Google Agenda > « Autres agendas » > + > S\'abonner à un agenda.',
      );
      warnings.push(`${context} : échec. ${hint}`);
      result.failed.push(userEmail);
    }

    await sleep(SUBSCRIBE_DELAY_MS);
  }

  return result;
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

  const specs = Array.isArray(config?.calendars) ? config.calendars : [];
  if (specs.length === 0) {
    log.info(
      'Aucun calendrier n\'est décrit dans config.json (champ « calendars ») : cette étape n\'a rien à faire.',
    );
    log.info(
      'Pour en ajouter un : { "key": "equipe", "summary": "Équipe", "timeZone": "America/Toronto", "role": "writer" }.',
    );
    return { created, updated, unchanged, warnings };
  }

  const mode = config?.auth?.mode ?? 'service-account';
  const canImpersonate = mode === 'service-account';

  /* --- Qui doit voir les calendriers ? ----------------------------- */
  // L'équipe, plus le compte administrateur s'il n'en fait pas partie : c'est
  // lui le propriétaire, autant que le calendrier soit coché chez lui aussi.
  const audience = [];
  const seen = new Set();
  for (const email of [...(config.team ?? []).map((m) => m?.email), config.adminEmail]) {
    const clean = typeof email === 'string' ? email.trim() : '';
    if (clean === '' || seen.has(lower(clean))) continue;
    seen.add(lower(clean));
    audience.push(clean);
  }

  log.step('Calendriers partagés');
  log.info(
    `${specs.length} calendrier(s) à mettre en place, propriétaire : ${config.adminEmail}. ` +
      `${audience.length} personne(s) doivent les voir.`,
  );
  if (config.group?.email) {
    log.info(
      `L'accès sera accordé au groupe ${config.group.email} plutôt qu'à chaque adresse : quand quelqu'un ` +
        'arrive ou part, il suffira de modifier le groupe et les calendriers suivront tout seuls.',
    );
  } else {
    log.info(
      "Aucun groupe n'est configuré : l'accès sera accordé directement à chacune des adresses de l'équipe.",
    );
  }

  /* --- Avertissement de mode --------------------------------------- */
  if (!canImpersonate) {
    const message =
      'Mode OAuth : la trousse ne peut PAS ajouter le calendrier dans le Google Agenda de chaque ' +
      'personne à sa place. Chacun recevra un courriel d\'invitation et devra cliquer dessus pour ' +
      'voir le calendrier apparaître. Le mode « compte de service » (config.json > auth.mode) évite ' +
      'complètement cette étape : il permet d\'agir au nom de chaque personne et le calendrier est ' +
      'déjà là à sa première ouverture.';
    log.warn(message);
    warnings.push(message);
  }

  /* --- Client du propriétaire -------------------------------------- */
  const { calendar: calendarApi } = await getClients({
    config,
    subject: config.adminEmail,
    scopes: CALENDAR_SCOPES,
  });

  /** @type {Array<Record<string, string>>} */
  const recap = [];

  for (const spec of specs) {
    log.step(`Calendrier « ${spec.summary} »`);

    /* --- 1. Le calendrier lui-même --------------------------------- */
    let ensured;
    try {
      ensured = await ensureCalendar({ calendarApi, spec, state, apply, log, warnings });
    } catch (error) {
      const context = `création du calendrier « ${spec.summary} »`;
      log.err(explain(error, context));
      warnings.push(`${context} : échec. ${errorInfo(error).message}`);
      recap.push({
        Calendrier: spec.summary,
        Identifiant: '(échec)',
        'Accès accordé à': '—',
        Rôle: spec.role,
        'Ajouté à leur Agenda': 'non',
      });
      continue; // on passe au calendrier suivant : un échec n'arrête pas tout
    }

    if (ensured.action === 'created') created.push(`Calendrier « ${spec.summary} » (${ensured.id})`);

    /* --- 2. Description et fuseau horaire -------------------------- */
    if (ensured.action === 'reused') {
      try {
        const changes = await syncCalendarFields({ calendarApi, calendar: ensured.calendar, spec, apply, log });
        if (changes.length > 0) updated.push(`Calendrier « ${spec.summary} » : ${changes.join(', ')}`);
        else unchanged.push(`Calendrier « ${spec.summary} »`);
      } catch (error) {
        const context = `mise à jour du calendrier « ${spec.summary} »`;
        log.warn(explain(error, context));
        warnings.push(`${context} : ${errorInfo(error).message}`);
      }
    }

    /* --- 3. Les partages ------------------------------------------- */
    const desired = buildDesiredAcl(config, spec);
    if (desired.length === 0) {
      const message =
        `Aucune personne ni aucun groupe à qui partager « ${spec.summary} » : la liste « team » est vide ` +
        'et aucun groupe n\'est configuré dans config.json.';
      log.warn(message);
      warnings.push(message);
    }

    let aclResult = { granted: [], adjusted: [], already: [], failed: [] };
    if (desired.length > 0) {
      try {
        aclResult = await reconcileAcl({
          calendarApi,
          calendarId: ensured.id,
          spec,
          desired,
          config,
          apply,
          log,
          warnings,
        });
      } catch (error) {
        const context = `partage du calendrier « ${spec.summary} »`;
        log.err(explain(error, context));
        warnings.push(`${context} : échec. ${errorInfo(error).message}`);
      }
    }

    for (const item of aclResult.granted) created.push(`Partage de « ${spec.summary} » avec ${item}`);
    for (const item of aclResult.adjusted) updated.push(`Partage de « ${spec.summary} » : ${item}`);
    for (const item of aclResult.already) unchanged.push(`Partage de « ${spec.summary} » avec ${item}`);

    /* --- 4. L'abonnement automatique ------------------------------- */
    let subResult = { inserted: [], updated: [], already: [], failed: [] };

    if (!canImpersonate) {
      log.info(
        `Étape sautée en mode OAuth : chaque personne devra accepter l'invitation reçue par courriel ` +
          `pour voir « ${spec.summary} » dans son Agenda.`,
      );
    } else if (audience.length === 0) {
      log.info("Personne à abonner : la liste « team » est vide dans config.json.");
    } else if (!ensured.id && !apply) {
      // Simulation d'un calendrier qui n'existe pas encore : on annonce quand même.
      for (const email of audience) {
        log.plan(`Ajouter « ${spec.summary} » directement dans le Google Agenda de ${email} (coché, visible).`);
        subResult.inserted.push(email);
      }
    } else if (!ensured.id) {
      log.warn(`Calendrier « ${spec.summary} » sans identifiant : abonnement impossible.`);
    } else {
      log.info(
        `Ajout de « ${spec.summary} » dans le Google Agenda de chaque personne — aucun courriel ` +
          'à accepter, le calendrier sera simplement là.',
      );
      subResult = await subscribeTeam({
        config,
        audience,
        calendarId: ensured.id,
        summary: spec.summary,
        apply,
        log,
        warnings,
      });
    }

    for (const item of subResult.inserted) created.push(`« ${spec.summary} » ajouté dans l'Agenda de ${item}`);
    for (const item of subResult.updated) updated.push(`« ${spec.summary} » réaffiché dans l'Agenda de ${item}`);
    for (const item of subResult.already) unchanged.push(`« ${spec.summary} » déjà dans l'Agenda de ${item}`);

    /* --- 5. Ligne de récapitulatif --------------------------------- */
    const acces = config.group?.email
      ? `${config.group.email} (groupe)`
      : desired.map((d) => d.value).join(', ') || '—';

    let abonnes;
    if (!canImpersonate) abonnes = 'non — invitation par courriel';
    else if (!apply) abonnes = `à faire pour ${audience.length} personne(s)`;
    else {
      const okCount = subResult.inserted.length + subResult.updated.length + subResult.already.length;
      abonnes = subResult.failed.length > 0 ? `${okCount}/${audience.length} (échecs : ${subResult.failed.join(', ')})` : `oui — ${okCount}/${audience.length}`;
    }

    recap.push({
      Calendrier: spec.summary,
      Identifiant: ensured.id ?? PLANNED_ID,
      'Accès accordé à': acces,
      Rôle: `${spec.role} — ${roleLabel(spec.role)}`,
      'Ajouté à leur Agenda': abonnes,
    });
  }

  /* --- Récapitulatif ------------------------------------------------ */
  log.step('Récapitulatif des calendriers');
  log.table(recap);

  if (apply && canImpersonate) {
    log.info(
      'Rien à faire pour l\'équipe : le calendrier apparaît déjà dans leur Google Agenda. ' +
        'Un rafraîchissement de la page suffit si quelqu\'un l\'avait ouvert avant.',
    );
  } else if (apply) {
    log.info(
      'Chaque personne doit maintenant ouvrir le courriel d\'invitation reçu de Google et cliquer ' +
        'sur « Ajouter cet agenda ».',
    );
  } else {
    log.plan('Rien n\'a été modifié. Relance avec --apply pour créer et partager pour de vrai.');
  }

  return { created, updated, unchanged, warnings };
}

export default { meta, run };
