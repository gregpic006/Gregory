/**
 * 05_Factures.gs — Réception et vérification des factures des clients.
 *
 * Deux points d'entrée :
 *   importerFacturesGmail() — récupère les factures reçues par courriel et les
 *                             dépose dans l'onglet Factures au statut « À vérifier ».
 *   verifierFactures()      — compare chaque facture « À vérifier » à son bilan
 *                             et explique l'écart quand il y en a un (§4.3 de SPEC.md).
 *
 * Deux garanties tiennent tout le module :
 *   1. LE SCRIPT NE DÉCIDE JAMAIS DU MONTANT À PAYER. Un montant lu dans un
 *      courriel est une SUGGESTION : la facture reste « À vérifier » et la
 *      colonne Notes le dit en toutes lettres.
 *   2. LA DÉCISION HUMAINE EST RESPECTÉE. Une facture passée à « Conforme » ou
 *      « Rejetée » n'est jamais réécrite (§4.3) — ce sont les deux seuls verdicts
 *      que le script vous laisse. À l'inverse, « Sans bilan », « Écart de montant »
 *      et « Doublon » sont SES propres verdicts : il les réexamine à chaque
 *      passage, pour que « corrigez puis relancez la vérification » fonctionne.
 *
 * verifierUneFacture_(), rattacherBilan_() et expliquerEcartFacture_() sont des
 * fonctions PURES : elles ne touchent ni au classeur, ni à Gmail, ni à Drive.
 * Elles reçoivent leurs données en paramètre, ce qui les rend testables hors de
 * Google (10_Tests.gs).
 */

// ---------------------------------------------------------------------------
// Noms de colonnes — toujours lus dans CONFIG, jamais codés en dur
// ---------------------------------------------------------------------------

/** Colonnes de l'onglet Factures. */
const FACTURES_COL_ = {
  ID: CONFIG.ONGLETS.FACTURES.colonnes[0].nom,
  CLIENT: CONFIG.ONGLETS.FACTURES.colonnes[1].nom,
  NOM_CLIENT: CONFIG.ONGLETS.FACTURES.colonnes[2].nom,
  NUMERO: CONFIG.ONGLETS.FACTURES.colonnes[3].nom,
  DATE: CONFIG.ONGLETS.FACTURES.colonnes[4].nom,
  PERIODE: CONFIG.ONGLETS.FACTURES.colonnes[5].nom,
  AVANT_TAXES: CONFIG.ONGLETS.FACTURES.colonnes[6].nom,
  TAXES: CONFIG.ONGLETS.FACTURES.colonnes[7].nom,
  TOTAL: CONFIG.ONGLETS.FACTURES.colonnes[8].nom,
  BILAN: CONFIG.ONGLETS.FACTURES.colonnes[9].nom,
  VERIFICATION: CONFIG.ONGLETS.FACTURES.colonnes[10].nom,
  ECART: CONFIG.ONGLETS.FACTURES.colonnes[11].nom,
  PAIEMENT: CONFIG.ONGLETS.FACTURES.colonnes[12].nom,
  LIEN_COURRIEL: CONFIG.ONGLETS.FACTURES.colonnes[13].nom,
  LIEN_PIECE: CONFIG.ONGLETS.FACTURES.colonnes[14].nom,
  NOTES: CONFIG.ONGLETS.FACTURES.colonnes[15].nom,
};

/** Colonnes de l'onglet Bilans utilisées ici. */
const FACTURES_COL_BILAN_ = {
  ID: CONFIG.ONGLETS.BILANS.colonnes[0].nom,
  CLIENT: CONFIG.ONGLETS.BILANS.colonnes[1].nom,
  NOM_CLIENT: CONFIG.ONGLETS.BILANS.colonnes[2].nom,
  PERIODE: CONFIG.ONGLETS.BILANS.colonnes[3].nom,
  MONTANT: CONFIG.ONGLETS.BILANS.colonnes[6].nom,
  STATUT: CONFIG.ONGLETS.BILANS.colonnes[8].nom,
  FACTURE: CONFIG.ONGLETS.BILANS.colonnes[9].nom,
};

/** Colonnes de l'onglet Lignes_bilan utilisées ici. */
const FACTURES_COL_LIGNE_ = {
  CLIENT: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[1].nom,
  PERIODE: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[2].nom,
  DESCRIPTION: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[4].nom,
  QUANTITE: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[5].nom,
  PRIX: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[6].nom,
  MONTANT: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[7].nom,
  BILAN: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[8].nom,
};

/** Colonnes de l'onglet Clients utilisées ici. */
const FACTURES_COL_CLIENT_ = {
  ID: CONFIG.ONGLETS.CLIENTS.colonnes[0].nom,
  NOM: CONFIG.ONGLETS.CLIENTS.colonnes[1].nom,
  COURRIEL: CONFIG.ONGLETS.CLIENTS.colonnes[2].nom,
  COPIE: CONFIG.ONGLETS.CLIENTS.colonnes[3].nom,
};

// ---------------------------------------------------------------------------
// Réglages internes du module
// ---------------------------------------------------------------------------

/** Nombre maximal de fils Gmail traités par exécution (limite des 6 minutes). */
const FACTURES_MAX_FILS_ = 50;

/** Durée au-delà de laquelle l'import s'arrête proprement (4 min 30 s). */
const FACTURES_DUREE_MAX_MS_ = 270000;

/** Longueur de corps de courriel analysée pour y chercher un montant. */
const FACTURES_CORPS_MAX_ = 5000;

/** Écart relatif accepté pour un rattachement approximatif (2 %). */
const FACTURES_ECART_RELATIF_MAX_ = 0.02;

/** Les taxes sont arrondies au cent : on tolère 2 cents dans les comparaisons. */
const FACTURES_TOLERANCE_TAXES_ = 2;

/**
 * Le commentaire automatique de vérification est encadré par ces deux
 * marqueurs. Le script ne réécrit QUE ce qui se trouve strictement entre eux :
 * tout ce que VOUS écrivez avant ⟦auto⟧ ou après ⟦/auto⟧ est conservé tel quel.
 */
const FACTURES_MARQUEUR_DEBUT_ = '⟦auto⟧';
const FACTURES_MARQUEUR_FIN_ = '⟦/auto⟧';

/** En-tête du commentaire automatique, à l'intérieur des marqueurs. */
const FACTURES_ENTETE_NOTE_ = 'Vérification : ';

/** Ancien délimiteur, d'avant les marqueurs : encore lu, jamais réécrit. */
const FACTURES_SEPARATEUR_NOTE_ = ' | ' + FACTURES_ENTETE_NOTE_;

/** Un montant écrit à la québécoise : 1 234,56 / 1,234.56 / 1234.56 / 1234. */
const FACTURES_NOMBRE_ = '\\d+(?:[ \\u00A0\\u202F.,]\\d{3})*(?:[.,]\\d{1,2})?';

/** Montant accompagné d'un symbole de devise : 1 234,56 $ ou $1,234.56. */
const FACTURES_MOTIF_MONTANT_ =
  '\\$\\s*(' + FACTURES_NOMBRE_ + ')|(' + FACTURES_NOMBRE_ + ')\\s*(?:\\$|CAD\\b|CAN\\$)';

/** Montant annoncé par un mot-clé, quand aucun symbole de devise n'apparaît. */
const FACTURES_MOTIF_MONTANT_MOT_ =
  '(?:total|montant|à payer|a payer|net à payer|solde|somme)[^\\d\\n]{0,24}(' +
  FACTURES_NOMBRE_ + ')';

/** N° de facture annoncé par facture / invoice / n° / no / #. */
const FACTURES_MOTIF_NUMERO_ =
  '(?:factures?|invoice|n[o°]s?|#)\\s*[:.\\-\\u2013\\u2014]?\\s*(?:n[o°]\\s*)?([A-Za-z0-9][A-Za-z0-9\\-_/.]{1,29})';

// ---------------------------------------------------------------------------
// §4.3 — Vérification d'une facture (fonctions pures)
// ---------------------------------------------------------------------------

/**
 * Normalise un n° de facture pour la comparaison : sans espaces, sans tirets,
 * sans accents, en majuscules. « INV 2026-001 » et « inv2026001 » deviennent
 * identiques, ce qui permet de repérer un doublon envoyé deux fois.
 * @param {*} numero Numéro tel qu'écrit par le client.
 * @return {string} Numéro comparable, ou chaîne vide.
 */
function facturesNormaliserNumero_(numero) {
  return texteNormalise_(numero);
}

/**
 * Lit une valeur de cellule comme un texte propre (jamais 'undefined').
 * @param {*} valeur Valeur brute.
 * @return {string} Texte sans espaces autour.
 */
function facturesTexte_(valeur) {
  if (valeur === null || valeur === undefined) return '';
  return String(valeur).trim();
}

/**
 * Indique si une facture a été annulée (statut de paiement « Annulée »).
 * @param {Object} facture Ligne de l'onglet Factures.
 * @return {boolean} Vrai si la facture est annulée.
 */
function facturesEstAnnulee_(facture) {
  return texteNormalise_(facture[FACTURES_COL_.PAIEMENT]) ===
         texteNormalise_(STATUT_PAIEMENT.ANNULEE);
}

