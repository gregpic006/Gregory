/**
 * 08_Courriels.gs — Tout ce qui sort du classeur par courriel.
 *
 * Deux responsabilités :
 *   1. Envoyer OU préparer en brouillon un courriel, selon le réglage MODE_ENVOI
 *      (par défaut « Brouillon » : rien ne part sans que Grégory l'ait relu).
 *   2. Préparer la relance des clients dont le solde ne balance pas, à partir de
 *      l'onglet Rapprochement : un seul courriel par client, qui liste
 *      précisément les pièces à vérifier plutôt qu'un vague « merci de vérifier ».
 *
 * Aucune fonction d'ici ne lève d'exception vers l'appelant : un problème de
 * courriel est journalisé et se traduit par le résultat « Échec ».
 */

/**
 * Noms de colonnes utilisés par ce module. Ils viennent tous de CONFIG :
 * si un en-tête change dans 00_Config.gs, ce fichier suit automatiquement.
 */
const COURRIELS_COL_ = {
  CLIENT_ID: CONFIG.ONGLETS.CLIENTS.colonnes[0].nom,              // ID client
  CLIENT_NOM: CONFIG.ONGLETS.CLIENTS.colonnes[1].nom,             // Nom
  CLIENT_COURRIEL: CONFIG.ONGLETS.CLIENTS.colonnes[2].nom,        // Courriel
  CLIENT_COPIE: CONFIG.ONGLETS.CLIENTS.colonnes[3].nom,           // Courriels en copie
  CLIENT_DEVISE: CONFIG.ONGLETS.CLIENTS.colonnes[5].nom,          // Devise

  RAPPRO_PERIODE: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[0].nom,   // Période
  RAPPRO_CLIENT: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[1].nom,    // ID client
  RAPPRO_NOM: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[2].nom,       // Nom client
  RAPPRO_THEORIQUE: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[3].nom, // Solde théorique
  RAPPRO_DECLARE: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[4].nom,   // Solde déclaré
  RAPPRO_ECART: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[5].nom,     // Écart
  RAPPRO_VERDICT: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[6].nom,   // Verdict
  RAPPRO_RELANCE: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[10].nom,  // Relance

  FACTURE_ID: CONFIG.ONGLETS.FACTURES.colonnes[0].nom,            // ID facture
  FACTURE_CLIENT: CONFIG.ONGLETS.FACTURES.colonnes[1].nom,        // ID client
  FACTURE_NUMERO: CONFIG.ONGLETS.FACTURES.colonnes[3].nom,        // N° facture client
  FACTURE_DATE: CONFIG.ONGLETS.FACTURES.colonnes[4].nom,          // Date facture
  FACTURE_PERIODE: CONFIG.ONGLETS.FACTURES.colonnes[5].nom,       // Période
  FACTURE_TOTAL: CONFIG.ONGLETS.FACTURES.colonnes[8].nom,         // Montant total
  FACTURE_VERIF: CONFIG.ONGLETS.FACTURES.colonnes[10].nom,        // Statut vérification

  PAIEMENT_ID: CONFIG.ONGLETS.PAIEMENTS.colonnes[0].nom,          // ID paiement
  PAIEMENT_CLIENT: CONFIG.ONGLETS.PAIEMENTS.colonnes[1].nom,      // ID client
  PAIEMENT_FACTURE: CONFIG.ONGLETS.PAIEMENTS.colonnes[3].nom,     // ID facture
  PAIEMENT_DATE: CONFIG.ONGLETS.PAIEMENTS.colonnes[4].nom,        // Date paiement
  PAIEMENT_MONTANT: CONFIG.ONGLETS.PAIEMENTS.colonnes[5].nom,     // Montant
  PAIEMENT_METHODE: CONFIG.ONGLETS.PAIEMENTS.colonnes[6].nom,     // Méthode
  PAIEMENT_REFERENCE: CONFIG.ONGLETS.PAIEMENTS.colonnes[7].nom,   // Référence
  PAIEMENT_DEDUIT: CONFIG.ONGLETS.PAIEMENTS.colonnes[8].nom,      // Déduit par le client
};

/** Les trois seuls résultats possibles d'un envoi. */
const COURRIELS_RESULTAT_ = {
  ENVOYE: 'Envoyé',
  BROUILLON: 'Brouillon créé',
  ECHEC: 'Échec',
};

/** Valeurs écrites dans la colonne « Relance » de l'onglet Rapprochement. */
const COURRIELS_RELANCE_ = {
  AUCUNE: '—',
  ENVOYEE: 'Envoyée',
  BROUILLON: 'Brouillon créé',
  ECHEC: 'Échec',
};

/** Courriels gardés en réserve sur le quota du jour (marge de sécurité). */
const COURRIELS_MARGE_QUOTA_ = 5;

/** Nombre maximal de pièces détaillées dans un courriel de relance. */
const COURRIELS_MAX_PIECES_ = 30;

/**
 * Durée au-delà de laquelle la relance s'arrête proprement (4 min 30 s).
 * Apps Script tue une exécution à 6 minutes : sans cette marge, des brouillons
 * existeraient dans Gmail sans que la colonne « Relance » ait pu être écrite.
 */
const COURRIELS_DUREE_MAX_MS_ = 270000;

/** Nombre de clients traités entre deux écritures de la colonne « Relance ». */
const COURRIELS_LOT_MAJ_ = 10;

/** Noms des mois, pour écrire une période en toutes lettres. */
const COURRIELS_MOIS_ = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Mémoire de l'exécution en cours (quota Gmail, mode d'envoi). */
const COURRIELS_CACHE_ = { quota: null };

/** Styles en ligne : Gmail ignore toute feuille de style externe. */
const COURRIELS_STYLE_ = {
  corps: 'max-width:600px;margin:0 auto;padding:0 8px;font-family:Arial,Helvetica,sans-serif;' +
         'font-size:14px;line-height:1.5;color:#222222;',
  titre: 'margin:0 0 16px 0;font-size:17px;line-height:1.3;color:#111111;',
  paragraphe: 'margin:0 0 14px 0;',
  tableau: 'width:100%;max-width:600px;border-collapse:collapse;font-size:13px;margin:0 0 16px 0;',
  entete: 'padding:6px 8px;border-bottom:2px solid #333333;text-align:left;font-weight:bold;',
  enteteDroite: 'padding:6px 8px;border-bottom:2px solid #333333;text-align:right;font-weight:bold;',
  cellule: 'padding:6px 8px;border-bottom:1px solid #dddddd;text-align:left;vertical-align:top;',
  celluleDroite: 'padding:6px 8px;border-bottom:1px solid #dddddd;text-align:right;' +
                 'vertical-align:top;white-space:nowrap;',
  libelle: 'padding:7px 8px;border-bottom:1px solid #dddddd;text-align:left;',
  montant: 'padding:7px 8px;border-bottom:1px solid #dddddd;text-align:right;white-space:nowrap;',
  libelleFort: 'padding:7px 8px;border-top:2px solid #333333;text-align:left;font-weight:bold;',
  montantFort: 'padding:7px 8px;border-top:2px solid #333333;text-align:right;' +
               'font-weight:bold;white-space:nowrap;',
  discret: 'margin:18px 0 0 0;font-size:12px;color:#777777;',
};

// ---------------------------------------------------------------------------
// Petits utilitaires du module (préfixés « courriels » : espace de noms global)
// ---------------------------------------------------------------------------

/**
 * Convertit n'importe quelle cellule en texte propre (sans espaces inutiles).
 * @param {*} valeur Contenu d'une cellule.
 * @return {string} Texte, éventuellement vide.
 */
function courrielsTexte_(valeur) {
  if (valeur === null || valeur === undefined) return '';
  return String(valeur).trim();
}

