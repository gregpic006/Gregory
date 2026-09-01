/**
 * dns.mjs — Commande « dns » : est-ce que le DNS du domaine est bien branché ?
 *
 * POURQUOI CETTE COMMANDE EXISTE
 * Toutes les autres commandes de la trousse parlent à Google. Celle-ci parle au
 * DNS public — l'annuaire mondial qui dit « les courriels de tondomaine.ca, il
 * faut les livrer à tel serveur ». Google Workspace peut être parfaitement
 * configuré côté console et les courriels partir quand même ailleurs (ou nulle
 * part) parce que quatre lignes n'ont pas été posées chez le registraire.
 *
 * C'est le genre de panne qui ne se voit pas : la boîte de réception est
 * simplement vide, et on met trois semaines à comprendre que les clients
 * écrivaient à un serveur qui n'existe plus.
 *
 * LECTURE SEULE, SANS EXCEPTION. Cette commande ne fait que des requêtes DNS.
 * Elle ignore volontairement --apply : il n'y a rien à appliquer. Elle ne
 * touche ni à Google, ni au registraire, ni au fichier de configuration.
 *
 * ZÉRO DÉPENDANCE ET ZÉRO AUTHENTIFICATION. Elle n'utilise que `node:dns`,
 * fourni avec Node. Conséquence pratique : elle fonctionne AVANT d'avoir un
 * config.json, avant d'avoir un client OAuth, avant même d'avoir un compte
 * Workspace. C'est souvent la toute première chose à lancer quand « les
 * courriels ne rentrent pas ».
 *
 * LES SIX CONTRÔLES :
 *   1. MX     — les courriels du domaine s'en vont-ils chez Google ?  (le plus grave)
 *   2. SPF    — Google a-t-il le droit d'envoyer des courriels en ton nom ?
 *   3. DMARC  — que doivent faire les autres serveurs face à un imposteur ?
 *   4. DKIM   — les courriels partants sont-ils signés ?
 *   5. NS     — qui gère le DNS du domaine ?  (pour savoir OÙ aller corriger)
 *   6. A      — le domaine pointe-t-il vers un site web ?  (information)
 *
 * Verdict et code de sortie : 0 si aucun [ÉCHEC], 1 dès qu'il y en a un.
 * Un [AVERT] ne fait jamais échouer la commande.
 *
 * OÙ LE DOMAINE EST PRIS : `config.domain`, ou l'option `--domain <domaine>`
 * qui a priorité. L'option existe justement pour pouvoir lancer le contrôle
 * avant d'avoir une configuration :
 *
 *     node src/cli.mjs dns --domain tondomaine.ca
 *     node src/commands/dns.mjs --domain tondomaine.ca     (sans config.json du tout)
 */

import { Resolver } from 'node:dns/promises';
import { resolve as resolveChemin } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import baseLog from '../lib/log.mjs';

export const meta = {
  name: 'dns',
  summary:
    'Vérifie le DNS du domaine : MX (livraison des courriels), SPF, DMARC, DKIM, ' +
    'plus qui gère le DNS. Aucune connexion à Google, ne modifie rien.',
};

/* ================================================================== *
 * Réglages des requêtes DNS
 * ================================================================== */

/**
 * Délai maximal d'une requête, en millisecondes, et nombre de tentatives.
 *
 * On garde ça court volontairement : six contrôles qui attendent chacun trente
 * secondes, ça donne une commande que personne n'a la patience de lancer. Un
 * serveur DNS en santé répond en moins de 100 ms ; 5 secondes, c'est déjà
 * énorme.
 */
const DNS_TIMEOUT_MS = 5000;
const DNS_TENTATIVES = 2;

/** Garde-fou global : si la bibliothèque DNS reste bloquée, on coupe nous-mêmes. */
const DNS_LIMITE_DURE_MS = DNS_TIMEOUT_MS * (DNS_TENTATIVES + 1);

/**
 * Traduction des codes d'erreur de la bibliothèque DNS de Node (c-ares).
 * Sans ça, l'usager lit « ESERVFAIL » et n'apprend rien.
 */
const CODES_DNS = {
  ENOTFOUND: "ce nom n'existe pas dans le DNS (réponse NXDOMAIN)",
  ENODATA: "ce nom existe, mais il n'a aucun enregistrement de ce type",
  ETIMEOUT: 'le serveur DNS de cette machine ne répond pas assez vite',
  ESERVFAIL: 'le serveur DNS a répondu « échec » (SERVFAIL) — zone mal signée (DNSSEC) ou serveur en panne',
  EREFUSED: 'le serveur DNS a refusé de répondre',
  ECONNREFUSED: 'le serveur DNS de cette machine refuse les connexions',
  EBADRESP: 'la réponse du serveur DNS est illisible',
  ECANCELLED: 'la requête DNS a été annulée',
  ENOTIMP: 'le serveur DNS ne sait pas traiter ce type de requête',
  EBADNAME: "le nom demandé n'est pas un nom de domaine valide",
  ENOMEM: 'plus assez de mémoire pour faire la requête',
};

/* ================================================================== *
 * Ce à quoi ressemble une configuration Google
 * ================================================================== */

/**
 * Un serveur de courriel appartient à Google si son nom se termine par un de
 * ces domaines. On compare sur la frontière de point (« .google.com ») et pas
 * avec un simple `includes` : « faussegoogle.com » ne doit pas passer.
 */
const DOMAINES_MX_GOOGLE = ['google.com', 'googlemail.com'];

/** Le seul enregistrement MX dont Google a besoin depuis 2023. */
const MX_MODERNE = 'smtp.google.com';

/** L'ancienne série de cinq MX. Toujours valide, mais Google ne la donne plus. */
const MX_CLASSIQUES = [
  'aspmx.l.google.com',
  'alt1.aspmx.l.google.com',
  'alt2.aspmx.l.google.com',
  'alt3.aspmx.l.google.com',
  'alt4.aspmx.l.google.com',
];

/**
 * Fournisseurs de courriel reconnaissables à leur MX. Sert uniquement à dire
 * « tes courriels s'en vont chez Microsoft » au lieu de « ce MX n'est pas
 * Google » — c'est infiniment plus utile pour comprendre quoi faire.
 */
const AUTRES_FOURNISSEURS_MX = [
  { motif: 'mail.protection.outlook.com', nom: 'Microsoft 365 / Outlook' },
  { motif: 'outlook.com', nom: 'Microsoft / Outlook' },
  { motif: 'pphosted.com', nom: 'Proofpoint (filtre antipourriel en amont)' },
  { motif: 'mimecast.com', nom: 'Mimecast (filtre antipourriel en amont)' },
  { motif: 'barracudanetworks.com', nom: 'Barracuda (filtre antipourriel en amont)' },
  { motif: 'messagelabs.com', nom: 'Symantec MessageLabs (filtre en amont)' },
  { motif: 'zoho', nom: 'Zoho Mail' },
  { motif: 'improvmx.com', nom: 'ImprovMX (redirection de courriels)' },
  { motif: 'forwardemail.net', nom: 'ForwardEmail (redirection de courriels)' },
  { motif: 'migadu.com', nom: 'Migadu' },
  { motif: 'protonmail', nom: 'Proton Mail' },
  { motif: 'fastmail.com', nom: 'Fastmail' },
  { motif: 'messagingengine.com', nom: 'Fastmail' },
  { motif: 'yandex', nom: 'Yandex Mail' },
  { motif: 'secureserver.net', nom: 'GoDaddy (courriel inclus avec le domaine)' },
  { motif: 'ovh.net', nom: 'OVH' },
  { motif: 'ovh.ca', nom: 'OVH' },
  { motif: 'hostinger', nom: 'Hostinger' },
  { motif: 'ionos', nom: 'IONOS' },
  { motif: 'bluehost.com', nom: 'Bluehost' },
  { motif: 'cpanel', nom: 'un hébergeur web avec cPanel' },
  { motif: 'websitewelcome.com', nom: 'HostGator' },
];

/** L'inclusion SPF que Google demande. Rien d'autre n'autorise ses serveurs. */
const INCLUSION_SPF_GOOGLE = '_spf.google.com';

/** Le sélecteur DKIM que Google propose par défaut. */
const SELECTEUR_DKIM = 'google';

/**
 * Qui héberge le DNS, reconnu au nom des serveurs de noms. C'est l'information
 * qui manque toujours quand on veut corriger : « va changer ça chez ton
 * registraire » ne sert à rien si personne ne se souvient duquel il s'agit.
 */