/**
 * Retrouve la position d'une facture dans la liste des factures existantes.
 * Sert à garantir qu'une facture n'est jamais son propre doublon, et que la
 * PREMIÈRE facture enregistrée reste l'originale.
 * @param {Array<Object>} liste Factures existantes, dans l'ordre de l'onglet.
 * @param {Object} facture Facture examinée.
 * @return {number} Index dans la liste, ou -1 si elle n'y figure pas.
 */
function facturesPosition_(liste, facture) {
  const identifiant = facturesTexte_(facture[FACTURES_COL_.ID]);
  for (let i = 0; i < liste.length; i++) {
    if (liste[i] === facture) return i;
    if (identifiant && facturesTexte_(liste[i][FACTURES_COL_.ID]) === identifiant) return i;
  }
  return -1;
}

/**
 * Cherche si la facture reprend une facture déjà enregistrée : même client et
 * même n° de facture, ou même client, même montant total et même période.
 * Les factures annulées ne servent jamais de référence, et une facture n'est
 * jamais son propre doublon.
 * @param {Object} facture Facture examinée.
 * @param {Array<Object>} facturesExistantes Toutes les factures de l'onglet.
 * @return {{facture: Object, motif: string}|null} La facture d'origine, ou null.
 */
function facturesTrouverDoublon_(facture, facturesExistantes) {
  const liste = facturesExistantes || [];
  const client = facturesTexte_(facture[FACTURES_COL_.CLIENT]);
  if (!client) return null;
  const identifiant = facturesTexte_(facture[FACTURES_COL_.ID]);
  const numero = facturesNormaliserNumero_(facture[FACTURES_COL_.NUMERO]);
  const periode = facturesTexte_(facture[FACTURES_COL_.PERIODE]);
  const totalCents = enCents_(facture[FACTURES_COL_.TOTAL]);
  const position = facturesPosition_(liste, facture);
  const limite = position >= 0 ? position : liste.length;

  for (let i = 0; i < limite; i++) {
    const autre = liste[i];
    if (!autre || autre === facture) continue;
    const idAutre = facturesTexte_(autre[FACTURES_COL_.ID]);
    if (identifiant && idAutre === identifiant) continue;
    if (facturesTexte_(autre[FACTURES_COL_.CLIENT]) !== client) continue;
    if (facturesEstAnnulee_(autre)) continue;
    if (numero && facturesNormaliserNumero_(autre[FACTURES_COL_.NUMERO]) === numero) {
      return { facture: autre, motif: 'numero' };
    }
    if (periode && totalCents !== 0 &&
        facturesTexte_(autre[FACTURES_COL_.PERIODE]) === periode &&
        enCents_(autre[FACTURES_COL_.TOTAL]) === totalCents) {
      return { facture: autre, motif: 'montant' };
    }
  }
  return null;
}

/**
 * Indique si un bilan est encore disponible pour cette facture : sa colonne
 * ID facture est vide, ou porte déjà l'identifiant de cette facture (ce qui
 * rend la vérification rejouable sans effet de bord).
 * @param {Object} bilan Ligne de l'onglet Bilans.
 * @param {string} idFacture Identifiant de la facture examinée.
 * @return {boolean} Vrai si le bilan peut être rattaché.
 */
function facturesBilanLibre_(bilan, idFacture) {
  const rattachee = facturesTexte_(bilan[FACTURES_COL_BILAN_.FACTURE]);
  return rattachee === '' || (idFacture !== '' && rattachee === idFacture);
}

/**
 * Parmi des bilans, celui dont le montant est le plus proche d'une cible.
 * @param {Array<Object>} bilans Bilans candidats.
 * @param {number} cibleCents Montant visé, en cents.
 * @return {Object|null} Le bilan le plus proche, ou null si la liste est vide.
 */
function facturesPlusProche_(bilans, cibleCents) {
  let choisi = null;
  let meilleur = -1;
  (bilans || []).forEach((bilan) => {
    const distance = Math.abs(enCents_(bilan[FACTURES_COL_BILAN_.MONTANT]) - cibleCents);
    if (choisi === null || distance < meilleur) {
      choisi = bilan;
      meilleur = distance;
    }
  });
  return choisi;
}

/**
 * Rattache une facture à un bilan (§4.3). Dans l'ordre :
 *   1. le bilan déjà indiqué dans la colonne ID bilan (décision humaine ou
 *      passage précédent), s'il existe et n'est pas annulé ;
 *   2. un bilan du même client, de la même période, non encore rattaché ;
 *   3. à défaut, le bilan non rattaché du même client le plus proche en montant,
 *      si l'écart relatif est inférieur à 2 %.
 * @param {Object} facture Facture à rattacher.
 * @param {Array<Object>} bilans Toutes les lignes de l'onglet Bilans.
 * @return {Object|null} Le bilan retenu, ou null si aucun ne convient.
 */
function rattacherBilan_(facture, bilans) {
  const client = facturesTexte_(facture[FACTURES_COL_.CLIENT]);
  if (!client) return null;
  const idFacture = facturesTexte_(facture[FACTURES_COL_.ID]);
  const periode = facturesTexte_(facture[FACTURES_COL_.PERIODE]);
  const totalCents = enCents_(facture[FACTURES_COL_.TOTAL]);
  const annule = texteNormalise_(STATUT_BILAN.ANNULE);

  const candidats = (bilans || []).filter((bilan) => bilan &&
    facturesTexte_(bilan[FACTURES_COL_BILAN_.CLIENT]) === client &&
    texteNormalise_(bilan[FACTURES_COL_BILAN_.STATUT]) !== annule);

  const demande = facturesTexte_(facture[FACTURES_COL_.BILAN]);
  if (demande) {
    const impose = candidats.filter(
      (bilan) => facturesTexte_(bilan[FACTURES_COL_BILAN_.ID]) === demande)[0];
    if (impose) return impose;
  }

  const libres = candidats.filter((bilan) => facturesBilanLibre_(bilan, idFacture));
  if (periode) {
    const memePeriode = libres.filter(
      (bilan) => facturesTexte_(bilan[FACTURES_COL_BILAN_.PERIODE]) === periode);
    if (memePeriode.length) return facturesPlusProche_(memePeriode, totalCents);
  }

  const proche = facturesPlusProche_(libres, totalCents);
  if (!proche) return null;
  const montantCents = enCents_(proche[FACTURES_COL_BILAN_.MONTANT]);
  const reference = Math.max(Math.abs(montantCents), Math.abs(totalCents));
  if (reference === 0) return proche;
  return (Math.abs(totalCents - montantCents) / reference) < FACTURES_ECART_RELATIF_MAX_
    ? proche : null;
}

/**
 * Ne garde que les lignes de bilan qui appartiennent au bilan rattaché.
 * @param {Object} bilan Bilan rattaché.
 * @param {Array<Object>} lignes Lignes de l'onglet Lignes_bilan.
 * @return {Array<Object>} Les lignes de ce bilan.
 */
function facturesLignesDuBilan_(bilan, lignes) {
  const liste = lignes || [];
  const identifiant = facturesTexte_(bilan[FACTURES_COL_BILAN_.ID]);
  if (identifiant) {
    const parId = liste.filter(
      (ligne) => ligne && facturesTexte_(ligne[FACTURES_COL_LIGNE_.BILAN]) === identifiant);
    if (parId.length) return parId;
  }
  const client = facturesTexte_(bilan[FACTURES_COL_BILAN_.CLIENT]);
  const periode = facturesTexte_(bilan[FACTURES_COL_BILAN_.PERIODE]);
  if (!client || !periode) return [];
  return liste.filter((ligne) => ligne &&
    facturesTexte_(ligne[FACTURES_COL_LIGNE_.CLIENT]) === client &&
    facturesTexte_(ligne[FACTURES_COL_LIGNE_.PERIODE]) === periode);
}

/*
 * Le montant d'une ligne de Lignes_bilan est calculé PAR bilansMontantLigneCents_
 * (04_Bilans.gs), et par elle seule : c'est la fonction qui a servi à écrire la
 * colonne « Montant du bilan ». Recalculer ici avec d'autres règles (cellule vide
 * confondue avec un zéro saisi, quantité « 2,5 » lue par Number(), quantité vide
 * traitée comme 0) ferait porter l'explication de l'écart sur des montants que le
 * bilan n'a jamais comptés.
 */

/**
 * Teste si l'écart s'explique par les taxes : TPS (5 %), TVQ (9,975 %),
 * TPS + TVQ sur le montant du bilan, ou le montant de taxes de la facture.
 * @param {number} ecartCents Écart facture − bilan, en cents.
 * @param {number} bilanCents Montant du bilan, en cents.
 * @param {number} taxesCents Taxes inscrites sur la facture, en cents.
 * @param {number} tolerance Tolérance de comparaison, en cents.
 * @param {string} devise Devise d'affichage.
 * @return {string} Phrase d'explication, ou chaîne vide.
 */
