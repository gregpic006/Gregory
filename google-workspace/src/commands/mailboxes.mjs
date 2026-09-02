/**
 * Commande « mailboxes » — les boîtes de courriel partagées (info@, ventes@…).
 *
 * ─── Pourquoi une boîte partagée plutôt qu'un compte ? ──────────────────────
 * On pourrait créer un 5e usager `info@leaselane.ca` et se passer son mot de
 * passe entre collègues. C'est ce que font beaucoup de PME, et c'est une
 * mauvaise idée : ça coûte une licence par mois, personne ne sait qui a répondu
 * quoi, et le jour où quelqu'un part il faut changer le mot de passe partout.
 *
 * Un GROUPE Google fait mieux, gratuitement : le courriel envoyé à `info@`
 * arrive dans la boîte de chaque membre, chacun répond avec SON compte, et
 * ajouter ou retirer quelqu'un est une seule opération.
 *
 * ─── Les deux réglages qui font échouer un « info@ » ────────────────────────
 * 1. `whoCanPostMessage` — par défaut, un groupe REFUSE les messages venant de
 *    l'extérieur du domaine. Une adresse de contact publique doit être en
 *    `ANYONE_CAN_POST`, sinon les courriels des clients rebondissent et
 *    personne ne s'en aperçoit avant d'avoir perdu des demandes.
 * 2. `messageModerationLevel` — la doc de Google recommande `MODERATE_NON_MEMBERS`
 *    quand on ouvre à tous. Ce conseil vise les forums de discussion publics :
 *    appliqué à une adresse de contact, il met CHAQUE courriel de client dans
 *    une file d'attente à approuver à la main. On prend donc `MODERATE_NONE`,
 *    en s'appuyant sur `spamModerationLevel: MODERATE` pour le pourriel. C'est
 *    un choix délibéré, pas un oubli.
 *
 * ─── La boîte collaborative ────────────────────────────────────────────────
 * `enableCollaborativeInbox` ajoute au groupe ce qu'un logiciel de billetterie
 * offre : s'assigner une demande, la marquer réglée, ou « aucune réponse
 * nécessaire ». C'est ce qui évite que deux personnes répondent au même client
 * sans le savoir.
 */

import { getClients, explainGoogleError, isConflict } from '../lib/google.mjs';
import {
  GROUP_SCOPES,
  normalizeEmail,
  findGroup,
  syncGroupSettings,
  listGroupMembers,
  syncMembers,
} from './group.mjs';

export const meta = {
  name: 'mailboxes',
  summary:
    'Crée les boîtes de courriel partagées (info@, etc.), ouvertes aux courriels de ' +
    "l'extérieur, avec assignation des demandes pour éviter le travail en double.",
};

/**
 * Réglages appliqués à une boîte partagée, avec le POURQUOI de chacun : ces
 * explications s'affichent dans le plan, pour que la personne qui lance la
 * commande comprenne ce qu'elle change plutôt que de voir défiler des noms
 * d'API.
 *
 * Toutes les valeurs de cette API sont des CHAÎNES, y compris les booléens
 * (`"true"`, pas `true`) — un vrai booléen se fait rejeter.
 */