const HEBERGEURS_DNS = [
  { motif: 'cloudflare.com', nom: 'Cloudflare', ou: 'dash.cloudflare.com > ton domaine > DNS' },
  { motif: 'domaincontrol.com', nom: 'GoDaddy', ou: 'godaddy.com > Mes produits > Domaines > DNS' },
  { motif: 'secureserver.net', nom: 'GoDaddy', ou: 'godaddy.com > Mes produits > Domaines > DNS' },
  { motif: 'registrar-servers.com', nom: 'Namecheap', ou: 'namecheap.com > Domain List > Manage > Advanced DNS' },
  { motif: 'awsdns', nom: 'Amazon Route 53', ou: 'console AWS > Route 53 > Hosted zones' },
  { motif: 'azure-dns', nom: 'Microsoft Azure DNS', ou: 'portal.azure.com > DNS zones' },
  { motif: 'ovh.net', nom: 'OVH', ou: 'ovh.com > Noms de domaine > Zone DNS' },
  { motif: 'ovh.ca', nom: 'OVH', ou: 'ovh.com > Noms de domaine > Zone DNS' },
  { motif: 'googledomains.com', nom: 'Google Domains (repris par Squarespace en 2023)', ou: 'account.squarespace.com > Domains' },
  { motif: 'squarespacedns.com', nom: 'Squarespace', ou: 'account.squarespace.com > Domains > DNS' },
  { motif: 'wixdns.net', nom: 'Wix', ou: 'wix.com > Domaines > Avancé > Enregistrements DNS' },
  { motif: 'shopify', nom: 'Shopify', ou: 'admin Shopify > Paramètres > Domaines' },
  { motif: 'gandi.net', nom: 'Gandi', ou: 'admin.gandi.net > Domaines > Enregistrements DNS' },
  { motif: 'dnsimple.com', nom: 'DNSimple', ou: 'dnsimple.com > ton domaine > DNS' },
  { motif: 'nsone.net', nom: 'NS1', ou: 'ns1.com > Zones' },
  { motif: 'dnsmadeeasy.com', nom: 'DNS Made Easy', ou: 'cp.dnsmadeeasy.com' },
  { motif: 'easydns.com', nom: 'easyDNS', ou: 'cp.easydns.com' },
  { motif: 'hover.com', nom: 'Hover', ou: 'hover.com > ton domaine > DNS' },
  { motif: 'name.com', nom: 'Name.com', ou: 'name.com > Domaines > DNS Records' },
  { motif: 'webnames.ca', nom: 'Webnames.ca', ou: 'webnames.ca > Mon compte > Gestion DNS' },
  { motif: 'namespro', nom: 'Namespro.ca', ou: 'namespro.ca > Mes domaines > Gestion DNS' },
  { motif: 'koumbit.net', nom: 'Koumbit', ou: 'panneau de gestion Koumbit' },
  { motif: 'ui-dns', nom: 'IONOS', ou: 'ionos.ca > Domaines et SSL > DNS' },
  { motif: 'bluehost.com', nom: 'Bluehost', ou: 'bluehost.com > Domains > DNS' },
  { motif: 'hostinger', nom: 'Hostinger', ou: 'hpanel.hostinger.com > Domaines > Zone DNS' },
  { motif: 'hostgator', nom: 'HostGator', ou: 'portal.hostgator.com > Domaines > DNS' },
  { motif: 'vercel-dns.com', nom: 'Vercel', ou: 'vercel.com > Domains' },
  { motif: 'netlify.com', nom: 'Netlify', ou: 'app.netlify.com > Domains' },
  { motif: 'digitalocean.com', nom: 'DigitalOcean', ou: 'cloud.digitalocean.com > Networking > Domains' },
  { motif: 'linode.com', nom: 'Akamai / Linode', ou: 'cloud.linode.com > Domains' },
  { motif: 'porkbun.com', nom: 'Porkbun', ou: 'porkbun.com > Domain Management > DNS' },
];

/**
 * Titre de chaque contrôle, au même endroit : ils servent à la fois quand le
 * contrôle s'exécute et quand il est déclaré « sans objet ».
 */
const TITRES = {
  1: 'MX — la livraison des courriels',
  2: "SPF — qui a le droit d'écrire en ton nom",
  3: 'DMARC — quoi faire des imposteurs',
  4: 'DKIM — la signature des courriels partants',
  5: 'NS — qui gère le DNS du domaine',
  6: 'A — le site web du domaine',
};

/* ================================================================== *
 * Statuts et affichage
 * ================================================================== */

const STATUT = {
  OK: 'OK',
  ECHEC: 'ÉCHEC',
  AVERT: 'AVERT',
  INFO: 'INFO',
};

/**
 * Ordre de gravité. Le statut d'un contrôle est le plus grave de ses lignes.
 * « INFO » est le plus bas : une ligne d'information ne décide de rien.
 */
const GRAVITE = { [STATUT.INFO]: 0, [STATUT.OK]: 1, [STATUT.AVERT]: 2, [STATUT.ECHEC]: 3 };

/**
 * Caractère d'échappement ANSI. On le construit au lieu de l'écrire en clair :
 * un caractère de contrôle invisible dans un fichier source, c'est le genre de
 * chose qui survit mal à un copier-coller ou à un éditeur mal réglé.
 */
const ESC = String.fromCharCode(27);
const COULEURS = {
  [STATUT.OK]: ESC + '[32m',
  [STATUT.ECHEC]: ESC + '[31m',
  [STATUT.AVERT]: ESC + '[33m',
  [STATUT.INFO]: ESC + '[90m',
};
const GRIS = ESC + '[90m';
const GRAS = ESC + '[1m';
const RESET = ESC + '[0m';

/** Vrai si la sortie accepte les couleurs. On réutilise la décision de log.mjs. */
function couleurActive() {
  try {
    return Boolean(baseLog.isColorEnabled?.());
  } catch {
    return false;
  }
}

/** Fabrique le marqueur « [OK] » / « [ÉCHEC] » / « [AVERT] » / « [INFO] ». */
function marqueur(statut) {
  const texte = `[${statut}]`.padEnd(8, ' ');
  if (!couleurActive()) return texte;
  return `${GRAS}${COULEURS[statut] ?? ''}${texte}${RESET}`;
}

/** Met un texte en gris, si la couleur est active. */
function gris(texte) {
  return couleurActive() ? `${GRIS}${texte}${RESET}` : texte;
}

/**
 * Complète le journal fourni par le CLI.
 *
 * cli.mjs « durcit » le journal en ne gardant qu'une poignée de fonctions :
 * raw, blank, bold et dim peuvent donc être absentes. On retombe alors sur le
 * vrai module plutôt que de planter en plein milieu d'un affichage.
 */
function makeView(injected) {
  const noms = ['banner', 'step', 'info', 'ok', 'warn', 'err', 'plan', 'skip', 'table', 'raw', 'blank', 'bold', 'dim'];
  const view = {};
  for (const nom of noms) {
    view[nom] = typeof injected?.[nom] === 'function' ? injected[nom] : baseLog[nom];
  }
  return view;
}

/* ================================================================== *
 * Petits utilitaires
 * ================================================================== */

/** Minuscules, sans espace autour. */
const bas = (valeur) => String(valeur ?? '').trim().toLowerCase();

/** Un nom DNS se termine parfois par un point (forme absolue) : on l'enlève. */
const sansPointFinal = (nom) => bas(nom).replace(/\.+$/, '');