function facturesExplicationTaxes_(ecartCents, bilanCents, taxesCents, tolerance, devise) {
  const absolu = Math.abs(ecartCents);
  const tps = Math.round(Math.abs(bilanCents) * CONFIG.TAUX_TPS);
  const tvq = Math.round(Math.abs(bilanCents) * CONFIG.TAUX_TVQ);
  const correspond = (montant) => montant > 0 && Math.abs(absolu - montant) <= tolerance;
  const sens = ecartCents > 0
    ? 'ajoutées sur la facture alors que le bilan ne les comprenait pas'
    : 'comprises dans le bilan mais absentes de la facture';

  if (correspond(tps)) {
    return `Cet écart correspond exactement à la TPS (5 %) sur le montant du bilan ` +
      `(${formaterMontant_(tps, devise)}) : des taxes semblent ${sens}.`;
  }
  if (correspond(tvq)) {
    return `Cet écart correspond exactement à la TVQ (9,975 %) sur le montant du bilan ` +
      `(${formaterMontant_(tvq, devise)}) : des taxes semblent ${sens}.`;
  }
  if (correspond(tps + tvq)) {
    return `Cet écart correspond exactement à la TPS + TVQ (14,975 %) sur le montant du bilan ` +
      `(${formaterMontant_(tps + tvq, devise)}) : des taxes semblent ${sens}.`;
  }
  if (correspond(Math.abs(taxesCents))) {
    return `Cet écart correspond exactement aux taxes inscrites sur la facture ` +
      `(${formaterMontant_(Math.abs(taxesCents), devise)}) : elles semblent ` +
      `${ecartCents > 0 ? 'comptées en trop' : 'manquantes'}.`;
  }
  return '';
}

/**
 * Teste si l'écart correspond au montant exact d'une ligne du bilan.
 * @param {number} ecartCents Écart facture − bilan, en cents.
 * @param {Array<Object>} lignes Lignes du bilan rattaché.
 * @param {number} tolerance Tolérance de comparaison, en cents.
 * @param {string} devise Devise d'affichage.
 * @return {string} Phrase d'explication, ou chaîne vide.
 */
function facturesExplicationLigne_(ecartCents, lignes, tolerance, devise) {
  const absolu = Math.abs(ecartCents);
  const liste = lignes || [];
  for (let i = 0; i < liste.length; i++) {
    const montant = bilansMontantLigneCents_(liste[i]);
    if (montant === 0 || Math.abs(Math.abs(montant) - absolu) > tolerance) continue;
    const description =
      facturesTexte_(liste[i][FACTURES_COL_LIGNE_.DESCRIPTION]) || '(ligne sans description)';
    const montantTexte = formaterMontant_(Math.abs(montant), devise);
    return ecartCents > 0
      ? `Cet écart correspond exactement à la ligne « ${description} » (${montantTexte}) du ` +
        `bilan : elle semble facturée en double, ou facturée en trop.`
      : `Cet écart correspond exactement à la ligne « ${description} » (${montantTexte}) du ` +
        `bilan : elle semble avoir été oubliée sur la facture.`;
  }
  return '';
}

/**
 * Explique en français, chiffres à l'appui, pourquoi une facture ne correspond
 * pas à son bilan. Teste les causes courantes (taxes, ligne oubliée ou en
 * double) et, à défaut, énonce clairement les deux montants comparés.
 * @param {number} ecartCents Montant total − Montant du bilan, en cents.
 * @param {Object} facture Facture examinée.
 * @param {Object} bilan Bilan rattaché.
 * @param {Array<Object>} lignes Lignes de ce bilan.
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {string} Phrase d'explication, prête à écrire dans Notes.
 */
function expliquerEcartFacture_(ecartCents, facture, bilan, lignes, params) {
  const reglages = params || {};
  const devise = reglages.DEVISE || CONFIG.PARAMETRES_DEFAUT.DEVISE;
  const tolerance = Math.max(0, Math.round(parametreNombre_(reglages, 'TOLERANCE_CENTS', 1)));
  const toleranceTaxes = Math.max(tolerance, FACTURES_TOLERANCE_TAXES_);
  const totalCents = enCents_(facture ? facture[FACTURES_COL_.TOTAL] : 0);
  const bilanCents = enCents_(bilan ? bilan[FACTURES_COL_BILAN_.MONTANT] : 0);
  const taxesCents = enCents_(facture ? facture[FACTURES_COL_.TAXES] : 0);
  const identifiant = bilan ? facturesTexte_(bilan[FACTURES_COL_BILAN_.ID]) : '';

  const constat = `La facture (${formaterMontant_(totalCents, devise)}) indique ` +
    `${formaterMontant_(Math.abs(ecartCents), devise)} ` +
    `${ecartCents > 0 ? 'de plus que' : 'de moins que'} le bilan ` +
    `${identifiant ? identifiant + ' ' : ''}(${formaterMontant_(bilanCents, devise)}).`;

  const taxes = facturesExplicationTaxes_(
    ecartCents, bilanCents, taxesCents, toleranceTaxes, devise);
  if (taxes) return `${constat} ${taxes}`;
  const ligne = facturesExplicationLigne_(ecartCents, lignes, tolerance, devise);
  if (ligne) return `${constat} ${ligne}`;
  return `${constat} Aucune explication courante (taxes, ligne du bilan) ne correspond à ` +
    `ce montant : comparez le détail du bilan avec la facture, puis corrigez le montant ` +
    `ou demandez une facture rectifiée au client.`;
}

/**
 * Phrase expliquant qu'une facture reprend une facture déjà enregistrée.
 * @param {{facture: Object, motif: string}} doublon Facture d'origine et motif.
 * @param {string} devise Devise d'affichage.
 * @return {string} Message pour la colonne Notes.
 */
function facturesNoteDoublon_(doublon, devise) {
  const origine = doublon.facture;
  const identifiant = facturesTexte_(origine[FACTURES_COL_.ID]) || '(sans identifiant)';
  const montant = formaterMontant_(enCents_(origine[FACTURES_COL_.TOTAL]), devise);
  const cause = doublon.motif === 'numero'
    ? `même n° de facture (${facturesTexte_(origine[FACTURES_COL_.NUMERO]) || '—'})`
    : `même montant (${montant}) et même période ` +
      `(${facturesTexte_(origine[FACTURES_COL_.PERIODE]) || '—'})`;
  return `Doublon probable de la facture ${identifiant} : ${cause}, pour le même client. ` +
    `Elle n'entre pas dans le solde à payer. Si les deux factures sont bien différentes, ` +
    `corrigez le statut de vérification à la main.`;
}

/**
 * Phrase expliquant qu'aucun bilan ne peut être rattaché à la facture.
 * @param {Object} facture Facture examinée.
 * @return {string} Message pour la colonne Notes.
 */
function facturesNoteSansBilan_(facture) {
  const periode = facturesTexte_(facture[FACTURES_COL_.PERIODE]);
  return `Aucun bilan disponible pour ce client${periode ? ' pour la période ' + periode : ''} : ` +
    `soit le bilan n'a pas encore été généré, soit tous les bilans de ce client sont déjà ` +
    `rattachés à une autre facture, soit le montant ne ressemble à aucun d'entre eux. ` +
    `Générez le bilan manquant, ou saisissez vous-même l'ID bilan puis relancez la vérification.`;
}

/**
 * Signale un rattachement discutable (période absente ou différente de celle du
 * bilan) pour que la décision reste visible et corrigeable.
 * @param {Object} facture Facture examinée.
 * @param {Object} bilan Bilan retenu.
 * @param {string} devise Devise d'affichage.
 * @return {string} Préfixe de note, ou chaîne vide si le rattachement est net.
 */
function facturesNoteRattachement_(facture, bilan, devise) {
  const identifiant = facturesTexte_(bilan[FACTURES_COL_BILAN_.ID]);
  if (facturesTexte_(facture[FACTURES_COL_.BILAN]) === identifiant) return '';
  const periodeFacture = facturesTexte_(facture[FACTURES_COL_.PERIODE]);
  const periodeBilan = facturesTexte_(bilan[FACTURES_COL_BILAN_.PERIODE]) || '—';
  const montant = formaterMontant_(enCents_(bilan[FACTURES_COL_BILAN_.MONTANT]), devise);
  if (!periodeFacture) {
    return `Rattachement à confirmer : la facture n'indiquait aucune période, elle a été ` +
      `rapprochée du bilan ${identifiant} (${periodeBilan}, ${montant}) d'après son montant. `;
  }
  if (periodeFacture !== periodeBilan) {
    return `Rattachement approximatif à confirmer : la facture porte la période ` +
      `${periodeFacture} et le bilan ${identifiant} la période ${periodeBilan} ` +
      `(${montant}) ; les montants sont proches à moins de 2 %. `;
  }
  return '';
}

/**
 * Applique à une facture les règles du §4.3, dans l'ordre : Doublon, puis
 * Sans bilan, puis Conforme, puis Écart de montant.
 * Fonction PURE : aucun appel à Google, tout arrive par le contexte.
 * @param {Object} facture Facture à vérifier.
 * @param {{bilans: Array<Object>, facturesExistantes: Array<Object>,
 *          lignesBilan: Array<Object>, params: Object}} contexte Données lues.
 * @return {{statut: string, idBilan: string, ecartCents: number, notes: string}}
 */