function desiredSettings() {
  return [
    {
      key: 'whoCanPostMessage',
      value: 'ANYONE_CAN_POST',
      why: "N'importe qui sur Internet peut écrire à cette adresse. Indispensable pour une "
        + 'adresse de contact : sans ça, les courriels de tes clients rebondissent.',
    },
    {
      key: 'messageModerationLevel',
      value: 'MODERATE_NONE',
      why: 'Les courriels arrivent directement, sans file d\'attente à approuver. '
        + 'Le pourriel est filtré par le réglage suivant.',
    },
    {
      key: 'spamModerationLevel',
      value: 'MODERATE',
      why: 'Le pourriel est mis de côté au lieu d\'être livré.',
    },
    {
      key: 'enableCollaborativeInbox',
      value: 'true',
      why: 'Chaque demande peut être assignée à quelqu\'un et marquée réglée. '
        + "C'est ce qui empêche deux personnes de répondre au même client.",
    },
    {
      key: 'whoCanAssignTopics',
      value: 'ALL_MEMBERS',
      why: 'Toute l\'équipe peut s\'assigner une demande, pas seulement les gestionnaires.',
    },
    {
      key: 'whoCanMarkNoResponseNeeded',
      value: 'ALL_MEMBERS',
      why: 'Toute l\'équipe peut classer une demande sans suite (pub, erreur d\'adresse).',
    },
    {
      key: 'membersCanPostAsTheGroup',
      value: 'true',
      why: 'Les réponses partent au nom de l\'adresse partagée plutôt que de l\'adresse '
        + 'personnelle. Le client voit une seule adresse, du début à la fin.',
    },
    {
      key: 'replyTo',
      value: 'REPLY_TO_LIST',
      why: 'Quand un client répond, sa réponse revient à toute l\'équipe — pas seulement '
        + 'à la personne qui a écrit en dernier.',
    },
    {
      key: 'allowExternalMembers',
      value: 'false',
      why: 'Seuls des comptes du domaine peuvent être MEMBRES. À ne pas confondre avec le '
        + 'premier réglage : les gens de l\'extérieur peuvent écrire, pas lire la boîte.',
    },
    {
      key: 'whoCanJoin',
      value: 'INVITED_CAN_JOIN',
      why: 'On ne s\'ajoute pas soi-même à la boîte partagée.',
    },
    {
      key: 'whoCanViewGroup',
      value: 'ALL_MEMBERS_CAN_VIEW',
      why: 'Seuls les membres lisent les demandes reçues.',
    },
    {
      key: 'whoCanViewMembership',
      value: 'ALL_MEMBERS_CAN_VIEW',
      why: 'Les membres voient qui d\'autre est dans la boîte.',
    },
    {
      key: 'whoCanDiscoverGroup',
      value: 'ALL_IN_DOMAIN_CAN_DISCOVER',
      why: 'L\'adresse est visible dans l\'annuaire interne, pratique pour l\'équipe.',
    },
    {
      key: 'whoCanModerateContent',
      value: 'OWNERS_AND_MANAGERS',
      why: 'Seuls les responsables gèrent la file de pourriel.',
    },
    {
      key: 'includeInGlobalAddressList',
      value: 'true',
      why: "L'adresse apparaît dans l'auto-complétion de Gmail pour l'équipe.",
    },
  ];
}

/**
 * @param {object} params
 * @param {object} params.config configuration validée
 * @param {boolean} params.apply false = simulation (défaut)
 * @param {object} params.state cache local (non utilisé ici : rien à mettre en cache)
 * @param {string} [params.configPath]
 * @param {object} params.log
 * @returns {Promise<{created: object[], updated: object[], unchanged: object[], warnings: string[]}>}
 */