/** Tronque un texte long pour garder le rapport lisible dans un terminal. */
function couper(texte, max = 300) {
  const s = String(texte ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Vrai si `nom` est `suffixe` ou un sous-domaine de `suffixe`.
 * On teste la frontière de point pour ne pas confondre « google.com » avec
 * « pasgoogle.com ».
 */
function estSousDomaineDe(nom, suffixe) {
  const n = sansPointFinal(nom);
  const s = sansPointFinal(suffixe);
  return n === s || n.endsWith(`.${s}`);
}

/** Vrai si ce serveur de courriel appartient à Google. */
function estMxGoogle(hote) {
  return DOMAINES_MX_GOOGLE.some((suffixe) => estSousDomaineDe(hote, suffixe));
}

/**
 * Vrai si un nom de serveur correspond au motif d'un fournisseur.
 *
 * Un motif qui contient un point est un vrai nom de domaine : on exige alors la
 * frontière de point, exactement comme pour Google. Sans ça, le motif
 * « name.com » se reconnaîtrait dans « ns1.monhostname.com » et la commande
 * annoncerait à quelqu'un d'aller corriger son DNS chez le mauvais fournisseur
 * — un mauvais conseil est pire que pas de conseil du tout.
 *
 * Un motif sans point (« awsdns », « zoho ») est un fragment volontaire : ces
 * fournisseurs-là changent d'extension selon le pays. On le cherche tel quel.
 */
function correspondAuMotif(hote, motif) {
  const h = sansPointFinal(hote);
  const m = sansPointFinal(motif);
  if (!h || !m) return false;
  return m.includes('.') ? estSousDomaineDe(h, m) : h.includes(m);
}

/** Nom du fournisseur reconnu derrière un MX, ou null. */
function fournisseurDuMx(hote) {
  const trouve = AUTRES_FOURNISSEURS_MX.find((f) => correspondAuMotif(hote, f.motif));
  return trouve ? trouve.nom : null;
}

/** Hébergeur DNS reconnu derrière un serveur de noms, ou null. */
function hebergeurDuNs(hote) {
  return HEBERGEURS_DNS.find((f) => correspondAuMotif(hote, f.motif)) ?? null;
}

/** Explication française d'un code d'erreur DNS. */
function expliquerCodeDns(code) {
  return CODES_DNS[code] ?? `code d'erreur DNS « ${code} » (peu courant)`;
}

/**
 * Nom de domaine simple : lettres, chiffres, tirets, au moins un point, et une
 * extension d'au moins deux lettres. Les domaines internationaux passent par
 * leur forme « xn-- », qui respecte le même jeu de caractères.
 */
const DOMAINE_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Convertit un domaine accentué en sa forme « punycode ».
 *
 * POURQUOI : le DNS ne transporte que de l'ASCII. « québec.ca » n'existe pas
 * dans le DNS ; ce qui existe, c'est « xn--qubec-csa.ca ». Les domaines .ca et
 * .quebec accentués sont bien réels, et quelqu'un qui tape le sien tel qu'il
 * l'a acheté doit obtenir un diagnostic, pas « nom de domaine invalide ».
 *
 * On passe par `URL`, qui applique la conversion normalisée (UTS-46) fournie
 * avec Node — plutôt que de la réécrire à la main.
 *
 * @param {string} nom
 * @returns {string} la forme punycode, ou le nom inchangé si rien à convertir
 */
function versPunycode(nom) {
  // Déjà entièrement en ASCII : rien à faire, et surtout rien à risquer.
  // On regarde les points de code plutôt que d'écrire une plage de caractères
  // de contrôle en clair dans le source : cf. la note sur ESC plus haut.
  if (![...nom].some((c) => c.codePointAt(0) > 127)) return nom;
  try {
    const converti = sansPointFinal(new URL(`http://${nom}`).hostname);
    return converti || nom;
  } catch {
    return nom; // Nom réellement impossible : le contrôle de validité le dira.
  }
}

/**
 * Nettoie ce que la personne a tapé pour en tirer un nom de domaine.
 *
 * On accepte volontairement les formes fautives les plus fréquentes
 * (https://…, greg@…, …/, point final, www.) parce que c'est exactement ce que
 * les gens copient-collent. Chaque correction est ANNONCÉE : on ne change
 * jamais silencieusement ce que quelqu'un a écrit.
 *
 * @param {unknown} brut
 * @returns {{ domaine: string|null, notes: string[] }}
 */
function normaliserDomaine(brut) {
  const notes = [];
  let d = bas(brut);
  if (!d) return { domaine: null, notes };

  if (d.includes('://')) {
    d = d.slice(d.indexOf('://') + 3);
    notes.push("L'adresse commençait par « http:// » ou « https:// » : on garde seulement le nom de domaine.");
  }

  // Le chemin se coupe AVANT l'arobase : dans « https://site.ca/photos/a@b », le
  // « @ » appartient au chemin, ce n'est pas une adresse courriel.
  const avantChemin = d;
  d = d.split('/')[0].split('?')[0].split('#')[0];
  if (d !== avantChemin) {
    notes.push(
      "Tout ce qui suivait la barre oblique (le chemin d'une page web) a été retiré : le DNS " +
        'ne connaît que le nom de domaine.',
    );
  }

  if (d.includes('@')) {
    d = d.slice(d.lastIndexOf('@') + 1);
    notes.push("C'était une adresse courriel : on garde seulement ce qui suit l'arobase.");
  }

  const avantPort = d;
  d = d.replace(/:\d+$/, '');
  if (d !== avantPort) {
    notes.push('Le numéro de port (« :443 », par exemple) a été retiré : le DNS n\'en tient pas compte.');
  }

  const avantPointFinal = d;
  d = d.replace(/\.+$/, '');
  if (d !== avantPointFinal) {
    notes.push('Le point final a été retiré : « exemple.ca. » et « exemple.ca » sont le même domaine.');
  }

  if (d.startsWith('www.') && d.split('.').length > 2) {
    d = d.slice(4);
    notes.push(
      'Le « www. » a été retiré : les enregistrements de courriel (MX, SPF, DMARC) se posent ' +
        'toujours sur le domaine racine, jamais sur www.',
    );
  }

  const punycode = versPunycode(d);
  if (punycode !== d) {
    notes.push(
      `Le domaine contient des accents. Le DNS, lui, ne connaît que sa forme « punycode » :\n` +
        `on interroge donc « ${punycode} », qui désigne exactement le même domaine que « ${d} ».`,
    );
    d = punycode;
  }

  return { domaine: d || null, notes };
}

/* ================================================================== *
 * Code de sortie
 * ================================================================== */

let sortieDejaForcee = false;

/**
 * Force le code de sortie du processus.
 *
 * Pourquoi ce détour : cli.mjs se termine par `process.exit(exitCode)` où
 * `exitCode` vaut 0 quand la commande n'a pas levé d'exception. Un simple
 * `process.exitCode = 1` serait donc écrasé. En revanche, un gestionnaire
 * `process.on('exit')` s'exécute APRÈS l'appel à process.exit() et peut encore
 * changer le code — comportement vérifié sur Node 22. C'est exactement ce que
 * fait « verify », et les deux commandes doivent se comporter pareil.
 *
 * On ne lève surtout pas d'exception à la place : « dns » qui trouve un MX
 * fautif n'est pas un plantage de la trousse, et une exception afficherait un
 * message de panne à la place du verdict.
 */
function forcerCodeDeSortie(code) {
  if (!code) return;
  process.exitCode = code;
  if (sortieDejaForcee) return;
  sortieDejaForcee = true;
  process.on('exit', () => {
    process.exitCode = code;
  });
}

/* ================================================================== *
 * Le rapport
 * ================================================================== */

/**
 * Accumule les résultats et les affiche au fur et à mesure.
 *
 * Chaque ligne est « [STATUT] explication », suivie au besoin de lignes « → »
 * qui disent EXACTEMENT quoi faire. Le statut d'un contrôle est le plus grave
 * de ses lignes.
 */
function creerRapport(view) {
  /** @type {Array<{ numero: number, titre: string, statut: string }>} */
  const controles = [];
  /** @type {string[]} */ const echecs = [];
  /** @type {string[]} */ const averts = [];
  let courant = null;

  function ecrire(texte) {
    try {
      view.raw(texte);
    } catch {
      console.log(texte);
    }
  }

  function ligne(statut, texte, correction) {
    ecrire(`  ${marqueur(statut)} ${couper(texte)}`);
    if (correction) {
      for (const bout of String(correction).split('\n')) {
        ecrire(`           ${gris(`→ ${bout}`)}`);
      }
    }

    if (courant && GRAVITE[statut] > GRAVITE[courant.statut]) courant.statut = statut;

    const entree = courant ? `Contrôle ${courant.numero} (${courant.titre}) : ${texte}` : texte;
    const complet = correction ? `${entree} → ${String(correction).split('\n')[0]}` : entree;
    if (statut === STATUT.ECHEC) echecs.push(complet);
    else if (statut === STATUT.AVERT) averts.push(complet);
  }

  return {
    controles,
    echecs,
    averts,
    ecrire,

    /** Ouvre un contrôle. Son statut démarre à « INFO » et monte avec les lignes. */
    ouvrir(numero, titre) {
      view.step(`Contrôle ${numero} — ${titre}`);
      courant = { numero, titre, statut: STATUT.INFO };
      controles.push(courant);
    },

    /** Ferme le contrôle courant et rappelle son verdict. */
    fermer() {
      if (!courant) return;
      ecrire(`  ${marqueur(courant.statut)} ${gris(`Contrôle ${courant.numero} : ${courant.titre}`)}`);
      courant = null;
    },

    /** Contexte neutre, sans effet sur le verdict. */
    note: (texte) => view.info(texte),

    ok: (texte, correction) => ligne(STATUT.OK, texte, correction),
    echec: (texte, correction) => ligne(STATUT.ECHEC, texte, correction),
    avert: (texte, correction) => ligne(STATUT.AVERT, texte, correction),
    info: (texte, correction) => ligne(STATUT.INFO, texte, correction),
  };
}

/* ================================================================== *
 * La brique de base : une requête DNS qui ne fait jamais planter
 * ================================================================== */

/**
 * Fait une requête DNS et range le résultat dans trois cas nets.
 *
 * La distinction qui compte, et que la commande répète partout :
 *   - « vide »   : la question a eu une réponse, et la réponse est « il n'y a
 *                  rien ». C'est un vrai résultat, sur lequel on peut conclure.
 *   - « erreur » : on n'a PAS eu de réponse (serveur DNS injoignable, délai
 *                  dépassé, zone en panne). On ne conclut rien du tout — dire
 *                  « ton SPF est absent » alors qu'on n'a pas pu regarder,
 *                  c'est envoyer quelqu'un modifier son DNS pour rien.
 *
 * @param {import('node:dns/promises').Resolver} resolver
 * @param {'resolveMx'|'resolveTxt'|'resolveNs'|'resolve4'} methode
 * @param {string} nom
 * @returns {Promise<{ etat: 'trouve'|'vide'|'erreur', enregistrements: any[], code: string|null, message: string|null, ms: number }>}
 */
async function interroger(resolver, methode, nom) {
  const debut = Date.now();
  let minuterie = null;

  try {
    const requete = resolver[methode](nom);

    // Filet de sécurité : la bibliothèque a déjà son propre délai, mais un
    // serveur DNS qui accepte la connexion sans jamais répondre peut le
    // contourner. On coupe alors nous-mêmes.
    const limite = new Promise((_, rejeter) => {
      minuterie = setTimeout(() => {
        const e = new Error(`aucune réponse après ${DNS_LIMITE_DURE_MS} ms`);
        e.code = 'ETIMEOUT';
        rejeter(e);
      }, DNS_LIMITE_DURE_MS);
      if (typeof minuterie.unref === 'function') minuterie.unref();
    });

    const brut = await Promise.race([requete, limite]);
    const liste = Array.isArray(brut) ? brut : [];
    const ms = Date.now() - debut;

    if (liste.length === 0) {
      return { etat: 'vide', enregistrements: [], code: 'ENODATA', message: null, ms };
    }
    return { etat: 'trouve', enregistrements: liste, code: null, message: null, ms };
  } catch (error) {
    const ms = Date.now() - debut;
    const code = String(error?.code ?? '').toUpperCase() || 'INCONNU';
    const message = error?.message ?? String(error);

    // NXDOMAIN et NODATA ne sont pas des pannes : ce sont des réponses.
    if (code === 'ENODATA' || code === 'ENOTFOUND') {
      return { etat: 'vide', enregistrements: [], code, message, ms };
    }
    return { etat: 'erreur', enregistrements: [], code, message, ms };
  } finally {
    if (minuterie) clearTimeout(minuterie);
  }
}

/**
 * Recolle un enregistrement TXT.
 *
 * PIÈGE CLASSIQUE : un TXT est découpé en morceaux de 255 caractères maximum,
 * et `resolveTxt` rend donc un TABLEAU DE TABLEAUX de chaînes. Une clé DKIM
 * dépasse toujours 255 caractères : elle arrive systématiquement en deux ou
 * trois morceaux. On les recolle SANS séparateur — c'est ce que dit la norme,
 * et mettre une espace au milieu casserait la clé.
 */
function recollerTxt(enregistrement) {
  if (Array.isArray(enregistrement)) return enregistrement.map((m) => String(m ?? '')).join('');
  return String(enregistrement ?? '');
}

/* ================================================================== *
 * Contrôle 1 — MX : où s'en vont les courriels du domaine
 * ================================================================== */

async function controleMx({ resolver, domaine, rapport, view }) {
  rapport.ouvrir(1, TITRES[1]);
  rapport.note(
    "L'enregistrement MX est le panneau routier du courriel : il dit au monde entier à quel\n" +
      `serveur livrer ce qui est adressé à @${domaine}. S'il ne pointe pas vers Google, ton\n` +
      'Google Workspace peut être parfait, les courriels de tes clients ne rentreront jamais\n' +
      "dedans. C'est le problème le plus grave que cette commande peut trouver.",
  );

  const res = await interroger(resolver, 'resolveMx', domaine);

  if (res.etat === 'erreur') {
    rapport.avert(
      `Impossible de vérifier les MX : ${expliquerCodeDns(res.code)}.`,
      "Ce n'est PAS un diagnostic sur ton domaine : la requête n'a pas abouti, donc on ne sait rien.\n" +
        'Vérifie ta connexion Internet, puis relance. Pour comparer avec un autre outil :\n' +
        `  nslookup -type=mx ${domaine} 8.8.8.8`,
    );
    rapport.fermer();
    return;
  }

  if (res.etat === 'vide') {
    // NXDOMAIN = le domaine lui-même n'existe pas. On le retient : les cinq
    // contrôles suivants n'auraient plus rien d'utile à dire.
    const inexistant = res.code === 'ENOTFOUND';
    if (inexistant) {
      rapport.echec(
        `Le domaine « ${domaine} » n'existe pas dans le DNS mondial (réponse NXDOMAIN).`,
        "Trois causes possibles, dans l'ordre de fréquence :\n" +
          '  1. faute de frappe dans le nom — relance avec : node src/cli.mjs dns --domain <le-bon-domaine>\n' +
          "  2. le domaine vient d'être acheté et n'est pas encore propagé (compte jusqu'à 48 h) ;\n" +
          '  3. le domaine est expiré — vérifie la date de renouvellement chez ton registraire.',
      );
    } else {
      rapport.echec(
        `Le domaine « ${domaine} » existe, mais il n'a AUCUN enregistrement MX. ` +
          'Personne au monde ne peut lui livrer un courriel.',
        'Chez le gestionnaire de ton DNS (voir le contrôle 5), ajoute cet enregistrement :\n' +
          `  Type MX · Nom : @ (ou ${domaine}) · Priorité : 1 · Valeur : ${MX_MODERNE}\n` +
          'Un seul suffit depuis 2023. Compte de 1 à 4 heures avant que ça prenne effet partout.',
      );
    }
    rapport.fermer();
    return { existe: !inexistant };
  }

  const tous = res.enregistrements.map((mx) => ({
    hote: sansPointFinal(mx?.exchange),
    priorite: Number.isFinite(Number(mx?.priority)) ? Number(mx.priority) : 0,
  }));

  // Tri par priorité croissante : c'est l'ordre dans lequel le monde les essaie.
  const entrees = tous
    .filter((e) => e.hote)
    .sort((a, b) => a.priorite - b.priorite || a.hote.localeCompare(b.hote));

  /*
   * LE « MX NUL ». Un enregistrement « priorité 0, valeur . » n'est pas une
   * faute de saisie : c'est une déclaration volontaire et normalisée qui veut
   * dire « ce domaine ne reçoit aucun courriel, n'essayez même pas ». Afficher
   * « aucun MX trouvé » enverrait quelqu'un chercher un enregistrement effacé
   * par erreur, alors que celui qui est là fait exactement son travail.
   */
  if (entrees.length === 0) {
    const nul = tous.length > 0;
    rapport.echec(
      nul
        ? `Le domaine « ${domaine} » déclare EXPLICITEMENT qu'il ne reçoit aucun courriel ` +
            "(enregistrement « MX nul » : priorité 0, valeur « . »)."
        : `Le domaine « ${domaine} » n'a aucun enregistrement MX exploitable.`,
      `Si @${domaine} doit recevoir du courrier dans Google Workspace, il faut SUPPRIMER cet\n` +
        'enregistrement et le remplacer, chez le gestionnaire de ton DNS (contrôle 5), par :\n' +
        `  Type MX · Nom : @ · Priorité : 1 · Valeur : ${MX_MODERNE}\n` +
        `Si au contraire le domaine ne sert qu'au site web et que personne n'écrit à @${domaine},\n` +
        "c'est correct tel quel — mais alors aucune boîte Workspace ne recevra jamais de courriel.",
    );
    rapport.fermer();
    return { existe: true };
  }

  view.table(
    entrees.map((e) => ({
      Priorité: e.priorite,
      'Serveur de courriel': e.hote,
      'Chez Google ?': estMxGoogle(e.hote) ? 'oui' : (fournisseurDuMx(e.hote) ?? 'non'),
    })),
  );

  const chezGoogle = entrees.filter((e) => estMxGoogle(e.hote));
  const ailleurs = entrees.filter((e) => !estMxGoogle(e.hote));

  if (chezGoogle.length === 0) {
    const fournisseurs = [...new Set(ailleurs.map((e) => fournisseurDuMx(e.hote)).filter(Boolean))];
    const chez = fournisseurs.length > 0 ? ` Ils s'en vont chez : ${fournisseurs.join(', ')}.` : '';
    rapport.echec(
      `AUCUN des ${entrees.length} MX du domaine ne pointe vers Google.${chez} ` +
        `Les courriels envoyés à @${domaine} n'arrivent PAS dans Google Workspace.`,
      "Tant que ce n'est pas corrigé, le reste de la trousse ne sert à rien : les boîtes de\n" +
        'réception resteront vides.\n' +
        'Chez le gestionnaire de ton DNS (contrôle 5), REMPLACE tous les MX existants par :\n' +
        `  Type MX · Nom : @ · Priorité : 1 · Valeur : ${MX_MODERNE}\n` +
        'ATTENTION avant de le faire : si une vraie boîte de courriel est encore active chez\n' +
        "l'ancien fournisseur, transfère son contenu AVANT de basculer, sinon le nouveau\n" +
        "courrier arrive chez Google pendant que l'ancien reste coincé ailleurs.",
    );
    rapport.fermer();
    return;
  }

  if (ailleurs.length > 0) {
    const plusPrioritaire = entrees[0];
    const detail = ailleurs.map((e) => `${e.hote} (priorité ${e.priorite})`).join(', ');
    rapport.avert(
      `Configuration mixte : ${chezGoogle.length} MX chez Google et ${ailleurs.length} ailleurs (${detail}).`,
      estMxGoogle(plusPrioritaire.hote)
        ? 'Le MX le plus prioritaire est bien celui de Google, donc le courrier normal entre. Les\n' +
            "autres servent de secours — c'est parfois voulu (filtre antipourriel, migration en\n" +
            "cours), parfois un reste d'ancienne configuration qu'on a oublié d'effacer.\n" +
            'Si tu ne sais pas à quoi ils servent : supprime-les. Un MX oublié est une porte\n' +
            "d'entrée pour du courrier qui n'arrivera jamais chez toi."
        : `Le MX le plus prioritaire (${plusPrioritaire.hote}, priorité ${plusPrioritaire.priorite}) n'est PAS\n` +
            "celui de Google : c'est LUI qui reçoit le courrier en premier. Si c'est un filtre\n" +
            'antipourriel qui relaie ensuite vers Google, tout va bien. Sinon, une partie de ton\n' +
            "courrier n'entre pas dans Workspace — à corriger en priorité.",
    );
  }

  const noms = chezGoogle.map((e) => e.hote);
  const moderne = noms.includes(MX_MODERNE);
  const classiquesTrouves = MX_CLASSIQUES.filter((h) => noms.includes(h));

  if (moderne && classiquesTrouves.length === 0 && ailleurs.length === 0) {
    rapport.ok(
      `Les courriels de @${domaine} sont livrés à Google (${MX_MODERNE}). ` +
        "C'est la configuration recommandée par Google depuis 2023 : un seul MX.",
    );
  } else if (classiquesTrouves.length === MX_CLASSIQUES.length && !moderne) {
    rapport.ok(
      `Les courriels de @${domaine} sont livrés à Google, avec la série classique de 5 MX ` +
        '(aspmx.l.google.com et ses quatre alternatives).',
      'Rien à corriger : cette configuration reste parfaitement valide et supportée. Si tu veux\n' +
        `simplifier un jour, elle se remplace par un seul enregistrement : priorité 1, ${MX_MODERNE}.`,
    );
  } else if (moderne && classiquesTrouves.length > 0) {
    rapport.ok(
      `Les courriels de @${domaine} sont livrés à Google (${MX_MODERNE} + ` +
        `${classiquesTrouves.length} MX de l'ancienne série).`,
      "Les deux générations cohabitent. Ça fonctionne, mais c'est de la redondance inutile :\n" +
        `tu peux ne garder que « priorité 1 · ${MX_MODERNE} » et supprimer les autres.`,
    );
  } else if (classiquesTrouves.length > 0 && classiquesTrouves.length < MX_CLASSIQUES.length) {
    const manquants = MX_CLASSIQUES.filter((h) => !noms.includes(h));
    rapport.avert(
      `Série classique INCOMPLÈTE : ${classiquesTrouves.length} MX Google sur 5. ` +
        `Manquent : ${manquants.join(', ')}.`,
      "Le courrier entre quand même — les serveurs présents suffisent — mais il n'y a plus de\n" +
        "secours si l'un d'eux est indisponible.\n" +
        `Le plus simple : remplace TOUS les MX par un seul « priorité 1 · ${MX_MODERNE} ».`,
    );
  } else {
    rapport.ok(
      `Les courriels de @${domaine} sont livrés à Google (${noms.join(', ')}).`,
      'Ces noms appartiennent bien à Google, mais ce ne sont pas ceux de la documentation.\n' +
        `Si tu veux la configuration standard : un seul MX « priorité 1 · ${MX_MODERNE} ».`,
    );
  }

  rapport.fermer();
}

/* ================================================================== *
 * Contrôle 2 — SPF : qui a le droit d'écrire au nom du domaine
 * ================================================================== */

/**
 * Découpe un enregistrement SPF en ses mécanismes.
 * @param {string} texte
 */
function analyserSpf(texte) {
  const jetons = texte.trim().split(/\s+/).filter(Boolean);
  const mecanismes = jetons.slice(1); // le premier jeton est « v=spf1 »
  const inclusions = [];
  const tousLesAll = [];

  for (const jeton of mecanismes) {
    const all = /^([+\-~?]?)all$/i.exec(jeton);
    if (all) tousLesAll.push({ qualificatif: all[1] || '+', jeton });

    const inc = /^[+\-~?]?include:(.+)$/i.exec(jeton);
    if (inc) inclusions.push(sansPointFinal(inc[1]));

    const red = /^redirect=(.+)$/i.exec(jeton);
    if (red) inclusions.push(sansPointFinal(red[1]));
  }

  // SPF s'évalue de gauche à droite et s'arrête au PREMIER mécanisme qui
  // correspond. C'est donc le premier « all » qui décide, pas le dernier.
  return { mecanismes, inclusions, all: tousLesAll[0] ?? null, nombreDeAll: tousLesAll.length };
}

/** Ce que chaque qualificatif de « all » veut dire, en clair. */
const SPF_ALL = {
  '-': {
    resume: '-all (strict)',
    quoi:
      "tout serveur non listé est REFUSÉ. C'est le plus sévère, et le meilleur — à condition " +
      "d'avoir listé TOUS tes expéditeurs (Google, ton infolettre, ton logiciel de facturation).",
  },
  '~': {
    resume: '~all (souple)',
    quoi:
      "tout serveur non listé est marqué SUSPECT sans être refusé. C'est ce que Google " +
      "recommande, et c'est un très bon réglage.",
  },
  '?': {
    resume: '?all (neutre)',
    quoi: "aucune consigne n'est donnée aux serveurs qui reçoivent : le SPF ne protège alors presque rien.",
  },
  '+': {
    resume: '+all (tout permis)',
    quoi:
      "n'importe quel serveur de la planète est déclaré autorisé à écrire en ton nom. " +
      "C'est exactement le contraire de ce à quoi sert le SPF.",
  },
};

const SPF_RECOMMANDE = `v=spf1 include:${INCLUSION_SPF_GOOGLE} ~all`;

async function controleSpf({ resolver, domaine, rapport, view }) {
  rapport.ouvrir(2, TITRES[2]);
  rapport.note(
    `Le SPF est la liste des serveurs autorisés à envoyer des courriels signés @${domaine}.\n` +
      "Sans lui, les courriels que TON équipe envoie ont de bonnes chances d'atterrir dans les\n" +
      "pourriels de tes clients — et n'importe qui peut écrire en ton nom.",
  );

  const res = await interroger(resolver, 'resolveTxt', domaine);

  if (res.etat === 'erreur') {
    rapport.avert(
      `Impossible de lire les enregistrements TXT du domaine : ${expliquerCodeDns(res.code)}.`,
      "La requête n'a pas abouti : on ne conclut rien. Relance plus tard, ou compare avec :\n" +
        `  nslookup -type=txt ${domaine} 8.8.8.8`,
    );
    rapport.fermer();
    return;
  }

  const textes = res.enregistrements.map(recollerTxt);
  const spfs = textes.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));

  if (spfs.length === 0) {
    rapport.echec(
      `Aucun enregistrement SPF sur ${domaine}. Rien ne dit que Google a le droit d'envoyer ` +
        'des courriels en ton nom.',
      'Conséquence concrète : les courriels de ton équipe partent quand même, mais une partie\n' +
        'tombe dans les pourriels — et personne ne te le dira jamais.\n' +
        'Chez le gestionnaire de ton DNS (contrôle 5), ajoute :\n' +
        `  Type TXT · Nom : @ (ou ${domaine}) · Valeur : ${SPF_RECOMMANDE}\n` +
        'UN SEUL enregistrement SPF par domaine, jamais deux.',
    );
    rapport.fermer();
    return;
  }

  view.table(spfs.map((t, i) => ({ '#': i + 1, 'Enregistrement SPF': couper(t, 160) })));

  if (spfs.length > 1) {
    rapport.avert(
      `${spfs.length} enregistrements SPF trouvés. Il n'en faut qu'UN SEUL.`,
      "C'est l'erreur de configuration la plus fréquente, et elle est traître : selon la norme,\n" +
        'plusieurs SPF donnent un résultat « permerror » et les serveurs qui reçoivent jettent\n' +
        "toute la validation. Autrement dit : deux SPF protègent MOINS bien qu'un seul.\n" +
        'Quoi faire : fusionner tous les « include: » dans un seul enregistrement, puis supprimer\n' +
        'les autres. Exemple avec Google plus un autre expéditeur :\n' +
        `  v=spf1 include:${INCLUSION_SPF_GOOGLE} include:lautre-service.com ~all`,
    );
  }

  // On analyse le premier : c'est celui que les serveurs liraient s'il était seul.
  const principal = spfs[0].trim();
  const analyse = analyserSpf(principal);
  const inclutGoogle = analyse.inclusions.some(
    (inc) => inc === INCLUSION_SPF_GOOGLE || estSousDomaineDe(inc, INCLUSION_SPF_GOOGLE),
  );

  if (inclutGoogle) {
    rapport.ok(`Le SPF autorise bien les serveurs de Google (include:${INCLUSION_SPF_GOOGLE}).`);
  } else {
    const autres = analyse.inclusions.length > 0 ? ` Il autorise plutôt : ${analyse.inclusions.join(', ')}.` : '';
    rapport.echec(
      `Le SPF existe, mais il n'inclut PAS « ${INCLUSION_SPF_GOOGLE} ».${autres} ` +
        'Les serveurs de Google ne sont donc pas déclarés comme autorisés à écrire en ton nom.',
      "Ajoute l'inclusion de Google DANS l'enregistrement existant (n'en crée surtout pas un\n" +
        `deuxième). Il suffit d'insérer « include:${INCLUSION_SPF_GOOGLE} » avant le « all » final :\n` +
        `  ${principal.replace(/\s*[+\-~?]?all\s*$/i, '')} include:${INCLUSION_SPF_GOOGLE} ${analyse.all?.jeton ?? '~all'}`,
    );
  }

  if (!analyse.all) {
    rapport.avert(
      'Le SPF ne se termine par aucun mécanisme « all » : il ne dit rien sur les serveurs qui ne ' +
        'sont pas dans la liste.',
      'Par défaut, ça équivaut à « neutre » : la protection est quasi nulle. Termine ton\n' +
        `enregistrement par « ~all » (souple) ou « -all » (strict). Recommandé : ${SPF_RECOMMANDE}`,
    );
  } else {
    const q = analyse.all.qualificatif;
    const desc = SPF_ALL[q] ?? SPF_ALL['?'];

    if (q === '+') {
      rapport.avert(
        `Le SPF se termine par « ${analyse.all.jeton} » : ${desc.quoi}`,
        'À corriger : remplace-le par « ~all » (souple, recommandé par Google) ou « -all » (strict).\n' +
          `Enregistrement conseillé : ${SPF_RECOMMANDE}`,
      );
    } else if (q === '?') {
      rapport.avert(
        `Le SPF se termine par « ${analyse.all.jeton} » : ${desc.quoi}`,
        "Ce n'est pas dangereux, mais ça ne sert pas à grand-chose non plus. Remplace « ?all »\n" +
          'par « ~all » pour que tes courriels soient réellement mieux traités.',
      );
    } else {
      rapport.ok(`Le SPF se termine par « ${desc.resume} » : ${desc.quoi}`);
    }

    if (analyse.nombreDeAll > 1) {
      rapport.avert(
        `L'enregistrement contient ${analyse.nombreDeAll} mécanismes « all ». Seul le premier compte.`,
        'Garde-en un seul, tout à la fin de la ligne. Les autres ne sont jamais lus et ne font\n' +
          "que semer la confusion la prochaine fois que quelqu'un relit cette ligne.",
      );
    }
  }

  rapport.fermer();
}

