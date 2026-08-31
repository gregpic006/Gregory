#!/usr/bin/env node
/**
 * outils/build.mjs — Assemble les modules de src/ en un seul fichier dist/Code.gs.
 *
 * Apps Script n'a pas de système de modules : tous les fichiers .gs partagent un
 * même espace de noms global. On peut donc simplement concaténer les fichiers, à
 * condition de respecter l'ordre alphabétique des noms (00_Config.gs d'abord, etc.).
 *
 * Le résultat, dist/Code.gs, est LE fichier que Grégory copie-colle dans l'éditeur
 * Apps Script. Il est volontairement reproductible : reconstruire sans avoir modifié
 * src/ redonne exactement le même contenu (aucune date de génération à l'intérieur),
 * pour que le suivi de version reste lisible.
 *
 * Aucune dépendance externe. Utilisation :
 *     node outils/build.mjs        (ou : npm run build)
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Dossier de ce script, pour que la commande marche depuis n'importe où. */
const DOSSIER_OUTILS = path.dirname(fileURLToPath(import.meta.url));

/** Racine du projet rapprochement-clients. */
export const RACINE = path.resolve(DOSSIER_OUTILS, '..');

/** Dossier des modules Apps Script à concaténer. */
export const DOSSIER_SOURCE = path.join(RACINE, 'src');

/** Dossier de sortie. */
export const DOSSIER_DIST = path.join(RACINE, 'dist');

/** Fichier assemblé, à copier-coller dans Apps Script. */
export const FICHIER_SORTIE = path.join(DOSSIER_DIST, 'Code.gs');

/** Extension des modules pris en compte. */
const EXTENSION = '.gs';

/** Largeur des bandeaux de commentaire, en caractères. */
const LARGEUR_BANDEAU = 78;

/**
 * Liste les modules à concaténer, dans l'ordre alphabétique de leur nom de fichier.
 * L'ordre est celui des codes de caractères (donc 00_, 01_, ... 09_, 10_), ce qui
 * garantit que 00_Config.gs est toujours en tête et que le résultat est stable.
 * @return {Promise<string[]>} Noms de fichiers, sans le chemin.
 */
export async function listerModules() {
  const entrees = await readdir(DOSSIER_SOURCE, { withFileTypes: true });
  const fichiers = entrees
    .filter((e) => e.isFile() && e.name.endsWith(EXTENSION))
    .map((e) => e.name)
    .sort();
  if (!fichiers.length) {
    throw new Error(`Aucun fichier ${EXTENSION} trouvé dans ${DOSSIER_SOURCE}.`);
  }
  return fichiers;
}

/**
 * Compose une ligne de bandeau commenté, calée sur LARGEUR_BANDEAU.
 * @param {string} texte Texte à encadrer (vide = ligne de séparation).
 * @return {string} Ligne de commentaire.
 */
function ligneBandeau_(texte) {
  if (!texte) return `// ${'='.repeat(LARGEUR_BANDEAU - 3)}`;
  return `// ${texte}`;
}

/**
 * Construit l'en-tête du fichier généré : avertissement, mode d'emploi et
 * ordre exact de concaténation des modules.
 * @param {string[]} modules Noms des fichiers concaténés, dans l'ordre.
 * @return {string} Bloc de commentaire prêt à écrire.
 */
export function construireEntete(modules) {
  const largeurNumero = String(modules.length).length;
  const liste = modules.map((nom, i) => {
    const numero = String(i + 1).padStart(largeurNumero, ' ');
    return ` *   ${numero}. src/${nom}`;
  });
  return [
    '/*',
    ` * ${'='.repeat(LARGEUR_BANDEAU - 3)}`,
    ' *  Code.gs — FICHIER GÉNÉRÉ. NE LE MODIFIEZ PAS À LA MAIN.',
    ` * ${'='.repeat(LARGEUR_BANDEAU - 3)}`,
    ' *',
    ' *  Ce fichier est produit par outils/build.mjs à partir du dossier src/.',
    " *  Toute retouche faite ici sera écrasée à la prochaine construction :",
    ' *  modifiez le module concerné dans src/, puis relancez  npm run build.',
    ' *',
    ' *  Mode d\'emploi :',
    ' *    1. Ouvrez votre classeur Google Sheets → Extensions → Apps Script.',
    ' *    2. Collez TOUT ce fichier dans un fichier nommé Code.gs, puis enregistrez.',
    ' *    3. Lancez la fonction installer() une première fois et autorisez le script.',
    ' *    4. Rechargez le classeur : le menu « 📋 Automatisation » apparaît.',
    ' *',
    ` *  Ordre de concaténation (ordre alphabétique des noms de fichiers, ${modules.length} modules) :`,
    ...liste,
    ' *',
    ' *  Apps Script n\'a pas de modules : tous ces fichiers partagent un seul espace',
    ' *  de noms global. L\'ordre ci-dessus est celui dans lequel le code est évalué.',
    ' *',
    ' *  Construction reproductible : sans changement dans src/, le contenu de ce',
    ' *  fichier est identique d\'une construction à l\'autre.',
    ` * ${'='.repeat(LARGEUR_BANDEAU - 3)}`,
    ' */',
    '',
  ].join('\n');
}