function verifierUneFacture_(facture, contexte) {
  const ctx = contexte || {};
  const params = ctx.params || {};
  const devise = params.DEVISE || CONFIG.PARAMETRES_DEFAUT.DEVISE;
  const tolerance = Math.max(0, Math.round(parametreNombre_(params, 'TOLERANCE_CENTS', 1)));
  const totalCents = enCents_(facture[FACTURES_COL_.TOTAL]);

  const doublon = facturesTrouverDoublon_(facture, ctx.facturesExistantes);
  if (doublon) {
    return {
      statut: STATUT_VERIF.DOUBLON,
      idBilan: facturesTexte_(facture[FACTURES_COL_.BILAN]),
      ecartCents: 0,
      notes: facturesNoteDoublon_(doublon, devise),
    };
  }

  const bilan = rattacherBilan_(facture, ctx.bilans);
  if (!bilan) {
    return {
      statut: STATUT_VERIF.SANS_BILAN,
      idBilan: '',
      ecartCents: 0,
      notes: facturesNoteSansBilan_(facture),
    };
  }

  const idBilan = facturesTexte_(bilan[FACTURES_COL_BILAN_.ID]);
  const bilanCents = enCents_(bilan[FACTURES_COL_BILAN_.MONTANT]);
  const ecartCents = totalCents - bilanCents;
  const prefixe = facturesNoteRattachement_(facture, bilan, devise);

  if (Math.abs(ecartCents) <= tolerance) {
    return {
      statut: STATUT_VERIF.CONFORME,
      idBilan: idBilan,
      ecartCents: ecartCents,
      notes: prefixe + `La facture (${formaterMontant_(totalCents, devise)}) correspond au ` +
        `bilan ${idBilan} (${formaterMontant_(bilanCents, devise)}). Elle peut être payée.`,
    };
  }

  const lignes = facturesLignesDuBilan_(bilan, ctx.lignesBilan);
  return {
    statut: STATUT_VERIF.ECART,
    idBilan: idBilan,
    ecartCents: ecartCents,
    notes: prefixe + expliquerEcartFacture_(ecartCents, facture, bilan, lignes, params),
  };
}

// ---------------------------------------------------------------------------
// verifierFactures() — application au classeur
// ---------------------------------------------------------------------------

/**
 * Statuts de vérification que le SCRIPT a lui-même posés : il a donc le droit
 * de les remettre en question au passage suivant. C'est ce qui rend l'invite
 * « corrigez puis relancez la vérification » (notes « Sans bilan » et « Écart de
 * montant ») réellement opérante.
 * Les deux seules décisions HUMAINES protégées par le §4.3 — « Conforme » et
 * « Rejetée » — n'y figurent pas : le script ne les réécrit jamais.
 */
const FACTURES_STATUTS_REJOUABLES_ = [
  '',
  STATUT_VERIF.A_VERIFIER,
  STATUT_VERIF.SANS_BILAN,
  STATUT_VERIF.ECART,
  STATUT_VERIF.DOUBLON,
].map(texteNormalise_);

/**
 * Ne garde que les factures que le script a le droit de traiter : statut vide,
 * « À vérifier », « Sans bilan », « Écart de montant » ou « Doublon ». Une
 * facture passée à « Conforme » ou « Rejetée » n'est jamais réécrite (§4.3).
 * @param {Array<Object>} factures Toutes les lignes de l'onglet Factures.
 * @return {Array<Object>} Les factures à retraiter.
 */
function facturesAVerifier_(factures) {
  return (factures || []).filter((facture) => {
    if (!facture) return false;
    if (!facturesTexte_(facture[FACTURES_COL_.ID]) &&
        !facturesTexte_(facture[FACTURES_COL_.CLIENT])) return false;
    const statut = texteNormalise_(facture[FACTURES_COL_.VERIFICATION]);
    return FACTURES_STATUTS_REJOUABLES_.indexOf(statut) >= 0;
  });
}

/**
 * Découpe la colonne Notes en trois : ce qui précède le bloc automatique, le
 * bloc automatique lui-même, et ce qui le suit. Une annotation écrite à la main
 * APRÈS le commentaire du script est ainsi reconnue et conservée.
 * @param {*} existantes Contenu actuel de la colonne Notes.
 * @return {{avant: string, apres: string, herite: boolean, ancien: string}}
 *     `herite` signale l'ancien format (sans marqueurs), dont on ne peut pas
 *     deviner la fin : `ancien` porte alors le texte qui va être remplacé.
 */
function facturesDecouperNote_(existantes) {
  // Le « | » qui séparait les morceaux appartient à la mise en forme, pas au
  // texte de l'utilisateur : on ne le reporte pas, sinon il se dédouble à
  // chaque vérification.
  const nettoyer = (texte) => String(texte).replace(/^[\s|]+/, '').replace(/[\s|]+$/, '');
  const brut = existantes === null || existantes === undefined ? '' : String(existantes);
  const debut = brut.indexOf(FACTURES_MARQUEUR_DEBUT_);
  const fin = debut < 0 ? -1
    : brut.indexOf(FACTURES_MARQUEUR_FIN_, debut + FACTURES_MARQUEUR_DEBUT_.length);
  if (debut >= 0 && fin > debut) {
    return {
      avant: nettoyer(brut.slice(0, debut)),
      apres: nettoyer(brut.slice(fin + FACTURES_MARQUEUR_FIN_.length)),
      herite: false,
      ancien: '',
    };
  }
  // Format hérité : le bloc automatique commençait à « Vérification : » et
  // courait jusqu'au bout de la cellule, sans marqueur de fin.
  let position = brut.indexOf(FACTURES_SEPARATEUR_NOTE_);
  if (position < 0 && brut.indexOf(FACTURES_ENTETE_NOTE_) === 0) position = 0;
  if (position >= 0) {
    return {
      avant: nettoyer(brut.slice(0, position)),
      apres: '',
      herite: true,
      ancien: nettoyer(brut.slice(position)),
    };
  }
  return { avant: nettoyer(brut), apres: '', herite: false, ancien: '' };
}

/**
 * Assemble la nouvelle colonne Notes : ce que l'utilisateur a écrit avant ET
 * après le bloc ⟦auto⟧…⟦/auto⟧ est conservé, seul l'intérieur du bloc est
 * remplacé.
 * @param {*} existantes Contenu actuel de la colonne Notes.
 * @param {string} note Nouveau commentaire de vérification.
 * @return {string} Notes complètes.
 */
function facturesFusionnerNote_(existantes, note) {
  const parties = facturesDecouperNote_(existantes);
  const morceaux = [];
  if (parties.avant) morceaux.push(parties.avant);
  if (note) {
    morceaux.push(`${FACTURES_MARQUEUR_DEBUT_} ${FACTURES_ENTETE_NOTE_}${note} ` +
      FACTURES_MARQUEUR_FIN_);
  }
  if (parties.apres) morceaux.push(parties.apres);
  return morceaux.join(' | ');
}

/**
 * Journalise le texte d'un ancien bloc automatique (format sans marqueur de
 * fin) avant de le remplacer : si une annotation manuelle y avait été ajoutée à
 * la suite, elle reste retrouvable dans le Journal. Ne se produit qu'une fois
 * par facture — la note réécrite porte désormais ses marqueurs.
 * @param {Object} facture Facture vérifiée.
 * @param {{herite: boolean, ancien: string}} parties Découpage de la note.
 * @param {string} note Nouveau commentaire de vérification.
 * @return {void}
 */
function facturesSignalerNoteHeritee_(facture, parties, note) {
  if (!parties.herite || !parties.ancien) return;
  if (parties.ancien === (FACTURES_ENTETE_NOTE_ + note).trim()) return;
  const reference = facturesTexte_(facture[FACTURES_COL_.ID]) || `ligne ${facture._ligne}`;
  journalAvert_('verifierFactures',
    `Facture ${reference} : ancien commentaire de la colonne Notes remplacé.`,
    `Texte remplacé (recopiez-en ce qui était de votre main) : ${parties.ancien}`);
}

/**
 * Construit la mise à jour d'une ligne de l'onglet Factures.
 * @param {Object} facture Facture vérifiée.
 * @param {Object} resultat Retour de verifierUneFacture_().
 * @param {Object|null} bilan Bilan rattaché, s'il y en a un.
 * @return {Object} Patch {nom de colonne: valeur}.
 */
function facturesPatchFacture_(facture, resultat, bilan) {
  const patch = {};
  patch[FACTURES_COL_.VERIFICATION] = resultat.statut;
  patch[FACTURES_COL_.BILAN] = resultat.idBilan || '';
  patch[FACTURES_COL_.ECART] = resultat.idBilan ? enDollars_(resultat.ecartCents) : '';
  facturesSignalerNoteHeritee_(
    facture, facturesDecouperNote_(facture[FACTURES_COL_.NOTES]), resultat.notes);
  patch[FACTURES_COL_.NOTES] = facturesFusionnerNote_(facture[FACTURES_COL_.NOTES], resultat.notes);
  if (!facturesTexte_(facture[FACTURES_COL_.PAIEMENT])) {
    patch[FACTURES_COL_.PAIEMENT] = STATUT_PAIEMENT.NON_PAYEE;
  }
  if (bilan) {
    if (!facturesTexte_(facture[FACTURES_COL_.PERIODE])) {
      patch[FACTURES_COL_.PERIODE] = facturesTexte_(bilan[FACTURES_COL_BILAN_.PERIODE]);
    }
    if (!facturesTexte_(facture[FACTURES_COL_.NOM_CLIENT])) {
      patch[FACTURES_COL_.NOM_CLIENT] = facturesTexte_(bilan[FACTURES_COL_BILAN_.NOM_CLIENT]);
    }
  }
  return patch;
}

/**
 * Construit la mise à jour du bilan rattaché : une facture conforme le fait
 * passer à « Vérifié », une facture en écart à « Facture reçue ». Les statuts
 * décidés par l'humain (Payé, Annulé) ne sont jamais écrasés.
 * @param {Object|null} bilan Bilan rattaché.
 * @param {Object} facture Facture vérifiée.
 * @param {Object} resultat Retour de verifierUneFacture_().
 * @return {{ligne: number, patch: Object}|null} Mise à jour, ou null.
 */