/* ================================================================== *
 * Contrôle 3 — DMARC : quoi faire des imposteurs
 * ================================================================== */

/**
 * Découpe un enregistrement DMARC ou DKIM en étiquettes « clé=valeur ».
 * @param {string} texte
 * @returns {Record<string,string>}
 */
function analyserEtiquettes(texte) {
  /** @type {Record<string,string>} */
  const tags = {};
  for (const morceau of String(texte).split(';')) {
    const t = morceau.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    tags[t.slice(0, i).trim().toLowerCase()] = t.slice(i + 1).trim();
  }
  return tags;
}

/** Ce que chaque politique DMARC change concrètement pour un imposteur. */
const DMARC_POLITIQUES = {
  none: {
    statut: STATUT.AVERT,
    resume: 'p=none — observation seulement',
    quoi:
      'les serveurs qui reçoivent NE FONT RIEN de spécial contre un imposteur : ils se contentent ' +
      "de t'envoyer des rapports. C'est la bonne première étape quand on démarre, mais tant que " +
      "tu restes là, ton domaine n'est pas protégé contre l'usurpation.",
    correction:
      "Reste à « p=none » un mois, le temps de lire les rapports et de vérifier qu'aucun de tes\n" +
      "vrais expéditeurs n'échoue. Passe ensuite à « p=quarantine », puis à « p=reject ».",
  },
  quarantine: {
    statut: STATUT.OK,
    resume: 'p=quarantine — mise en quarantaine',
    quoi:
      'un courriel qui se fait passer pour ton domaine sans être authentifié part directement ' +
      "dans les pourriels du destinataire. C'est déjà une vraie protection.",
    correction:
      'Étape suivante quand tu es en confiance : « p=reject », qui fait carrément refuser le\n' +
      "courriel au lieu de l'envoyer dans les pourriels.",
  },
  reject: {
    statut: STATUT.OK,
    resume: 'p=reject — refus pur et simple',
    quoi:
      "un courriel qui se fait passer pour ton domaine est REFUSÉ avant même d'arriver. " +
      "C'est le réglage le plus protecteur, et celui à viser.",
    correction: null,
  },
};

