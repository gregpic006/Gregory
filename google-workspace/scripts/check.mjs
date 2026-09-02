/**
 * Vérification hors ligne de la trousse — AUCUN appel réseau, AUCUNE modification.
 *
 * À lancer avant de commiter (`npm run check`). Elle répond à cinq questions :
 *   1. Les modules s'importent-ils et exportent-ils bien ce que le reste du code attend ?
 *   2. Chaque commande est-elle atteignable depuis le CLI ?
 *   3. Le modèle de configuration passe-t-il la validation ?
 *   4. Les portées OAuth sont-elles exactement celles vérifiées dans les discovery
 *      documents de Google ? (une portée en trop ou en moins casse l'authentification)
 *   5. Une donnée personnelle est-elle sur le point de partir sur le dépôt ?
 *
 * Le contrôle 5 existe parce que ce dépôt est PUBLIC et que l'erreur s'est déjà
 * produite : une adresse personnelle écrite dans un fichier de documentation. Il
 * examine tout ce que git enverrait — fichiers suivis ET fichiers neufs non ignorés —
 * et pas seulement les fichiers déjà suivis, précisément parce qu'un fichier neuf
 * échappe à `git ls-files` tant qu'il n'a pas été ajouté au moins une fois.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE = join(ICI, '..');

let echecs = 0;
const ok = (m) => console.log(`  [OK]    ${m}`);
const echec = (m) => {
  console.log(`  [ÉCHEC] ${m}`);
  echecs += 1;
};

/* ------------------------------------------------------------------ *
 * 1. Les modules partagés
 * ------------------------------------------------------------------ */
console.log('\n1. Les modules partagés exportent bien leur contrat');

const CONTRAT = {
  'lib/log.mjs': ['step', 'info', 'ok', 'warn', 'err', 'plan', 'skip', 'banner'],
  'lib/config.mjs': ['loadConfig', 'DEFAULTS'],
  'lib/state.mjs': ['loadState', 'saveState', 'setStateKey'],
  'lib/auth.mjs': ['getAuthClient', 'SCOPES', 'ALL_SCOPES'],
  'lib/google.mjs': ['getClients', 'withRetry', 'explainGoogleError'],
};

