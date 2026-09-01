/**
 * auth.mjs — Obtention d'un client authentifié Google.
 *
 * C'est le module où 90 % des blocages arrivent. Il est donc écrit avec une
 * obsession : quand ça échoue, dire EXACTEMENT quoi corriger et où, avec le
 * texte à copier-coller (identifiant client numérique, liste de portées).
 *
 * Deux modes :
 *
 *   "service-account" — compte de service + délégation à l'échelle du domaine.
 *       Le compte de service n'est pas un utilisateur Workspace : il n'existe
 *       pas dans l'annuaire et ne peut pas être administrateur. Son seul
 *       pouvoir vient de la délégation autorisée par un super-admin, plus
 *       l'identité qu'il emprunte (le « subject »). Tourne sans humain.
 *
 *   "oauth" — client OAuth de type « Application de bureau ». Le script ouvre
 *       le navigateur, l'administrateur se connecte une fois, le jeton de
 *       rafraîchissement est mis en cache. Aucune clé privée sur disque.
 *
 * Aucune dépendance hors googleapis.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { google } from 'googleapis';
import log from './log.mjs';

/* ------------------------------------------------------------------ */
/* Portées                                                             */
/* ------------------------------------------------------------------ */

/**
 * Portées OAuth regroupées par domaine fonctionnel.
 *
 * ATTENTION : la délégation à l'échelle du domaine exige une correspondance
 * EXACTE, caractère par caractère. Demander « admin.directory.user » alors que
 * la console n'autorise que « admin.directory.user.readonly » échoue avec
 * unauthorized_client. C'est la cause numéro un des blocages.
 *
 * Toujours coller dans la console la liste générée par ce fichier
 * (commande « portail scopes »), jamais une liste retapée à la main.
 */
export const SCOPES = Object.freeze({
  /** Annuaire : créer et lire les utilisateurs, gérer les groupes et leurs membres. */
  directory: Object.freeze([
    'https://www.googleapis.com/auth/admin.directory.user',
    'https://www.googleapis.com/auth/admin.directory.group',
    'https://www.googleapis.com/auth/admin.directory.group.member',
  ]),
  /** Réglages de groupe : qui peut publier, qui peut voir les archives, etc. */
  groups: Object.freeze(['https://www.googleapis.com/auth/apps.groups.settings']),
  /** Calendriers : création des agendas partagés et de leurs partages (ACL). */
  calendar: Object.freeze(['https://www.googleapis.com/auth/calendar']),
  /** Drive : création du Drive partagé, de ses dossiers et de ses membres. */
  drive: Object.freeze(['https://www.googleapis.com/auth/drive']),
});

/** Toutes les portées, dédupliquées, dans un ordre stable. */
export const ALL_SCOPES = Object.freeze([...new Set(Object.values(SCOPES).flat())]);

/** Portées demandées en plus en mode OAuth, pour vérifier qui s'est connecté. */
const OAUTH_IDENTITY_SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email'];

/**
 * Met la liste de portées au format attendu par la console d'administration :
 * séparées par des virgules, sans espace.
 * @param {string[]} [scopes]
 * @returns {string}
 */
export function formatScopeList(scopes = ALL_SCOPES) {
  return [...new Set(scopes)].join(',');
}

/**
 * Texte d'instructions pour autoriser la délégation à l'échelle du domaine.
 * Utilisé tel quel dans les messages d'erreur : c'est ce que l'admin doit faire.
 *
 * @param {{ clientId?: string|null, scopes?: string[], serviceAccountEmail?: string|null }} params
 * @returns {string}
 */