function facturesPatchBilan_(bilan, facture, resultat) {
  if (!bilan || !bilan._ligne) return null;
  const patch = {};
  const idFacture = facturesTexte_(facture[FACTURES_COL_.ID]);
  if (idFacture && facturesTexte_(bilan[FACTURES_COL_BILAN_.FACTURE]) !== idFacture) {
    patch[FACTURES_COL_BILAN_.FACTURE] = idFacture;
  }
  const statut = texteNormalise_(bilan[FACTURES_COL_BILAN_.STATUT]);
  const enCours = [STATUT_BILAN.BROUILLON, STATUT_BILAN.ENVOYE].map(texteNormalise_);
  const modifiables = enCours.concat([texteNormalise_(STATUT_BILAN.FACTURE_RECUE)]);
  if (resultat.statut === STATUT_VERIF.CONFORME && modifiables.indexOf(statut) >= 0) {
    patch[FACTURES_COL_BILAN_.STATUT] = STATUT_BILAN.VERIFIE;
  } else if (resultat.statut === STATUT_VERIF.ECART && enCours.indexOf(statut) >= 0) {
    patch[FACTURES_COL_BILAN_.STATUT] = STATUT_BILAN.FACTURE_RECUE;
  }
  return Object.keys(patch).length ? { ligne: bilan._ligne, patch: patch } : null;
}

/**
 * Reporte le résultat sur les objets en mémoire, pour que la facture suivante
 * ne rattache pas le même bilan et voie la période qui vient d'être déduite.
 * @param {Object} facture Facture vérifiée.
 * @param {Object|null} bilan Bilan rattaché.
 * @param {Object} resultat Retour de verifierUneFacture_().
 * @return {void}
 */
function facturesAppliquerEnMemoire_(facture, bilan, resultat) {
  facture[FACTURES_COL_.VERIFICATION] = resultat.statut;
  facture[FACTURES_COL_.BILAN] = resultat.idBilan || '';
  if (!bilan) return;
  const idFacture = facturesTexte_(facture[FACTURES_COL_.ID]);
  if (idFacture) bilan[FACTURES_COL_BILAN_.FACTURE] = idFacture;
  if (!facturesTexte_(facture[FACTURES_COL_.PERIODE])) {
    facture[FACTURES_COL_.PERIODE] = facturesTexte_(bilan[FACTURES_COL_BILAN_.PERIODE]);
  }
}

/**
 * Rédige le message affiché à la fin de la vérification.
 * @param {Object} compteurs Nombre de factures par statut.
 * @param {number} total Nombre de factures examinées.
 * @return {string} Message lisible.
 */
function facturesResume_(compteurs, total) {
  const lignes = [`${total} facture(s) examinée(s).`, ''];
  [STATUT_VERIF.CONFORME, STATUT_VERIF.ECART, STATUT_VERIF.DOUBLON, STATUT_VERIF.SANS_BILAN]
    .forEach((statut) => {
      if (compteurs[statut]) lignes.push(`• ${statut} : ${compteurs[statut]}`);
    });
  if (compteurs[STATUT_VERIF.ECART] || compteurs[STATUT_VERIF.SANS_BILAN] ||
      compteurs[STATUT_VERIF.DOUBLON]) {
    lignes.push('');
    lignes.push('Ouvrez l\'onglet Factures : la colonne Notes explique chaque anomalie, ' +
      'montants à l\'appui. Corrigez ce qu\'elle indique (montant, période, bilan manquant) ' +
      'puis relancez cette action : le script réexamine ces factures. Si vous passez vous-même ' +
      `une facture à « ${STATUT_VERIF.CONFORME} » ou « ${STATUT_VERIF.REJETEE} », il ne la ` +
      'touchera plus jamais.');
  }
  if (compteurs[STATUT_VERIF.CONFORME]) {
    lignes.push('');
    lignes.push(`Les factures « ${STATUT_VERIF.CONFORME} » sont prêtes pour l'étape ` +
      '« 5. Préparer le lot de paiements ».');
  }
  return lignes.join('\n');
}

/**
 * Vérifie toutes les factures « À vérifier » : rattachement au bilan, détection
 * des doublons, comparaison des montants et explication des écarts (§4.3).
 * Point d'entrée du menu.
 * @return {string} Résumé lisible du traitement.
 */
function verifierFactures() {
  const nomFactures = CONFIG.ONGLETS.FACTURES.nom;
  const nomBilans = CONFIG.ONGLETS.BILANS.nom;
  const params = lireParametres_();
  const factures = lireTable_(nomFactures);
  const aTraiter = facturesAVerifier_(factures);
  if (!aTraiter.length) {
    journalInfo_('verifierFactures', 'Aucune facture à vérifier.');
    return `Aucune facture à vérifier : toutes les factures sont déjà « ` +
      `${STATUT_VERIF.CONFORME} » ou « ${STATUT_VERIF.REJETEE} », les deux statuts que le ` +
      `script ne réécrit jamais.`;
  }

  // Copies de travail : on peut y noter les rattachements sans toucher au classeur.
  const bilans = lireTable_(nomBilans).map((bilan) => Object.assign({}, bilan));
  const contexte = {
    bilans: bilans,
    facturesExistantes: factures,
    lignesBilan: lireTable_(CONFIG.ONGLETS.LIGNES_BILAN.nom),
    params: params,
  };
  const majFactures = [];
  const majBilans = [];
  const compteurs = {};

  aTraiter.forEach((facture) => {
    const reference = facturesTexte_(facture[FACTURES_COL_.ID]) || `ligne ${facture._ligne}`;
    let resultat = null;
    try {
      resultat = verifierUneFacture_(facture, contexte);
    } catch (e) {
      journalErreur_('verifierFactures', `Facture ${reference} : vérification impossible.`,
        `${e.message}\n${e.stack}`);
      return;
    }
    compteurs[resultat.statut] = (compteurs[resultat.statut] || 0) + 1;
    const rattache = (resultat.statut === STATUT_VERIF.CONFORME ||
                      resultat.statut === STATUT_VERIF.ECART)
      ? bilans.filter((b) => facturesTexte_(b[FACTURES_COL_BILAN_.ID]) === resultat.idBilan)[0]
      : null;
    majFactures.push({
      ligne: facture._ligne,
      patch: facturesPatchFacture_(facture, resultat, rattache || null),
    });
    const majBilan = facturesPatchBilan_(rattache || null, facture, resultat);
    if (majBilan) majBilans.push(majBilan);
    facturesAppliquerEnMemoire_(facture, rattache || null, resultat);
  });

  majLignes_(nomFactures, majFactures);
  majLignes_(nomBilans, majBilans);
  journalInfo_('verifierFactures', `${majFactures.length} facture(s) vérifiée(s).`,
    JSON.stringify(compteurs));
  return facturesResume_(compteurs, aTraiter.length);
}

// ---------------------------------------------------------------------------
// importerFacturesGmail() — lecture des courriels et archivage des pièces jointes
// ---------------------------------------------------------------------------

/**
 * Extrait une adresse de courriel, en minuscules, d'un texte du genre
 * « Nom du client <adresse@exemple.ca> » ou « adresse@exemple.ca ».
 * @param {*} brut Texte à analyser.
 * @return {string} L'adresse en minuscules, ou chaîne vide.
 */
function facturesAdresse_(brut) {
  const texte = facturesTexte_(brut);
  if (!texte) return '';
  const entreChevrons = /<([^>]+)>/.exec(texte);
  const adresse = (entreChevrons ? entreChevrons[1] : texte).trim().toLowerCase();
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(adresse) ? adresse : '';
}

/**
 * Construit l'index adresse de courriel → client, à partir des colonnes
 * Courriel et Courriels en copie de l'onglet Clients.
 * @param {Array<Object>} clients Lignes de l'onglet Clients.
 * @return {Object} Dictionnaire {adresse en minuscules: client}.
 */
function facturesIndexCourriels_(clients) {
  const index = {};
  (clients || []).forEach((client) => {
    if (!client) return;
    const brut = `${facturesTexte_(client[FACTURES_COL_CLIENT_.COURRIEL])};` +
      `${facturesTexte_(client[FACTURES_COL_CLIENT_.COPIE])}`;
    brut.split(/[,;]/).forEach((morceau) => {
      const adresse = facturesAdresse_(morceau);
      if (adresse && !index[adresse]) index[adresse] = client;
    });
  });
  return index;
}

/**
 * Retrouve le client d'un message d'après son expéditeur.
 * @param {Object} message Message Gmail.
 * @param {Object} index Index construit par facturesIndexCourriels_().
 * @return {Object|null} Le client, ou null si l'adresse est inconnue.
 */
function facturesClientDuMessage_(message, index) {
  const candidates = [];
  try { candidates.push(message.getFrom()); } catch (e) { /* adresse illisible */ }
  try { candidates.push(message.getReplyTo()); } catch (e) { /* champ absent */ }
  for (let i = 0; i < candidates.length; i++) {
    const adresse = facturesAdresse_(candidates[i]);
    if (adresse && index[adresse]) return index[adresse];
  }
  return null;
}