/**
 * Échappe le HTML d'une donnée venant du classeur. Un nom de client contenant
 * une apostrophe, un « & » ou un chevron ne doit jamais casser le rendu ni
 * permettre d'injecter du balisage dans le courriel.
 * @param {*} texte Donnée brute (nom, note, référence...).
 * @return {string} Texte sûr à insérer dans du HTML.
 */
function courrielsEchapperHtml_(texte) {
  return courrielsTexte_(texte)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Échappe un texte et transforme ses retours à la ligne en <br> (signature...).
 * @param {*} texte Donnée brute sur plusieurs lignes.
 * @return {string} HTML sûr.
 */
function courrielsMultiligneHtml_(texte) {
  return courrielsEchapperHtml_(texte).replace(/\r?\n/g, '<br>');
}

/**
 * Nettoie une liste d'adresses courriel séparées par des virgules ou des
 * points-virgules et ne garde que celles qui ressemblent à une adresse.
 * @param {*} valeur Une ou plusieurs adresses.
 * @return {string} Adresses valides séparées par des virgules, ou ''.
 */
function courrielsAdresses_(valeur) {
  return courrielsTexte_(valeur)
    .split(/[,;]/)
    .map((adresse) => adresse.trim())
    .filter((adresse) => adresse.length >= 3 && adresse.indexOf('@') > 0 &&
      adresse.indexOf('@') < adresse.length - 1 && !/\s/.test(adresse))
    .join(',');
}

/**
 * Version texte de secours d'un courriel HTML, pour les clients de messagerie
 * qui n'affichent pas le HTML.
 * @param {string} html Corps HTML.
 * @return {string} Texte brut lisible.
 */
function courrielsHtmlVersTexte_(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|tr|h1|h2|div|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Devise à afficher pour un client : la sienne, sinon celle des Paramètres.
 * @param {Object} client Ligne de l'onglet Clients.
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {string} Code de devise (CAD par défaut).
 */
function courrielsDevise_(client, params) {
  return courrielsTexte_((client || {})[COURRIELS_COL_.CLIENT_DEVISE]) ||
    courrielsTexte_((params || {}).DEVISE) || 'CAD';
}

/**
 * Compare deux valeurs de statut sans se soucier des accents, des emojis
 * ni de la casse (« ✅ Balancé » et « balance » sont identiques).
 * @param {*} valeur Valeur lue dans la feuille.
 * @param {string} reference Constante attendue.
 * @return {boolean} Vrai si les deux désignent la même chose.
 */
function courrielsMemeValeur_(valeur, reference) {
  return texteNormalise_(valeur) === texteNormalise_(reference);
}

// ---------------------------------------------------------------------------
// Envoi : le seul point de passage vers Gmail
// ---------------------------------------------------------------------------

/**
 * Nombre de courriels que Gmail nous laisse encore envoyer aujourd'hui.
 * La valeur est lue une seule fois par exécution puis décrémentée à chaque
 * envoi direct, pour éviter de réinterroger le service à chaque client.
 * @return {number} Quota restant (0 si le service ne répond pas).
 */
function quotaCourrielRestant_() {
  if (COURRIELS_CACHE_.quota !== null) return COURRIELS_CACHE_.quota;
  let quota = 0;
  try {
    quota = (typeof MailApp !== 'undefined' && MailApp)
      ? Number(MailApp.getRemainingDailyQuota())
      : 0;
  } catch (e) {
    journalErreur_('quotaCourrielRestant_',
      `Le quota de courriels n'a pas pu être lu : ${e.message}`, `${e.message}\n${e.stack}`);
    quota = 0;
  }
  if (!isFinite(quota) || quota < 0) quota = 0;
  COURRIELS_CACHE_.quota = quota;
  return quota;
}

/**
 * Indique si les courriels doivent partir tout de suite (MODE_ENVOI = Direct)
 * ou seulement être préparés en brouillon. Le brouillon est le comportement
 * par défaut, y compris si les Paramètres sont illisibles.
 * @param {Object} [options] Options d'envoi ; options.mode a priorité.
 * @return {boolean} Vrai si l'envoi doit être immédiat.
 */
function courrielsModeDirect_(options) {
  const impose = courrielsTexte_((options || {}).mode);
  if (impose) return texteNormalise_(impose) === 'DIRECT';
  try {
    return texteNormalise_(lireParametres_().MODE_ENVOI) === 'DIRECT';
  } catch (e) {
    journalAvert_('envoyerOuBrouillonner_',
      "Le mode d'envoi n'a pas pu être lu : le courriel est préparé en brouillon.",
      `${e.message}\n${e.stack}`);
    return false;
  }
}

/**
 * Construit les options passées à Gmail à partir des options du module.
 * @param {Object} options {cc|copie, nomExpediteur, piecesJointes, repondreA}.
 * @param {string} html Corps HTML, qui sert aussi à fabriquer la version texte.
 * @return {Object} Options acceptées par GmailApp.
 */
function courrielsOptionsGmail_(options, html) {
  const source = options || {};
  const gmail = { htmlBody: html };
  const copie = courrielsAdresses_(source.cc !== undefined ? source.cc : source.copie);
  if (copie) gmail.cc = copie;
  const expediteur = courrielsTexte_(source.nomExpediteur);
  if (expediteur) gmail.name = expediteur;
  const repondreA = courrielsAdresses_(source.repondreA);
  if (repondreA) gmail.replyTo = repondreA;
  const pieces = source.piecesJointes;
  if (pieces) gmail.attachments = Array.isArray(pieces) ? pieces : [pieces];
  return gmail;
}

/**
 * Envoie un courriel, ou le prépare en brouillon, selon le réglage MODE_ENVOI.
 * Ne lève jamais d'exception : toute erreur est journalisée (message ET pile)
 * et se traduit par le résultat « Échec ».
 * @param {string} destinataire Adresse principale (obligatoire, doit contenir @).
 * @param {string} sujet Objet du message.
 * @param {string} html Corps HTML complet.
 * @param {Object} [options] {cc, nomExpediteur, piecesJointes, repondreA, mode}.
 * @return {string} 'Envoyé', 'Brouillon créé' ou 'Échec'.
 */
function envoyerOuBrouillonner_(destinataire, sujet, html, options) {
  const adresse = courrielsAdresses_(destinataire);
  if (!adresse) {
    journalAvert_('envoyerOuBrouillonner_',
      "Courriel non préparé : l'adresse du destinataire est vide ou invalide.",
      `Adresse reçue : « ${courrielsTexte_(destinataire)} », objet : « ${courrielsTexte_(sujet)} ».`);
    return COURRIELS_RESULTAT_.ECHEC;
  }
  if (typeof GmailApp === 'undefined' || !GmailApp) {
    journalErreur_('envoyerOuBrouillonner_', "Le service Gmail n'est pas disponible.",
      `Destinataire : ${adresse}.`);
    return COURRIELS_RESULTAT_.ECHEC;
  }
  const objet = courrielsTexte_(sujet) || '(sans objet)';
  const corpsHtml = String(html === null || html === undefined ? '' : html);
  const corpsTexte = courrielsHtmlVersTexte_(corpsHtml);
  const gmail = courrielsOptionsGmail_(options, corpsHtml);
  const direct = courrielsModeDirect_(options);
  if (direct && quotaCourrielRestant_() <= 0) {
    journalAvert_('envoyerOuBrouillonner_',
      `Quota de courriels épuisé : le message à ${adresse} n'a pas été envoyé.`,
      'Réessayez demain, ou passez MODE_ENVOI à « Brouillon » pour préparer les messages.');
    return COURRIELS_RESULTAT_.ECHEC;
  }
  return courrielsRemettreAGmail_(adresse, objet, corpsTexte, gmail, direct);
}

/**
 * Appelle Gmail et traduit le résultat. Isolé pour que l'appel réseau soit le
 * seul endroit sous try/catch.
 * @param {string} adresse Destinataire déjà validé.
 * @param {string} objet Objet du message.
 * @param {string} corpsTexte Version texte du message.
 * @param {Object} gmail Options Gmail déjà construites.
 * @param {boolean} direct Vrai pour envoyer, faux pour créer un brouillon.
 * @return {string} 'Envoyé', 'Brouillon créé' ou 'Échec'.
 */
function courrielsRemettreAGmail_(adresse, objet, corpsTexte, gmail, direct) {
  try {
    if (direct) {
      GmailApp.sendEmail(adresse, objet, corpsTexte, gmail);
      if (COURRIELS_CACHE_.quota !== null && COURRIELS_CACHE_.quota > 0) COURRIELS_CACHE_.quota--;
      journalInfo_('envoyerOuBrouillonner_', `Courriel envoyé à ${adresse}.`, objet);
      return COURRIELS_RESULTAT_.ENVOYE;
    }
    GmailApp.createDraft(adresse, objet, corpsTexte, gmail);
    journalInfo_('envoyerOuBrouillonner_', `Brouillon préparé dans Gmail pour ${adresse}.`, objet);
    return COURRIELS_RESULTAT_.BROUILLON;
  } catch (e) {
    journalErreur_('envoyerOuBrouillonner_',
      `Le courriel à ${adresse} n'a pas pu être ${direct ? 'envoyé' : 'préparé'} : ${e.message}`,
      `Objet : ${objet}\n${e.message}\n${e.stack}`);
    return COURRIELS_RESULTAT_.ECHEC;
  }
}

// ---------------------------------------------------------------------------
// Gabarit HTML commun
// ---------------------------------------------------------------------------

/**
 * Enveloppe HTML commune à tous les courriels du classeur : largeur maximale
 * de 600 px, styles en ligne, titre, corps, signature des Paramètres et
 * mention discrète que le message a été préparé automatiquement.
 * @param {string} titre Titre affiché en haut du message.
 * @param {string} corpsHtml Corps déjà construit (HTML déjà échappé).
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {string} Le courriel HTML complet.
 */
function gabaritBase_(titre, corpsHtml, params) {
  const reglages = params || {};
  const titreTexte = courrielsTexte_(titre);
  const blocs = [`<div style="${COURRIELS_STYLE_.corps}">`];
  if (titreTexte) {
    blocs.push(`<h1 style="${COURRIELS_STYLE_.titre}">${courrielsEchapperHtml_(titreTexte)}</h1>`);
  }
  blocs.push(String(corpsHtml === null || corpsHtml === undefined ? '' : corpsHtml));
  blocs.push(courrielsSignatureHtml_(reglages));
  blocs.push(`<p style="${COURRIELS_STYLE_.discret}">Ce message a été préparé automatiquement ` +
    'à partir de notre registre de comptes. Vous pouvez y répondre directement : ' +
    'votre réponse nous parvient.</p>');
  blocs.push('</div>');
  return blocs.filter((bloc) => bloc !== '').join('\n');
}

/**
 * Formule de politesse et signature venant des Paramètres.
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {string} Le bloc HTML de signature.
 */
function courrielsSignatureHtml_(params) {
  const signature = courrielsTexte_(params.SIGNATURE) || courrielsTexte_(params.NOM_EXPEDITEUR);
  const blocs = [`<p style="${COURRIELS_STYLE_.paragraphe}">Merci de votre collaboration, ` +
    'et bonne journée.</p>'];
  if (signature) {
    blocs.push(`<p style="${COURRIELS_STYLE_.paragraphe}">${courrielsMultiligneHtml_(signature)}</p>`);
  }
  return blocs.join('\n');
}

// ---------------------------------------------------------------------------
// Périodes et dates (fonctions pures)
// ---------------------------------------------------------------------------

/**
 * Bornes d'une période 'AAAA-TN' (ou 'AAAA-MM'). Utilise bornesTrimestre_ de
 * 07_Rapprochement.gs si ce module est présent, sinon calcule les bornes ici.
 * @param {string} periode Période à borner.
 * @param {Object} [params] Réglages (pour TRIMESTRE_DECALAGE_MOIS).
 * @return {{debut: Date, fin: Date}|null} Les bornes, ou null si illisible.
 */
function courrielsBornesPeriode_(periode, params) {
  const texte = courrielsTexte_(periode).toUpperCase();
  if (!texte) return null;
  const decalage = params ? Math.round(parametreNombre_(params, 'TRIMESTRE_DECALAGE_MOIS', 0)) : 0;
  if (typeof bornesTrimestre_ === 'function' && /^\d{4}-T[1-4]$/.test(texte)) {
    try {
      // Le décalage doit être transmis : sans lui, la relance bornerait le
      // trimestre autrement que le rapprochement, et le courriel annoncerait au
      // client la mauvaise période avec les pièces d'un autre trimestre.
      const bornes = bornesTrimestre_(texte, decalage);
      if (bornes && bornes.debut && bornes.fin) return bornes;
    } catch (e) {
      journalAvert_('courrielsBornesPeriode_',
        `Les bornes de la période ${texte} n'ont pas pu être calculées par le rapprochement.`,
        `${e.message}\n${e.stack}`);
    }
  }
  const trimestre = /^(\d{4})-T([1-4])$/.exec(texte);
  if (trimestre) {
    const premierMois = (Number(trimestre[2]) - 1) * 3 + decalage;
    return courrielsBornesMois_(Number(trimestre[1]), premierMois, 3);
  }
  const mois = /^(\d{4})-(\d{1,2})$/.exec(texte);
  if (mois) return courrielsBornesMois_(Number(mois[1]), Number(mois[2]) - 1, 1);
  return null;
}

/**
 * Construit un intervalle de dates couvrant un nombre entier de mois.
 * @param {number} annee Année de départ.
 * @param {number} moisIndex Index du premier mois (0 = janvier ; peut déborder).
 * @param {number} nombreMois Nombre de mois couverts.
 * @return {{debut: Date, fin: Date}} Du premier jour au dernier jour, inclus.
 */
function courrielsBornesMois_(annee, moisIndex, nombreMois) {
  const debut = new Date(annee, moisIndex, 1, 0, 0, 0, 0);
  const fin = new Date(annee, moisIndex + nombreMois, 0, 23, 59, 59, 999);
  return { debut: debut, fin: fin };
}

/**
 * Écrit une période en toutes lettres : '2026-T2' devient '2e trimestre 2026'.
 * @param {string} periode Période au format 'AAAA-TN' ou 'AAAA-MM'.
 * @return {string} Période lisible, ou la période telle quelle si inconnue.
 */
function courrielsPeriodeLisible_(periode) {
  const texte = courrielsTexte_(periode).toUpperCase();
  const trimestre = /^(\d{4})-T([1-4])$/.exec(texte);
  if (trimestre) {
    const rang = Number(trimestre[2]);
    return `${rang === 1 ? '1er' : rang + 'e'} trimestre ${trimestre[1]}`;
  }
  const mois = /^(\d{4})-(\d{1,2})$/.exec(texte);
  if (mois && Number(mois[2]) >= 1 && Number(mois[2]) <= 12) {
    return `${COURRIELS_MOIS_[Number(mois[2]) - 1]} ${mois[1]}`;
  }
  return courrielsTexte_(periode);
}

/**
 * Écrit une date en toutes lettres : '1er avril 2026'.
 * @param {*} valeur Date ou valeur convertible.
 * @return {string} Date lisible, ou '' si ce n'est pas une date.
 */
function courrielsDateEnLettres_(valeur) {
  const date = versDate_(valeur);
  if (!date) return '';
  const jour = date.getDate();
  return `${jour === 1 ? '1er' : jour} ${COURRIELS_MOIS_[date.getMonth()]} ${date.getFullYear()}`;
}

/**
 * Phrase qui situe la période : 'du 1er avril au 30 juin 2026'.
 * @param {{debut: Date, fin: Date}|null} bornes Bornes de la période.
 * @return {string} Texte lisible, ou '' si les bornes sont inconnues.
 */
function courrielsIntervalleLisible_(bornes) {
  if (!bornes || !bornes.debut || !bornes.fin) return '';
  const debut = versDate_(bornes.debut);
  const fin = versDate_(bornes.fin);
  if (!debut || !fin) return '';
  const memeAnnee = debut.getFullYear() === fin.getFullYear();
  const jour = debut.getDate() === 1 ? '1er' : debut.getDate();
  const texteDebut = memeAnnee
    ? `${jour} ${COURRIELS_MOIS_[debut.getMonth()]}`
    : courrielsDateEnLettres_(debut);
  return `du ${texteDebut} au ${courrielsDateEnLettres_(fin)}`;
}

// ---------------------------------------------------------------------------
// Lecture d'une ligne de rapprochement
// ---------------------------------------------------------------------------

/**
 * Extrait les trois montants d'une ligne de rapprochement, en cents entiers.
 * L'écart de la feuille fait foi ; s'il est absent, il est recalculé.
 * @param {Object} ligne Ligne de l'onglet Rapprochement.
 * @return {{theorique: number, declare: number, ecart: number}} Montants en cents.
 */
function courrielsSoldesLigne_(ligne) {
  const rangee = ligne || {};
  const theorique = enCents_(rangee[COURRIELS_COL_.RAPPRO_THEORIQUE]);
  const declare = enCents_(rangee[COURRIELS_COL_.RAPPRO_DECLARE]);
  const brut = rangee[COURRIELS_COL_.RAPPRO_ECART];
  const renseigne = !(brut === null || brut === undefined || courrielsTexte_(brut) === '');
  return {
    theorique: theorique,
    declare: declare,
    ecart: renseigne ? enCents_(brut) : theorique - declare,
  };
}

/**
 * Vrai si le verdict de la ligne est « ❌ Écart inexpliqué ».
 * @param {Object} ligne Ligne de l'onglet Rapprochement.
 * @return {boolean}
 */
function courrielsEstInexplique_(ligne) {
  return courrielsMemeValeur_((ligne || {})[COURRIELS_COL_.RAPPRO_VERDICT], VERDICT.INEXPLIQUE);
}

// ---------------------------------------------------------------------------
// Courriel de relance — le texte que le client va lire
// ---------------------------------------------------------------------------

/**
 * Objet du courriel de relance : neutre, il annonce simplement un rapprochement.
 * @param {Object} ligne Ligne de l'onglet Rapprochement.
 * @return {string} L'objet du message.
 */
function courrielsSujetRelance_(ligne) {
  const periode = courrielsPeriodeLisible_((ligne || {})[COURRIELS_COL_.RAPPRO_PERIODE]);
  return periode
    ? `Rapprochement de nos comptes — ${periode}`
    : 'Rapprochement de nos comptes';
}

/**
 * Construit le courriel envoyé à un client dont le solde ne concorde pas.
 * Ton courtois et factuel : on expose les deux soldes, on chiffre l'écart, on
 * liste les pièces à vérifier, et on demande une confirmation ou une correction.
 * Les pièces sont attendues dans `ligne._pieces` (voir courrielsPieces_).
 * @param {Object} client Ligne de l'onglet Clients.
 * @param {Object} ligne Ligne de l'onglet Rapprochement, enrichie de _pieces.
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {string} Le corps HTML complet du courriel.
 */
function construireRelanceHtml_(client, ligne, params) {
  const fiche = client || {};
  const rangee = ligne || {};
  const reglages = params || {};
  const devise = courrielsTexte_(rangee._devise) || courrielsDevise_(fiche, reglages);
  const nom = courrielsTexte_(fiche[COURRIELS_COL_.CLIENT_NOM]) ||
    courrielsTexte_(rangee[COURRIELS_COL_.RAPPRO_NOM]);
  const periode = courrielsTexte_(rangee[COURRIELS_COL_.RAPPRO_PERIODE]);
  const bornes = courrielsBornesPeriode_(periode, reglages);
  const soldes = courrielsSoldesLigne_(rangee);
  const pieces = Array.isArray(rangee._pieces) ? rangee._pieces : [];
  const inexplique = courrielsEstInexplique_(rangee) || pieces.length === 0;
  const p = COURRIELS_STYLE_.paragraphe;
  const corps = [
    `<p style="${p}">Bonjour${nom ? ` ${courrielsEchapperHtml_(nom)}` : ''},</p>`,
    `<p style="${p}">Dans le cadre de notre rapprochement de fin de période, nous avons comparé ` +
      `votre relevé avec nos registres pour ${courrielsEchapperHtml_(courrielsPeriodeLisible_(periode))}` +
      `${bornes ? ` (${courrielsEchapperHtml_(courrielsIntervalleLisible_(bornes))})` : ''}. ` +
      'Les deux ne concordent pas tout à fait, et nous aimerions valider cela avec vous.</p>',
    courrielsHtmlSoldes_(soldes, devise),
    courrielsHtmlPhraseEcart_(soldes.ecart, devise, inexplique),
    courrielsHtmlPieces_(pieces, devise, inexplique),
    courrielsHtmlDemande_(inexplique, bornes),
  ];
  return gabaritBase_(courrielsSujetRelance_(rangee), corps.filter((b) => b !== '').join('\n'), reglages);
}

/**
 * Tableau de comparaison des deux soldes, avec la différence en gras.
 * @param {{theorique: number, declare: number, ecart: number}} soldes Montants en cents.
 * @param {string} devise Code de devise affiché.
 * @return {string} Le tableau HTML.
 */
function courrielsHtmlSoldes_(soldes, devise) {
  const lignes = [
    ['Solde figurant à votre relevé', soldes.declare],
    ['Solde selon nos registres', soldes.theorique],
  ].map((paire) =>
    `<tr><td style="${COURRIELS_STYLE_.libelle}">${courrielsEchapperHtml_(paire[0])}</td>` +
    `<td style="${COURRIELS_STYLE_.montant}">` +
    `${courrielsEchapperHtml_(formaterMontant_(paire[1], devise))}</td></tr>`);
  lignes.push(`<tr><td style="${COURRIELS_STYLE_.libelleFort}">Différence à valider</td>` +
    `<td style="${COURRIELS_STYLE_.montantFort}">` +
    `${courrielsEchapperHtml_(formaterMontant_(Math.abs(soldes.ecart), devise))}</td></tr>`);
  return `<table role="presentation" cellspacing="0" cellpadding="0" ` +
    `style="${COURRIELS_STYLE_.tableau}">\n${lignes.join('\n')}\n</table>`;
}

/**
 * Phrase qui explique le sens de l'écart, sans jamais accuser le client.
 * @param {number} ecartCents Solde théorique moins solde déclaré, en cents.
 * @param {string} devise Code de devise affiché.
 * @param {boolean} inexplique Vrai si l'origine de l'écart n'a pas été retracée.
 * @return {string} Le paragraphe HTML.
 */
function courrielsHtmlPhraseEcart_(ecartCents, devise, inexplique) {
  const montant = courrielsEchapperHtml_(formaterMontant_(Math.abs(ecartCents), devise));
  const p = COURRIELS_STYLE_.paragraphe;
  if (inexplique) {
    return `<p style="${p}">Nous n'avons pas réussi à retracer l'origine de cette différence ` +
      `de ${montant} à partir des documents que nous avons au dossier.</p>`;
  }
  if (ecartCents < 0) {
    return `<p style="${p}">Votre relevé indique donc ${montant} de plus que ce que nous avons ` +
      'à notre dossier. Il se peut simplement que certains de nos paiements ne vous soient pas ' +
      'encore parvenus ou n\'aient pas encore été portés à notre compte.</p>';
  }
  return `<p style="${p}">Votre relevé indique donc ${montant} de moins que ce que nous avons ` +
    'à notre dossier. Il se peut qu\'une facture ou un ajustement de votre part nous ait ' +
    'échappé, ou qu\'un montant ait été comptabilisé deux fois chez nous.</p>';
}

/**
 * Tableau des pièces à vérifier : le cœur du courriel. Le client n'a que ces
 * lignes-là à contrôler, pas tout son grand livre.
 * @param {Array<Object>} pieces Pièces {date, type, reference, montantCents}.
 * @param {string} devise Code de devise affiché.
 * @param {boolean} inexplique Vrai si l'origine de l'écart n'a pas été retracée.
 * @return {string} Le bloc HTML, ou '' s'il n'y a aucune pièce.
 */
function courrielsHtmlPieces_(pieces, devise, inexplique) {
  if (!pieces || !pieces.length) return '';
  const visibles = pieces.slice(0, COURRIELS_MAX_PIECES_);
  const reste = pieces.length - visibles.length;
  const introduction = inexplique
    ? 'Voici, pour la période, l\'ensemble des pièces que nous avons à votre dossier :'
    : 'Voici les pièces qui, selon nos registres, pourraient expliquer cette différence. ' +
      'Vous n\'avez donc que ces lignes-là à vérifier :';
  const note = reste > 0
    ? `<tr><td colspan="4" style="${COURRIELS_STYLE_.cellule}">… et ${reste} autre(s) pièce(s) ` +
      'que nous pouvons vous transmettre sur demande.</td></tr>'
    : '';
  return [
    `<p style="${COURRIELS_STYLE_.paragraphe}">${introduction}</p>`,
    `<table role="presentation" cellspacing="0" cellpadding="0" style="${COURRIELS_STYLE_.tableau}">`,
    '<tr>',
    `<th style="${COURRIELS_STYLE_.entete}">Date</th>`,
    `<th style="${COURRIELS_STYLE_.entete}">Type</th>`,
    `<th style="${COURRIELS_STYLE_.entete}">Référence</th>`,
    `<th style="${COURRIELS_STYLE_.enteteDroite}">Montant</th>`,
    '</tr>',
    visibles.map((piece) => courrielsHtmlPiece_(piece, devise)).join('\n'),
    note,
    '</table>',
  ].filter((bloc) => bloc !== '').join('\n');
}

/**
 * Une ligne du tableau des pièces.
 * @param {Object} piece Pièce {date, type, reference, montantCents}.
 * @param {string} devise Code de devise affiché.
 * @return {string} La ligne HTML.
 */
function courrielsHtmlPiece_(piece, devise) {
  const date = courrielsEchapperHtml_(formaterDate_(piece.date)) || '—';
  const type = courrielsEchapperHtml_(piece.type) || '—';
  const reference = courrielsEchapperHtml_(piece.reference) || '—';
  const montant = courrielsEchapperHtml_(formaterMontant_(piece.montantCents, devise));
  return `<tr><td style="${COURRIELS_STYLE_.cellule}">${date}</td>` +
    `<td style="${COURRIELS_STYLE_.cellule}">${type}</td>` +
    `<td style="${COURRIELS_STYLE_.cellule}">${reference}</td>` +
    `<td style="${COURRIELS_STYLE_.celluleDroite}">${montant}</td></tr>`;
}

/**
 * Ce qu'on demande au client : confirmer, corriger, ou nous faire parvenir son
 * état de compte détaillé quand l'écart reste sans explication.
 * @param {boolean} inexplique Vrai si l'origine de l'écart n'a pas été retracée.
 * @param {{debut: Date, fin: Date}|null} bornes Bornes de la période.
 * @return {string} Le bloc HTML de conclusion.
 */
function courrielsHtmlDemande_(inexplique, bornes) {
  const p = COURRIELS_STYLE_.paragraphe;
  const intervalle = courrielsIntervalleLisible_(bornes);
  const blocs = [];
  if (inexplique) {
    blocs.push(`<p style="${p}">Pourriez-vous nous faire parvenir votre <strong>état de compte ` +
      `détaillé</strong>${intervalle ? ` pour la période ${courrielsEchapperHtml_(intervalle)}` : ''}, ` +
      'avec la liste des factures et des paiements que vous avez appliqués à notre compte ? ' +
      'Nous le comparerons ligne par ligne avec le nôtre et nous reviendrons vers vous avec ' +
      'le résultat.</p>');
  } else {
    blocs.push(`<p style="${p}">Pourriez-vous vérifier si ces pièces apparaissent bien à notre ` +
      'compte dans vos livres ? Si l\'une d\'elles vous manque, nous vous en transmettons ' +
      'volontiers la preuve (avis de virement, copie du chèque ou de la facture).</p>');
  }
  blocs.push(`<p style="${p}">Si tout concorde de votre côté, un simple mot de confirmation nous ` +
    'suffira : nous corrigerons alors nos registres en conséquence. Et si l\'erreur vient de ' +
    'chez nous, dites-le-nous sans hésiter, nous la corrigerons tout de suite.</p>');
  return blocs.join('\n');
}

// ---------------------------------------------------------------------------
// Collecte des pièces à faire vérifier par le client
// ---------------------------------------------------------------------------

/**
 * Rassemble les pièces d'un client pour la période : d'abord les paiements
 * (la cause la plus fréquente d'un solde trop élevé), puis les factures dont
 * le montant reste à valider.
 * @param {Object} contexte Contexte préparé par courrielsContexte_.
 * @param {string} idClient ID du client.
 * @param {boolean} inexplique Vrai si l'origine de l'écart n'a pas été retracée.
 * @return {Array<Object>} Pièces {date, type, reference, montantCents}.
 */
function courrielsPieces_(contexte, idClient, inexplique) {
  const paiements = (contexte.paiementsParClient.get(idClient) || [])
    .filter((ligne) => courrielsDansPeriode_(ligne[COURRIELS_COL_.PAIEMENT_DATE], contexte.bornes));
  const nonDeduits = paiements.filter((ligne) =>
    !courrielsMemeValeur_(ligne[COURRIELS_COL_.PAIEMENT_DEDUIT], 'Oui'));
  const retenus = (inexplique || !nonDeduits.length) ? paiements : nonDeduits;
  const factures = (contexte.facturesParClient.get(idClient) || [])
    .filter((ligne) => courrielsFactureRetenue_(ligne, contexte, inexplique));
  const pieces = retenus
    .map((ligne) => courrielsPiecePaiement_(ligne))
    .concat(factures.map((ligne) => courrielsPieceFacture_(ligne)));
  return pieces.sort((a, b) => {
    const dateA = a.date ? a.date.getTime() : 0;
    const dateB = b.date ? b.date.getTime() : 0;
    return dateA - dateB;
  });
}

/**
 * Vrai si une date tombe dans la période traitée. Sans bornes connues, on
 * accepte tout : mieux vaut une liste un peu large qu'une liste vide.
 * @param {*} valeur Date lue dans la feuille.
 * @param {{debut: Date, fin: Date}|null} bornes Bornes de la période.
 * @return {boolean}
 */
function courrielsDansPeriode_(valeur, bornes) {
  if (!bornes) return true;
  const date = versDate_(valeur);
  if (!date) return false;
  return date.getTime() >= bornes.debut.getTime() && date.getTime() <= bornes.fin.getTime();
}

/**
 * Vrai si une facture mérite d'être soumise au client : celles dont le montant
 * reste à valider, reçues en double ou sans bilan correspondant. Quand l'écart
 * est inexpliqué, on joint aussi les factures conformes de la période pour que
 * le client puisse comparer ligne par ligne.
 * @param {Object} facture Ligne de l'onglet Factures.
 * @param {Object} contexte Contexte préparé par courrielsContexte_.
 * @param {boolean} inexplique Vrai si l'origine de l'écart n'a pas été retracée.
 * @return {boolean}
 */
function courrielsFactureRetenue_(facture, contexte, inexplique) {
  if (!courrielsFactureDeLaPeriode_(facture, contexte)) return false;
  const statut = facture[COURRIELS_COL_.FACTURE_VERIF];
  if (courrielsMemeValeur_(statut, STATUT_VERIF.ECART) ||
      courrielsMemeValeur_(statut, STATUT_VERIF.DOUBLON) ||
      courrielsMemeValeur_(statut, STATUT_VERIF.SANS_BILAN)) {
    return true;
  }
  return inexplique && courrielsMemeValeur_(statut, STATUT_VERIF.CONFORME);
}

/**
 * Vrai si une facture relève de la période traitée : sa date fait foi, et à
 * défaut sa colonne Période (on retient alors tout chevauchement).
 * @param {Object} facture Ligne de l'onglet Factures.
 * @param {Object} contexte Contexte préparé par courrielsContexte_.
 * @return {boolean}
 */
function courrielsFactureDeLaPeriode_(facture, contexte) {
  const date = versDate_(facture[COURRIELS_COL_.FACTURE_DATE]);
  if (date) return courrielsDansPeriode_(date, contexte.bornes);
  const bornes = courrielsBornesPeriode_(facture[COURRIELS_COL_.FACTURE_PERIODE], contexte.params);
  if (!bornes) return false;
  if (!contexte.bornes) return true;
  return bornes.debut.getTime() <= contexte.bornes.fin.getTime() &&
    bornes.fin.getTime() >= contexte.bornes.debut.getTime();
}

/**
 * Transforme un paiement en pièce affichable dans le courriel.
 * @param {Object} paiement Ligne de l'onglet Paiements.
 * @return {Object} Pièce {date, type, reference, montantCents}.
 */
function courrielsPiecePaiement_(paiement) {
  const methode = courrielsTexte_(paiement[COURRIELS_COL_.PAIEMENT_METHODE]);
  const reference = courrielsTexte_(paiement[COURRIELS_COL_.PAIEMENT_REFERENCE]) ||
    courrielsTexte_(paiement[COURRIELS_COL_.PAIEMENT_FACTURE]) ||
    courrielsTexte_(paiement[COURRIELS_COL_.PAIEMENT_ID]);
  return {
    date: versDate_(paiement[COURRIELS_COL_.PAIEMENT_DATE]),
    type: methode ? `Notre paiement (${methode})` : 'Notre paiement',
    reference: reference,
    montantCents: enCents_(paiement[COURRIELS_COL_.PAIEMENT_MONTANT]),
  };
}

/**
 * Transforme une facture en pièce affichable dans le courriel. Le libellé reste
 * factuel : on décrit ce que nous avons au dossier, on n'affirme pas une faute.
 * @param {Object} facture Ligne de l'onglet Factures.
 * @return {Object} Pièce {date, type, reference, montantCents}.
 */
function courrielsPieceFacture_(facture) {
  const statut = facture[COURRIELS_COL_.FACTURE_VERIF];
  let type = 'Votre facture';
  if (courrielsMemeValeur_(statut, STATUT_VERIF.ECART)) type = 'Votre facture (montant à valider)';
  else if (courrielsMemeValeur_(statut, STATUT_VERIF.DOUBLON)) type = 'Votre facture (reçue en double)';
  else if (courrielsMemeValeur_(statut, STATUT_VERIF.SANS_BILAN)) type = 'Votre facture (à rapprocher)';
  return {
    date: versDate_(facture[COURRIELS_COL_.FACTURE_DATE]),
    type: type,
    reference: courrielsTexte_(facture[COURRIELS_COL_.FACTURE_NUMERO]) ||
      courrielsTexte_(facture[COURRIELS_COL_.FACTURE_ID]),
    montantCents: enCents_(facture[COURRIELS_COL_.FACTURE_TOTAL]),
  };
}

// ---------------------------------------------------------------------------
// Point d'entrée du menu : relancer les clients en écart
// ---------------------------------------------------------------------------

/**
 * Prépare un courriel de relance par client en écart. La période traitée est
 * celle que l'appelant transmet — 07_Rapprochement.gs passe la période qu'il
 * vient de calculer, pour ne jamais relancer un autre trimestre que celui-là.
 * Sans argument (appel depuis le menu), c'est la période la plus récente de
 * l'onglet Rapprochement qui est retenue. Les lignes déjà relancées sont
 * sautées : videz la cellule « Relance » pour en refaire une.
 * @param {string} [periode] Période 'AAAA-TN' à relancer.
 * @return {string} Résumé lisible, affiché par le menu.
 */
function relancerClientsEnEcart(periode) {
  const debut = new Date().getTime();
  const nomOnglet = CONFIG.ONGLETS.RAPPROCHEMENT.nom;
  const params = lireParametres_();
  const lignes = lireTable_(nomOnglet);
  const periodeTraitee = courrielsTexte_(periode) || courrielsPeriodeLaPlusRecente_(lignes);
  if (!periodeTraitee) {
    return `Aucune période à relancer : l'onglet « ${nomOnglet} » est vide. ` +
      'Lancez d\'abord « 7. Rapprochement trimestriel ».';
  }
  const selection = courrielsSelectionner_(lignes, periodeTraitee);
  const resume = courrielsNouveauResume_(periodeTraitee, selection);
  if (!selection.aTraiter.length) {
    return courrielsResume_(resume);
  }
  const contexte = courrielsContexte_(periodeTraitee, params);
  const groupes = indexerGroupesPar_(selection.aTraiter, COURRIELS_COL_.RAPPRO_CLIENT);
  const entrees = [];
  groupes.forEach((lignesClient, idClient) => entrees.push({ id: idClient, lignes: lignesClient }));

  // Les brouillons sont créés un par un dans Gmail : la colonne « Relance » est
  // écrite au fil de l'eau (tous les COURRIELS_LOT_MAJ_ clients) et l'exécution
  // s'arrête d'elle-même avant les 6 minutes. Ainsi un courriel qui existe déjà
  // dans Gmail est toujours marqué, et le passage suivant ne le refait pas.
  let majs = [];
  let traites = 0;
  let arretTemps = false;
  for (let i = 0; i < entrees.length; i++) {
    const entree = entrees[i];
    if (arretTemps) { resume.interrompus += entree.lignes.length; continue; }
    if (resume.envoyes + resume.brouillons >= contexte.disponible) {
      resume.restants += entree.lignes.length;
      continue;
    }
    if (new Date().getTime() - debut > COURRIELS_DUREE_MAX_MS_) {
      arretTemps = true;
      resume.interrompus += entree.lignes.length;
      continue;
    }
    const statut = courrielsTraiterClient_(contexte, entree.id, entree.lignes, resume);
    const patch = {};
    patch[COURRIELS_COL_.RAPPRO_RELANCE] = statut;
    entree.lignes.forEach((ligne) => majs.push({ ligne: ligne._ligne, patch: patch }));
    traites++;
    if (traites % COURRIELS_LOT_MAJ_ === 0) {
      courrielsEcrireRelances_(nomOnglet, majs);
      majs = [];
    }
  }
  courrielsEcrireRelances_(nomOnglet, majs);
  courrielsJournaliserRelance_(resume);
  return courrielsResume_(resume);
}

/**
 * Écrit un lot de valeurs dans la colonne « Relance ». Un échec d'écriture est
 * journalisé sans interrompre la relance : les courriels déjà préparés restent
 * tracés dans le Journal, et l'utilisateur sait quoi regarder.
 * @param {string} nomOnglet Onglet Rapprochement.
 * @param {Array<{ligne: number, patch: Object}>} majs Mises à jour à écrire.
 * @return {boolean} Vrai si le lot a bien été écrit.
 */
function courrielsEcrireRelances_(nomOnglet, majs) {
  if (!majs || !majs.length) return true;
  try {
    majLignes_(nomOnglet, majs);
    return true;
  } catch (e) {
    journalErreur_('relancerClientsEnEcart',
      `${majs.length} ligne(s) de l'onglet ${nomOnglet} n'ont pas pu être marquées dans la ` +
      `colonne « ${COURRIELS_COL_.RAPPRO_RELANCE} » : leurs courriels ont pourtant été ` +
      'préparés. Vérifiez Gmail avant de relancer cette action.',
      `${e.message}\n${e.stack}`);
    return false;
  }
}

/**
 * Période la plus récente présente dans l'onglet Rapprochement. Les périodes
 * 'AAAA-TN' se trient correctement dans l'ordre alphabétique.
 * @param {Array<Object>} lignes Lignes de l'onglet Rapprochement.
 * @return {string} La période la plus récente, ou '' si l'onglet est vide.
 */
function courrielsPeriodeLaPlusRecente_(lignes) {
  const periodes = (lignes || [])
    .map((ligne) => courrielsTexte_(ligne[COURRIELS_COL_.RAPPRO_PERIODE]))
    .filter((periode) => periode !== '')
    .sort();
  return periodes.length ? periodes[periodes.length - 1] : '';
}

/**
 * Retient les lignes de la période à relancer : verdict « ⚠️ Écart expliqué »
 * ou « ❌ Écart inexpliqué », et pas déjà relancées avec succès.
 * @param {Array<Object>} lignes Lignes de l'onglet Rapprochement.
 * @param {string} periode Période traitée.
 * @return {{aTraiter: Array<Object>, dejaFaites: number, sansId: number}} Sélection.
 */
function courrielsSelectionner_(lignes, periode) {
  const aTraiter = [];
  let dejaFaites = 0;
  let sansId = 0;
  (lignes || []).forEach((ligne) => {
    if (courrielsTexte_(ligne[COURRIELS_COL_.RAPPRO_PERIODE]) !== periode) return;
    const verdict = ligne[COURRIELS_COL_.RAPPRO_VERDICT];
    if (!courrielsMemeValeur_(verdict, VERDICT.EXPLIQUE) &&
        !courrielsMemeValeur_(verdict, VERDICT.INEXPLIQUE)) return;
    if (courrielsDejaRelancee_(ligne)) { dejaFaites++; return; }
    if (!courrielsTexte_(ligne[COURRIELS_COL_.RAPPRO_CLIENT])) {
      sansId++;
      journalAvert_('relancerClientsEnEcart',
        `Ligne ${ligne._ligne} du rapprochement ignorée : la colonne ` +
        `« ${COURRIELS_COL_.RAPPRO_CLIENT} » est vide.`,
        'Relancez le rapprochement trimestriel pour régénérer cette ligne.');
      return;
    }
    aTraiter.push(ligne);
  });
  return { aTraiter: aTraiter, dejaFaites: dejaFaites, sansId: sansId };
}

/**
 * Vrai si la ligne porte déjà une relance réussie. Une cellule vide, un tiret
 * ou un « Échec » sont au contraire des lignes à (re)traiter : c'est ainsi que
 * l'utilisateur redemande une relance, en vidant simplement la cellule.
 * @param {Object} ligne Ligne de l'onglet Rapprochement.
 * @return {boolean}
 */
function courrielsDejaRelancee_(ligne) {
  const valeur = texteNormalise_(ligne[COURRIELS_COL_.RAPPRO_RELANCE]);
  if (!valeur) return false;
  return valeur === texteNormalise_(COURRIELS_RELANCE_.ENVOYEE) ||
    valeur === texteNormalise_(COURRIELS_RESULTAT_.ENVOYE) ||
    valeur === texteNormalise_(COURRIELS_RELANCE_.BROUILLON);
}

/**
 * Prépare tout ce dont la relance a besoin, en une seule lecture par onglet.
 * @param {string} periode Période traitée.
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {Object} Contexte partagé de la relance.
 */
function courrielsContexte_(periode, params) {
  const direct = texteNormalise_(params.MODE_ENVOI) === 'DIRECT';
  const disponible = direct
    ? Math.max(0, quotaCourrielRestant_() - COURRIELS_MARGE_QUOTA_)
    : Number.MAX_SAFE_INTEGER;
  return {
    periode: periode,
    params: params,
    bornes: courrielsBornesPeriode_(periode, params),
    clients: indexerPar_(lireTable_(CONFIG.ONGLETS.CLIENTS.nom), COURRIELS_COL_.CLIENT_ID),
    paiementsParClient: indexerGroupesPar_(lireTable_(CONFIG.ONGLETS.PAIEMENTS.nom),
      COURRIELS_COL_.PAIEMENT_CLIENT),
    facturesParClient: indexerGroupesPar_(lireTable_(CONFIG.ONGLETS.FACTURES.nom),
      COURRIELS_COL_.FACTURE_CLIENT),
    direct: direct,
    disponible: disponible,
  };
}

/**
 * Prépare et remet à Gmail le courriel d'un client : un seul message, même si
 * le client présente plusieurs lignes d'anomalie pour la période.
 * @param {Object} contexte Contexte préparé par courrielsContexte_.
 * @param {string} idClient ID du client.
 * @param {Array<Object>} lignesClient Lignes de rapprochement de ce client.
 * @param {Object} resume Compteurs de l'exécution, complétés au passage.
 * @return {string} Valeur à écrire dans la colonne « Relance ».
 */
function courrielsTraiterClient_(contexte, idClient, lignesClient, resume) {
  const principale = courrielsLignePrincipale_(lignesClient);
  const client = contexte.clients.get(idClient) || {};
  const nom = courrielsTexte_(client[COURRIELS_COL_.CLIENT_NOM]) ||
    courrielsTexte_(principale[COURRIELS_COL_.RAPPRO_NOM]) || idClient;
  const destinataire = courrielsTexte_(client[COURRIELS_COL_.CLIENT_COURRIEL]);
  if (!destinataire) {
    resume.sansCourriel.push(nom);
    journalAvert_('relancerClientsEnEcart',
      `Relance impossible pour ${nom} : aucune adresse courriel.`,
      `Complétez la colonne « ${COURRIELS_COL_.CLIENT_COURRIEL} » de l'onglet ` +
      `${CONFIG.ONGLETS.CLIENTS.nom}, puis relancez cette action.`);
    return COURRIELS_RELANCE_.ECHEC;
  }
  let statut = COURRIELS_RESULTAT_.ECHEC;
  try {
    const enrichie = Object.assign({}, principale);
    enrichie._pieces = courrielsPieces_(contexte, idClient, courrielsEstInexplique_(principale));
    enrichie._devise = courrielsDevise_(client, contexte.params);
    statut = envoyerOuBrouillonner_(destinataire, courrielsSujetRelance_(principale),
      construireRelanceHtml_(client, enrichie, contexte.params), {
        cc: client[COURRIELS_COL_.CLIENT_COPIE],
        nomExpediteur: contexte.params.NOM_EXPEDITEUR,
      });
  } catch (e) {
    journalErreur_('relancerClientsEnEcart',
      `La relance de ${nom} n'a pas pu être préparée : ${e.message}`, `${e.message}\n${e.stack}`);
    statut = COURRIELS_RESULTAT_.ECHEC;
  }
  return courrielsComptabiliser_(statut, nom, resume);
}

/**
 * Ligne de rapprochement retenue pour rédiger le courriel : celle dont l'écart
 * est le plus important quand un client en présente plusieurs.
 * @param {Array<Object>} lignesClient Lignes de rapprochement d'un client.
 * @return {Object} La ligne principale.
 */
function courrielsLignePrincipale_(lignesClient) {
  let principale = lignesClient[0];
  let maximum = Math.abs(courrielsSoldesLigne_(principale).ecart);
  lignesClient.forEach((ligne) => {
    const ecart = Math.abs(courrielsSoldesLigne_(ligne).ecart);
    if (ecart > maximum) { maximum = ecart; principale = ligne; }
  });
  return principale;
}

/**
 * Traduit le résultat d'un envoi en valeur pour la colonne « Relance » et met
 * à jour les compteurs du résumé.
 * @param {string} statut Résultat de envoyerOuBrouillonner_.
 * @param {string} nom Nom du client, pour le résumé.
 * @param {Object} resume Compteurs de l'exécution.
 * @return {string} Valeur à écrire dans la colonne « Relance ».
 */
function courrielsComptabiliser_(statut, nom, resume) {
  if (courrielsMemeValeur_(statut, COURRIELS_RESULTAT_.ENVOYE)) {
    resume.envoyes++;
    return COURRIELS_RELANCE_.ENVOYEE;
  }
  if (courrielsMemeValeur_(statut, COURRIELS_RESULTAT_.BROUILLON)) {
    resume.brouillons++;
    return COURRIELS_RELANCE_.BROUILLON;
  }
  resume.echecs.push(nom);
  return COURRIELS_RELANCE_.ECHEC;
}

// ---------------------------------------------------------------------------
// Résumé affiché à l'utilisateur
// ---------------------------------------------------------------------------

/**
 * Compteurs vierges pour une exécution de relance.
 * @param {string} periode Période traitée.
 * @param {{aTraiter: Array<Object>, dejaFaites: number}} selection Sélection.
 * @return {Object} Le résumé, complété au fil du traitement.
 */
function courrielsNouveauResume_(periode, selection) {
  return {
    periode: periode,
    total: selection.aTraiter.length,
    dejaFaites: selection.dejaFaites,
    sansId: selection.sansId || 0,
    envoyes: 0,
    brouillons: 0,
    restants: 0,
    interrompus: 0,
    echecs: [],
    sansCourriel: [],
  };
}

/**
 * Journalise le déroulement de la relance, y compris ce qui reste à faire.
 * @param {Object} resume Compteurs de l'exécution.
 * @return {void}
 */
function courrielsJournaliserRelance_(resume) {
  journalInfo_('relancerClientsEnEcart',
    `Période ${resume.periode} : ${resume.envoyes} courriel(s) envoyé(s), ` +
    `${resume.brouillons} brouillon(s) préparé(s), ${resume.echecs.length} échec(s).`,
    `${resume.total} ligne(s) en écart à traiter, ${resume.dejaFaites} déjà relancée(s), ` +
    `${resume.sansCourriel.length} client(s) sans adresse courriel.`);
  if (resume.restants > 0) {
    journalAvert_('relancerClientsEnEcart',
      `Quota de courriels atteint : ${resume.restants} ligne(s) restent à relancer.`,
      'Leur colonne « Relance » n\'a pas été touchée : le prochain passage reprendra ' +
      'exactement là où celui-ci s\'est arrêté.');
  }
  if (resume.interrompus > 0) {
    journalAvert_('relancerClientsEnEcart',
      `Arrêt volontaire avant la limite des 6 minutes : ${resume.interrompus} ligne(s) ` +
      'restent à relancer.',
      `Les relances déjà préparées sont marquées dans la colonne ` +
      `« ${COURRIELS_COL_.RAPPRO_RELANCE} » : relancez la même action pour reprendre ` +
      'exactement là où celle-ci s\'est arrêtée, sans créer de doublon dans Gmail.');
  }
}

/**
 * Rédige le résumé affiché dans la fenêtre du menu, en français clair.
 * @param {Object} resume Compteurs de l'exécution.
 * @return {string} Le message affiché à l'utilisateur.
 */
function courrielsResume_(resume) {
  const lignes = [`Période traitée : ${resume.periode}.`];
  if (!resume.total) {
    lignes.push(resume.dejaFaites
      ? `Les ${resume.dejaFaites} client(s) en écart ont déjà été relancés. Pour en refaire un, ` +
        `videz sa cellule « ${COURRIELS_COL_.RAPPRO_RELANCE} » puis relancez cette action.`
      : 'Aucun client en écart à relancer pour cette période. Tout balance : rien à faire.');
    if (resume.sansId) {
      lignes.push(`${resume.sansId} ligne(s) sans « ${COURRIELS_COL_.RAPPRO_CLIENT} » ont été ` +
        'ignorées : relancez le rapprochement trimestriel pour les régénérer.');
    }
    return lignes.join('\n\n');
  }
  if (resume.brouillons) {
    lignes.push(`${resume.brouillons} brouillon(s) de relance préparé(s) dans Gmail. ` +
      'Ouvrez Gmail, relisez-les, puis envoyez-les vous-même.');
  }
  if (resume.envoyes) lignes.push(`${resume.envoyes} courriel(s) envoyé(s) directement.`);
  if (resume.sansCourriel.length) {
    lignes.push(`${resume.sansCourriel.length} client(s) sans adresse courriel : ` +
      `${courrielsListeCourte_(resume.sansCourriel)}. Complétez l'onglet ` +
      `${CONFIG.ONGLETS.CLIENTS.nom}, puis relancez cette action.`);
  }
  if (resume.echecs.length) {
    lignes.push(`${resume.echecs.length} relance(s) n'ont pas abouti : ` +
      `${courrielsListeCourte_(resume.echecs)}. Le Journal en donne la raison.`);
  }
  if (resume.dejaFaites) lignes.push(`${resume.dejaFaites} client(s) déjà relancé(s) ont été sautés.`);
  if (resume.sansId) {
    lignes.push(`${resume.sansId} ligne(s) sans « ${COURRIELS_COL_.RAPPRO_CLIENT} » ont été ` +
      'ignorées : relancez le rapprochement trimestriel pour les régénérer.');
  }
  if (resume.restants) {
    lignes.push(`${resume.restants} ligne(s) n'ont pas pu être traitées aujourd'hui ` +
      '(quota de courriels atteint) : relancez cette action demain.');
  }
  if (resume.interrompus) {
    lignes.push(`${resume.interrompus} ligne(s) n'ont pas pu être traitées dans le temps ` +
      'imparti (Google coupe une exécution au bout de 6 minutes). Relancez simplement la ' +
      'même action : elle reprendra où elle s\'est arrêtée et ne renverra pas les courriels ' +
      'déjà préparés.');
  }
  lignes.push(`La colonne « ${COURRIELS_COL_.RAPPRO_RELANCE} » de l'onglet ` +
    `${CONFIG.ONGLETS.RAPPROCHEMENT.nom} indique le résultat, client par client.`);
  return lignes.join('\n\n');
}

/**
 * Énumère quelques noms puis abrège, pour garder un message lisible.
 * @param {Array<string>} elements Noms à énumérer.
 * @param {number} [maximum] Nombre de noms affichés (3 par défaut).
 * @return {string} Énumération abrégée.
 */
function courrielsListeCourte_(elements, maximum) {
  const plafond = maximum || 3;
  const visibles = elements.slice(0, plafond);
  const reste = elements.length - visibles.length;
  return visibles.join(', ') + (reste > 0 ? ` et ${reste} autre(s)` : '');
}