/**
 * Construit le séparateur commenté inséré avant chaque module.
 * @param {string} nom Nom du fichier source.
 * @param {number} rang Position du module (à partir de 1).
 * @param {number} total Nombre total de modules.
 * @return {string} Bloc de commentaire prêt à écrire.
 */
export function construireSeparateur(nom, rang, total) {
  return [
    '',
    ligneBandeau_(''),
    ligneBandeau_(`▼ src/${nom}   (module ${rang} sur ${total})`),
    ligneBandeau_(''),
    '',
  ].join('\n');
}

/**
 * Formate un nombre d'octets pour l'affichage, en français.
 * @param {number} octets Taille en octets.
 * @return {string} Ex. « 402 315 octets (393,0 Ko) ».
 */
export function formaterTaille(octets) {
  const ko = octets / 1024;
  const enKo = ko >= 1024
    ? `${(ko / 1024).toLocaleString('fr-CA', { maximumFractionDigits: 1 })} Mo`
    : `${ko.toLocaleString('fr-CA', { maximumFractionDigits: 1 })} Ko`;
  return `${octets.toLocaleString('fr-CA')} octets (${enKo})`;
}

/**
 * Lit tous les modules et assemble le contenu de dist/Code.gs.
 * @param {string[]} modules Noms de fichiers, dans l'ordre de concaténation.
 * @return {Promise<{code: string, tailles: Array<{nom: string, octets: number, lignes: number}>}>}
 */
async function assembler_(modules) {
  const morceaux = [construireEntete(modules)];
  const tailles = [];
  for (let i = 0; i < modules.length; i++) {
    const nom = modules[i];
    let contenu = await readFile(path.join(DOSSIER_SOURCE, nom), 'utf8');
    contenu = contenu.replace(/^\uFEFF/, '').replace(/\s*$/, '\n');
    tailles.push({
      nom,
      octets: Buffer.byteLength(contenu, 'utf8'),
      lignes: contenu.split('\n').length - 1,
    });
    morceaux.push(construireSeparateur(nom, i + 1, modules.length));
    morceaux.push(contenu);
  }
  return { code: morceaux.join(''), tailles };
}

/**
 * Construit dist/Code.gs à partir de src/*.gs.
 * @param {{silencieux?: boolean}} [options] silencieux = n'affiche rien sur la console.
 * @return {Promise<{fichier: string, code: string, modules: string[], octets: number, lignes: number}>}
 *     Le fichier écrit, son contenu, la liste des modules, sa taille et son nombre de lignes.
 */
export async function construire(options = {}) {
  const silencieux = Boolean(options.silencieux);
  const modules = await listerModules();
  const { code, tailles } = await assembler_(modules);

  await mkdir(DOSSIER_DIST, { recursive: true });
  await writeFile(FICHIER_SORTIE, code, 'utf8');

  const octets = Buffer.byteLength(code, 'utf8');
  const lignes = code.split('\n').length - (code.endsWith('\n') ? 1 : 0);

  if (!silencieux) afficherResume_(modules, tailles, octets, lignes);
  return { fichier: FICHIER_SORTIE, code, modules, octets, lignes };
}

/**
 * Affiche le compte rendu de construction, en français.
 * @param {string[]} modules Modules concaténés, dans l'ordre.
 * @param {Array<{nom: string, octets: number, lignes: number}>} tailles Détail par module.
 * @param {number} octets Taille finale du fichier.
 * @param {number} lignes Nombre de lignes du fichier final.
 * @return {void}
 */
function afficherResume_(modules, tailles, octets, lignes) {
  const largeurNom = Math.max(...modules.map((n) => n.length));
  const largeurNumero = String(modules.length).length;
  console.log('Construction de dist/Code.gs');
  console.log(`  ${modules.length} modules concaténés (ordre alphabétique) :`);
  tailles.forEach((t, i) => {
    const numero = String(i + 1).padStart(largeurNumero, ' ');
    const nom = t.nom.padEnd(largeurNom, ' ');
    const nbLignes = String(t.lignes).padStart(6, ' ');
    console.log(`    ${numero}. ${nom}  ${nbLignes} lignes`);
  });
  console.log('');
  console.log(`  Fichier écrit : ${FICHIER_SORTIE}`);
  console.log(`  Taille        : ${formaterTaille(octets)}`);
  console.log(`  Lignes        : ${lignes.toLocaleString('fr-CA')}`);
  console.log('');
  console.log('  À faire ensuite : ouvrez ce fichier, copiez-le entièrement et collez-le');
  console.log('  dans le fichier Code.gs de votre projet Apps Script.');
}

/**
 * Point d'entrée : n'exécute la construction que si le fichier est lancé
 * directement (pas quand outils/test.mjs l'importe).
 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  construire().catch((e) => {
    console.error(`Échec de la construction : ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  });
}