async function controleDmarc({ resolver, domaine, rapport, view }) {
  const nom = `_dmarc.${domaine}`;
  rapport.ouvrir(3, TITRES[3]);
  rapport.note(
    "Le DMARC répond à une question que SPF et DKIM ne règlent pas : « et si quelqu'un écrit\n" +
      `en se faisant passer pour @${domaine}, qu'est-ce que le serveur qui reçoit doit en\n` +
      'faire ? ». Sans DMARC, la réponse est « le livrer quand même ».',
  );
  rapport.note(`Nom vérifié : ${nom}`);

  const res = await interroger(resolver, 'resolveTxt', nom);

  if (res.etat === 'erreur') {
    rapport.avert(
      `Impossible de lire ${nom} : ${expliquerCodeDns(res.code)}.`,
      `La requête n'a pas abouti : on ne conclut rien. À comparer avec :\n  nslookup -type=txt ${nom} 8.8.8.8`,
    );
    rapport.fermer();
    return;
  }

  const dmarcs = res.enregistrements.map(recollerTxt).filter((t) => /^v=DMARC1\s*;/i.test(t.trim()));

  if (dmarcs.length === 0) {
    rapport.avert(
      `Aucun enregistrement DMARC sur ${nom}.`,
      "Le risque, en clair : n'importe qui peut envoyer un courriel qui affiche ton adresse\n" +
        'comme expéditeur — une fausse facture à un client, une demande de virement à ton\n' +
        "comptable — et rien n'empêchera sa livraison. C'est l'arnaque la plus courante contre\n" +
        'les petites entreprises.\n' +
        'Premier pas, sans aucun risque pour tes courriels légitimes :\n' +
        `  Type TXT · Nom : _dmarc · Valeur : v=DMARC1; p=none; rua=mailto:postmaster@${domaine}\n` +
        "Ça n'agit sur rien : ça te fait juste recevoir des rapports. Un mois plus tard, tu passes\n" +
        'à « p=quarantine », puis à « p=reject ».',
    );
    rapport.fermer();
    return;
  }

  view.table(dmarcs.map((t, i) => ({ '#': i + 1, 'Enregistrement DMARC': couper(t, 160) })));

  if (dmarcs.length > 1) {
    rapport.avert(
      `${dmarcs.length} enregistrements DMARC sur ${nom}. Il n'en faut qu'UN SEUL.`,
      'Quand il y en a plusieurs, la norme dit aux serveurs de tous les ignorer : tu te retrouves\n' +
        'donc sans DMARC du tout, en croyant en avoir un. Supprime les enregistrements en trop.',
    );
  }

  const tags = analyserEtiquettes(dmarcs[0]);
  const politique = bas(tags.p);
  const description = DMARC_POLITIQUES[politique];

  if (!description) {
    rapport.avert(
      politique
        ? `La politique DMARC « p=${politique} » n'est pas une valeur reconnue (attendu : none, quarantine ou reject).`
        : "L'enregistrement DMARC ne contient pas d'étiquette « p= » : la politique est indéfinie.",
      "Sans « p= » valide, l'enregistrement ne sert à rien. Corrige-le, par exemple :\n" +
        `  v=DMARC1; p=quarantine; rua=mailto:postmaster@${domaine}`,
    );
  } else if (description.statut === STATUT.OK) {
    rapport.ok(`Politique DMARC : ${description.resume}. Concrètement : ${description.quoi}`, description.correction);
  } else {
    rapport.avert(`Politique DMARC : ${description.resume}. Concrètement : ${description.quoi}`, description.correction);
  }

  // Détails utiles, qui ne changent pas le verdict.
  if (tags.sp) {
    rapport.info(
      `Politique des sous-domaines : sp=${tags.sp} — c'est ce qui s'applique à ` +
        `« quelquechose.${domaine} », indépendamment de la politique principale.`,
    );
  }
  if (tags.pct) {
    const pct = Number(tags.pct);
    if (Number.isFinite(pct) && pct < 100) {
      rapport.avert(
        `pct=${tags.pct} : la politique ne s'applique qu'à ${tags.pct} % des courriels douteux. ` +
          `Les ${100 - pct} % restants passent comme s'il n'y avait pas de DMARC.`,
        "C'est fait pour un déploiement progressif. Quand tu es en confiance, retire « pct= »\n" +
          '(la valeur par défaut est 100).',
      );
    }
  }
  if (tags.rua) {
    rapport.info(`Rapports agrégés envoyés à : ${tags.rua}`);
  } else {
    rapport.info(
      'Aucune adresse de rapport (« rua= ») : tu ne recevras jamais de bilan de qui écrit en ' +
        "ton nom. Ce n'est pas obligatoire, mais c'est bien pratique pour ajuster.",
    );
  }

  rapport.fermer();
}