export function delegationInstructions({ clientId = null, scopes = ALL_SCOPES, serviceAccountEmail = null } = {}) {
  return [
    'Autoriser le compte de service dans la console d\'administration Google :',
    '',
    '  1. Aller sur https://admin.google.com/ac/owl/domainwidedelegation',
    '     (chemin manuel : Menu > Sécurité > Contrôle des accès et des données >',
    '      Commandes des API > Délégation à l\'échelle du domaine > Gérer > Ajouter)',
    '',
    '  2. Coller CET identifiant client (le nombre à 21 chiffres, PAS le courriel) :',
    '',
    `        ${clientId ?? '(introuvable dans le fichier de clé — champ "client_id")'}`,
    '',
    serviceAccountEmail
      ? `     (pour information, le courriel du compte de service est ${serviceAccountEmail} —\n      ce n'est PAS ce qu'il faut coller dans le champ « ID client »)\n`
      : null,
    '  3. Coller CETTE liste de portées, telle quelle, en une seule ligne :',
    '',
    `        ${formatScopeList(scopes)}`,
    '',
    '  4. Enregistrer, puis attendre de 1 à 10 minutes (propagation chez Google).',
    '',
    'Deux pièges fréquents :',
    '  - La correspondance des portées est EXACTE. Une portée en trop côté code,',
    '    ou une portée « .readonly » côté console, et Google refuse tout.',
    '  - Sur certains domaines, une modification de la délégation exige',
    '    l\'approbation d\'un DEUXIÈME super-administrateur. Si l\'ajout reste',
    '    « en attente », c\'est ça — ce n\'est pas un bogue.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Erreurs                                                             */
/* ------------------------------------------------------------------ */

/** Erreur d'authentification : le message est déjà rédigé pour un humain. */
export class AuthError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = details.code ?? 'AUTH_FAILED';
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

/* ------------------------------------------------------------------ */
/* Utilitaires internes                                                */
/* ------------------------------------------------------------------ */

/** Développe `~` et rend un chemin absolu par rapport au dossier du config.json. */
function resolveFromConfig(config, filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return null;
  let p = filePath.trim();
  if (p === '~') p = homedir();
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  const base = config?.__configDir ?? process.cwd();
  return isAbsolute(p) ? p : resolve(base, p);
}

/** Chemin du fichier de clé du compte de service. */
function keyFilePath(config) {
  return config?.auth?.resolved?.keyFile ?? resolveFromConfig(config, config?.auth?.keyFile);
}

/** Chemin du fichier de client OAuth. */
function oauthClientPath(config) {
  return config?.auth?.resolved?.oauthClientFile ?? resolveFromConfig(config, config?.auth?.oauthClientFile);
}

/** Chemin du cache de jetons OAuth. */
function tokenFilePath(config) {
  return config?.auth?.resolved?.tokenFile ?? resolveFromConfig(config, config?.auth?.tokenFile);
}

/** Lit et analyse un fichier JSON, avec un message français si ça tourne mal. */
function readJsonFile(path, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new AuthError(
      `Impossible de lire ${label} : ${path}\nDétail : ${e.message}\n` +
        'Quoi faire : vérifier que le fichier existe et qu\'il est lisible.',
      { code: 'AUTH_FILE_UNREADABLE', cause: e },
    );
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new AuthError(
      `${label} n'est pas du JSON valide : ${path}\nDétail : ${e.message}\n` +
        'Quoi faire : re-télécharger le fichier depuis la console Google Cloud sans le modifier.',
      { code: 'AUTH_FILE_INVALID', cause: e },
    );
  }
}

/**
 * Extrait le code d'erreur normalisé d'une erreur googleapis / gaxios.
 * Le point de terminaison de jetons renvoie { error, error_description } ;
 * les API renvoient { error: { code, message, errors:[...] } }.
 * @param {unknown} e
 * @returns {{ code: string|null, description: string, status: number|null }}
 */
function tokenErrorInfo(e) {
  let data = e?.response?.data ?? e?.data ?? null;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      /* on garde la chaîne brute */
    }
  }

  let code = null;
  let description = '';

  if (data && typeof data === 'object') {
    if (typeof data.error === 'string') code = data.error;
    else if (data.error && typeof data.error === 'object') code = data.error.status ?? data.error.code ?? null;
    description = data.error_description ?? (typeof data.error === 'object' ? data.error?.message : '') ?? '';
  }

  const message = String(e?.message ?? '');
  if (!code) {
    for (const known of ['unauthorized_client', 'invalid_grant', 'invalid_client', 'invalid_scope', 'access_denied', 'invalid_request']) {
      if (message.includes(known)) {
        code = known;
        break;
      }
    }
  }

  const status = e?.response?.status ?? (typeof e?.code === 'number' ? e.code : null);
  return { code: code ? String(code) : null, description: String(description || message), status };
}