/**
 * Relève les identifiants de messages Gmail déjà importés, stockés dans la
 * colonne Notes sous la forme [gmail:<id>]. C'est ce qui rend l'import
 * strictement idempotent.
 * @param {Array<Object>} factures Lignes de l'onglet Factures.
 * @return {Object} Dictionnaire {identifiant de message: true}.
 */
function facturesMessagesImportes_(factures) {
  const index = {};
  (factures || []).forEach((facture) => {
    const notes = facturesTexte_(facture[FACTURES_COL_.NOTES]);
    if (!notes) return;
    const motif = /\[gmail:([^\]]+)\]/g;
    let trouve = motif.exec(notes);
    while (trouve) {
      index[trouve[1].trim()] = true;
      trouve = motif.exec(notes);
    }
  });
  return index;
}

/**
 * Relève tous les montants d'un texte pour un motif donné.
 * @param {string} texte Texte à analyser.
 * @param {string} source Expression régulière, sous forme de chaîne.
 * @return {Array<number>} Montants trouvés, en cents, sans doublon.
 */
function facturesMontantsMotif_(texte, source) {
  const motif = new RegExp(source, 'gi');
  const vus = {};
  const montants = [];
  let trouve = motif.exec(texte);
  while (trouve) {
    const cents = enCents_(trouve[1] || trouve[2] || '');
    if (cents > 0 && !vus[cents]) {
      vus[cents] = true;
      montants.push(cents);
    }
    trouve = motif.exec(texte);
  }
  return montants;
}

/**
 * Cherche le montant de la facture dans le sujet et le corps du courriel.
 * Formats acceptés : 1 234,56 $ / $1,234.56 / 1234.56$ / « Total : 1 234,56 ».
 * Le plus grand montant trouvé est retenu — c'est une SUGGESTION, jamais une
 * décision : la facture reste « À vérifier ».
 * @param {string} texte Sujet et corps du courriel.
 * @return {{cents: number, valeurs: Array<number>}} Montant retenu et candidats.
 */
function facturesMontantSuggere_(texte) {
  let montants = facturesMontantsMotif_(texte, FACTURES_MOTIF_MONTANT_);
  if (!montants.length) montants = facturesMontantsMotif_(texte, FACTURES_MOTIF_MONTANT_MOT_);
  montants.sort((a, b) => b - a);
  return { cents: montants.length ? montants[0] : 0, valeurs: montants };
}

/**
 * Cherche un n° de facture (motifs facture / invoice / n° / no / #).
 * Un candidat sans aucun chiffre est écarté (« facture ci-jointe »...).
 * @param {string} texte Sujet ou corps du courriel.
 * @return {string} Le numéro trouvé, ou chaîne vide.
 */
function facturesNumeroSuggere_(texte) {
  const motif = new RegExp(FACTURES_MOTIF_NUMERO_, 'gi');
  let trouve = motif.exec(texte || '');
  while (trouve) {
    const candidat = facturesTexte_(trouve[1]).replace(/[.,;:)\]]+$/, '');
    if (/\d/.test(candidat) && candidat.length >= 2) return candidat;
    trouve = motif.exec(texte || '');
  }
  return '';
}

/**
 * Dossiers Drive déjà résolus pendant l'exécution en cours (une seule
 * résolution par dossier, quel que soit le nombre de pièces jointes).
 */
const FACTURES_CACHE_DRIVE_ = { racine: null, sous: {} };

/**
 * Le dossier racine où le script archive tout : pièces jointes et fichiers de
 * lot. Il est identifié par son IDENTIFIANT Drive (paramètre DOSSIER_DRIVE_ID),
 * jamais par son nom.
 *
 * Pourquoi : le manifeste ne demande que le scope `drive.file`, volontairement
 * minimal — le script ne voit que ce qu'il a lui-même créé. DriveApp
 * .getFoldersByName ne peut donc PAS retrouver un dossier créé à la main par
 * l'utilisateur, et renverrait « rien trouvé » à chaque fois : le script
 * créerait un dossier de plus à chaque exécution. On crée donc le dossier une
 * seule fois, on retient son identifiant dans Paramètres, et on journalise son
 * URL pour que l'utilisateur le retrouve.
 *
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {Object} Le dossier racine, garanti existant et hors corbeille.
 */
function facturesDossierRacineDrive_(params) {
  if (FACTURES_CACHE_DRIVE_.racine) return FACTURES_CACHE_DRIVE_.racine;
  const reglages = params || {};
  const identifiant = facturesTexte_(reglages.DOSSIER_DRIVE_ID);
  const nomVoulu = facturesTexte_(reglages.DOSSIER_DRIVE) || CONFIG.PARAMETRES_DEFAUT.DOSSIER_DRIVE;
  if (identifiant) {
    try {
      const connu = DriveApp.getFolderById(identifiant);
      if (!(typeof connu.isTrashed === 'function' && connu.isTrashed())) {
        // Si l'utilisateur a changé DOSSIER_DRIVE, il s'attend à ce que
        // l'archivage suive : on ne reste pas silencieusement sur l'ancien
        // dossier, on en crée un au nouveau nom et on réenregistre son ID.
        const nomActuel = typeof connu.getName === 'function' ? connu.getName() : nomVoulu;
        if (texteNormalise_(nomActuel) === texteNormalise_(nomVoulu)) {
          FACTURES_CACHE_DRIVE_.racine = connu;
          return connu;
        }
        journalInfo_('resoudreDossierDrive_',
          'Le réglage DOSSIER_DRIVE a changé : les prochaines pièces seront archivées ' +
          `dans « ${nomVoulu} » au lieu de « ${nomActuel} ». L'ancien dossier est conservé.`,
          `DOSSIER_DRIVE_ID = ${identifiant}`);
      } else {
        journalAvert_('resoudreDossierDrive_',
          'Le dossier Drive enregistré est à la corbeille : un nouveau dossier va être créé.',
          `DOSSIER_DRIVE_ID = ${identifiant}`);
      }
    } catch (e) {
      journalAvert_('resoudreDossierDrive_',
        'Le dossier Drive enregistré est introuvable : un nouveau dossier va être créé.',
        `DOSSIER_DRIVE_ID = ${identifiant} — ${e.message}`);
    }
  }

  const nom = nomVoulu;
  const cree = DriveApp.createFolder(nom);
  FACTURES_CACHE_DRIVE_.racine = cree;
  try {
    ecrireParametre_('DOSSIER_DRIVE_ID', cree.getId());
  } catch (e) {
    journalErreur_('resoudreDossierDrive_',
      'Identifiant du dossier Drive non enregistré dans Paramètres : un dossier de plus ' +
      'sera créé au prochain passage.', `${e.message}\n${e.stack}`);
  }
  journalInfo_('resoudreDossierDrive_',
    `Dossier Drive « ${nom} » créé : c'est là que tout est archivé.`, cree.getUrl());
  return cree;
}

/**
 * Résout le dossier Drive de travail — la fonction UNIQUE utilisée par
 * 05_Factures.gs et 06_Paiements.gs, pour que les pièces jointes et les
 * fichiers de lot atterrissent toujours au même endroit.
 * @param {Object} params Réglages lus par lireParametres_().
 * @param {string} [sousDossierNom] Sous-dossier voulu (client). Vide = la racine.
 * @return {Object} Le dossier Drive, garanti existant et hors corbeille.
 */
function resoudreDossierDrive_(params, sousDossierNom) {
  const racine = facturesDossierRacineDrive_(params);
  const nom = facturesTexte_(sousDossierNom);
  if (!nom) return racine;
  if (!FACTURES_CACHE_DRIVE_.sous[nom]) {
    let choisi = null;
    const existants = racine.getFoldersByName(nom);
    while (existants.hasNext()) {
      const dossier = existants.next();
      if (typeof dossier.isTrashed === 'function' && dossier.isTrashed()) continue;
      choisi = dossier;
      break;
    }
    FACTURES_CACHE_DRIVE_.sous[nom] = choisi || racine.createFolder(nom);
  }
  return FACTURES_CACHE_DRIVE_.sous[nom];
}

/**
 * Renvoie le sous-dossier Drive du client, sous le dossier racine.
 * @param {Object} contexte Contexte d'import (params).
 * @param {Object} client Ligne de l'onglet Clients.
 * @return {Object} Le dossier Drive du client.
 */