/* ================================================================== *
 * Contrôle 4 — DKIM : la signature des courriels partants
 * ================================================================== */

async function controleDkim({ resolver, domaine, rapport }) {
  const nom = `${SELECTEUR_DKIM}._domainkey.${domaine}`;
  rapport.ouvrir(4, TITRES[4]);
  rapport.note(
    'Le DKIM ajoute une signature invisible à chaque courriel que ton équipe envoie. Le\n' +
      'serveur qui reçoit vérifie la signature avec une clé publique posée dans ton DNS : si\n' +
      "elle concorde, il sait que le courriel vient vraiment de chez toi et n'a pas été\n" +
      "modifié en route. Google ne l'active PAS tout seul : il faut le faire à la main, une fois.",
  );
  rapport.note(`Nom vérifié : ${nom}`);

  // Une seule ligne, volontairement : ce texte est inséré dans une liste
  // numérotée, et un saut de ligne au milieu casserait l'alignement.
  const cheminConsole =
    "Console d'administration (admin.google.com) > Applications > Google Workspace > Gmail > Authentifier le courrier électronique";

  const res = await interroger(resolver, 'resolveTxt', nom);

  if (res.etat === 'erreur') {
    rapport.avert(
      `Impossible de lire ${nom} : ${expliquerCodeDns(res.code)}.`,
      `La requête n'a pas abouti : on ne conclut rien. À comparer avec :\n  nslookup -type=txt ${nom} 8.8.8.8`,
    );
    rapport.fermer();
    return;
  }

  if (res.etat === 'vide') {
    rapport.avert(
      `Aucune clé DKIM sur ${nom} : les courriels partants de @${domaine} ne sont pas signés.`,
      'Sans DKIM, tes courriels sont plus souvent classés comme pourriels, et le DMARC du\n' +
        'contrôle 3 ne peut pas fonctionner à plein régime (il a besoin de SPF OU de DKIM, et\n' +
        'DKIM est le plus solide des deux — il survit aux redirections).\n' +
        "Comment l'activer, une seule fois, en cinq minutes :\n" +
        `  1. ${cheminConsole}\n` +
        `  2. choisis le domaine ${domaine}, puis « Générer un nouvel enregistrement »\n` +
        '     (clé de 2048 bits, préfixe du sélecteur : google)\n' +
        '  3. Google affiche un nom et une longue valeur : copie-les dans ton DNS (contrôle 5)\n' +
        `     Type TXT · Nom : ${SELECTEUR_DKIM}._domainkey · Valeur : la longue ligne v=DKIM1...\n` +
        '  4. attends une heure, puis reviens dans la console et clique « Commencer\n' +
        "     l'authentification ». Cette dernière étape est celle qu'on oublie tout le temps.\n" +
        `Note : si quelqu'un a choisi un autre préfixe que « ${SELECTEUR_DKIM} », la clé existe ` +
        'peut-être sous un autre nom, et ce contrôle ne peut pas la voir.',
    );
    rapport.fermer();
    return;
  }

  const cles = res.enregistrements.map(recollerTxt);
  const dkim = cles.find((t) => /v=DKIM1/i.test(t)) ?? cles[0];
  const tags = analyserEtiquettes(dkim);
  const cle = String(tags.p ?? '');

  if (!/v=DKIM1/i.test(dkim)) {
    rapport.avert(
      `Il y a bien un enregistrement TXT sur ${nom}, mais il ne ressemble pas à une clé DKIM ` +
        '(il ne commence pas par « v=DKIM1 »).',
      `Regénère la clé depuis la console et remplace la valeur :\n  ${cheminConsole}`,
    );
  } else if (cle === '') {
    rapport.avert(
      "La clé DKIM existe mais elle est VIDE (« p= » sans valeur) : c'est la façon normale de " +
        'RÉVOQUER une clé. Les courriels ne sont donc plus signés.',
      "Quelqu'un a révoqué la clé, ou une rotation s'est mal terminée. Génère une nouvelle clé :\n" +
        `  ${cheminConsole}`,
    );
  } else {
    // La longueur de la clé encodée en base64 donne une bonne idée de sa taille :
    // environ 216 caractères pour du 1024 bits, environ 392 pour du 2048.
    const bits = cle.length >= 350 ? 2048 : 1024;
    rapport.ok(
      `Une clé DKIM publique est publiée sur ${nom} (environ ${bits} bits). ` +
        'Les courriels partants peuvent être signés.',
      bits === 1024
        ? 'La clé semble être une clé de 1024 bits. Ça fonctionne, mais Google recommande\n' +
            `2048 bits depuis longtemps. Pour la remplacer :\n  ${cheminConsole}`
        : null,
    );
    rapport.info(
      "Attention : cette commande voit que la clé est PUBLIÉE, pas qu'elle est ACTIVÉE. La " +
        "signature ne démarre que lorsqu'on a cliqué « Commencer l'authentification » dans la " +
        'console. Pour en avoir le cœur net : envoie-toi un courriel depuis une adresse du ' +
        "domaine vers une adresse Gmail personnelle, ouvre-le, menu « Afficher l'original », et " +
        'vérifie la ligne « DKIM : PASS ».',
    );
  }

  rapport.fermer();
}