/** Décode la charge utile d'un id_token JWT sans vérifier la signature. */
function decodeIdToken(idToken) {
  try {
    const payload = String(idToken).split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Ouvre une URL dans le navigateur par défaut. Silencieux si ça ne marche pas. */
function openBrowser(url) {
  if (process.env.PORTAIL_NO_BROWSER) return false;
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Mode « compte de service »                                          */
/* ------------------------------------------------------------------ */

/**
 * Charge et valide le fichier de clé du compte de service.
 * @param {object} config
 * @returns {{ client_email: string, private_key: string, client_id: string|null, path: string }}
 */
function loadServiceAccountKey(config) {
  const path = keyFilePath(config);

  if (!path) {
    throw new AuthError(
      'Aucun fichier de clé de compte de service n\'est configuré.\n' +
        'Quoi faire : renseigner "auth": { "keyFile": "./service-account.json" } dans config.json.',
      { code: 'AUTH_KEYFILE_MISSING' },
    );
  }

  if (!existsSync(path)) {
    throw new AuthError(
      [
        `Fichier de clé du compte de service introuvable : ${path}`,
        '',
        'Quoi faire — créer la clé (une seule fois) :',
        '  1. https://console.cloud.google.com/iam-admin/serviceaccounts',
        '  2. Choisir le projet, puis « Créer un compte de service »',
        '     (aucun rôle IAM n\'est nécessaire : un compte de service ne tire pas',
        '      son pouvoir d\'un rôle Cloud, mais de la délégation Workspace).',
        '  3. Onglet « Clés » > Ajouter une clé > Créer une clé > JSON',
        `  4. Déposer le fichier téléchargé ici : ${path}`,
        '',
        'Ce fichier est un secret : il ne doit jamais être versionné ni envoyé par courriel.',
        'Le .gitignore de la trousse l\'exclut déjà.',
        '',
        'Alternative sans clé privée sur disque : passer en mode OAuth,',
        'avec "auth": { "mode": "oauth" } dans config.json.',
      ].join('\n'),
      { code: 'AUTH_KEYFILE_NOT_FOUND' },
    );
  }

  const key = readJsonFile(path, 'Le fichier de clé du compte de service');

  if (key.installed || key.web) {
    throw new AuthError(
      [
        `Le fichier ${path} est un client OAuth, pas une clé de compte de service.`,
        '',
        'Deux fichiers différents se ressemblent :',
        '  - clé de compte de service : contient "type": "service_account" et "private_key"',
        '  - client OAuth             : contient "installed" ou "web"',
        '',
        'Quoi faire, au choix :',
        '  a) mettre ce fichier dans "auth": { "oauthClientFile": ... } et passer',
        '     "auth": { "mode": "oauth" } ; ou',
        '  b) télécharger une vraie clé de compte de service (console Cloud >',
        '     IAM et administration > Comptes de service > Clés > JSON).',
      ].join('\n'),
      { code: 'AUTH_KEYFILE_WRONG_TYPE' },
    );
  }

  if (key.type !== 'service_account') {
    throw new AuthError(
      `Le fichier ${path} n'est pas une clé de compte de service ` +
        `(champ "type" = ${JSON.stringify(key.type ?? null)}, attendu "service_account").\n` +
        'Quoi faire : re-télécharger la clé depuis Console Cloud > IAM et administration >\n' +
        'Comptes de service > (le compte) > Clés > Ajouter une clé > JSON.',
      { code: 'AUTH_KEYFILE_WRONG_TYPE' },
    );
  }

  const missing = ['client_email', 'private_key'].filter((f) => typeof key[f] !== 'string' || key[f].trim() === '');
  if (missing.length > 0) {
    throw new AuthError(
      `Le fichier de clé ${path} est incomplet : il manque ${missing.map((m) => `"${m}"`).join(' et ')}.\n` +
        'Quoi faire : re-télécharger une clé JSON complète depuis la console Cloud.',
      { code: 'AUTH_KEYFILE_INCOMPLETE' },
    );
  }

  // Piège classique en intégration continue : la clé est passée par une variable
  // d'environnement et les sauts de ligne sont restés littéraux (\n en deux
  // caractères). Sans cette correction : « invalid_grant / Invalid JWT Signature ».
  const privateKey = key.private_key.includes('\\n') && !key.private_key.includes('\n')
    ? key.private_key.replace(/\\n/g, '\n')
    : key.private_key;

  if (!privateKey.includes('BEGIN') || !privateKey.includes('PRIVATE KEY')) {
    throw new AuthError(
      `La clé privée contenue dans ${path} est malformée (elle ne ressemble pas à un bloc PEM).\n` +
        'Quoi faire : re-télécharger la clé JSON sans l\'ouvrir ni la réenregistrer dans un\n' +
        'éditeur qui reformate le texte.',
      { code: 'AUTH_KEY_MALFORMED' },
    );
  }

  return {
    client_email: key.client_email.trim(),
    private_key: privateKey,
    private_key_id: typeof key.private_key_id === 'string' ? key.private_key_id : undefined,
    client_id: typeof key.client_id === 'string' ? key.client_id : null,
    path,
  };
}

/**
 * Transforme un échec d'obtention de jeton en diagnostic actionnable.
 * @param {unknown} e
 * @param {{ key: object, scopes: string[], subject: string }} ctx
 * @returns {AuthError}
 */
function diagnoseServiceAccountError(e, { key, scopes, subject }) {
  const { code, description } = tokenErrorInfo(e);
  const raw = `${code ?? ''} ${description}`.trim();

  if (code === 'unauthorized_client' || /unauthorized to retrieve access tokens/i.test(description)) {
    return new AuthError(
      [
        'Google a REFUSÉ d\'émettre un jeton : la délégation à l\'échelle du domaine',
        'n\'autorise pas ce compte de service pour ces portées.',
        '',
        `Message de Google : ${raw}`,
        '',
        delegationInstructions({
          clientId: key.client_id,
          scopes,
          serviceAccountEmail: key.client_email,
        }),
        '',
        'Si la délégation est déjà en place, vérifier dans l\'ordre :',
        '  - l\'identifiant client collé est bien le nombre à 21 chiffres ci-dessus ;',
        '  - la liste de portées est identique à celle ci-dessus (aucune en moins) ;',
        '  - la délégation a été ajoutée sur LE BON domaine Workspace ;',
        '  - l\'ajout date de moins de 10 minutes (propagation en cours).',
      ].join('\n'),
      { code: 'AUTH_UNAUTHORIZED_CLIENT', cause: e },
    );
  }

  if (code === 'invalid_grant') {
    const now = new Date();
    return new AuthError(
      [
        'Google a REFUSÉ le jeton signé (invalid_grant).',
        '',
        `Message de Google : ${raw}`,
        '',
        'Causes possibles, de la plus fréquente à la moins fréquente :',
        '',
        `  1. Le compte emprunté « ${subject} » ne peut pas l'être :`,
        '     - l\'adresse n\'existe pas ou comporte une faute de frappe ;',
        '     - le compte est suspendu ;',
        '     - le compte ne s\'est JAMAIS connecté et n\'a jamais accepté les',
        '       conditions d\'utilisation. Un compte jamais utilisé ne peut pas',
        '       être emprunté. Se connecter une fois à https://mail.google.com',
        '       avec ce compte, puis relancer.',
        '',
        '  2. L\'horloge de cette machine est décalée de plus de 5 minutes par',
        `     rapport à Google. Heure locale vue par le script : ${now.toISOString()}`,
        '     (comparer avec https://time.is — corriger via la synchronisation',
        '     automatique de l\'heure du système si l\'écart dépasse 2 minutes).',
        '',
        '  3. La clé privée est malformée (sauts de ligne perdus lors d\'un',
        `     copier-coller). Fichier utilisé : ${key.path}`,
        '',
        '  4. La clé a été supprimée dans la console Cloud, ou le compte de',
        '     service a été désactivé. Vérifier :',
        '     https://console.cloud.google.com/iam-admin/serviceaccounts',
        '',
        `  5. Le compte emprunté n'est pas dans le domaine autorisé par la délégation.`,
      ].join('\n'),
      { code: 'AUTH_INVALID_GRANT', cause: e },
    );
  }

  if (code === 'invalid_client') {
    return new AuthError(
      [
        'Google ne reconnaît pas ce compte de service (invalid_client).',
        `Message de Google : ${raw}`,
        '',
        'Quoi faire :',
        `  - vérifier que le compte de service ${key.client_email} existe toujours ;`,
        '  - vérifier que le projet Google Cloud n\'a pas été supprimé ;',
        '  - re-télécharger une clé JSON à jour.',
      ].join('\n'),
      { code: 'AUTH_INVALID_CLIENT', cause: e },
    );
  }

  if (code === 'invalid_scope' || /invalid.*scope/i.test(raw)) {
    return new AuthError(
      [
        'Une des portées demandées est refusée ou mal orthographiée.',
        `Message de Google : ${raw}`,
        '',
        'Portées demandées par le script :',
        ...scopes.map((s) => `  ${s}`),
        '',
        'Quoi faire : comparer cette liste avec celle enregistrée dans la',
        'délégation à l\'échelle du domaine — elles doivent être identiques.',
      ].join('\n'),
      { code: 'AUTH_INVALID_SCOPE', cause: e },
    );
  }

  if (/has not been used in project|accessNotConfigured|SERVICE_DISABLED/i.test(raw)) {
    return new AuthError(
      [
        'Une API Google nécessaire n\'est pas activée dans le projet Cloud.',
        `Message de Google : ${raw}`,
        '',
        'Quoi faire — activer les quatre API de la trousse :',
        '  https://console.cloud.google.com/apis/library/admin.googleapis.com',
        '  https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
        '  https://console.cloud.google.com/apis/library/drive.googleapis.com',
        '  https://console.cloud.google.com/apis/library/groupssettings.googleapis.com',
        '',
        '(Attention : l\'API Agenda s\'appelle « calendar-json.googleapis.com »,',
        ' pas « calendar.googleapis.com » — chercher le second ne donne rien.)',
        '',
        'En une commande, si l\'outil gcloud est installé :',
        '  gcloud services enable admin.googleapis.com calendar-json.googleapis.com \\',
        '    drive.googleapis.com groupssettings.googleapis.com --project=MON_PROJET',
        '',
        'Compter 1 à 2 minutes après activation avant de relancer.',
      ].join('\n'),
      { code: 'AUTH_API_DISABLED', cause: e },
    );
  }

  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(e?.code)) {
    return new AuthError(
      `Impossible de joindre les serveurs Google (${e.code}).\n` +
        'Quoi faire : vérifier la connexion Internet, puis relancer. Si la machine passe\n' +
        'par un proxy d\'entreprise, définir les variables HTTPS_PROXY et NO_PROXY.',
      { code: 'AUTH_NETWORK', cause: e },
    );
  }

  return new AuthError(
    [
      'L\'authentification par compte de service a échoué.',
      `Message de Google : ${raw || String(e?.message ?? e)}`,
      '',
      'Vérifications utiles :',
      `  - fichier de clé          : ${key.path}`,
      `  - compte de service       : ${key.client_email}`,
      `  - identifiant client      : ${key.client_id ?? '(absent du fichier)'}`,
      `  - compte emprunté         : ${subject}`,
      `  - nombre de portées       : ${scopes.length}`,
      '',
      'Relancer avec la variable DEBUG=1 pour voir la trace complète.',
    ].join('\n'),
    { code: 'AUTH_FAILED', cause: e },
  );
}

/**
 * Construit un client JWT impersonnant `subject`.
 * @param {{ config: object, scopes: string[], subject: string }} params
 */
async function getServiceAccountClient({ config, scopes, subject }) {
  const key = loadServiceAccountKey(config);

  if (!subject) {
    throw new AuthError(
      'Aucun compte à emprunter n\'est défini.\n' +
        'Quoi faire : renseigner "adminEmail" dans config.json — c\'est l\'adresse du\n' +
        'super-administrateur Workspace dont le script emprunte l\'identité.',
      { code: 'AUTH_NO_SUBJECT' },
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: 'service_account',
      client_email: key.client_email,
      private_key: key.private_key,
      private_key_id: key.private_key_id,
    },
    scopes: [...scopes],
    // C'est ICI que se joue l'emprunt d'identité : la revendication « sub » du JWT.
    clientOptions: { subject },
  });

  let client;
  try {
    client = await auth.getClient();
  } catch (e) {
    throw diagnoseServiceAccountError(e, { key, scopes, subject });
  }

  // On force l'obtention d'un jeton tout de suite : mieux vaut échouer ici, avec
  // un diagnostic complet, qu'au milieu de la création des ressources.
  try {
    if (typeof client.authorize === 'function') await client.authorize();
    else await client.getAccessToken();
  } catch (e) {
    throw diagnoseServiceAccountError(e, { key, scopes, subject });
  }

  client.__portail = { mode: 'service-account', subject, scopes: [...scopes], serviceAccount: key.client_email };
  return client;
}

/* ------------------------------------------------------------------ */
/* Mode OAuth (application de bureau, boucle locale 127.0.0.1)         */
/* ------------------------------------------------------------------ */

/** Lit le fichier de client OAuth et en extrait client_id / client_secret. */
function loadOAuthClient(config) {
  const path = oauthClientPath(config);

  if (!path) {
    throw new AuthError(
      'Aucun fichier de client OAuth n\'est configuré.\n' +
        'Quoi faire : renseigner "auth": { "oauthClientFile": "./oauth-client.json" }.',
      { code: 'AUTH_OAUTH_FILE_MISSING' },
    );
  }

  if (!existsSync(path)) {
    throw new AuthError(
      [
        `Fichier de client OAuth introuvable : ${path}`,
        '',
        'Quoi faire — créer le client (une seule fois) :',
        '  1. https://console.cloud.google.com/apis/credentials',
        '  2. « Créer des identifiants » > « ID client OAuth »',
        '  3. Type d\'application : « Application de bureau » (Desktop app).',
        '     Ce type accepte n\'importe quel port sur 127.0.0.1 : il n\'y a AUCUNE',
        '     URI de redirection à déclarer.',
        '  4. Télécharger le JSON et le déposer ici :',
        `     ${path}`,
        '',
        'Sur l\'écran de consentement, choisir « Interne » : pas de vérification',
        'Google à passer, et le jeton de rafraîchissement n\'expire pas au bout de',
        '7 jours (ce qui arrive aux applications « Externe » en mode test).',
      ].join('\n'),
      { code: 'AUTH_OAUTH_FILE_NOT_FOUND' },
    );
  }

  const json = readJsonFile(path, 'Le fichier de client OAuth');

  if (json.type === 'service_account') {
    throw new AuthError(
      `Le fichier ${path} est une clé de compte de service, pas un client OAuth.\n` +
        'Quoi faire : soit passer "auth": { "mode": "service-account" } et pointer\n' +
        '"keyFile" sur ce fichier, soit créer un vrai client OAuth de type\n' +
        '« Application de bureau » dans https://console.cloud.google.com/apis/credentials.',
      { code: 'AUTH_OAUTH_WRONG_TYPE' },
    );
  }

  const block = json.installed ?? json.web ?? json;
  const isWeb = Boolean(json.web) && !json.installed;

  if (typeof block.client_id !== 'string' || typeof block.client_secret !== 'string') {
    throw new AuthError(
      `Le fichier ${path} ne contient pas "client_id" et "client_secret".\n` +
        'Quoi faire : re-télécharger le JSON du client OAuth depuis\n' +
        'https://console.cloud.google.com/apis/credentials (icône de téléchargement).',
      { code: 'AUTH_OAUTH_INCOMPLETE' },
    );
  }

  /** @type {string[]} */
  const declaredRedirects = Array.isArray(block.redirect_uris) ? block.redirect_uris : [];

  return {
    clientId: block.client_id,
    clientSecret: block.client_secret,
    isWeb,
    declaredRedirects,
    path,
  };
}

/** Lit le cache de jetons. Retourne null si absent ou inutilisable. */
function readTokenCache(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

/** Écrit le cache de jetons avec des permissions restreintes (600). */
function writeTokenCache(path, tokens) {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    // writeFileSync n'applique « mode » qu'à la création : on force au cas où
    // le fichier existait déjà avec des permissions plus larges.
    chmodSync(path, 0o600);
  } catch {
    /* systèmes de fichiers sans permissions POSIX (Windows) : sans conséquence */
  }
}

/**
 * Supprime le cache de jetons OAuth. Utile quand l'autorisation a été révoquée
 * ou que l'on veut se reconnecter avec un autre compte.
 * @param {object} config
 * @returns {boolean} true si un fichier a été supprimé
 */
export function clearTokenCache(config) {
  const path = tokenFilePath(config);
  if (!path || !existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** Vérifie que les jetons en cache couvrent bien toutes les portées demandées. */
function tokenCoversScopes(tokens, scopes) {
  if (!tokens?.scope) return false;
  const granted = new Set(String(tokens.scope).split(/\s+/).filter(Boolean));
  return scopes.every((s) => granted.has(s));
}

/**
 * Exécute le flux d'autorisation complet via un mini-serveur sur 127.0.0.1.
 * @param {{ oauthClient: object, scopes: string[], subject: string, timeoutMs: number }} params
 * @returns {Promise<{ tokens: object, redirectUri: string }>}
 */
async function runLoopbackFlow({ oauthClient, scopes, subject, timeoutMs }) {
  const requestedPort = Number(process.env.PORTAIL_OAUTH_PORT ?? 0) || 0;
  const state = randomBytes(16).toString('hex');

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    /** @type {NodeJS.Timeout|null} */
    let timer = null;

    const server = createServer();

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close(() => fn(value));
    };

    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        finish(
          rejectPromise,
          new AuthError(
            `Le port ${requestedPort} est déjà utilisé sur cette machine.\n` +
              'Quoi faire : fermer l\'application qui l\'occupe, ou laisser le script choisir\n' +
              'un port libre en retirant la variable PORTAIL_OAUTH_PORT.',
            { code: 'AUTH_PORT_BUSY', cause: e },
          ),
        );
      } else {
        finish(rejectPromise, new AuthError(`Le serveur local d'autorisation n'a pas pu démarrer : ${e.message}`, { code: 'AUTH_SERVER', cause: e }));
      }
    });

    server.listen(requestedPort, '127.0.0.1', async () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      oauthClient.redirectUri = redirectUri;
      // La bibliothèque lit aussi cette propriété interne selon les chemins de code.
      if (oauthClient._redirectUri !== undefined) oauthClient._redirectUri = redirectUri;

      const authorizeUrl = oauthClient.generateAuthUrl({
        access_type: 'offline', // demande un jeton de rafraîchissement
        prompt: 'consent', // force son émission même si l'accès a déjà été accordé
        scope: [...scopes, ...OAUTH_IDENTITY_SCOPES],
        state,
        login_hint: subject || undefined,
        include_granted_scopes: false,
      });

      log.step('Autorisation Google requise');
      log.info(`Le navigateur va s'ouvrir pour se connecter avec ${subject || 'le compte administrateur'}.`);
      log.info('Si rien ne s\'ouvre, copier-coller cette adresse dans le navigateur :');
      log.raw('');
      log.raw(`    ${authorizeUrl}`);
      log.raw('');
      log.info(`En attente du retour de Google sur ${redirectUri} …`);

      openBrowser(authorizeUrl);

      timer = setTimeout(() => {
        finish(
          rejectPromise,
          new AuthError(
            `Aucune réponse de Google après ${Math.round(timeoutMs / 1000)} secondes.\n` +
              'Quoi faire : relancer la commande et terminer la connexion dans le navigateur.\n' +
              'Si le navigateur est sur une AUTRE machine que celle qui exécute le script,\n' +
              'le retour sur 127.0.0.1 ne peut pas aboutir : lancer le script depuis un poste\n' +
              'avec navigateur, ou utiliser le mode "service-account".',
            { code: 'AUTH_TIMEOUT' },
          ),
        );
      }, timeoutMs);

      server.on('request', async (req, res) => {
        let url;
        try {
          url = new URL(req.url, redirectUri);
        } catch {
          res.writeHead(400).end('requête invalide');
          return;
        }

        if (url.pathname === '/favicon.ico') {
          res.writeHead(204).end();
          return;
        }
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404).end('rien ici');
          return;
        }

        const respond = (title, body) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            `<!doctype html><html lang="fr"><meta charset="utf-8">` +
              `<title>${title}</title>` +
              `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.6">` +
              `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`,
          );
        };

        const errorParam = url.searchParams.get('error');
        if (errorParam) {
          respond('Autorisation refusée', `Google a renvoyé : <code>${errorParam}</code>. Tu peux fermer cet onglet.`);
          finish(
            rejectPromise,
            new AuthError(
              `L'autorisation a été refusée dans le navigateur (${errorParam}).\n` +
                (errorParam === 'access_denied'
                  ? 'Quoi faire : relancer et cliquer « Autoriser ». Si l\'écran de consentement\n' +
                    'affiche « accès bloqué », vérifier que l\'écran de consentement est en mode\n' +
                    '« Interne » et que le compte utilisé appartient bien au domaine.'
                  : 'Quoi faire : relancer la commande.'),
              { code: 'AUTH_DENIED' },
            ),
          );
          return;
        }

        if (url.searchParams.get('state') !== state) {
          respond('Autorisation invalide', 'Le jeton anti-rejeu ne correspond pas. Tu peux fermer cet onglet.');
          finish(
            rejectPromise,
            new AuthError(
              'La réponse de Google ne correspond pas à la demande (paramètre « state » invalide).\n' +
                'Cela arrive si deux autorisations tournent en même temps, ou si un vieil onglet\n' +
                'a été rechargé. Quoi faire : fermer les onglets d\'autorisation et relancer.',
              { code: 'AUTH_STATE_MISMATCH' },
            ),
          );
          return;
        }

        const code = url.searchParams.get('code');
        if (!code) {
          respond('Réponse incomplète', 'Google n\'a pas renvoyé de code d\'autorisation.');
          finish(rejectPromise, new AuthError('Google n\'a pas renvoyé de code d\'autorisation. Relancer la commande.', { code: 'AUTH_NO_CODE' }));
          return;
        }

        try {
          const { tokens } = await oauthClient.getToken(code);
          respond('Connexion réussie', 'La trousse Portail est autorisée. Tu peux fermer cet onglet et revenir au terminal.');
          finish(resolvePromise, { tokens, redirectUri });
        } catch (e) {
          respond('Échec de l\'échange', 'Le code d\'autorisation n\'a pas pu être échangé. Voir le terminal.');
          const { code: errCode, description } = tokenErrorInfo(e);
          finish(
            rejectPromise,
            new AuthError(
              `L'échange du code d'autorisation a échoué (${errCode ?? 'erreur inconnue'}).\n` +
                `Message de Google : ${description}\n` +
                'Quoi faire : vérifier que le client OAuth est bien de type « Application de\n' +
                'bureau », puis relancer.',
              { code: 'AUTH_CODE_EXCHANGE', cause: e },
            ),
          );
        }
      });
    });
  });
}