const modules = {};
for (const [fichier, attendus] of Object.entries(CONTRAT)) {
  try {
    const mod = await import(join(RACINE, 'src', fichier));
    modules[fichier] = mod;
    const manquants = attendus.filter((nom) => !(nom in mod));
    if (manquants.length > 0) echec(`${fichier} — exports manquants : ${manquants.join(', ')}`);
    else ok(`${fichier}`);
  } catch (erreur) {
    echec(`${fichier} — import impossible : ${erreur.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * 2. Les commandes
 * ------------------------------------------------------------------ */
console.log('\n2. Chaque commande est complète et atteignable depuis le CLI');

const COMMANDES = ['init', 'doctor', 'dns', 'audit', 'group', 'calendar', 'drive', 'detach', 'verify'];
const cli = readFileSync(join(RACINE, 'src', 'cli.mjs'), 'utf8');

for (const nom of COMMANDES) {
  try {
    const mod = await import(join(RACINE, 'src', 'commands', `${nom}.mjs`));
    if (typeof mod.run !== 'function') echec(`${nom} — « run » absent ou n'est pas une fonction`);
    else if (!mod.meta?.name) echec(`${nom} — « meta.name » absent`);
    // Une commande écrite mais jamais déclarée dans le CLI est inatteignable.
    // C'est arrivé à « dns » : le fichier existait, la commande n'existait pas.
    else if (!cli.includes(`'${nom}'`) && !cli.includes(`"${nom}"`)) {
      echec(`${nom} — écrite mais PAS déclarée dans cli.mjs : inatteignable`);
    } else ok(`${nom}`);
  } catch (erreur) {
    echec(`${nom} — import impossible : ${erreur.message}`);
  }
}

if (!cli.includes("'setup'")) echec('cli.mjs ne déclare pas « setup »');
else ok('setup');

/* ------------------------------------------------------------------ *
 * 3. Le modèle de configuration
 * ------------------------------------------------------------------ */
console.log('\n3. Le modèle de configuration est valide');

try {
  const config = modules['lib/config.mjs'].loadConfig(join(RACINE, 'config.example.json'));
  ok(`config.example.json accepté (domaine « ${config.domain} »)`);
  if (config.auth?.mode !== 'oauth') {
    echec(`le mode d'authentification par défaut est « ${config.auth?.mode} », attendu « oauth »`);
  } else ok('mode par défaut : oauth (navigateur, sans fichier de clé)');
} catch (erreur) {
  echec(`config.example.json rejeté : ${erreur.message}`);
}

/* ------------------------------------------------------------------ *
 * 4. Les portées
 * ------------------------------------------------------------------ */
console.log('\n4. Les portées correspondent aux discovery documents de Google');

const PORTEES_VERIFIEES = [
  'admin.directory.user',
  'admin.directory.group',
  'admin.directory.group.member',
  'admin.directory.customer.readonly',
  'calendar',
  'drive',
  'apps.groups.settings',
].map((suffixe) => `https://www.googleapis.com/auth/${suffixe}`);

const delegation = modules['lib/auth.mjs']?.SCOPES?.delegation;
if (!Array.isArray(delegation)) {
  echec('SCOPES.delegation est absent ou n\'est pas un tableau');
} else {
  const trie = (liste) => JSON.stringify([...liste].sort());
  if (trie(delegation) !== trie(PORTEES_VERIFIEES)) {
    const enTrop = delegation.filter((p) => !PORTEES_VERIFIEES.includes(p));
    const manquantes = PORTEES_VERIFIEES.filter((p) => !delegation.includes(p));
    echec(
      'SCOPES.delegation ne correspond pas.' +
        (manquantes.length ? `\n           manquantes : ${manquantes.join(', ')}` : '') +
        (enTrop.length ? `\n           en trop    : ${enTrop.join(', ')}` : ''),
    );
  } else ok(`les ${PORTEES_VERIFIEES.length} portées, exactement`);
}

/* ------------------------------------------------------------------ *
 * 5. Aucune donnée personnelle en partance
 * ------------------------------------------------------------------ */
console.log('\n5. Aucune donnée personnelle ne part sur le dépôt (il est PUBLIC)');

// Les motifs cherchent la FORME d'une donnée personnelle, pas une valeur précise :
// une valeur en dur ici deviendrait elle-même la fuite qu'on veut empêcher.
// Les adresses d'exemple de la documentation sont volontairement reconnaissables :
// leur partie locale commence par « ton- », « ta- », « mon- », « exemple- »… ou est
// « adresse-perso ». Elles n'appartiennent à personne, donc pas d'alerte. Toute autre
// adresse Gmail/Hotmail/Yahoo est traitée comme réelle jusqu'à preuve du contraire.
const EXEMPLE = /^(?:ton|ta|tes|mon|ma|votre|vos|exemple|adresse|prenom|nom|xxx)[-_.]/i;

const MOTIFS = [
  {
    quoi: 'une adresse Gmail/Hotmail/Yahoo personnelle',
    re: /[\w.+-]+@(?:gmail|hotmail|outlook|yahoo|icloud)\.[a-z.]+/gi,
    estUnExemple: (trouve) => EXEMPLE.test(trouve.split('@')[0]),
  },
  { quoi: 'une clé privée', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { quoi: 'un secret client Google', re: /GOCSPX-[\w-]+/ },
  { quoi: 'un jeton de rafraîchissement Google', re: /"refresh_token"\s*:\s*"1\/\//},
];

// Tout ce que git enverrait : fichiers suivis + fichiers neufs non ignorés.
// Les fichiers ignorés (config.json, .tokens.json, les clés) sont exclus par
// construction : ils ne partent jamais, et ils contiennent légitimement de vraies
// adresses.
let aExaminer = [];
try {
  const sortie = execSync('git ls-files --cached --others --exclude-standard', {
    cwd: RACINE,
    encoding: 'utf8',
  });
  aExaminer = sortie.split('\n').map((l) => l.trim()).filter(Boolean);
} catch (erreur) {
  echec(`impossible de lister les fichiers suivis par git : ${erreur.message}`);
}

// Le modèle de configuration a le droit de contenir des adresses d'exemple.
const EXEMPTS = new Set(['config.example.json']);
let fichiersExamines = 0;
let trouvailles = 0;

for (const chemin of aExaminer) {
  if (EXEMPTS.has(chemin)) continue;
  let contenu;
  try {
    contenu = readFileSync(join(RACINE, chemin), 'utf8');
  } catch {
    continue; // binaire ou illisible : rien à y chercher
  }
  fichiersExamines += 1;
  for (const { quoi, re, estUnExemple } of MOTIFS) {
    const trouves = contenu.match(re) ?? [];
    const reels = estUnExemple ? trouves.filter((t) => !estUnExemple(t)) : trouves;
    if (reels.length === 0) continue;
    // On nomme le fichier et la nature du problème, jamais la valeur trouvée :
    // l'afficher la recopierait dans les journaux de la console, et dans les
    // journaux d'intégration continue s'il y en a un jour.
    echec(`${chemin} contient ${quoi} (${reels.length}) — à retirer avant de commiter`);
    trouvailles += 1;
  }
}
if (trouvailles === 0) ok(`${fichiersExamines} fichier(s) examiné(s), rien de personnel`);

/* ------------------------------------------------------------------ *
 * Verdict
 * ------------------------------------------------------------------ */
console.log(
  echecs === 0
    ? '\nTout est conforme.\n'
    : `\n${echecs} problème(s) à corriger avant de commiter.\n`,
);
process.exit(echecs === 0 ? 0 : 1);