/* ================================================================== *
 * Contrôle 5 — NS : qui gère le DNS (donc où aller corriger)
 * ================================================================== */

async function controleNs({ resolver, domaine, rapport, view }) {
  rapport.ouvrir(5, TITRES[5]);
  rapport.note(
    'Information, pas un test. Les serveurs de noms disent QUI détient la vérité sur ce\n' +
      "domaine : c'est là — et nulle part ailleurs — qu'il faut aller corriger tout ce que les\n" +
      'contrôles précédents ont signalé.',
  );

  const res = await interroger(resolver, 'resolveNs', domaine);

  if (res.etat === 'erreur') {
    rapport.info(
      `Impossible de lire les serveurs de noms : ${expliquerCodeDns(res.code)}. ` +
        "Ça n'empêche rien : c'est une information de confort.",
    );
    rapport.fermer();
    return;
  }

  if (res.etat === 'vide') {
    rapport.avert(
      `Aucun serveur de noms trouvé pour ${domaine}.`,
      "Un domaine sans serveur de noms n'est délégué à personne : plus rien ne fonctionne, ni le\n" +
        "courriel, ni le site web. Vérifie chez ton registraire que le domaine n'est pas expiré\n" +
        'et que les serveurs de noms sont bien renseignés.',
    );
    rapport.fermer();
    return;
  }

  const serveurs = res.enregistrements.map(sansPointFinal).filter(Boolean).sort();
  const reconnus = serveurs.map((s) => hebergeurDuNs(s)).filter(Boolean);
  const noms = [...new Set(reconnus.map((h) => h.nom))];

  view.table(
    serveurs.map((s) => ({
      'Serveur de noms': s,
      Hébergeur: hebergeurDuNs(s)?.nom ?? '(non reconnu)',
    })),
  );

  if (noms.length === 1) {
    const ou = reconnus.find((h) => h.nom === noms[0])?.ou;
    rapport.info(
      `Le DNS de ${domaine} est géré par : ${noms[0]}.`,
      ou ? `C'est là qu'on ajoute ou corrige un enregistrement : ${ou}` : null,
    );
  } else if (noms.length > 1) {
    rapport.avert(
      `Les serveurs de noms appartiennent à plusieurs fournisseurs différents : ${noms.join(', ')}.`,
      "C'est parfois volontaire (redondance), mais le plus souvent c'est le reste d'une\n" +
        'migration inachevée — et là ça devient dangereux : selon le serveur interrogé, le monde\n' +
        'voit deux configurations différentes de ton domaine. Vérifie chez ton registraire quels\n' +
        'serveurs de noms sont réellement déclarés.',
    );
  } else {
    rapport.info(
      `${serveurs.length} serveur(s) de noms, aucun fournisseur reconnu automatiquement : ` +
        `${serveurs.join(', ')}.`,
      "C'est normal — la liste des fournisseurs connus de la trousse est courte. Le nom du\n" +
        "serveur t'indique presque toujours chez qui aller : c'est le domaine au milieu\n" +
        '(par exemple « ns1.MONREGISTRAIRE.com »).',
    );
  }

  rapport.fermer();
}

/* ================================================================== *
 * Contrôle 6 — A : le site web du domaine
 * ================================================================== */

async function controleA({ resolver, domaine, rapport }) {
  rapport.ouvrir(6, TITRES[6]);
  rapport.note(
    'Information, pas un test. Un domaine peut très bien servir uniquement au courriel : ne ' +
      "pas avoir de site web ici n'est pas un problème.",
  );

  const racine = await interroger(resolver, 'resolve4', domaine);
  const www = await interroger(resolver, 'resolve4', `www.${domaine}`);

  const decrire = (nom, res) => {
    if (res.etat === 'trouve') {
      rapport.info(`${nom} pointe vers : ${res.enregistrements.join(', ')}`);
      return true;
    }
    if (res.etat === 'vide') {
      rapport.info(`${nom} n'a aucune adresse IPv4 (pas de site web à ce nom-là).`);
      return false;
    }
    rapport.info(`${nom} : impossible à vérifier (${expliquerCodeDns(res.code)}).`);
    return false;
  };

  const aRacine = decrire(domaine, racine);
  const aWww = decrire(`www.${domaine}`, www);

  if (!aRacine && !aWww) {
    rapport.info(
      `Aucun site web répondant sur ${domaine} ni sur www.${domaine}. ` +
        "Si tu comptes en avoir un un jour, c'est au même endroit qu'au contrôle 5 qu'il faudra " +
        "ajouter un enregistrement A ou CNAME. Le courriel, lui, n'a besoin de rien de tout ça.",
    );
  }

  rapport.fermer();
}

/* ================================================================== *
 * Contrôle déclaré « sans objet »
 * ================================================================== */

/**
 * Quand le contrôle 1 a établi que le domaine n'existe carrément pas dans le
 * DNS, les cinq contrôles suivants n'ont plus rien d'utile à dire. « Ajoute un
 * SPF » sur un domaine qui n'existe pas, c'est une consigne absurde, et cinq
 * échecs de plus noieraient le seul qui compte. On le dit une fois, en clair.
 */
function sansObjet(rapport, numero) {
  rapport.ouvrir(numero, TITRES[numero]);
  rapport.info(
    "Sans objet : le contrôle 1 a établi que le domaine n'existe pas dans le DNS. Tant que " +
      "ce point-là n'est pas réglé, rien d'autre ne peut être vérifié — ni corrigé, d'ailleurs.",
  );
  rapport.fermer();
}

/* ================================================================== *
 * La commande
 * ================================================================== */