/**
 * Construit un client OAuth2 autorisé, en réutilisant le cache si possible.
 * @param {{ config: object, scopes: string[], subject: string }} params
 */
async function getOAuthUserClient({ config, scopes, subject }) {
  const clientInfo = loadOAuthClient(config);
  const tokenPath = tokenFilePath(config);

  if (clientInfo.isWeb) {
    log.warn(
      `Le client OAuth ${clientInfo.path} est de type « Application Web ». Le type ` +
        '« Application de bureau » est recommandé : il accepte n\'importe quel port de ' +
        'boucle locale sans déclaration préalable. Avec un client Web, il faut déclarer ' +
        'l\'URI de redirection exacte dans la console, sinon Google renvoie redirect_uri_mismatch.',
    );
  }

  const oauthClient = new google.auth.OAuth2(clientInfo.clientId, clientInfo.clientSecret);

  // Persiste automatiquement les jetons rafraîchis par la bibliothèque.
  oauthClient.on('tokens', (tokens) => {
    if (!tokenPath) return;
    try {
      const previous = readTokenCache(tokenPath) ?? {};
      writeTokenCache(tokenPath, { ...previous, ...tokens });
    } catch (e) {
      log.warn(`Impossible de mettre à jour le cache de jetons (${e.message}). L'exécution continue.`);
    }
  });

  const cached = readTokenCache(tokenPath);

  if (cached?.refresh_token) {
    if (!tokenCoversScopes(cached, scopes)) {
      log.info('Les autorisations demandées ont changé depuis la dernière connexion : une nouvelle autorisation est nécessaire.');
    } else {
      oauthClient.setCredentials(cached);
      try {
        await oauthClient.getAccessToken(); // rafraîchit si nécessaire
        verifyOAuthIdentity(cached, subject);
        oauthClient.__portail = { mode: 'oauth', subject, scopes: [...scopes], reused: true };
        return oauthClient;
      } catch (e) {
        const { code, description } = tokenErrorInfo(e);
        if (code === 'invalid_grant') {
          log.warn(
            'L\'autorisation enregistrée n\'est plus valide (accès révoqué, mot de passe changé, ' +
              'ou application « Externe » en mode test dont le jeton expire après 7 jours). ' +
              'Une nouvelle connexion va être demandée.',
          );
        } else {
          log.warn(`Le jeton en cache n'a pas pu être rafraîchi (${code ?? 'erreur inconnue'} : ${description}). Une nouvelle connexion va être demandée.`);
        }
      }
    }
  }

  const timeoutMs = Number(process.env.PORTAIL_OAUTH_TIMEOUT_MS ?? 300000) || 300000;
  const { tokens } = await runLoopbackFlow({ oauthClient, scopes, subject, timeoutMs });

  if (!tokens.refresh_token) {
    log.warn(
      'Google n\'a pas renvoyé de jeton de rafraîchissement : il faudra se reconnecter ' +
        'à la prochaine exécution. Cela arrive si l\'accès avait déjà été accordé auparavant. ' +
        'Pour repartir à neuf : révoquer l\'accès sur https://myaccount.google.com/permissions, ' +
        'puis relancer.',
    );
  }

  oauthClient.setCredentials(tokens);
  if (tokenPath) {
    try {
      writeTokenCache(tokenPath, { ...(cached ?? {}), ...tokens });
      log.ok(`Autorisation enregistrée dans ${tokenPath} (lisible par toi seul). Les prochaines exécutions ne demanderont plus rien.`);
    } catch (e) {
      log.warn(`L'autorisation a réussi mais n'a pas pu être enregistrée (${e.message}) : il faudra se reconnecter à la prochaine exécution.`);
    }
  }

  verifyOAuthIdentity(tokens, subject);
  oauthClient.__portail = { mode: 'oauth', subject, scopes: [...scopes], reused: false };
  return oauthClient;
}