function facturesDossierClient_(contexte, client) {
  const cle = facturesTexte_(client[FACTURES_COL_CLIENT_.ID]) || 'Client inconnu';
  const nomClient = facturesTexte_(client[FACTURES_COL_CLIENT_.NOM]);
  const nom = `${cle}${nomClient ? ' - ' + nomClient : ''}`.replace(/[\\/:*?"<>|]/g, '-');
  return resoudreDossierDrive_(contexte.params, nom);
}

/**
 * Ne garde que les pièces jointes qui peuvent être une facture : PDF et images.
 * @param {Object} piece Pièce jointe Gmail.
 * @return {boolean} Vrai si la pièce mérite d'être archivée.
 */
function facturesPieceUtile_(piece) {
  let type = '';
  let nom = '';
  try {
    type = String(piece.getContentType() || '').toLowerCase();
    nom = String(piece.getName() || '').toLowerCase();
  } catch (e) {
    return false;
  }
  if (type.indexOf('pdf') >= 0 || type.indexOf('image/') === 0) return true;
  return /\.(pdf|png|jpe?g|gif|heic|webp|tiff?)$/.test(nom);
}

/**
 * Nom sous lequel la pièce jointe est archivée dans Drive.
 * @param {Object} message Message Gmail.
 * @param {Object} piece Pièce jointe.
 * @return {string} Nom de fichier lisible.
 */
function facturesNomFichier_(message, piece) {
  let date = '';
  try { date = formaterDate_(message.getDate()); } catch (e) { date = ''; }
  const nom = String(piece.getName() || 'piece-jointe').replace(/[\\/:*?"<>|]/g, '-');
  return `${date || 'sans-date'} ${nom}`;
}

/**
 * Enregistre les pièces jointes PDF et images d'un message dans le dossier
 * Drive du client. Un échec sur une pièce n'interrompt jamais l'import.
 * @param {Object} message Message Gmail.
 * @param {Object} client Ligne de l'onglet Clients.
 * @param {Object} contexte Contexte d'import.
 * @return {{liens: Array<string>, noms: Array<string>}} Fichiers enregistrés.
 */
function facturesEnregistrerPieces_(message, client, contexte) {
  const resultat = { liens: [], noms: [] };
  let pieces = [];
  try {
    pieces = message.getAttachments({ includeInlineImages: false, includeAttachments: true }) || [];
  } catch (e) {
    try { pieces = message.getAttachments() || []; } catch (eBis) { pieces = []; }
  }
  const retenues = pieces.filter((piece) => facturesPieceUtile_(piece));
  if (!retenues.length) return resultat;

  let dossier = null;
  try {
    dossier = facturesDossierClient_(contexte, client);
  } catch (e) {
    journalErreur_('importerFacturesGmail', 'Dossier Drive inaccessible : pièces non archivées.',
      `${e.message}\n${e.stack}`);
    return resultat;
  }
  retenues.forEach((piece) => {
    try {
      const fichier = dossier.createFile(
        piece.copyBlob().setName(facturesNomFichier_(message, piece)));
      resultat.liens.push(fichier.getUrl());
      resultat.noms.push(fichier.getName());
    } catch (e) {
      journalErreur_('importerFacturesGmail', 'Pièce jointe non enregistrée dans Drive.',
        `${e.message}\n${e.stack}`);
    }
  });
  return resultat;
}

/**
 * Rédige la colonne Notes d'une facture importée : marqueur d'idempotence,
 * provenance, et avertissement sur le montant suggéré.
 * @param {Object} message Message Gmail.
 * @param {{cents: number, valeurs: Array<number>}} montant Montant repéré.
 * @param {{liens: Array<string>, noms: Array<string>}} pieces Pièces archivées.
 * @param {string} devise Devise d'affichage.
 * @return {string} Contenu de la colonne Notes.
 */
function facturesNoteImport_(message, montant, pieces, devise) {
  const morceaux = [`[gmail:${message.getId()}]`];
  morceaux.push(`Importée de Gmail (courriel du ${formaterDate_(message.getDate())}).`);
  if (montant.cents) {
    morceaux.push(`Montant SUGGÉRÉ par le script : ${formaterMontant_(montant.cents, devise)}. ` +
      `À confirmer : le script ne décide jamais du montant à payer.`);
    if (montant.valeurs.length > 1) {
      const liste = montant.valeurs.slice(0, 5)
        .map((cents) => formaterMontant_(cents, devise)).join(' ; ');
      morceaux.push(`Plusieurs montants figurent dans ce courriel (${liste}) : le plus élevé ` +
        `a été retenu, vérifiez-le.`);
    }
  } else {
    morceaux.push(`Aucun montant n'a pu être lu dans ce courriel : saisissez le montant total ` +
      `à la main, puis relancez la vérification.`);
  }
  if (!pieces.liens.length) {
    morceaux.push('Aucune pièce jointe PDF ou image dans ce courriel.');
  } else if (pieces.liens.length > 1) {
    morceaux.push(`${pieces.liens.length} pièces jointes archivées dans Drive ` +
      `(${pieces.noms.join(', ')}) ; le lien pointe vers la première.`);
  }
  return morceaux.join(' ');
}

/**
 * Construit la ligne à ajouter dans l'onglet Factures pour un message.
 * @param {Object} message Message Gmail.
 * @param {string} permalien Lien vers le fil Gmail.
 * @param {Object} client Ligne de l'onglet Clients.
 * @param {Object} contexte Contexte d'import.
 * @return {Object} Ligne prête pour ajouterLignes_().
 */
function facturesLigneDepuisMessage_(message, permalien, client, contexte) {
  const devise = contexte.params.DEVISE || CONFIG.PARAMETRES_DEFAUT.DEVISE;
  const sujet = String(message.getSubject() || '');
  let corps = '';
  try { corps = String(message.getPlainBody() || '').slice(0, FACTURES_CORPS_MAX_); }
  catch (e) { corps = ''; }
  const montant = facturesMontantSuggere_(`${sujet}\n${corps}`);
  const pieces = facturesEnregistrerPieces_(message, client, contexte);

  const ligne = {};
  ligne[FACTURES_COL_.CLIENT] = facturesTexte_(client[FACTURES_COL_CLIENT_.ID]);
  ligne[FACTURES_COL_.NOM_CLIENT] = facturesTexte_(client[FACTURES_COL_CLIENT_.NOM]);
  ligne[FACTURES_COL_.NUMERO] = facturesNumeroSuggere_(sujet) || facturesNumeroSuggere_(corps);
  ligne[FACTURES_COL_.DATE] = message.getDate();
  ligne[FACTURES_COL_.PERIODE] = '';
  ligne[FACTURES_COL_.TOTAL] = montant.cents ? enDollars_(montant.cents) : '';
  ligne[FACTURES_COL_.VERIFICATION] = STATUT_VERIF.A_VERIFIER;
  ligne[FACTURES_COL_.PAIEMENT] = STATUT_PAIEMENT.NON_PAYEE;
  ligne[FACTURES_COL_.LIEN_COURRIEL] = permalien;
  ligne[FACTURES_COL_.LIEN_PIECE] = pieces.liens[0] || '';
  ligne[FACTURES_COL_.NOTES] = facturesNoteImport_(message, montant, pieces, devise);
  return ligne;
}

/**
 * Traite un fil Gmail : une ligne de facture par message encore non importé et
 * provenant d'une adresse connue dans l'onglet Clients.
 * Le fil n'est déclaré « complet » que si TOUS ses messages ont été importés ou
 * étaient déjà connus. Un seul message laissé de côté (expéditeur absent de
 * l'onglet Clients, ou erreur de lecture) laisse le fil incomplet : l'appelant
 * ne lui pose alors pas l'étiquette « …/Traité », sans quoi la requête de
 * recherche l'exclurait à jamais et la facture serait perdue.
 * @param {Object} fil Fil Gmail.
 * @param {Object} contexte Contexte d'import.
 * @return {{lignes: Array<Object>, ignores: number, complet: boolean,
 *           adresses: Array<string>}} Lignes créées, messages ignorés,
 *     fil entièrement traité ou non, adresses inconnues rencontrées.
 */
function facturesTraiterFil_(fil, contexte) {
  const lignes = [];
  const adresses = [];
  let ignores = 0;
  let complet = true;
  let messages = [];
  let permalien = '';
  try {
    messages = fil.getMessages() || [];
    permalien = fil.getPermalink() || '';
  } catch (e) {
    journalErreur_('importerFacturesGmail', 'Fil Gmail illisible, il a été sauté.',
      `${e.message}\n${e.stack}`);
    return { lignes: lignes, ignores: ignores, complet: false, adresses: adresses };
  }
  messages.forEach((message) => {
    try {
      const identifiant = message.getId();
      if (contexte.importes[identifiant]) return;
      const client = facturesClientDuMessage_(message, contexte.clients);
      if (!client) {
        ignores += 1;
        complet = false;
        const adresse = facturesAdresseExpediteur_(message);
        if (adresse && adresses.indexOf(adresse) < 0) adresses.push(adresse);
        return;
      }
      lignes.push(facturesLigneDepuisMessage_(message, permalien, client, contexte));
      contexte.importes[identifiant] = true;
    } catch (e) {
      complet = false;
      journalErreur_('importerFacturesGmail', 'Message Gmail non importé.',
        `${e.message}\n${e.stack}`);
    }
  });
  return { lignes: lignes, ignores: ignores, complet: complet, adresses: adresses };
}

/**
 * Adresse de l'expéditeur d'un message, pour pouvoir la NOMMER à l'utilisateur
 * quand elle ne figure dans aucune fiche client.
 * @param {Object} message Message Gmail.
 * @return {string} L'adresse en minuscules, ou chaîne vide.
 */
function facturesAdresseExpediteur_(message) {
  try {
    return facturesAdresse_(message.getFrom());
  } catch (e) {
    return '';
  }
}

/**
 * Liste les fils encore à traiter : ceux qui portent l'étiquette configurée
 * sans porter l'étiquette de suivi « …/Traité ».
 * @param {string} nomEtiquette Nom de l'étiquette Gmail.
 * @param {Object} etiquette Étiquette Gmail correspondante.
 * @param {number} limite Nombre maximal de fils traités par exécution.
 * @return {Array<Object>} Fils Gmail (un de plus que la limite, s'il en reste).
 */
function facturesFilsATraiter_(nomEtiquette, etiquette, limite) {
  const requete = `label:"${nomEtiquette}" -label:"${nomEtiquette}/Traité"`;
  try {
    return GmailApp.search(requete, 0, limite + 1) || [];
  } catch (e) {
    journalAvert_('importerFacturesGmail',
      'Recherche Gmail impossible : lecture directe de l\'étiquette.',
      `${e.message}\n${e.stack}`);
    return etiquette.getThreads(0, limite + 1) || [];
  }
}

/**
 * Applique l'étiquette de suivi « …/Traité » aux fils traités, en un seul appel.
 * @param {string} nomEtiquette Nom de l'étiquette Gmail configurée.
 * @param {Array<Object>} fils Fils à marquer.
 * @return {void}
 */
function facturesMarquerTraites_(nomEtiquette, fils) {
  if (!fils.length) return;
  try {
    const nom = `${nomEtiquette}/Traité`;
    const etiquette = GmailApp.getUserLabelByName(nom) || GmailApp.createLabel(nom);
    etiquette.addToThreads(fils);
  } catch (e) {
    journalErreur_('importerFacturesGmail',
      'Étiquette de suivi « Traité » non appliquée : ces fils seront relus au prochain passage.',
      `${e.message}\n${e.stack}`);
  }
}

/**
 * Attribue un identifiant F-xxxxxx à chaque nouvelle facture, en une seule
 * lecture de l'onglet.
 * @param {Array<Object>} lignes Lignes à numéroter.
 * @return {void}
 */
function facturesAttribuerIds_(lignes) {
  if (!lignes.length) return;
  const premier = prochainId_(CONFIG.ONGLETS.FACTURES.nom, FACTURES_COL_.ID, 'F-', 6);
  const trouve = /(\d+)\s*$/.exec(premier);
  const largeur = trouve ? trouve[1].length : 6;
  let numero = trouve ? parseInt(trouve[1], 10) : 1;
  lignes.forEach((ligne) => {
    let suffixe = String(numero);
    while (suffixe.length < largeur) suffixe = '0' + suffixe;
    ligne[FACTURES_COL_.ID] = 'F-' + suffixe;
    numero += 1;
  });
}

/**
 * Rédige le message affiché à la fin de l'import Gmail.
 * @param {Object} bilanImport Compteurs {creees, ignores, fils, restants, arret,
 *     adresses}.
 * @return {string} Message lisible.
 */
function facturesResumeImport_(bilanImport) {
  const lignes = [];
  lignes.push(bilanImport.creees
    ? `${bilanImport.creees} facture(s) ajoutée(s) au statut « ${STATUT_VERIF.A_VERIFIER} », ` +
      `à partir de ${bilanImport.fils} fil(s) de courriel.`
    : `Aucune nouvelle facture : les courriels de l'étiquette étaient déjà importés.`);
  if (bilanImport.ignores) {
    const liste = (bilanImport.adresses || []).slice(0, 5).join(', ');
    lignes.push(`${bilanImport.ignores} message(s) ignoré(s) : l'adresse de l'expéditeur ` +
      `ne figure dans aucune fiche de l'onglet Clients` +
      `${liste ? ' (' + liste + ')' : ''}.`);
    lignes.push('Ces courriels n\'ont PAS été marqués « Traité » : ajoutez la fiche du ' +
      'client (onglet Clients, colonne Courriel), puis relancez cette action — la facture ' +
      'sera importée.');
  }
  if (bilanImport.restants || bilanImport.arret) {
    lignes.push(`Il reste des courriels à traiter : relancez cette action pour les importer.`);
  }
  if (bilanImport.creees) {
    lignes.push('');
    lignes.push('Les montants lus dans les courriels sont des SUGGESTIONS. Relisez-les dans ' +
      'l\'onglet Factures, corrigez au besoin, puis lancez « 4. Vérifier les factures ».');
  }
  return lignes.join('\n');
}

/**
 * Importe les factures reçues par courriel : pour chaque message étiqueté,
 * archive les pièces jointes dans Drive et crée une ligne « À vérifier » avec
 * le lien Gmail, le lien Drive et un montant suggéré.
 * L'import est strictement idempotent : un message déjà importé est ignoré.
 *
 * Point d'entrée du menu ET cible du déclencheur horaire : c'est pourquoi
 * l'enveloppe try/catch/finally est ici et non chez l'appelant. Sans le
 * viderTamponJournal_() du finally, tout ce que l'import journalise resterait
 * en mémoire et disparaîtrait avec le runtime — une panne d'import (étiquette
 * renommée, quota Gmail, autorisation retirée) serait strictement invisible.
 * @return {string} Résumé lisible du traitement.
 */
function importerFacturesGmail() {
  try {
    return facturesImporter_();
  } catch (e) {
    journalErreur_('importerFacturesGmail', 'Import des factures interrompu par une erreur.',
      `${e.message}\n${e.stack}`);
    return 'L\'import des factures a échoué : ' + e.message + '\n\n' +
      'Le détail est dans l\'onglet Journal. Rien n\'a été perdu : les courriels non ' +
      'importés n\'ont pas été marqués « Traité », relancez cette action après correction.';
  } finally {
    viderTamponJournal_();
  }
}

/**
 * Corps de l'import Gmail (voir importerFacturesGmail(), qui l'enveloppe).
 * @return {string} Résumé lisible du traitement.
 */
function facturesImporter_() {
  const debut = new Date().getTime();
  const params = lireParametres_();
  const nomEtiquette = facturesTexte_(params.ETIQUETTE_GMAIL);
  if (!nomEtiquette) {
    return 'Aucune étiquette Gmail n\'est configurée : renseignez ETIQUETTE_GMAIL dans ' +
      'l\'onglet Paramètres, puis relancez.';
  }
  const etiquette = GmailApp.getUserLabelByName(nomEtiquette);
  if (!etiquette) {
    journalAvert_('importerFacturesGmail', `Étiquette Gmail introuvable : ${nomEtiquette}.`);
    return `L'étiquette Gmail « ${nomEtiquette} » n'existe pas encore.\n\n` +
      'Dans Gmail, créez cette étiquette et classez-y les factures que vos clients vous ' +
      'envoient, puis relancez cette action.';
  }

  const fils = facturesFilsATraiter_(nomEtiquette, etiquette, FACTURES_MAX_FILS_);
  const contexte = {
    params: params,
    clients: facturesIndexCourriels_(lireTable_(CONFIG.ONGLETS.CLIENTS.nom)),
    importes: facturesMessagesImportes_(lireTable_(CONFIG.ONGLETS.FACTURES.nom)),
  };
  const nouvelles = [];
  // `traites` = les fils qui recevront l'étiquette « …/Traité ». Un fil dont un
  // message a été laissé de côté n'y entre PAS : la requête de recherche exclut
  // les fils étiquetés, l'étiqueter reviendrait à perdre la facture pour de bon.
  const traites = [];
  const adressesInconnues = [];
  let examines = 0;
  let ignores = 0;
  let incomplets = 0;
  let arret = false;

  for (let i = 0; i < fils.length && i < FACTURES_MAX_FILS_; i++) {
    if (new Date().getTime() - debut > FACTURES_DUREE_MAX_MS_) { arret = true; break; }
    const resultat = facturesTraiterFil_(fils[i], contexte);
    resultat.lignes.forEach((ligne) => nouvelles.push(ligne));
    ignores += resultat.ignores;
    examines += 1;
    (resultat.adresses || []).forEach((adresse) => {
      if (adressesInconnues.indexOf(adresse) < 0) adressesInconnues.push(adresse);
    });
    if (resultat.complet) traites.push(fils[i]);
    else incomplets += 1;
  }

  facturesAttribuerIds_(nouvelles);
  ajouterLignes_(CONFIG.ONGLETS.FACTURES.nom, nouvelles);
  facturesMarquerTraites_(nomEtiquette, traites);

  if (adressesInconnues.length) {
    journalAvert_('importerFacturesGmail',
      `${ignores} message(s) d'expéditeur inconnu : ajoutez ces adresses dans l'onglet ` +
      `${CONFIG.ONGLETS.CLIENTS.nom}, puis relancez l'import.`,
      `Adresses inconnues : ${adressesInconnues.join(', ')}`);
  }
  if (incomplets) {
    journalAvert_('importerFacturesGmail',
      `${incomplets} fil(s) laissé(s) sans l'étiquette « ${nomEtiquette}/Traité » : ` +
      `ils seront relus au prochain passage.`,
      'Un fil n\'est marqué traité que si TOUS ses messages ont été importés ou étaient ' +
      'déjà connus.');
  }

  const restants = Math.max(0, fils.length - examines);
  if (restants || arret) {
    journalAvert_('importerFacturesGmail',
      `${restants || 'Des'} fil(s) de courriel restent à importer.`,
      arret ? 'Arrêt volontaire avant la limite de 6 minutes d\'Apps Script.'
            : `Limite de ${FACTURES_MAX_FILS_} fils par exécution.`);
  }
  journalInfo_('importerFacturesGmail',
    `${nouvelles.length} facture(s) importée(s) depuis ${examines} fil(s) examiné(s).`,
    `${traites.length} fil(s) marqué(s) traité(s) ; ` +
    `${ignores} message(s) d'expéditeurs inconnus ignorés.`);
  return facturesResumeImport_({
    creees: nouvelles.length, ignores: ignores, fils: examines,
    restants: restants, arret: arret, adresses: adressesInconnues,
  });
}
