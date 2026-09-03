/**
 * Ajoute une boîte de courriel partagée dans config.json — sans éditer de JSON à la main.
 *
 * Utilisation :
 *   node scripts/ajouter-boite.mjs info@mondomaine.ca
 *   node scripts/ajouter-boite.mjs info@mondomaine.ca "Info — Ma Compagnie"
 *
 * Pourquoi ce script existe : demander à quelqu'un d'insérer un bloc JSON au bon
 * endroit, avec la virgule au bon endroit, c'est une consigne qui échoue une fois
 * sur deux — et quand elle échoue, elle laisse un config.json cassé qui bloque
 * TOUTES les commandes de la trousse. Une commande qui fait l'édition ne peut pas
 * se tromper de virgule.
 *
 * Ce script ne touche à RIEN chez Google. Il modifie un seul fichier local, après
 * en avoir fait une copie de sauvegarde, et refuse d'écrire si le résultat ne
 * passe pas la validation.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { loadConfig } from '../src/lib/config.mjs';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(RACINE, 'config.json');

// Mêmes règles que src/lib/log.mjs : sans ça, une sortie redirigée vers un
// fichier se remplirait de codes d'échappement illisibles.
const COULEUR =
  !(typeof process.env.NO_COLOR === 'string' && process.env.NO_COLOR !== '') &&
  process.env.TERM !== 'dumb' &&
  Boolean(process.stdout && process.stdout.isTTY);
const peindre = (code, t) => (COULEUR ? `[${code}m${t}[0m` : t);
const rouge = (t) => peindre('31', t);
const vert = (t) => peindre('32', t);
const jaune = (t) => peindre('33', t);

function abandonner(message) {
  console.error(`\n${rouge('✗')} ${message}\n`);
  process.exit(1);
}

/* --- Les arguments --------------------------------------------------- */
const [adresseBrute, nomFourni] = process.argv.slice(2);

if (!adresseBrute || adresseBrute === '--help' || adresseBrute === '-h') {
  console.log(`
Ajoute une boîte de courriel partagée (info@, ventes@…) dans config.json.

  node scripts/ajouter-boite.mjs <adresse> [nom affiché]

Exemples :
  node scripts/ajouter-boite.mjs info@mondomaine.ca
  node scripts/ajouter-boite.mjs ventes@mondomaine.ca "Ventes"

Ensuite, pour créer la boîte pour de vrai chez Google :
  node src/cli.mjs mailboxes            (simulation — montre ce qui serait fait)
  node src/cli.mjs mailboxes --apply    (exécution)
`);
  process.exit(0);
}

const adresse = String(adresseBrute).trim().toLowerCase();

if (!existsSync(CONFIG)) {
  abandonner(
    `Aucun config.json trouvé dans ${RACINE}.\n` +
      "  Lance d'abord : node src/cli.mjs init --apply",
  );
}

/* --- Lecture --------------------------------------------------------- */
let brut;
try {
  brut = JSON.parse(readFileSync(CONFIG, 'utf8'));
} catch (erreur) {
  abandonner(
    `config.json n'est pas un JSON valide : ${erreur.message}\n` +
      "  S'il a été édité à la main, une virgule manque probablement. Tu peux le\n" +
      '  regénérer avec : node src/cli.mjs init --apply --force',
  );
}

/* --- Vérifications avant d'écrire ------------------------------------ */
const domaine = brut.domain;
if (domaine && !adresse.endsWith(`@${domaine}`)) {
  abandonner(
    `« ${adresse} » n'est pas dans ton domaine « ${domaine} ».\n` +
      `  Une boîte partagée se crée obligatoirement dans le domaine administré.\n` +
      `  Tu voulais peut-être : ${adresse.split('@')[0]}@${domaine}`,
  );
}

const liste = Array.isArray(brut.sharedMailboxes) ? brut.sharedMailboxes : [];

if (liste.some((b) => String(b?.email ?? '').toLowerCase() === adresse)) {
  console.log(`\n${jaune('•')} ${adresse} est déjà dans config.json — rien à changer.`);
  console.log(`  Pour la créer chez Google : ${vert('node src/cli.mjs mailboxes --apply')}\n`);
  process.exit(0);
}

const nom = nomFourni?.trim() || adresse.split('@')[0];

/* --- On construit le nouveau contenu --------------------------------- */
const nouveau = {
  ...brut,
  sharedMailboxes: [
    ...liste,
    {
      email: adresse,
      name: nom,
      description:
        'Adresse de contact partagée. Les courriels arrivent dans la boîte de chaque ' +
        "membre de l'équipe ; chacun répond avec son propre compte.",
    },
  ],
};

/* --- On valide AVANT d'écrire ---------------------------------------- */
// On écrit dans un fichier temporaire, on le fait valider par le même code que
// la trousse, et on ne remplace le vrai config.json que si tout passe. Sinon,
// une erreur laisserait l'utilisateur avec une configuration cassée qui bloque
// toutes les autres commandes.
const provisoire = `${CONFIG}.essai`;
writeFileSync(provisoire, `${JSON.stringify(nouveau, null, 2)}\n`, 'utf8');
try {
  loadConfig(provisoire);
} catch (erreur) {
  const explication = String(erreur.message).split(provisoire).join(CONFIG);
  abandonner(
    `L'ajout rendrait config.json invalide, donc rien n'a été modifié :\n\n${explication}`,
  );
} finally {
  try {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(provisoire);
  } catch {
    /* le fichier d'essai a déjà disparu : sans conséquence */
  }
}

/* --- Sauvegarde puis écriture ---------------------------------------- */
copyFileSync(CONFIG, `${CONFIG}.bak`);
writeFileSync(CONFIG, `${JSON.stringify(nouveau, null, 2)}\n`, 'utf8');

console.log(`\n${vert('✓')} Boîte partagée ajoutée à config.json`);
console.log(`    Adresse : ${adresse}`);
console.log(`    Nom     : ${nom}`);
console.log(`    (copie de l'ancien fichier : config.json.bak)`);
console.log(`\n  Prochaine étape — voir ce qui serait créé chez Google :`);
console.log(`    ${vert('node src/cli.mjs mailboxes')}`);
console.log(`\n  Puis, pour le faire pour de vrai :`);
console.log(`    ${vert('node src/cli.mjs mailboxes --apply')}\n`);