/** Avertit si le compte connecté n'est pas celui attendu. */
function verifyOAuthIdentity(tokens, expectedEmail) {
  if (!tokens?.id_token || !expectedEmail) return;
  const claims = decodeIdToken(tokens.id_token);
  const actual = claims?.email;
  if (!actual) return;
  if (String(actual).toLowerCase() !== String(expectedEmail).toLowerCase()) {
    log.warn(
      `Le compte connecté est « ${actual} », alors que la configuration attend ` +
        `« ${expectedEmail} » (champ adminEmail). Les ressources seront créées au nom de ` +
        `« ${actual} ». Si ce n'est pas voulu : supprimer le cache de jetons et se ` +
        'reconnecter avec le bon compte.',
    );
  }
}

/* ------------------------------------------------------------------ */
/* Point d'entrée                                                      */
/* ------------------------------------------------------------------ */

/** Cache des clients par (mode, clé, subject, portées) pour un même processus. */
const clientCache = new Map();

/**
 * Retourne un client Google authentifié, prêt à être passé à googleapis.
 *
 * @param {object} params
 * @param {object} params.config configuration chargée par loadConfig()
 * @param {string[]} [params.scopes] portées demandées (défaut : ALL_SCOPES)
 * @param {string} [params.subject] compte à emprunter (défaut : config.adminEmail)
 * @returns {Promise<object>} client utilisable comme `auth:` dans googleapis
 * @throws {AuthError} message français diagnostiquant la cause exacte
 */