/**
 * Lit « --domain » / « --domaine ».
 *
 * On lit à la fois les paramètres passés par le CLI (`argv`, que cli.mjs
 * transmet déjà aux commandes) et process.argv : ce second chemin est un filet
 * qui permet à « dns » de fonctionner même avec un src/cli.mjs qui ne connaît
 * pas encore cette option.
 *
 * @param {object} params
 * @returns {{ domaine: string|null }}
 */
function lireOptions(params = {}) {
  const argv = Array.isArray(params.argv) ? params.argv : process.argv.slice(2);
  let domaine = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? '');
    if (arg.startsWith('--domain=')) domaine = arg.slice('--domain='.length);
    else if (arg.startsWith('--domaine=')) domaine = arg.slice('--domaine='.length);
    else if ((arg === '--domain' || arg === '--domaine') && argv[i + 1] && !String(argv[i + 1]).startsWith('-')) {
      domaine = String(argv[i + 1]);
      i += 1;
    }
  }

  if (params.domain) domaine = String(params.domain);
  return { domaine: domaine ? String(domaine) : null };
}

/**
 * @param {{ config?: object|null, apply?: boolean, state?: object, log?: object }} params
 * @returns {Promise<{created: string[], updated: string[], unchanged: string[], warnings: string[]}>}
 */
export async function run({ config = null, apply = false, state = {}, log, ...rest } = {}) {
  void state; // « dns » ne crée aucune ressource : il n'y a rien à mettre en cache.

  const view = makeView(log);
  const rapport = creerRapport(view);

  view.step('À quoi sert cette commande');
  view.info(
    'Elle interroge le DNS public — pas Google — pour répondre à quatre questions :\n' +
      'les courriels de ton domaine arrivent-ils bien chez Google ? tes courriels partants\n' +
      'sont-ils reconnus comme légitimes ? un imposteur peut-il écrire en ton nom ? et à qui\n' +
      'faut-il parler pour corriger tout ça ?',
  );
  view.info(
    'Elle ne se connecte à rien et ne modifie RIEN, jamais : ni chez Google, ni chez ton\n' +
      "registraire, ni dans tes fichiers. L'option --apply n'a aucun effet ici.",
  );
  if (apply) {
    view.warn("Cette commande est en lecture seule : l'option --apply est sans effet.");
  }

  /* ---------------------------------------------------------------- *
   * Quel domaine on vérifie
   * ---------------------------------------------------------------- */

  const options = lireOptions(rest);
  const source = options.domaine ? "l'option --domain" : 'config.json';
  const { domaine, notes } = normaliserDomaine(options.domaine ?? config?.domain);

  if (!domaine) {
    view.err(
      'Aucun domaine à vérifier.\n' +
        'Quoi faire, au choix :\n' +
        '  node src/cli.mjs dns --domain tondomaine.ca      (sans avoir besoin de config.json)\n' +
        '  ou remplis le champ « domain » dans config.json, puis relance : node src/cli.mjs dns',
    );
    forcerCodeDeSortie(1);
    return {
      created: [],
      updated: [],
      unchanged: [],
      warnings: [
        'ÉCHEC — aucun domaine à vérifier : utilise --domain <domaine> ou remplis « domain » dans config.json.',
      ],
    };
  }

  if (!DOMAINE_RE.test(domaine)) {
    view.err(
      `« ${domaine} » n'est pas un nom de domaine valide.\n` +
        'Attendu : quelque chose comme « tondomaine.ca » — sans https://, sans arobase, sans\n' +
        'barre oblique.\n' +
        '  node src/cli.mjs dns --domain tondomaine.ca',
    );
    forcerCodeDeSortie(1);
    return {
      created: [],
      updated: [],
      unchanged: [],
      warnings: [`ÉCHEC — « ${domaine} » n'est pas un nom de domaine valide.`],
    };
  }

  view.step('Ce qui va être vérifié');
  view.info(`Domaine : ${domaine}  (source : ${source})`);
  for (const note of notes) view.info(note);

  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TENTATIVES });
  let serveursUtilises = [];
  try {
    serveursUtilises = resolver.getServers();
  } catch {
    serveursUtilises = [];
  }
  view.info(
    `Serveurs DNS interrogés (ceux de cette machine) : ${serveursUtilises.join(', ') || 'inconnus'}.\n` +
      "Si un contrôle répond « impossible de vérifier », c'est souvent eux le problème,\n" +
      'pas ton domaine.',
  );
  view.info(
    'Rappel : une modification DNS met de quelques minutes à quelques heures à se propager\n' +
      'partout dans le monde. Si tu viens de corriger quelque chose, laisse passer une heure\n' +
      'avant de conclure que ça ne marche pas.',
  );

  /* ---------------------------------------------------------------- *
   * Les six contrôles, dans l'ordre d'importance
   * ---------------------------------------------------------------- */

  // Le contrôle 1 est le seul dont le résultat conditionne les autres.
  const resultatMx = (await controleMx({ resolver, domaine, rapport, view })) ?? {};

  if (resultatMx.existe === false) {
    for (const numero of [2, 3, 4, 5, 6]) sansObjet(rapport, numero);
  } else {
    await controleSpf({ resolver, domaine, rapport, view });
    await controleDmarc({ resolver, domaine, rapport, view });
    await controleDkim({ resolver, domaine, rapport, view });
    await controleNs({ resolver, domaine, rapport, view });
    await controleA({ resolver, domaine, rapport, view });
  }

  /* ---------------------------------------------------------------- *
   * Verdict
   * ---------------------------------------------------------------- */

  view.banner('Verdict');

  view.table(
    rapport.controles.map((c) => ({
      '#': c.numero,
      Contrôle: c.titre,
      Résultat: `[${c.statut}]`,
    })),
  );

  const nbEchecs = rapport.controles.filter((c) => c.statut === STATUT.ECHEC).length;
  const nbAverts = rapport.controles.filter((c) => c.statut === STATUT.AVERT).length;
  const nbOk = rapport.controles.filter((c) => c.statut === STATUT.OK).length;
  const nbInfo = rapport.controles.filter((c) => c.statut === STATUT.INFO).length;

  view.info(
    `${nbOk} contrôle(s) conforme(s) · ${nbAverts} avec avertissement · ${nbEchecs} en échec` +
      (nbInfo > 0 ? ` · ${nbInfo} purement informatif(s)` : ''),
  );

  const code = nbEchecs > 0 ? 1 : 0;

  if (nbEchecs > 0) {
    view.err(
      `VERDICT : DNS NON CONFORME. ${rapport.echecs.length} problème(s) bloquant(s). ` +
        'Chaque ligne [ÉCHEC] ci-dessus dit exactement quel enregistrement poser et où.',
    );
    view.info(
      "Ordre conseillé : corriger les MX en premier (sans eux, rien n'entre), puis le SPF, puis " +
        'relancer « node src/cli.mjs dns » une heure plus tard, le temps que la propagation se fasse.',
    );
    view.info(
      "Tout se corrige chez le gestionnaire de ton DNS — le contrôle 5 dit lequel c'est. Aucune " +
        'de ces corrections ne se fait dans la console Google, sauf la clé DKIM du contrôle 4.',
    );
  } else if (nbAverts > 0) {
    view.ok(
      `VERDICT : LE COURRIEL FONCTIONNE, avec ${rapport.averts.length} point(s) à améliorer. ` +
        'Les courriels de ton domaine sont bien livrés à Google Workspace.',
    );
    view.info(
      "Les avertissements ne bloquent rien aujourd'hui. Ils touchent presque tous la même chose : " +
        "la crédibilité de tes courriels sortants et ta protection contre quelqu'un qui voudrait " +
        'écrire en ton nom. Ça vaut une heure de ton temps, une seule fois.',
    );
  } else {
    view.ok(
      'VERDICT : DNS IMPECCABLE. Les courriels entrent chez Google, les courriels sortants sont ' +
        "autorisés (SPF), signés (DKIM) et protégés contre l'usurpation (DMARC). Rien à faire.",
    );
  }

  view.info(`Code de sortie : ${code} (0 = aucun échec, 1 = au moins un échec).`);
  forcerCodeDeSortie(code);

  /* ---------------------------------------------------------------- *
   * Résumé rendu à cli.mjs
   * ---------------------------------------------------------------- */

  return {
    created: [],
    updated: [],
    unchanged: rapport.controles
      .filter((c) => c.statut === STATUT.OK)
      .map((c) => `Contrôle ${c.numero} — ${c.titre} : conforme`),
    warnings: [
      ...rapport.echecs.map((m) => `${STATUT.ECHEC} — ${m}`),
      ...rapport.averts.map((m) => `${STATUT.AVERT} — ${m}`),
    ],
  };
}

/* ================================================================== *
 * Exécution directe
 * ================================================================== *
 *
 * « dns » est la seule commande qui n'a besoin de RIEN : ni config.json, ni
 * client OAuth, ni connexion à Google. On la rend donc lançable toute seule,
 * pour le cas très concret où les courriels ne rentrent pas et où la trousse
 * n'est même pas encore configurée :
 *
 *     node src/commands/dns.mjs --domain tondomaine.ca
 */

const lanceDirectement = (() => {
  try {
    if (!process.argv[1]) return false;
    return resolveChemin(process.argv[1]) === resolveChemin(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (lanceDirectement) {
  baseLog.banner('Trousse Google Workspace — commande « dns »');
  await run({ config: null, apply: false, state: {}, log: baseLog });
}

export default { meta, run };