export async function run({ config, apply = false, state = {}, configPath = './config.json', log }) {
  void state; // aucune ressource dont l'identifiant vaudrait la peine d'être caché.

  /** @type {{created: object[], updated: object[], unchanged: object[], warnings: string[]}} */
  const summary = { created: [], updated: [], unchanged: [], warnings: [] };

  const boites = Array.isArray(config.sharedMailboxes) ? config.sharedMailboxes : [];

  if (boites.length === 0) {
    log.step('Aucune boîte de courriel partagée à créer.');
    log.info(
      'Le champ « sharedMailboxes » de config.json est vide. C\'est un choix valide.\n' +
        'Pour en ajouter une, mets dans config.json :\n' +
        '  "sharedMailboxes": [\n' +
        `    { "email": "info@${config.domain}", "name": "Info — ${config.domain}",\n` +
        '      "description": "Adresse de contact publique." }\n' +
        '  ]\n' +
        'puis relance « node src/cli.mjs mailboxes --apply ».',
    );
    log.skip('Rien à faire pour la commande « mailboxes ».');
    return summary;
  }

  log.step(`${boites.length} boîte(s) de courriel partagée(s) à mettre en place`);
  log.info(
    'Une boîte partagée est un groupe Google, pas un compte : aucune licence à payer, ' +
      'aucun mot de passe à se passer entre collègues. Chaque membre reçoit les courriels ' +
      'dans sa propre boîte et répond avec son propre compte.',
  );

  const { admin, groupsSettings } = await getClients({ config, scopes: GROUP_SCOPES });

  for (const [i, boite] of boites.entries()) {
    const email = normalizeEmail(boite.email);
    const nom = boite.name ?? email;
    const description = boite.description ?? '';

    log.step(`${i + 1}/${boites.length} — ${nom} <${email}>`);

    /* --- La boîte existe-t-elle déjà ? -------------------------------- */
    let groupe = await findGroup(admin, email);
    let vientDEtreCree = false;

    if (!groupe) {
      if (!apply) {
        log.plan(`À créer : boîte partagée ${email}`);
        summary.created.push({ quoi: `Boîte partagée ${email}` });
      } else {
        try {
          const res = await admin.groups.insert({
            requestBody: { email, name: nom, description },
          });
          groupe = res?.data ?? null;
          vientDEtreCree = true;
          log.ok(`Boîte partagée créée : ${email}`);
          summary.created.push({ quoi: `Boîte partagée ${email}` });
        } catch (e) {
          // Une création concurrente, ou un alias déjà pris par un autre groupe.
          if (isConflict(e)) {
            groupe = await findGroup(admin, email, { propagation: true });
            if (groupe) {
              log.skip(`La boîte ${email} existait déjà.`);
              summary.unchanged.push({ quoi: `Boîte partagée ${email}` });
            } else {
              summary.warnings.push(
                `L'adresse ${email} est déjà prise chez Google mais introuvable comme groupe. ` +
                  "C'est peut-être un compte d'usager, ou un alias. Vérifie dans " +
                  'admin.google.com > Répertoire, et choisis une autre adresse au besoin.',
              );
              log.warn(summary.warnings.at(-1));
              continue;
            }
          } else {
            summary.warnings.push(`Création de ${email} impossible : ${explainGoogleError(e)}`);
            log.warn(summary.warnings.at(-1));
            continue;
          }
        }
      }
    } else {
      log.skip(`La boîte ${email} existe déjà.`);
      summary.unchanged.push({ quoi: `Boîte partagée ${email}` });
    }

    /* --- Les réglages -------------------------------------------------- */
    // En simulation, le groupe n'existe pas encore : les réglages ne sont pas
    // lisibles, on affiche seulement l'intention.
    if (!apply && !groupe) {
      log.plan(
        `À régler : ${email} ouverte aux courriels de l'extérieur, avec assignation ` +
          'des demandes (boîte collaborative).',
      );
      summary.updated.push({ quoi: `Réglages de ${email}` });
    } else {
      const reglages = await syncGroupSettings({
        groupsSettings,
        groupEmail: email,
        desired: desiredSettings(),
        apply,
        groupJustCreated: vientDEtreCree,
        log,
      });
      if (reglages.changed.length > 0) summary.updated.push({ quoi: `Réglages de ${email}` });
      summary.warnings.push(...reglages.warnings);

      // Le contrôle qui compte vraiment : si les messages de l'extérieur sont
      // refusés, l'adresse est inutilisable comme contact public — et rien ne
      // le signalerait autrement qu'un client qui se plaint de ne pas avoir de
      // réponse.
      const ouvert = reglages.current?.whoCanPostMessage;
      if (apply && ouvert && ouvert !== 'ANYONE_CAN_POST') {
        summary.warnings.push(
          `${email} n'accepte PAS les courriels de l'extérieur (réglage actuel : ${ouvert}). ` +
            'Les messages de tes clients vont rebondir. À corriger dans ' +
            `groups.google.com > ${email} > Paramètres du groupe > Qui peut publier.`,
        );
        log.warn(summary.warnings.at(-1));
      }
    }

    /* --- Les membres --------------------------------------------------- */
    const existants = apply && groupe ? await listGroupMembers(admin, email) : [];
    const membres = await syncMembers({
      admin,
      groupEmail: email,
      team: config.team,
      existing: existants,
      apply,
      groupJustCreated: vientDEtreCree || !groupe,
      personalEmail: config.personalEmail,
      adminEmail: config.adminEmail,
      configFile: configPath,
      membersReadable: Boolean(apply && groupe),
      log,
    });
    summary.created.push(...membres.created);
    summary.updated.push(...membres.updated);
    summary.unchanged.push(...membres.unchanged);
    summary.warnings.push(...membres.warnings);

    if (apply && groupe) {
      log.ok(
        `${email} est prête. Écris-lui de l'extérieur pour tester : le message doit arriver ` +
          `dans la boîte des ${config.team.length} membres.`,
      );
    }
  }

  /* --- Ce que la trousse ne peut pas faire à ta place ------------------ */
  log.step('À savoir avant de publier cette adresse');
  log.info(
    "1. Teste-la pour vrai : envoie un courriel depuis une adresse HORS du domaine (ton\n" +
      '   Gmail perso fait très bien l\'affaire) et vérifie qu\'il arrive chez tout le monde.\n' +
      '   Un groupe mal réglé rebondit en silence — tu ne perds pas un courriel, tu perds un client.\n' +
      '2. Pour voir les demandes assignées et les marquer réglées, c\'est groups.google.com,\n' +
      '   pas Gmail. Gmail livre les messages ; l\'assignation vit dans Groupes.\n' +
      '3. Mets cette adresse sur le site et dans les signatures — pas une adresse personnelle.\n' +
      "   Le jour où quelqu'un part, rien ne se perd.",
  );

  return summary;
}