export async function getAuthClient({ config, scopes, subject } = {}) {
  if (!config || typeof config !== 'object') {
    throw new AuthError(
      'getAuthClient a été appelé sans configuration. C\'est un bogue interne de la trousse :\n' +
        'la configuration doit être chargée avec loadConfig() avant toute authentification.',
      { code: 'AUTH_NO_CONFIG' },
    );
  }

  const requested = Array.isArray(scopes) && scopes.length > 0 ? [...new Set(scopes)] : [...ALL_SCOPES];
  const impersonated = subject ?? config.adminEmail ?? null;
  const mode = config.auth?.mode ?? 'service-account';

  const cacheKey = JSON.stringify([mode, keyFilePath(config), oauthClientPath(config), impersonated, [...requested].sort()]);
  if (clientCache.has(cacheKey)) return clientCache.get(cacheKey);

  let promise;
  if (mode === 'service-account') {
    promise = getServiceAccountClient({ config, scopes: requested, subject: impersonated });
  } else if (mode === 'oauth') {
    promise = getOAuthUserClient({ config, scopes: requested, subject: impersonated });
  } else {
    throw new AuthError(
      `Mode d'authentification inconnu : « ${mode} ».\n` +
        'Valeurs acceptées dans config.json > auth.mode : "service-account" ou "oauth".',
      { code: 'AUTH_UNKNOWN_MODE' },
    );
  }

  // On met la promesse en cache (pas seulement le résultat) pour que deux appels
  // simultanés ne lancent pas deux fois le flux OAuth.
  clientCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (e) {
    clientCache.delete(cacheKey);
    throw e;
  }
}

/**
 * Description courte du mode d'authentification, pour l'affichage.
 * @param {object} config
 * @returns {string}
 */
export function describeAuth(config) {
  const mode = config?.auth?.mode ?? 'service-account';
  if (mode === 'oauth') {
    return `OAuth (application de bureau), compte attendu : ${config?.adminEmail ?? 'non défini'}`;
  }
  return `compte de service avec délégation, identité empruntée : ${config?.adminEmail ?? 'non défini'}`;
}

/**
 * Identifiant client numérique du compte de service, s'il est disponible.
 * Retourne null en mode OAuth ou si le fichier de clé est absent.
 * @param {object} config
 * @returns {string|null}
 */
export function serviceAccountClientId(config) {
  try {
    const path = keyFilePath(config);
    if (!path || !existsSync(path) || statSync(path).isDirectory()) return null;
    const key = JSON.parse(readFileSync(path, 'utf8'));
    return typeof key.client_id === 'string' ? key.client_id : null;
  } catch {
    return null;
  }
}

export default {
  getAuthClient,
  SCOPES,
  ALL_SCOPES,
  formatScopeList,
  delegationInstructions,
  describeAuth,
  serviceAccountClientId,
  clearTokenCache,
  AuthError,
};
