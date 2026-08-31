/**
 * 07_Rapprochement.gs — Le cœur de l'outil : le rapprochement trimestriel.
 *
 * Chaque trimestre, le client annonce le solde qu'il affiche. Ce module calcule
 * le solde que VOUS devriez encore lui devoir, compare les deux, et — surtout —
 * explique chaque écart avec les pièces en cause (dates, montants, références),
 * au lieu de se contenter de dire « ça ne balance pas ».
 *
 * SÉPARATION STRICTE, et elle n'est pas négociable :
 *   • rapprochementTrimestriel() est la SEULE fonction qui touche aux feuilles.
 *     Elle lit tout, appelle le moteur, puis écrit le résultat.
 *   • rapprocherPeriode_(), calculerSoldeTheorique_(), diagnostiquerEcart_(),
 *     trouverSousEnsemble_(), periodeTrimestre_(), bornesTrimestre_() et
 *     normaliserSolde_() sont PURES : elles reçoivent leurs données en
 *     paramètre et ne connaissent ni SpreadsheetApp ni l'heure qu'il est.
 *     C'est ce qui permet de les tester réellement, hors de Google (§7).
 *
 * L'argent est TOUJOURS manipulé en cents entiers : deux flottants ne sont
 * jamais comparés avec === .
 */

/** Colonnes utilisées ici. Les noms viennent tous de CONFIG, jamais du code. */
const RAPPROCHEMENT_COL_ = {
  CLIENT_ID: CONFIG.ONGLETS.CLIENTS.colonnes[0].nom,               // ID client
  CLIENT_NOM: CONFIG.ONGLETS.CLIENTS.colonnes[1].nom,              // Nom
  CLIENT_DEVISE: CONFIG.ONGLETS.CLIENTS.colonnes[5].nom,           // Devise

  BILAN_ID: CONFIG.ONGLETS.BILANS.colonnes[0].nom,                 // ID bilan
  BILAN_CLIENT: CONFIG.ONGLETS.BILANS.colonnes[1].nom,             // ID client
  BILAN_NOM: CONFIG.ONGLETS.BILANS.colonnes[2].nom,                // Nom client
  BILAN_PERIODE: CONFIG.ONGLETS.BILANS.colonnes[3].nom,            // Période
  BILAN_MONTANT: CONFIG.ONGLETS.BILANS.colonnes[6].nom,            // Montant du bilan

  FACTURE_ID: CONFIG.ONGLETS.FACTURES.colonnes[0].nom,             // ID facture
  FACTURE_CLIENT: CONFIG.ONGLETS.FACTURES.colonnes[1].nom,         // ID client
  FACTURE_NOM: CONFIG.ONGLETS.FACTURES.colonnes[2].nom,            // Nom client
  FACTURE_NUMERO: CONFIG.ONGLETS.FACTURES.colonnes[3].nom,         // N° facture client
  FACTURE_DATE: CONFIG.ONGLETS.FACTURES.colonnes[4].nom,           // Date facture
  FACTURE_PERIODE: CONFIG.ONGLETS.FACTURES.colonnes[5].nom,        // Période
  FACTURE_AVANT_TAXES: CONFIG.ONGLETS.FACTURES.colonnes[6].nom,    // Montant avant taxes
  FACTURE_TAXES: CONFIG.ONGLETS.FACTURES.colonnes[7].nom,          // Taxes
  FACTURE_TOTAL: CONFIG.ONGLETS.FACTURES.colonnes[8].nom,          // Montant total
  FACTURE_VERIFICATION: CONFIG.ONGLETS.FACTURES.colonnes[10].nom,  // Statut vérification
  FACTURE_ECART: CONFIG.ONGLETS.FACTURES.colonnes[11].nom,         // Écart vs bilan
  FACTURE_PAIEMENT: CONFIG.ONGLETS.FACTURES.colonnes[12].nom,      // Statut paiement

  PAIEMENT_ID: CONFIG.ONGLETS.PAIEMENTS.colonnes[0].nom,           // ID paiement
  PAIEMENT_CLIENT: CONFIG.ONGLETS.PAIEMENTS.colonnes[1].nom,       // ID client
  PAIEMENT_NOM: CONFIG.ONGLETS.PAIEMENTS.colonnes[2].nom,          // Nom client
  PAIEMENT_DATE: CONFIG.ONGLETS.PAIEMENTS.colonnes[4].nom,         // Date paiement
  PAIEMENT_MONTANT: CONFIG.ONGLETS.PAIEMENTS.colonnes[5].nom,      // Montant
  PAIEMENT_REFERENCE: CONFIG.ONGLETS.PAIEMENTS.colonnes[7].nom,    // Référence
  PAIEMENT_DEDUIT: CONFIG.ONGLETS.PAIEMENTS.colonnes[8].nom,       // Déduit par le client
  PAIEMENT_CONFIRME: CONFIG.ONGLETS.PAIEMENTS.colonnes[9].nom,     // Confirmé au rapprochement

  SOLDE_CLIENT: CONFIG.ONGLETS.SOLDES_DECLARES.colonnes[1].nom,    // ID client
  SOLDE_NOM: CONFIG.ONGLETS.SOLDES_DECLARES.colonnes[2].nom,       // Nom client
  SOLDE_PERIODE: CONFIG.ONGLETS.SOLDES_DECLARES.colonnes[3].nom,   // Période
  SOLDE_DATE: CONFIG.ONGLETS.SOLDES_DECLARES.colonnes[4].nom,      // Date du relevé
  SOLDE_MONTANT: CONFIG.ONGLETS.SOLDES_DECLARES.colonnes[5].nom,   // Solde déclaré

  RAP_PERIODE: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[0].nom,       // Période
  RAP_CLIENT: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[1].nom,        // ID client
  RAP_NOM: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[2].nom,           // Nom client
  RAP_THEORIQUE: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[3].nom,     // Solde théorique
  RAP_DECLARE: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[4].nom,       // Solde déclaré
  RAP_ECART: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[5].nom,         // Écart
  RAP_VERDICT: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[6].nom,       // Verdict
  RAP_DIAGNOSTIC: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[7].nom,    // Diagnostic
  RAP_DETAIL: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[8].nom,        // Détail
  RAP_ACTION: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[9].nom,        // Action suggérée
  RAP_RELANCE: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[10].nom,      // Relance
  RAP_EXECUTE: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[11].nom,      // Exécuté le
};

/** Valeurs de la liste « Déduit par le client » (À confirmer / Oui / Non). */
const RAPPROCHEMENT_DEDUIT_ = {
  A_CONFIRMER: CONFIG.ONGLETS.PAIEMENTS.colonnes[8].liste[0],
  OUI: CONFIG.ONGLETS.PAIEMENTS.colonnes[8].liste[1],
  NON: CONFIG.ONGLETS.PAIEMENTS.colonnes[8].liste[2],
};

/** Statuts de vérification qui font d'une facture une dette reconnue (§4.2). */
const RAPPROCHEMENT_STATUTS_RECONNUS_ = [STATUT_VERIF.CONFORME, STATUT_VERIF.ECART];

/** Statuts de vérification des factures écartées du solde mais explicatives (§4.4 n° 5). */
const RAPPROCHEMENT_STATUTS_ECARTES_ = [STATUT_VERIF.DOUBLON, STATUT_VERIF.SANS_BILAN];

/** Gravité des verdicts : sert à trier le rapport, le plus urgent en haut. */
const RAPPROCHEMENT_GRAVITE_ = {
  [VERDICT.INEXPLIQUE]: 0,
  [VERDICT.EXPLIQUE]: 1,
  [VERDICT.NON_DECLARE]: 2,
  [VERDICT.BALANCE]: 3,
};

/** Nombre de pièces nommées dans un même « Détail » avant de résumer. */
const RAPPROCHEMENT_MAX_PIECES_ = 6;

/** Nombre d'écarts inexpliqués cités dans le résumé final. */
const RAPPROCHEMENT_MAX_RESUME_ = 5;

/** Texte de la colonne « Relance » tant qu'aucun courriel n'a été préparé. */
const RAPPROCHEMENT_SANS_RELANCE_ = '—';

/**
 * Valeurs de la colonne « Relance » qui signifient qu'un courriel a DÉJÀ été
 * préparé pour ce client sur ce trimestre (§3.7). Relancer le rapprochement du
 * même trimestre doit les reporter telles quelles : sans cela, la colonne
 * repasserait à « — » et le client recevrait une seconde relance identique.
 */
const RAPPROCHEMENT_RELANCES_FAITES_ = ['Envoyée', 'Brouillon créé'];

// ---------------------------------------------------------------------------
// Point d'entrée : la seule fonction de ce fichier qui touche aux feuilles
// ---------------------------------------------------------------------------

/**
 * Rapprochement trimestriel complet : lit le classeur, calcule, explique, écrit.
 *
 * Relancer la fonction sur le même trimestre réécrit proprement les lignes de
 * ce trimestre dans l'onglet Rapprochement et laisse les autres trimestres
 * intacts (remplacerPeriode_). Aucune donnée saisie à la main n'est supprimée.
 *
 * @param {string} [periode] Trimestre à traiter, au format 'AAAA-TN'. Si le
 *     paramètre est absent, le trimestre est choisi automatiquement : celui en
 *     cours, ou le précédent s'il est le seul pour lequel des soldes ont été
 *     déclarés (cas du passage automatique le premier jour du trimestre).
 * @return {string} Résumé lisible, affiché tel quel à l'utilisateur.
 */
function rapprochementTrimestriel(periode) {
  const nomFonction = 'rapprochementTrimestriel';
  const params = lireParametres_();
  const donnees = rapprochementLireDonnees_(params);
  const cible = rapprochementPeriodeChoisie_(periode, donnees);
  if (!cible) {
    throw new Error(`« ${periode} » n'est pas un trimestre valide. Utilisez le format ` +
      'AAAA-TN, par exemple 2026-T2.');
  }
  journalInfo_(nomFonction, `Rapprochement du trimestre ${cible}.`,
    `${donnees.clients.length} client(s), ${donnees.factures.length} facture(s), ` +
    `${donnees.paiements.length} paiement(s), ${donnees.soldes.length} solde(s) déclaré(s).`);

  const resultat = rapprocherPeriode_(cible, donnees);
  rapprochementEcrireResultat_(resultat);
  journalInfo_(nomFonction, `Trimestre ${cible} rapproché : ${resultat.total} client(s).`,
    rapprochementDetailCompteurs_(resultat));
  resultat.messages.forEach((message) => journalAvert_(nomFonction, message, ''));

  const relance = rapprochementRelanceAuto_(params, resultat);
  return rapprochementResume_(resultat, relance);
}

/**
 * Lit d'un coup toutes les tables dont le moteur a besoin.
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {Object} Jeu de données complet passé au moteur pur.
 */
function rapprochementLireDonnees_(params) {
  return {
    clients: lireTable_(CONFIG.ONGLETS.CLIENTS.nom),
    factures: lireTable_(CONFIG.ONGLETS.FACTURES.nom),
    paiements: lireTable_(CONFIG.ONGLETS.PAIEMENTS.nom),
    soldes: lireTable_(CONFIG.ONGLETS.SOLDES_DECLARES.nom),
    bilans: lireTable_(CONFIG.ONGLETS.BILANS.nom),
    // Lu AVANT remplacerPeriode_ : c'est là que se trouve l'état des relances
    // déjà envoyées pour ce trimestre.
    rapprochements: lireTable_(CONFIG.ONGLETS.RAPPROCHEMENT.nom),
    params: params || {},
    maintenant: new Date(),
  };
}

/**
 * Écrit le résultat du moteur : les lignes du trimestre dans l'onglet
 * Rapprochement, puis les colonnes « Déduit par le client » et « Confirmé au
 * rapprochement » des paiements concernés.
 * @param {Object} resultat Ce que renvoie rapprocherPeriode_().
 * @return {void}
 */
function rapprochementEcrireResultat_(resultat) {
  remplacerPeriode_(CONFIG.ONGLETS.RAPPROCHEMENT.nom, RAPPROCHEMENT_COL_.RAP_PERIODE,
    resultat.periode, resultat.lignes);
  if (!resultat.majPaiements.length) return;
  try {
    majLignes_(CONFIG.ONGLETS.PAIEMENTS.nom, resultat.majPaiements);
  } catch (e) {
    journalErreur_('rapprochementEcrireResultat_',
      "Le rapport est écrit, mais la colonne « Déduit par le client » n'a pas pu être mise à jour.",
      `${e.message}\n${e.stack}`);
  }
}

/**
 * Prépare les relances si le réglage RELANCE_AUTO est à « Oui » et qu'au moins
 * un client est en écart. La relance porte sur LE trimestre qui vient d'être
 * calculé, jamais sur un autre. Un échec de relance ne fait jamais perdre le rapport.
 * @param {Object} params Réglages lus par lireParametres_().
 * @param {Object} resultat Ce que renvoie rapprocherPeriode_().
 * @return {string} Phrase à ajouter au résumé, ou chaîne vide.
 */
function rapprochementRelanceAuto_(params, resultat) {
  const enEcart = rapprochementCompteur_(resultat, VERDICT.EXPLIQUE) +
    rapprochementCompteur_(resultat, VERDICT.INEXPLIQUE);
  if (!enEcart || !parametreBooleen_(params, 'RELANCE_AUTO')) return '';
  if (typeof relancerClientsEnEcart !== 'function') {
    journalAvert_('rapprochementRelanceAuto_',
      "RELANCE_AUTO est à « Oui » mais le module des courriels est absent.", '');
    return '';
  }
  try {
    const retour = relancerClientsEnEcart(resultat.periode);
    return typeof retour === 'string' && retour ? retour : 'Les relances ont été préparées.';
  } catch (e) {
    journalErreur_('rapprochementRelanceAuto_',
      'Le rapprochement est terminé, mais les relances automatiques ont échoué.',
      `${e.message}\n${e.stack}`);
    return "Les relances automatiques n'ont pas abouti : lancez « 8. Relancer les clients " +
      'en écart » depuis le menu (le détail est dans l\'onglet Journal).';
  }
}

/**
 * Choisit le trimestre à traiter : celui demandé, sinon le trimestre en cours,
 * sinon le précédent lorsqu'il est le seul à porter des soldes déclarés.
 * @param {string} demande Trimestre demandé par l'appelant (peut être vide).
 * @param {Object} donnees Jeu de données complet.
 * @return {string} Trimestre au format 'AAAA-TN', ou '' si le format est invalide.
 */
function rapprochementPeriodeChoisie_(demande, donnees) {
  const decalage = parametreNombre_(donnees.params, 'TRIMESTRE_DECALAGE_MOIS', 0);
  if (demande !== null && demande !== undefined && String(demande).trim() !== '') {
    return rapprochementPeriodeValide_(demande);
  }
  const courante = periodeTrimestre_(donnees.maintenant || new Date(), decalage);
  const precedente = rapprochementPeriodeVoisine_(courante, -1);
  const declarees = {};
  (donnees.soldes || []).forEach((solde) => {
    const cle = rapprochementPeriodeValide_(solde[RAPPROCHEMENT_COL_.SOLDE_PERIODE]);
    if (cle) declarees[cle] = true;
  });
  if (!declarees[courante] && declarees[precedente]) return precedente;
  return courante;
}

// ---------------------------------------------------------------------------
// Le moteur — 100 % pur, aucune feuille, aucune date « maintenant »
// ---------------------------------------------------------------------------

/**
 * Rapproche un trimestre entier. Fonction PURE : tout vient de `donnees`, rien
 * n'est écrit nulle part. C'est elle qui produit à la fois le rapport, les
 * mises à jour de paiements et les compteurs du résumé.
 *
 * @param {string} periode Trimestre à traiter ('AAAA-TN').
 * @param {Object} donnees {clients, factures, paiements, soldes, bilans,
 *     params, maintenant} — tel que le renvoie rapprochementLireDonnees_().
 * @return {Object} {periode, debut, fin, lignes, majPaiements, compteurs,
 *     total, inexpliques, paiementsConfirmes, paiementsRefuses, piecesSansDate,
 *     clientsSansDate, messages}.
 */
function rapprocherPeriode_(periode, donnees) {
  const base = rapprochementPreparer_(periode, donnees);
  const resultat = rapprochementResultatVide_(base.periode, base.bornes);
  if (!base.bornes) {
    resultat.messages.push(`Trimestre « ${periode} » illisible : aucun calcul n'a été fait.`);
    return resultat;
  }
  const fiches = [];
  base.dossiers.forEach((dossier) => {
    const fiche = rapprochementTraiterClient_(dossier, base);
    if (fiche) fiches.push(fiche);
  });
  fiches.sort(rapprochementComparerFiches_);
  fiches.forEach((fiche) => {
    resultat.lignes.push(rapprochementLigneFeuille_(fiche, base));
    resultat.compteurs[fiche.verdict] = (resultat.compteurs[fiche.verdict] || 0) + 1;
    fiche.majPaiements.forEach((maj) => resultat.majPaiements.push(maj));
    resultat.paiementsConfirmes += fiche.confirmes;
    resultat.paiementsRefuses += fiche.refuses;
    if (fiche.sansDate) {
      resultat.piecesSansDate += fiche.sansDate;
      resultat.clientsSansDate.push(`${fiche.nom || fiche.id} (${fiche.id})`);
    }
  });
  resultat.total = fiches.length;
  resultat.inexpliques = fiches
    .filter((fiche) => fiche.verdict === VERDICT.INEXPLIQUE)
    .slice(0, RAPPROCHEMENT_MAX_RESUME_)
    .map((fiche) => ({
      id: fiche.id, nom: fiche.nom, ecartCents: fiche.ecartCents,
      montant: formaterMontant_(fiche.ecartCents, fiche.devise),
    }));
  return resultat;
}

/**
 * Prépare le contexte commun à tous les clients d'un trimestre.
 * @param {string} periode Trimestre demandé.
 * @param {Object} donnees Jeu de données complet.
 * @return {Object} {periode, bornes, params, decalage, toleranceCents,
 *     deviseDefaut, maintenant, dossiers, relances}.
 */
function rapprochementPreparer_(periode, donnees) {
  const jeu = donnees || {};
  const params = jeu.params || {};
  const decalage = parametreNombre_(params, 'TRIMESTRE_DECALAGE_MOIS', 0);
  const canonique = rapprochementPeriodeValide_(periode);
  return {
    periode: canonique || String(periode === null || periode === undefined ? '' : periode).trim(),
    bornes: canonique ? bornesTrimestre_(canonique, decalage) : null,
    params: params,
    decalage: decalage,
    toleranceCents: Math.max(0, Math.round(parametreNombre_(params, 'TOLERANCE_CENTS', 1))),
    deviseDefaut: params.DEVISE || CONFIG.PARAMETRES_DEFAUT.DEVISE,
    maintenant: versDate_(jeu.maintenant) || new Date(),
    dossiers: rapprochementDossiers_(jeu),
    relances: rapprochementRelancesExistantes_(jeu.rapprochements, canonique),
  };
}

/**
 * Relit la colonne « Relance » des lignes déjà écrites pour ce trimestre, afin
 * de la reporter sur les nouvelles lignes. Seuls les états qui prouvent qu'un
 * courriel a été préparé sont repris ; « — » et « Échec » ne le sont pas, pour
 * qu'un envoi manqué puisse être retenté.
 * @param {Array<Object>} lignes Lignes de l'onglet Rapprochement, lues avant
 *     la réécriture de la période.
 * @param {string} periode Trimestre traité, au format canonique.
 * @return {Map<string, string>} Clé du client vers l'état de relance à reprendre.
 */
function rapprochementRelancesExistantes_(lignes, periode) {
  const reprises = new Map();
  if (!periode) return reprises;
  (lignes || []).forEach((ligne) => {
    if (!ligne) return;
    if (rapprochementPeriodeValide_(ligne[RAPPROCHEMENT_COL_.RAP_PERIODE]) !== periode) return;
    const cle = rapprochementCle_(ligne[RAPPROCHEMENT_COL_.RAP_CLIENT]);
    if (!cle) return;
    const valeur = rapprochementTexte_(ligne[RAPPROCHEMENT_COL_.RAP_RELANCE]);
    const faite = RAPPROCHEMENT_RELANCES_FAITES_
      .some((etat) => texteNormalise_(etat) === texteNormalise_(valeur));
    if (faite) reprises.set(cle, valeur);
  });
  return reprises;
}

/**
 * Squelette du résultat, utilisé même quand rien n'a pu être calculé.
 * @param {string} periode Trimestre traité.
 * @param {?Object} bornes Bornes du trimestre, ou null.
 * @return {Object} Résultat vide, prêt à être rempli.
 */
function rapprochementResultatVide_(periode, bornes) {
  return {
    periode: periode,
    debut: bornes ? bornes.debut : null,
    fin: bornes ? bornes.fin : null,
    lignes: [],
    majPaiements: [],
    compteurs: {},
    total: 0,
    inexpliques: [],
    paiementsConfirmes: 0,
    paiementsRefuses: 0,
    piecesSansDate: 0,
    clientsSansDate: [],
    messages: [],
  };
}

/**
 * Regroupe toutes les lignes du classeur par client, en une seule passe par
 * onglet. Les clients absents de l'onglet Clients mais présents dans les
 * factures, les paiements ou les soldes sont conservés : on ne perd personne.
 * @param {Object} donnees Jeu de données complet.
 * @return {Map<string, Object>} Clé de client vers son dossier.
 */
function rapprochementDossiers_(donnees) {
  const dossiers = new Map();
  const col = RAPPROCHEMENT_COL_;
  rapprochementRanger_(dossiers, donnees.clients, col.CLIENT_ID, col.CLIENT_NOM, '');
  rapprochementRanger_(dossiers, donnees.factures, col.FACTURE_CLIENT, col.FACTURE_NOM, 'factures');
  rapprochementRanger_(dossiers, donnees.paiements, col.PAIEMENT_CLIENT, col.PAIEMENT_NOM,
    'paiements');
  rapprochementRanger_(dossiers, donnees.soldes, col.SOLDE_CLIENT, col.SOLDE_NOM, 'soldes');
  rapprochementRanger_(dossiers, donnees.bilans, col.BILAN_CLIENT, col.BILAN_NOM, 'bilans');
  return dossiers;
}

/**
 * Range une table dans les dossiers clients (crée le dossier au besoin).
 * @param {Map<string, Object>} dossiers Dossiers en cours de construction.
 * @param {Array<Object>} lignes Lignes de la table.
 * @param {string} colId Colonne portant l'identifiant du client.
 * @param {string} colNom Colonne portant le nom du client.
 * @param {string} champ Champ du dossier à alimenter ('' pour la fiche client).
 * @return {void}
 */
function rapprochementRanger_(dossiers, lignes, colId, colNom, champ) {
  (lignes || []).forEach((ligne) => {
    if (!ligne) return;
    const cle = rapprochementCle_(ligne[colId]);
    if (!cle) return;
    if (!dossiers.has(cle)) {
      dossiers.set(cle, {
        cle: cle, id: '', nom: '', client: null,
        factures: [], paiements: [], soldes: [], bilans: [],
      });
    }
    const dossier = dossiers.get(cle);
    if (!dossier.id) dossier.id = rapprochementTexte_(ligne[colId]);
    if (!dossier.nom) dossier.nom = rapprochementTexte_(ligne[colNom]);
    if (champ) dossier[champ].push(ligne);
    else dossier.client = ligne;
  });
}

/**
 * Traite un client : solde théorique, solde déclaré, diagnostic, mises à jour.
 * @param {Object} dossier Dossier du client.
 * @param {Object} base Contexte commun préparé par rapprochementPreparer_().
 * @return {?Object} Fiche du client, ou null s'il n'y a rien à dire de lui.
 */
function rapprochementTraiterClient_(dossier, base) {
  const donneesClient = { dossiers: base.dossiers };
  const theorique = calculerSoldeTheorique_(dossier.cle, base.bornes.fin, donneesClient);
  const declaration = rapprochementDeclaration_(dossier, base);
  const paiementsPeriode = rapprochementPiecesPeriode_(
    dossier.paiements.map(rapprochementPiecePaiement_), base.bornes, true);
  const facturesPeriode = rapprochementPiecesPeriode_(
    dossier.factures.map(rapprochementPieceFacture_), base.bornes, true);
  if (!declaration.connu && theorique === 0 && !paiementsPeriode.length && !facturesPeriode.length) {
    return null; // Client sans activité et sans solde déclaré : aucune ligne, aucun bruit.
  }
  const devise = rapprochementDevise_(dossier, base);
  const diag = diagnostiquerEcart_({
    clientId: dossier.id, nomClient: dossier.nom, devise: devise,
    periode: base.periode, bornes: base.bornes, decalageMois: base.decalage,
    toleranceCents: base.toleranceCents,
    soldeDeclareConnu: declaration.connu,
    soldeTheoriqueCents: theorique, soldeDeclareCents: declaration.cents,
    factures: dossier.factures, paiements: dossier.paiements, bilans: dossier.bilans,
  });
  const fiche = {
    cle: dossier.cle, id: dossier.id, nom: dossier.nom || dossier.id, devise: devise,
    theoriqueCents: theorique, declareCents: declaration.cents, declareConnu: declaration.connu,
    ecartCents: declaration.connu ? theorique - declaration.cents : 0,
    verdict: diag.verdict, diag: diag, paiementsPeriode: paiementsPeriode,
    sansDate: Number(diag.piecesSansDate) || 0,
    majPaiements: [], confirmes: 0, refuses: 0,
  };
  rapprochementMajPaiements_(fiche, base);
  return fiche;
}

/**
 * Retient le solde déclaré du trimestre : le relevé le plus récent l'emporte.
 * @param {Object} dossier Dossier du client.
 * @param {Object} base Contexte commun.
 * @return {{connu: boolean, cents: number, ligne: ?Object}} Solde retenu.
 */
function rapprochementDeclaration_(dossier, base) {
  let retenue = null;
  let horodatage = -Infinity;
  dossier.soldes.forEach((ligne) => {
    if (rapprochementPeriodeValide_(ligne[RAPPROCHEMENT_COL_.SOLDE_PERIODE]) !== base.periode) return;
    const brut = ligne[RAPPROCHEMENT_COL_.SOLDE_MONTANT];
    if (brut === null || brut === undefined || String(brut).trim() === '') return;
    const date = versDate_(ligne[RAPPROCHEMENT_COL_.SOLDE_DATE]);
    const rang = date ? date.getTime() : 0;
    if (retenue === null || rang >= horodatage) {
      retenue = ligne;
      horodatage = rang;
    }
  });
  if (!retenue) return { connu: false, cents: 0, ligne: null };
  return {
    connu: true,
    cents: normaliserSolde_(retenue[RAPPROCHEMENT_COL_.SOLDE_MONTANT], base.params),
    ligne: retenue,
  };
}

/**
 * Devise à utiliser pour ce client (celle de sa fiche, sinon celle des réglages).
 * @param {Object} dossier Dossier du client.
 * @param {Object} base Contexte commun.
 * @return {string} Code de devise.
 */
function rapprochementDevise_(dossier, base) {
  const propre = dossier.client
    ? rapprochementTexte_(dossier.client[RAPPROCHEMENT_COL_.CLIENT_DEVISE])
    : '';
  return propre || base.deviseDefaut;
}

/**
 * Prépare les mises à jour de la colonne « Déduit par le client » et de la
 * colonne « Confirmé au rapprochement » pour un client donné :
 *   • client balancé → tous ses paiements du trimestre passent à « Oui » ;
 *   • paiements identifiés comme non déduits → « Non ».
 * Seules les cellules qui changent réellement sont écrites.
 * @param {Object} fiche Fiche du client, complétée sur place.
 * @param {Object} base Contexte commun.
 * @return {void}
 */
function rapprochementMajPaiements_(fiche, base) {
  const marquer = (source, valeur) => {
    if (!source || !source._ligne) return false;
    const patch = {};
    if (rapprochementTexte_(source[RAPPROCHEMENT_COL_.PAIEMENT_DEDUIT]) !== valeur) {
      patch[RAPPROCHEMENT_COL_.PAIEMENT_DEDUIT] = valeur;
    }
    if (rapprochementTexte_(source[RAPPROCHEMENT_COL_.PAIEMENT_CONFIRME]) !== base.periode) {
      patch[RAPPROCHEMENT_COL_.PAIEMENT_CONFIRME] = base.periode;
    }
    if (!Object.keys(patch).length) return false;
    fiche.majPaiements.push({ ligne: source._ligne, patch: patch });
    return true;
  };
  if (fiche.verdict === VERDICT.BALANCE) {
    fiche.paiementsPeriode.forEach((piece) => {
      if (marquer(piece.source, RAPPROCHEMENT_DEDUIT_.OUI)) fiche.confirmes++;
    });
  }
  (fiche.diag.sourcesNonDeduites || []).forEach((source) => {
    if (marquer(source, RAPPROCHEMENT_DEDUIT_.NON)) fiche.refuses++;
  });
}

/**
 * Convertit une fiche client en ligne de l'onglet Rapprochement.
 * @param {Object} fiche Fiche produite par rapprochementTraiterClient_().
 * @param {Object} base Contexte commun.
 * @return {Object} Ligne clée par les noms d'en-tête de CONFIG.
 */
function rapprochementLigneFeuille_(fiche, base) {
  const col = RAPPROCHEMENT_COL_;
  const ligne = {};
  ligne[col.RAP_PERIODE] = base.periode;
  ligne[col.RAP_CLIENT] = fiche.id;
  ligne[col.RAP_NOM] = fiche.nom;
  ligne[col.RAP_THEORIQUE] = enDollars_(fiche.theoriqueCents);
  ligne[col.RAP_DECLARE] = fiche.declareConnu ? enDollars_(fiche.declareCents) : '';
  ligne[col.RAP_ECART] = fiche.declareConnu ? enDollars_(fiche.ecartCents) : '';
  ligne[col.RAP_VERDICT] = fiche.verdict;
  ligne[col.RAP_DIAGNOSTIC] = fiche.diag.diagnostic;
  ligne[col.RAP_DETAIL] = fiche.diag.detail;
  ligne[col.RAP_ACTION] = fiche.diag.action;
  const dejaRelance = base.relances ? base.relances.get(fiche.cle) : '';
  ligne[col.RAP_RELANCE] = dejaRelance || RAPPROCHEMENT_SANS_RELANCE_;
  ligne[col.RAP_EXECUTE] = base.maintenant;
  return ligne;
}

/**
 * Ordre du rapport : le plus grave d'abord, puis le plus gros écart.
 * @param {Object} a Première fiche.
 * @param {Object} b Seconde fiche.
 * @return {number} Ordre de tri.
 */
function rapprochementComparerFiches_(a, b) {
  const graviteA = RAPPROCHEMENT_GRAVITE_[a.verdict];
  const graviteB = RAPPROCHEMENT_GRAVITE_[b.verdict];
  const rangA = graviteA === undefined ? 9 : graviteA;
  const rangB = graviteB === undefined ? 9 : graviteB;
  if (rangA !== rangB) return rangA - rangB;
  const ecartA = Math.abs(a.ecartCents);
  const ecartB = Math.abs(b.ecartCents);
  if (ecartA !== ecartB) return ecartB - ecartA;
  return String(a.nom || a.id).localeCompare(String(b.nom || b.id));
}

// ---------------------------------------------------------------------------
// §4.2 — Solde théorique
// ---------------------------------------------------------------------------

/**
 * Solde théorique d'un client à la fin d'une période, en cents entiers (§4.2) :
 *
 *   Σ factures reconnues (Conforme ou Écart de montant, non Annulée,
 *                         période ≤ fin) − Σ paiements (date ≤ fin)
 *
 * Positif = vous devez encore de l'argent au client. Les factures Doublon,
 * Sans bilan et Rejetée sont exclues : ce ne sont pas des dettes reconnues.
 * Une pièce sans aucune date n'est jamais écartée : elle existe, donc elle compte.
 *
 * @param {string} clientId Identifiant du client (les espaces et tirets sont ignorés).
 * @param {Date} finPeriode Dernier instant de la période.
 * @param {Object} donnees {factures, paiements} ou {dossiers} déjà indexés.
 * @return {number} Solde en cents entiers.
 */
function calculerSoldeTheorique_(clientId, finPeriode, donnees) {
  const cle = rapprochementCle_(clientId);
  const fin = versDate_(finPeriode);
  const dossier = rapprochementDossierDe_(donnees, cle);
  let cents = 0;
  dossier.factures.forEach((facture) => {
    if (!rapprochementFactureReconnue_(facture)) return;
    if (!rapprochementAvantOuEgal_(rapprochementDateFacture_(facture), fin)) return;
    cents += enCents_(facture[RAPPROCHEMENT_COL_.FACTURE_TOTAL]);
  });
  dossier.paiements.forEach((paiement) => {
    if (!rapprochementAvantOuEgal_(rapprochementDatePaiement_(paiement), fin)) return;
    cents -= enCents_(paiement[RAPPROCHEMENT_COL_.PAIEMENT_MONTANT]);
  });
  return cents;
}

/**
 * Retrouve le dossier d'un client, qu'il soit déjà indexé ou non. Permet
 * d'appeler calculerSoldeTheorique_ avec de simples tableaux dans les tests.
 * @param {Object} donnees {dossiers} indexés, ou {factures, paiements, ...}.
 * @param {string} cle Clé normalisée du client.
 * @return {Object} Dossier {factures, paiements, soldes, bilans}.
 */
function rapprochementDossierDe_(donnees, cle) {
  const jeu = donnees || {};
  if (jeu.dossiers && typeof jeu.dossiers.get === 'function') {
    return jeu.dossiers.get(cle) ||
      { cle: cle, id: '', nom: '', client: null, factures: [], paiements: [], soldes: [], bilans: [] };
  }
  const col = RAPPROCHEMENT_COL_;
  const garder = (lignes, colonne) => (lignes || [])
    .filter((ligne) => ligne && rapprochementCle_(ligne[colonne]) === cle);
  return {
    cle: cle, id: '', nom: '', client: null,
    factures: garder(jeu.factures, col.FACTURE_CLIENT),
    paiements: garder(jeu.paiements, col.PAIEMENT_CLIENT),
    soldes: garder(jeu.soldes, col.SOLDE_CLIENT),
    bilans: garder(jeu.bilans, col.BILAN_CLIENT),
  };
}

/**
 * Une facture est-elle une dette reconnue au sens du §4.2 ?
 * @param {Object} facture Ligne de l'onglet Factures.
 * @return {boolean} Vrai si elle entre dans le solde théorique.
 */
function rapprochementFactureReconnue_(facture) {
  if (!facture) return false;
  const verification = texteNormalise_(facture[RAPPROCHEMENT_COL_.FACTURE_VERIFICATION]);
  const reconnue = RAPPROCHEMENT_STATUTS_RECONNUS_
    .some((statut) => texteNormalise_(statut) === verification);
  if (!reconnue) return false;
  const paiement = texteNormalise_(facture[RAPPROCHEMENT_COL_.FACTURE_PAIEMENT]);
  return paiement !== texteNormalise_(STATUT_PAIEMENT.ANNULEE);
}

/**
 * Date de rattachement d'une facture : le premier jour de sa période si elle en
 * a une, sinon sa date de facture.
 * @param {Object} facture Ligne de l'onglet Factures.
 * @return {?Date} Date de rattachement, ou null si la facture n'en a aucune.
 */
function rapprochementDateFacture_(facture) {
  const mois = rapprochementDebutDuMois_(facture[RAPPROCHEMENT_COL_.FACTURE_PERIODE]);
  return mois || versDate_(facture[RAPPROCHEMENT_COL_.FACTURE_DATE]);
}

/**
 * Date d'un paiement.
 * @param {Object} paiement Ligne de l'onglet Paiements.
 * @return {?Date} Date du paiement, ou null.
 */
function rapprochementDatePaiement_(paiement) {
  return versDate_(paiement[RAPPROCHEMENT_COL_.PAIEMENT_DATE]);
}

/**
 * Premier jour d'une période mensuelle 'AAAA-MM'.
 * @param {*} periode Période mensuelle.
 * @return {?Date} Premier jour du mois, ou null si le format ne correspond pas.
 */
function rapprochementDebutDuMois_(periode) {
  const trouve = /^(\d{4})[-/](\d{1,2})$/.exec(rapprochementTexte_(periode));
  if (!trouve) return null;
  return feuillesDateValide_(Number(trouve[1]), Number(trouve[2]), 1);
}

/**
 * Une pièce est-elle antérieure ou égale à une borne ? Une pièce sans date est
 * conservée : on ne fait jamais disparaître une dette faute de date saisie.
 * @param {?Date} date Date de la pièce.
 * @param {?Date} borne Dernier instant accepté.
 * @return {boolean} Vrai si la pièce doit être comptée.
 */
function rapprochementAvantOuEgal_(date, borne) {
  if (!borne) return true;
  if (!date) return true;
  return date.getTime() <= borne.getTime();
}

// ---------------------------------------------------------------------------
// §4.4 — Le moteur de diagnostic : dix hypothèses, dans l'ordre
// ---------------------------------------------------------------------------

/**
 * Explique un écart entre le solde théorique et le solde déclaré (§4.4).
 * Les hypothèses sont testées DANS L'ORDRE ; la première qui explique
 * exactement l'écart gagne. Rien n'est deviné : sans correspondance exacte,
 * l'écart est déclaré inexpliqué plutôt qu'expliqué à peu près.
 *
 * @param {Object} contexte {clientId, nomClient, devise, periode, bornes,
 *     decalageMois, toleranceCents, soldeDeclareConnu, soldeTheoriqueCents,
 *     soldeDeclareCents, ecartCents (facultatif), factures, paiements, bilans}.
 * @return {{verdict: string, diagnostic: string, detail: string, action: string,
 *     paiementsNonDeduits: Array<string>, sourcesNonDeduites: Array<Object>,
 *     piecesSansDate: number}}
 *     Verdict, explication nommant les pièces, et geste à faire ensuite.
 */
function diagnostiquerEcart_(contexte) {
  const c = rapprochementContexte_(contexte);
  return rapprochementSignalerSansDate_(rapprochementChoisirHypothese_(c), c);
}

/**
 * Déroule les hypothèses du §4.4 dans l'ordre et renvoie la première qui
 * explique EXACTEMENT l'écart.
 * @param {Object} c Contexte complété par rapprochementContexte_().
 * @return {Object} Résultat de diagnostic.
 */
function rapprochementChoisirHypothese_(c) {
  if (!c.soldeDeclareConnu) return rapprochementNonDeclare_(c);
  if (Math.abs(c.ecartCents) <= c.toleranceCents) return rapprochementBalance_(c);
  const atelier = rapprochementAtelier_(c);
  const hypotheses = [
    rapprochementHypPaiementsNonDeduits_,   // 1
    rapprochementHypFactureNonComptabilisee_, // 2
    rapprochementHypPaiementDouble_,        // 3
    rapprochementHypEcartFacturation_,      // 4
    rapprochementHypFactureEcartee_,        // 5
    rapprochementHypTaxes_,                 // 6
    rapprochementHypSigneInverse_,          // 7
    rapprochementHypDecalagePeriode_,       // 8
  ];
  for (let i = 0; i < hypotheses.length; i++) {
    const trouve = hypotheses[i](c, atelier);
    if (trouve) return trouve;
  }
  return rapprochementHypInexplique_(c, atelier);   // 9
}

/**
 * Ajoute au « Détail » la phrase qui nomme les pièces sans date (§4.4). Ces
 * pièces comptent dans le solde théorique : les taire reviendrait à déclarer
 * « inexpliqué » un écart dont la cause est dans le classeur.
 * @param {Object} resultat Résultat de diagnostic, complété sur place.
 * @param {Object} c Contexte complété.
 * @return {Object} Le même résultat, enrichi.
 */
function rapprochementSignalerSansDate_(resultat, c) {
  const phrase = rapprochementPhraseSansDate_(c);
  resultat.piecesSansDate = rapprochementPiecesSansDate_(c).length;
  if (!phrase) return resultat;
  resultat.detail = resultat.detail ? `${resultat.detail} ${phrase}` : phrase;
  return resultat;
}

/**
 * Complète un contexte de diagnostic avec ses valeurs par défaut.
 * @param {Object} contexte Contexte fourni par l'appelant.
 * @return {Object} Contexte utilisable sans vérification supplémentaire.
 */
function rapprochementContexte_(contexte) {
  const brut = contexte || {};
  const theorique = Math.round(Number(brut.soldeTheoriqueCents) || 0);
  const declare = Math.round(Number(brut.soldeDeclareCents) || 0);
  const fourni = brut.ecartCents !== null && brut.ecartCents !== undefined;
  return {
    clientId: rapprochementTexte_(brut.clientId),
    nomClient: rapprochementTexte_(brut.nomClient),
    devise: brut.devise || CONFIG.PARAMETRES_DEFAUT.DEVISE,
    periode: rapprochementTexte_(brut.periode),
    bornes: brut.bornes || null,
    decalageMois: rapprochementDecalage_(brut.decalageMois),
    toleranceCents: Math.max(0, Math.round(Number(brut.toleranceCents) || 0)),
    soldeDeclareConnu: brut.soldeDeclareConnu !== false,
    soldeTheoriqueCents: theorique,
    soldeDeclareCents: declare,
    ecartCents: fourni ? Math.round(Number(brut.ecartCents) || 0) : theorique - declare,
    factures: brut.factures || [],
    paiements: brut.paiements || [],
    bilans: brut.bilans || [],
  };
}

/**
 * Prépare une fois pour toutes les pièces dont les hypothèses ont besoin.
 * @param {Object} c Contexte complété.
 * @return {Object} {facturesPeriode, paiementsPeriode, bilansPeriode,
 *     facturesAvant, voisines} — toutes les listes sont des « pièces ».
 */
function rapprochementAtelier_(c) {
  const factures = c.factures.map(rapprochementPieceFacture_);
  const paiements = c.paiements.map(rapprochementPiecePaiement_);
  const bilans = c.bilans.map(rapprochementPieceBilan_);
  const fin = c.bornes ? c.bornes.fin : null;
  // §4.4 : une hypothèse ne raisonne que sur les pièces qui composent RÉELLEMENT
  // le solde théorique (§4.2). Une facture Annulée, Rejetée, Doublon ou Sans
  // bilan n'y entre pas : l'accuser d'expliquer un écart est une contradiction,
  // et le courriel qui en découlerait enverrait le client vérifier une pièce
  // qu'aucun des deux ne compte. Le filtre est posé ICI, une fois, plutôt que
  // répété dans chaque hypothèse — c'est l'oubli d'un de ces filtres qui a
  // produit les faux diagnostics des hypothèses 6, 8 et 9.
  // Seule l'hypothèse 5, dont c'est précisément l'objet, regarde les factures
  // écartées : elle passe par facturesAvant, volontairement non filtrée.
  const reconnues = factures.filter((piece) => rapprochementFactureReconnue_(piece.source));
  return {
    facturesPeriode: rapprochementPiecesPeriode_(reconnues, c.bornes, true),
    paiementsPeriode: rapprochementPiecesPeriode_(paiements, c.bornes, true),
    bilansPeriode: rapprochementPiecesPeriode_(bilans, c.bornes),
    facturesAvant: factures.filter((piece) => rapprochementAvantOuEgal_(piece.date, fin)),
    voisines: rapprochementPiecesVoisines_(c, reconnues.concat(paiements)),
  };
}

/**
 * Hypothèse 1 — un ou plusieurs paiements que le client n'a pas déduits.
 * C'est la cause la plus fréquente : son solde est trop élevé d'autant.
 * Les paiements dont « Déduit par le client » ≠ Oui sont essayés en premier.
 * @param {Object} c Contexte complété.
 * @param {Object} atelier Pièces préparées.
 * @return {?Object} Résultat de diagnostic, ou null.
 */
function rapprochementHypPaiementsNonDeduits_(c, atelier) {
  const cible = -c.ecartCents;
  const trouves = rapprochementSousEnsemblePaiements_(atelier.paiementsPeriode, cible);
  if (!trouves) return null;
  const resultat = rapprochementResultat_(VERDICT.EXPLIQUE,
    `${trouves.length} paiement(s) que le client n'a pas déduit(s) de son solde.`,
    `${rapprochementSens_(c)} ${formaterMontant_(cible, c.devise)}, ` +
    `soit exactement le total de : ${rapprochementEnumerer_(trouves, c.devise)}.`,
    'Envoyez-lui la preuve de ce(s) paiement(s) et demandez un relevé corrigé ; ' +
    'la colonne « Déduit par le client » de ces paiements est passée à ' +
    `« ${RAPPROCHEMENT_DEDUIT_.NON} ».`);
  resultat.paiementsNonDeduits = trouves.map((piece) => piece.id).filter((id) => id !== '');
  resultat.sourcesNonDeduites = trouves.map((piece) => piece.source);
  return resultat;
}

/**
 * Cherche un sous-ensemble de paiements dont la somme vaut exactement la cible,
 * en privilégiant ceux qui ne sont pas encore marqués comme déduits.
 * @param {Array<Object>} paiements Pièces de paiement du trimestre.
 * @param {number} cibleCents Somme recherchée, en cents.
 * @return {?Array<Object>} Les pièces trouvées, ou null.
 */
function rapprochementSousEnsemblePaiements_(paiements, cibleCents) {
  const prioritaires = paiements.filter((piece) =>
    rapprochementTexte_(piece.source[RAPPROCHEMENT_COL_.PAIEMENT_DEDUIT]) !==
      RAPPROCHEMENT_DEDUIT_.OUI);
  const essais = prioritaires.length && prioritaires.length < paiements.length
    ? [prioritaires, paiements]
    : [paiements];
  for (let i = 0; i < essais.length; i++) {
    const liste = essais[i];
    const indices = trouverSousEnsemble_(liste.map((piece) => piece.cents), cibleCents,
      CONFIG.SOUS_ENSEMBLE_MAX_ELEMENTS);
    if (indices) return indices.map((position) => liste[position]);
  }
  return null;
}

/**
 * Hypothèse 2 — une ou plusieurs factures que le client n'a pas comptabilisées.
 * @param {Object} c Contexte complété.
 * @param {Object} atelier Pièces préparées.
 * @return {?Object} Résultat de diagnostic, ou null.
 */
function rapprochementHypFactureNonComptabilisee_(c, atelier) {
  // Toutes les factures RECONNUES, pas seulement les « Conforme » : une facture
  // « Écart de montant » compte dans le solde théorique (§4.2), donc le client
  // peut tout aussi bien avoir omis de la comptabiliser. La restreindre aux
  // « Conforme » rendait le rapport contradictoire avec son propre calcul.
  const reconnues = atelier.facturesPeriode;
  const indices = trouverSousEnsemble_(reconnues.map((piece) => piece.cents), c.ecartCents,
    CONFIG.SOUS_ENSEMBLE_MAX_ELEMENTS);
  if (!indices) return null;
  const trouves = indices.map((position) => reconnues[position]);
  return rapprochementResultat_(VERDICT.EXPLIQUE,
    `${trouves.length} facture(s) que le client n'a pas comptabilisée(s).`,
    `${rapprochementSens_(c)} ${formaterMontant_(c.ecartCents, c.devise)}, ` +
    `soit exactement le total de : ${rapprochementEnumerer_(trouves, c.devise)}.`,
    'Demandez-lui de vérifier que cette (ces) facture(s) figure(nt) bien dans son relevé ; ' +
    'joignez-lui les copies au besoin.');
}

/**
 * Hypothèse 3 — un paiement déduit deux fois par le client (§4.4).
 *
 * SIGNE IMPOSÉ : écart > 0. Retrancher un paiement une fois de trop ABAISSE le
 * solde du client ; son solde est donc plus bas que le vôtre, exactement du
 * montant de ce paiement (et non du double : le paiement légitime est déjà
 * déduit des deux côtés). Un écart négatif ne peut pas venir de là.
 *
 * @param {Object} c Contexte complété.
 * @param {Object} atelier Pièces préparées.
 * @return {?Object} Résultat de diagnostic, ou null.
 */
function rapprochementHypPaiementDouble_(c, atelier) {
  if (c.ecartCents <= 0) return null;
  const paiements = atelier.paiementsPeriode;
  for (let i = 0; i < paiements.length; i++) {
    const piece = paiements[i];
    if (piece.cents <= 0) continue;
    if (Math.abs(piece.cents - c.ecartCents) > c.toleranceCents) continue;
    return rapprochementResultat_(VERDICT.EXPLIQUE, 'Un paiement semble compté deux fois.',
      `${rapprochementSens_(c)} ${formaterMontant_(c.ecartCents, c.devise)}, soit exactement ` +
      `le montant ${rapprochementDe_(piece)}${rapprochementDecrire_(piece, c.devise)} : ` +
      'il l\'a vraisemblablement retranché une fois de trop de son solde.',
      'Demandez-lui de vérifier qu\'il n\'a pas enregistré ce paiement deux fois.');
  }
  return null;
}

/**
 * Hypothèse 4 — l'écart correspond aux écarts de facturation du trimestre
 * (les factures dont le montant ne collait pas au bilan envoyé).
 * @param {Object} c Contexte complété.
 * @param {Object} atelier Pièces préparées.
 * @return {?Object} Résultat de diagnostic, ou null.
 */
function rapprochementHypEcartFacturation_(c, atelier) {
  const enEcart = atelier.facturesPeriode.filter((piece) =>
    texteNormalise_(piece.source[RAPPROCHEMENT_COL_.FACTURE_VERIFICATION]) ===
      texteNormalise_(STATUT_VERIF.ECART));
  if (!enEcart.length) return null;
  const somme = enEcart.reduce((total, piece) =>
    total + enCents_(piece.source[RAPPROCHEMENT_COL_.FACTURE_ECART]), 0);
  // La somme des « Écart vs bilan » a un sens déterminé : on la compare SIGNÉE
  // à l'écart signé. En valeur absolue, un écart de sens contraire serait
  // présenté comme l'explication exacte, ce qu'il n'est pas.
  if (somme === 0 || Math.abs(somme - c.ecartCents) > c.toleranceCents) {
    return null;
  }
  const details = enEcart.map((piece) => `${rapprochementDecrire_(piece, c.devise)} — écart de ` +
    `${formaterMontant_(enCents_(piece.source[RAPPROCHEMENT_COL_.FACTURE_ECART]), c.devise)} ` +
    'par rapport à votre bilan');
  return rapprochementResultat_(VERDICT.EXPLIQUE,
    `Écart de facturation sur ${enEcart.length} facture(s).`,
    `${rapprochementSens_(c)} ${formaterMontant_(Math.abs(c.ecartCents), c.devise)}, ` +
    `soit exactement la somme des écarts constatés à la vérification : ` +
    `${rapprochementJoindre_(details)}.`,
    'Convenez avec lui du montant retenu, puis corrigez le bilan ou demandez une facture ' +
    'rectifiée.');
}

/**
 * Hypothèse 5 — le client a compté une facture que vous avez écartée
 * (Doublon ou Sans bilan) et qui n'entre donc pas dans votre solde.
 * @param {Object} c Contexte complété.
 * @param {Object} atelier Pièces préparées.
 * @return {?Object} Résultat de diagnostic, ou null.
 */
function rapprochementHypFactureEcartee_(c, atelier) {
  // SIGNE IMPOSÉ : écart < 0. Si le client compte une facture que vous avez
  // écartée, son solde est plus ÉLEVÉ que le vôtre, jamais plus bas.
  if (c.ecartCents >= 0) return null;
  const absolu = -c.ecartCents;
  const ecartees = atelier.facturesAvant.filter((piece) => {
    const statut = texteNormalise_(piece.source[RAPPROCHEMENT_COL_.FACTURE_VERIFICATION]);
    return RAPPROCHEMENT_STATUTS_ECARTES_.some((v) => texteNormalise_(v) === statut);
  });
  const trouvee = ecartees.filter((piece) =>
    piece.cents !== 0 && Math.abs(piece.cents - absolu) <= c.toleranceCents)[0];
  if (!trouvee) return null;
  const statut = rapprochementTexte_(trouvee.source[RAPPROCHEMENT_COL_.FACTURE_VERIFICATION]);
  return rapprochementResultat_(VERDICT.EXPLIQUE,
    `Le client semble compter une facture classée « ${statut} ».`,
    `${rapprochementSens_(c)} ${formaterMontant_(absolu, c.devise)}, soit exactement le ` +
    `montant ${rapprochementDe_(trouvee)}${rapprochementDecrire_(trouvee, c.devise)}, que ` +
    `vous avez classée « ${statut} » : elle n'entre pas dans votre solde.`,
    'Demandez-lui de retirer cette facture de son relevé — ou, si elle est valable, ' +
    `remettez-la à « ${STATUT_VERIF.CONFORME} » dans l'onglet ${CONFIG.ONGLETS.FACTURES.nom} ` +
    'et relancez le rapprochement.');
}

/**
 * Hypothèse 6 — erreur de taxes : l'écart vaut la TPS, la TVQ, les deux, ou les
 * taxes inscrites sur une pièce du trimestre.
 * @param {Object} c Contexte complété.
 * @param {Object} atelier Pièces préparées.
 * @return {?Object} Résultat de diagnostic, ou null.
 */
function rapprochementHypTaxes_(c, atelier) {
  const absolu = Math.abs(c.ecartCents);
  const pieces = atelier.facturesPeriode.concat(atelier.bilansPeriode);
  for (let i = 0; i < pieces.length; i++) {
    const candidates = rapprochementCandidatsTaxes_(pieces[i]);
    for (let j = 0; j < candidates.length; j++) {
      const candidate = candidates[j];
      if (candidate.cents <= 0) continue;
      if (Math.abs(candidate.cents - absolu) > c.toleranceCents) continue;
      return rapprochementResultat_(VERDICT.EXPLIQUE, 'Erreur de taxes.',
        `${rapprochementSens_(c)} ${formaterMontant_(absolu, c.devise)}, soit exactement ` +
        `${candidate.libelle} ${rapprochementDe_(pieces[i])}` +
        `${rapprochementDecrire_(pieces[i], c.devise)}.`,
        'Vérifiez avec lui si les taxes ont été ajoutées en trop ou oubliées sur cette pièce, ' +
        'puis corrigez la facture ou le bilan concerné.');
    }
  }
  return null;
}

/**
 * Montants de taxes testables sur une pièce (TPS, TVQ, TPS+TVQ, taxes inscrites).
 * @param {Object} piece Pièce normalisée (facture ou bilan).
 * @return {Array<{libelle: string, cents: number}>} Candidats en cents.
 */
function rapprochementCandidatsTaxes_(piece) {
  const base = Math.abs(piece.cents);
  const tps = Math.round(base * CONFIG.TAUX_TPS);
  const tvq = Math.round(base * CONFIG.TAUX_TVQ);
  const candidats = [
    { libelle: 'la TPS (5 %)', cents: tps },
    { libelle: 'la TVQ (9,975 %)', cents: tvq },
    { libelle: 'la TPS + la TVQ (14,975 %)', cents: tps + tvq },
    { libelle: 'la part de taxes comprise dans le montant',
      cents: base - Math.round(base / (1 + CONFIG.TAUX_TPS + CONFIG.TAUX_TVQ)) },
  ];
  if (piece.genre === 'facture') {
    const inscrites = Math.abs(enCents_(piece.source[RAPPROCHEMENT_COL_.FACTURE_TAXES]));
    if (inscrites) candidats.push({ libelle: 'les taxes inscrites', cents: inscrites });
  }
  return candidats;
}

/**
 * Hypothèse 7 — le client a inversé le signe de son solde.
 * @param {Object} c Contexte complété.
 * @return {?Object} Résultat de diagnostic, ou null.
 */
function rapprochementHypSigneInverse_(c) {
  if (Math.abs(c.soldeTheoriqueCents + c.soldeDeclareCents) > c.toleranceCents) return null;
  return rapprochementResultat_(VERDICT.EXPLIQUE, 'Le solde déclaré est à l\'envers.',
    `Son solde déclaré (${formaterMontant_(c.soldeDeclareCents, c.devise)}) est exactement ` +
    `l'opposé de votre solde théorique (${formaterMontant_(c.soldeTheoriqueCents, c.devise)}) : ` +
    'les deux comptabilités disent la même chose, avec des conventions de signe contraires.',
    'Si tous vos clients déclarent leur solde en négatif, passez le réglage ' +
    `SIGNE_SOLDE_CLIENT à « Inversé » dans l'onglet ${CONFIG.ONGLETS.PARAMETRES.nom}, ` +
    'puis relancez le rapprochement.');
}

/**
 * Hypothèse 8 — décalage de période : l'écart vaut le montant d'une pièce du
 * trimestre précédent ou suivant (date de coupure différente chez le client).
 * @param {Object} c Contexte complété.
 * @param {Object} atelier Pièces préparées.
 * @return {?Object} Résultat de diagnostic, ou null.
 */
function rapprochementHypDecalagePeriode_(c, atelier) {
  const absolu = Math.abs(c.ecartCents);
  const trouvee = atelier.voisines.filter((piece) =>
    piece.cents !== 0 && Math.abs(Math.abs(piece.cents) - absolu) <= c.toleranceCents)[0];
  if (!trouvee) return null;
  return rapprochementResultat_(VERDICT.EXPLIQUE, 'Décalage de période.',
    `${rapprochementSens_(c)} ${formaterMontant_(absolu, c.devise)}, soit exactement le ` +
    `montant ${rapprochementDe_(trouvee)}${rapprochementDecrire_(trouvee, c.devise)}, qui ` +
    `appartient au trimestre ${trouvee.periodeVoisine} et non à ${c.periode}.`,
    'Vérifiez la date de coupure de son relevé : la pièce a sans doute été comptée dans ' +
    'l\'autre trimestre. Aucune correction n\'est nécessaire si les deux trimestres se suivent.');
}

/**
 * Hypothèse 9 — aucune explication exacte : on l'écrit franchement, avec les
 * montants les plus proches pour orienter la vérification manuelle.
 * @param {Object} c Contexte complété.
 * @param {Object} atelier Pièces préparées.
 * @return {Object} Résultat de diagnostic.
 */
function rapprochementHypInexplique_(c, atelier) {
  const absolu = Math.abs(c.ecartCents);
  const candidats = atelier.facturesPeriode
    .concat(atelier.paiementsPeriode)
    .concat(atelier.voisines)
    .filter((piece) => piece.cents !== 0)
    .sort((a, b) => Math.abs(Math.abs(a.cents) - absolu) - Math.abs(Math.abs(b.cents) - absolu))
    .slice(0, Math.max(1, Number(CONFIG.CANDIDATS_INEXPLIQUE) || 3));
  const proches = candidats.map((piece) => `${rapprochementDecrire_(piece, c.devise)} ` +
    `(à ${formaterMontant_(Math.abs(Math.abs(piece.cents) - absolu), c.devise)} près)`);
  const detail = `${rapprochementSens_(c)} ${formaterMontant_(absolu, c.devise)}. ` +
    'Aucune combinaison exacte de vos factures ou de vos paiements n\'explique ce montant. ' +
    (proches.length
      ? `Montants les plus proches : ${rapprochementJoindre_(proches)}.`
      : 'Aucune pièce n\'est enregistrée pour ce client sur le trimestre.');
  return rapprochementResultat_(VERDICT.INEXPLIQUE, 'Écart inexpliqué.', detail,
    `Demandez-lui le détail de son relevé pour ${c.periode} et comparez-le ligne par ligne ` +
    `avec les onglets ${CONFIG.ONGLETS.FACTURES.nom} et ${CONFIG.ONGLETS.PAIEMENTS.nom}.`);
}

/**
 * Cas 0 — tout concorde.
 * @param {Object} c Contexte complété.
 * @return {Object} Résultat de diagnostic.
 */
function rapprochementBalance_(c) {
  return rapprochementResultat_(VERDICT.BALANCE, 'Tout concorde.',
    `Votre solde théorique (${formaterMontant_(c.soldeTheoriqueCents, c.devise)}) et le solde ` +
    `déclaré par le client (${formaterMontant_(c.soldeDeclareCents, c.devise)}) sont ` +
    'identiques : tous vos paiements du trimestre ont bien été déduits.',
    'Rien à faire.');
}

/**
 * Cas « ❓ » — le client n'a pas envoyé son solde : on le dit sans dramatiser.
 * @param {Object} c Contexte complété.
 * @return {Object} Résultat de diagnostic.
 */
function rapprochementNonDeclare_(c) {
  return rapprochementResultat_(VERDICT.NON_DECLARE,
    'Ce client ne vous a pas communiqué son solde pour ce trimestre.',
    `D'après vos livres, vous lui devez ${formaterMontant_(c.soldeTheoriqueCents, c.devise)} ` +
    `à la fin de ${c.periode}. Aucune ligne pour ce trimestre dans l'onglet ` +
    `${CONFIG.ONGLETS.SOLDES_DECLARES.nom} : impossible de comparer.`,
    `Demandez-lui son état de compte, recopiez le montant dans l'onglet ` +
    `${CONFIG.ONGLETS.SOLDES_DECLARES.nom} (Période ${c.periode}), puis relancez le ` +
    'rapprochement.');
}

/**
 * Fabrique un résultat de diagnostic complet.
 * @param {string} verdict Une valeur de VERDICT.
 * @param {string} diagnostic Cause, en une phrase.
 * @param {string} detail Explication nommant les pièces, utilisable telle quelle
 *     dans un courriel au client.
 * @param {string} action Ce que Grégory doit faire ensuite, en une phrase.
 * @return {Object} Résultat de diagnostic.
 */
function rapprochementResultat_(verdict, diagnostic, detail, action) {
  return {
    verdict: verdict,
    diagnostic: diagnostic,
    detail: detail,
    action: action,
    paiementsNonDeduits: [],
    sourcesNonDeduites: [],
    piecesSansDate: 0,
  };
}

/**
 * Phrase d'ouverture d'une explication : de quel côté penche l'écart.
 * @param {Object} c Contexte complété.
 * @return {string} « Son solde est plus bas/haut que le vôtre de ».
 */
function rapprochementSens_(c) {
  return c.ecartCents > 0
    ? 'Son solde est plus bas que le vôtre de'
    : 'Son solde est plus élevé que le vôtre de';
}

// ---------------------------------------------------------------------------
// Pièces : une représentation unique pour les factures, paiements et bilans
// ---------------------------------------------------------------------------

/**
 * Normalise une facture en « pièce » comparable.
 * @param {Object} facture Ligne de l'onglet Factures.
 * @return {Object} Pièce {genre, id, numero, date, cents, source}.
 */
function rapprochementPieceFacture_(facture) {
  return {
    genre: 'facture',
    id: rapprochementTexte_(facture[RAPPROCHEMENT_COL_.FACTURE_ID]),
    numero: rapprochementTexte_(facture[RAPPROCHEMENT_COL_.FACTURE_NUMERO]),
    date: rapprochementDateFacture_(facture),
    cents: enCents_(facture[RAPPROCHEMENT_COL_.FACTURE_TOTAL]),
    source: facture,
  };
}

/**
 * Normalise un paiement en « pièce » comparable.
 * @param {Object} paiement Ligne de l'onglet Paiements.
 * @return {Object} Pièce {genre, id, reference, date, cents, source}.
 */
function rapprochementPiecePaiement_(paiement) {
  return {
    genre: 'paiement',
    id: rapprochementTexte_(paiement[RAPPROCHEMENT_COL_.PAIEMENT_ID]),
    reference: rapprochementTexte_(paiement[RAPPROCHEMENT_COL_.PAIEMENT_REFERENCE]),
    date: rapprochementDatePaiement_(paiement),
    cents: enCents_(paiement[RAPPROCHEMENT_COL_.PAIEMENT_MONTANT]),
    source: paiement,
  };
}

/**
 * Normalise un bilan en « pièce » comparable.
 * @param {Object} bilan Ligne de l'onglet Bilans.
 * @return {Object} Pièce {genre, id, date, cents, source}.
 */
function rapprochementPieceBilan_(bilan) {
  return {
    genre: 'bilan',
    id: rapprochementTexte_(bilan[RAPPROCHEMENT_COL_.BILAN_ID]),
    numero: '',
    date: rapprochementDebutDuMois_(bilan[RAPPROCHEMENT_COL_.BILAN_PERIODE]),
    cents: enCents_(bilan[RAPPROCHEMENT_COL_.BILAN_MONTANT]),
    source: bilan,
  };
}

/**
 * Ne garde que les pièces dont la date tombe dans le trimestre.
 *
 * Une pièce SANS DATE compte dans le solde théorique (§4.2) : elle est donc
 * rattachée au trimestre traité (§4.4, « Pièces sans date ») pour que les
 * hypothèses puissent la nommer. Ce rattachement ne vaut que pour le trimestre
 * examiné : les trimestres voisins (hypothèse 8) ne l'appliquent pas, sans quoi
 * la même pièce appartiendrait à trois trimestres à la fois.
 *
 * @param {Array<Object>} pieces Pièces normalisées.
 * @param {?Object} bornes {debut, fin} du trimestre.
 * @param {boolean} [inclureSansDate] Vrai pour le trimestre traité.
 * @return {Array<Object>} Pièces du trimestre.
 */
function rapprochementPiecesPeriode_(pieces, bornes, inclureSansDate) {
  if (!bornes) return [];
  const debut = bornes.debut.getTime();
  const fin = bornes.fin.getTime();
  return (pieces || []).filter((piece) => {
    if (!piece.date) return inclureSansDate === true;
    return piece.date.getTime() >= debut && piece.date.getTime() <= fin;
  });
}

/**
 * Pièces (factures et paiements) d'un client dont la date est vide ou illisible.
 * Elles comptent dans le solde théorique : le rapport doit les nommer, sinon
 * l'écart qu'elles créent serait déclaré inexpliqué alors que sa cause est dans
 * le classeur (§4.4).
 * @param {Object} c Contexte complété.
 * @return {Array<Object>} Pièces sans date, factures d'abord.
 */
function rapprochementPiecesSansDate_(c) {
  const sansDate = (piece) => !piece.date;
  // Seules les factures reconnues sont annoncées : la phrase dit « ces pièces
  // comptent dans votre solde », ce qui serait faux d'une facture Rejetée ou
  // Doublon — et enverrait Grégory compléter la date d'une facture qu'il a
  // lui-même écartée, avec un avertissement qui ne disparaîtrait jamais.
  return c.factures.map(rapprochementPieceFacture_)
    .filter((piece) => sansDate(piece) && rapprochementFactureReconnue_(piece.source))
    .concat(c.paiements.map(rapprochementPiecePaiement_).filter(sansDate));
}

/**
 * Phrase qui nomme les lignes du classeur dont la date manque.
 * Exemple : « 2 pièce(s) sans date : lignes 14 et 27 de l'onglet Paiements —
 * complétez la colonne Date. »
 * @param {Object} c Contexte complété.
 * @return {string} Phrase à ajouter au « Détail », ou chaîne vide.
 */
function rapprochementPhraseSansDate_(c) {
  const pieces = rapprochementPiecesSansDate_(c);
  if (!pieces.length) return '';
  const groupes = [
    { onglet: CONFIG.ONGLETS.FACTURES.nom, genre: 'facture' },
    { onglet: CONFIG.ONGLETS.PAIEMENTS.nom, genre: 'paiement' },
  ].map((groupe) => rapprochementGroupeSansDate_(
    pieces.filter((piece) => piece.genre === groupe.genre), groupe.onglet))
    .filter((texte) => texte !== '');
  return `${pieces.length} pièce(s) sans date : ${groupes.join(' ; ')} — complétez la ` +
    'colonne Date : ces pièces comptent dans votre solde mais ne peuvent pas être rattachées ' +
    'à un trimestre.';
}

/**
 * Désigne les pièces sans date d'un onglet : « lignes 14 et 27 de l'onglet
 * Paiements ». Une pièce lue hors du classeur (tests) est nommée par son
 * identifiant, faute de numéro de ligne.
 * @param {Array<Object>} pieces Pièces sans date de cet onglet.
 * @param {string} onglet Nom de l'onglet.
 * @return {string} Désignation lisible, ou chaîne vide.
 */
function rapprochementGroupeSansDate_(pieces, onglet) {
  if (!pieces.length) return '';
  const numeros = [];
  const nommees = [];
  pieces.forEach((piece) => {
    const numero = piece.source ? piece.source._ligne : null;
    if (numero) numeros.push(String(numero));
    else nommees.push(piece.id || '(sans identifiant)');
  });
  const morceaux = [];
  if (numeros.length) {
    morceaux.push(`${numeros.length > 1 ? 'lignes' : 'ligne'} ${rapprochementEnumererEt_(numeros)}`);
  }
  if (nommees.length) morceaux.push(rapprochementEnumererEt_(nommees));
  return `${morceaux.join(', ')} de l'onglet ${onglet}`;
}

/**
 * Énumère des textes avec « et » avant le dernier.
 * @param {Array<string>} textes Textes à énumérer.
 * @return {string} Énumération lisible.
 */
function rapprochementEnumererEt_(textes) {
  if (textes.length <= 1) return textes.join('');
  return `${textes.slice(0, -1).join(', ')} et ${textes[textes.length - 1]}`;
}

/**
 * Pièces des trimestres immédiatement précédent et suivant (hypothèse 8).
 * Chaque pièce retenue porte en plus le nom du trimestre voisin où elle tombe.
 * @param {Object} c Contexte complété.
 * @param {Array<Object>} pieces Toutes les pièces du client.
 * @return {Array<Object>} Pièces des trimestres voisins.
 */
function rapprochementPiecesVoisines_(c, pieces) {
  if (!c.periode) return [];
  const voisines = [];
  [-1, 1].forEach((pas) => {
    const periode = rapprochementPeriodeVoisine_(c.periode, pas);
    const bornes = bornesTrimestre_(periode, c.decalageMois);
    rapprochementPiecesPeriode_(pieces, bornes).forEach((piece) => {
      const copie = {};
      Object.keys(piece).forEach((cle) => { copie[cle] = piece[cle]; });
      copie.periodeVoisine = periode;
      voisines.push(copie);
    });
  });
  return voisines;
}

/**
 * Décrit une pièce en toutes lettres, prêt à recopier dans un courriel :
 * « paiement P-000042 du 2026-05-12 de 1 250,00 $, référence VIR-8891 ».
 * @param {Object} piece Pièce normalisée.
 * @param {string} devise Code de devise.
 * @return {string} Description lisible.
 */
function rapprochementDecrire_(piece, devise) {
  let phrase = `${piece.genre} ${piece.id || '(sans identifiant)'}`;
  if (piece.numero) phrase += ` (n° ${piece.numero})`;
  const date = formaterDate_(piece.date);
  if (date) phrase += ` du ${date}`;
  phrase += ` de ${formaterMontant_(piece.cents, devise)}`;
  if (piece.reference) phrase += `, référence ${piece.reference}`;
  return phrase;
}

/**
 * Article contracté à placer devant la description d'une pièce, pour que les
 * phrases restent du français correct : « de la facture… », « du paiement… ».
 * @param {Object} piece Pièce normalisée.
 * @return {string} 'de la ' ou 'du ', espace compris.
 */
function rapprochementDe_(piece) {
  return piece && piece.genre === 'facture' ? 'de la ' : 'du ';
}

/**
 * Énumère des pièces dans une phrase, en s'arrêtant avant de devenir illisible.
 * @param {Array<Object>} pieces Pièces à nommer.
 * @param {string} devise Code de devise.
 * @return {string} Énumération lisible.
 */
function rapprochementEnumerer_(pieces, devise) {
  return rapprochementJoindre_(pieces.map((piece) => rapprochementDecrire_(piece, devise)));
}

/**
 * Assemble des morceaux de phrase, en résumant au-delà du seuil lisible.
 * @param {Array<string>} textes Morceaux à assembler.
 * @return {string} Phrase assemblée.
 */
function rapprochementJoindre_(textes) {
  const liste = (textes || []).filter((texte) => texte !== '');
  if (liste.length <= RAPPROCHEMENT_MAX_PIECES_) return liste.join(' ; ');
  const gardes = liste.slice(0, RAPPROCHEMENT_MAX_PIECES_);
  return `${gardes.join(' ; ')} et ${liste.length - RAPPROCHEMENT_MAX_PIECES_} autre(s)`;
}

// ---------------------------------------------------------------------------
// §4.4 — Recherche de sous-ensemble (cents entiers, bornée, exacte)
// ---------------------------------------------------------------------------

/**
 * Cherche un sous-ensemble dont la somme vaut EXACTEMENT la cible (§4.4).
 *
 * Stratégie, dans cet ordre :
 *   1. la recherche exhaustive des combinaisons de 1, 2 puis 3 éléments a
 *      TOUJOURS lieu, quel que soit le nombre de pièces : ce sont les seules
 *      explications qu'un humain accepte de vérifier à la main, et ce sont les
 *      plus fréquentes (taille 1 en O(n), tailles 2 et 3 par table de hachage,
 *      la taille 3 étant plafonnée à CONFIG.SOUS_ENSEMBLE_MAX_TAILLE3 pièces) ;
 *   2. ensuite seulement, si la liste ne dépasse pas la borne demandée,
 *      programmation dynamique sur les cents, avec reconstruction de la
 *      solution, bornée par CONFIG.SOUS_ENSEMBLE_MAX_CIBLE.
 *
 * Jamais d'à-peu-près : sans correspondance exacte, la réponse est null.
 *
 * @param {Array<number>} montantsCents Montants en cents entiers (les valeurs
 *     négatives et les doublons sont acceptés).
 * @param {number} cibleCents Somme recherchée, en cents. Doit être > 0.
 * @param {number} [maxElements] Taille maximale de la liste ACCEPTÉE PAR LA
 *     PROGRAMMATION DYNAMIQUE ; CONFIG.SOUS_ENSEMBLE_MAX_ELEMENTS par défaut.
 *     Elle ne borne jamais la recherche exhaustive de 1, 2 ou 3 éléments.
 * @return {?Array<number>} Indices (croissants) des montants retenus, ou null.
 */
function trouverSousEnsemble_(montantsCents, cibleCents, maxElements) {
  if (!Array.isArray(montantsCents) || !montantsCents.length) return null;
  const cible = Math.round(Number(cibleCents));
  if (!isFinite(cible) || cible <= 0) return null;
  const montants = montantsCents.map((valeur) => {
    const entier = Math.round(Number(valeur));
    return isFinite(entier) ? entier : 0;
  });
  let totalPositif = 0;
  for (let i = 0; i < montants.length; i++) {
    if (montants[i] > 0) totalPositif += montants[i];
  }
  if (cible > totalPositif) return null;
  const petit = rapprochementSousEnsembleExhaustif_(montants, cible);
  if (petit) return petit;
  const plafond = (maxElements === null || maxElements === undefined || !isFinite(maxElements))
    ? Number(CONFIG.SOUS_ENSEMBLE_MAX_ELEMENTS)
    : Math.floor(Number(maxElements));
  if (!(plafond >= 1) || montants.length > plafond) return null;
  if (montants.length <= 3) return null;
  return rapprochementSousEnsembleDynamique_(montants, cible);
}

/**
 * Recherche exhaustive des combinaisons de 1, 2 puis 3 éléments. Elle a
 * toujours lieu, quelle que soit la taille de la liste (§4.4) : taille 1 en
 * O(n), taille 2 en O(n) par table de hachage, taille 3 en O(n²) par table de
 * hachage, plafonnée à CONFIG.SOUS_ENSEMBLE_MAX_TAILLE3 éléments.
 * @param {Array<number>} montants Montants en cents entiers.
 * @param {number} cible Somme recherchée.
 * @return {?Array<number>} Indices retenus (croissants), ou null.
 */
function rapprochementSousEnsembleExhaustif_(montants, cible) {
  const n = montants.length;
  for (let i = 0; i < n; i++) {
    if (montants[i] === cible) return [i];
  }
  const vus = new Map();
  for (let j = 0; j < n; j++) {
    const complement = cible - montants[j];
    if (vus.has(complement)) return [vus.get(complement), j];
    if (!vus.has(montants[j])) vus.set(montants[j], j);
  }
  const limite = Math.min(n, rapprochementPlafondTaille3_());
  for (let i = 0; i < limite; i++) {
    const restant = cible - montants[i];
    const paires = new Map();
    for (let k = i + 1; k < limite; k++) {
      const complement = restant - montants[k];
      if (paires.has(complement)) return [i, paires.get(complement), k];
      if (!paires.has(montants[k])) paires.set(montants[k], k);
    }
  }
  return null;
}

/**
 * Nombre maximal de pièces examinées par la recherche de taille 3 (O(n²)).
 * @return {number} Plafond, au moins 3.
 */
function rapprochementPlafondTaille3_() {
  const brut = Math.floor(Number(CONFIG.SOUS_ENSEMBLE_MAX_TAILLE3));
  return isFinite(brut) && brut >= 3 ? brut : 3;
}

/**
 * Programmation dynamique sur les cents, avec reconstruction de la solution.
 * Seuls les montants strictement positifs y participent : un sous-ensemble
 * trouvé reste donc un sous-ensemble exact de la liste d'origine, et la mémoire
 * reste bornée. Abandonne proprement (null) si les bornes sont dépassées.
 * @param {Array<number>} montants Montants en cents entiers.
 * @param {number} cible Somme recherchée (> 0).
 * @return {?Array<number>} Indices retenus, ou null.
 */
function rapprochementSousEnsembleDynamique_(montants, cible) {
  if (cible > Number(CONFIG.SOUS_ENSEMBLE_MAX_CIBLE)) return null;
  const positifs = [];
  let total = 0;
  for (let i = 0; i < montants.length; i++) {
    if (montants[i] > 0) { positifs.push(i); total += montants[i]; }
  }
  if (positifs.length < 4 || total < cible) return null;
  const atteint = new Int32Array(cible + 1).fill(-1);
  atteint[0] = -2; // marqueur de départ : la somme nulle est toujours atteignable
  for (let p = 0; p < positifs.length; p++) {
    const indice = positifs[p];
    const montant = montants[indice];
    for (let somme = cible; somme >= montant; somme--) {
      if (atteint[somme] === -1 && atteint[somme - montant] !== -1) atteint[somme] = indice;
    }
    if (atteint[cible] !== -1) break;
  }
  return rapprochementReconstruire_(atteint, montants, cible);
}

/**
 * Remonte le tableau de programmation dynamique jusqu'à la somme nulle.
 * @param {Int32Array} atteint Indice du montant utilisé pour atteindre chaque somme.
 * @param {Array<number>} montants Montants en cents entiers.
 * @param {number} cible Somme recherchée.
 * @return {?Array<number>} Indices retenus (croissants), ou null.
 */
function rapprochementReconstruire_(atteint, montants, cible) {
  if (atteint[cible] === -1) return null;
  const indices = [];
  let somme = cible;
  let garde = 0;
  while (somme > 0 && garde <= montants.length) {
    const indice = atteint[somme];
    if (indice < 0) return null;
    indices.push(indice);
    somme -= montants[indice];
    garde++;
  }
  if (somme !== 0 || !indices.length) return null;
  return indices.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Trimestres et soldes — fonctions pures, très testées (bords, T4, décalage)
// ---------------------------------------------------------------------------

/**
 * Trimestre auquel appartient une date, au format 'AAAA-TN'.
 *
 * Avec un décalage d'exercice, l'exercice porte l'année de son PREMIER
 * trimestre : si les trimestres commencent en avril (décalage 3), le 15 février
 * 2026 appartient à '2025-T4' (exercice avril 2025 → mars 2026).
 *
 * @param {*} date Date, ou toute valeur convertible par versDate_.
 * @param {number} [decalageMois] Valeur du réglage TRIMESTRE_DECALAGE_MOIS
 *     (0 = trimestres civils). Passé explicitement pour rester pur.
 * @return {string} Trimestre 'AAAA-TN', ou '' si la date est illisible.
 */
function periodeTrimestre_(date, decalageMois) {
  const reference = versDate_(date);
  if (!reference) return '';
  const decalage = rapprochementDecalage_(decalageMois);
  const mois = reference.getMonth() + 1;
  const rang = (((mois - 1 - decalage) % 12) + 12) % 12;
  const trimestre = Math.floor(rang / 3) + 1;
  const annee = reference.getFullYear() - (mois <= decalage ? 1 : 0);
  return `${annee}-T${trimestre}`;
}

/**
 * Bornes d'un trimestre : premier instant du premier jour, dernier instant du
 * dernier jour (années bissextiles et fins de mois comprises).
 * @param {string} periode Trimestre 'AAAA-TN'.
 * @param {number} [decalageMois] Valeur du réglage TRIMESTRE_DECALAGE_MOIS.
 * @return {?{debut: Date, fin: Date}} Bornes, ou null si le format est invalide.
 */
function bornesTrimestre_(periode, decalageMois) {
  const canonique = rapprochementPeriodeValide_(periode);
  if (!canonique) return null;
  const annee = Number(canonique.slice(0, 4));
  const trimestre = Number(canonique.slice(6, 7));
  const decalage = rapprochementDecalage_(decalageMois);
  const premier = decalage + (trimestre - 1) * 3;
  const suivant = premier + 3;
  return {
    debut: new Date(annee + Math.floor(premier / 12), premier % 12, 1, 0, 0, 0, 0),
    fin: new Date(annee + Math.floor(suivant / 12), suivant % 12, 0, 23, 59, 59, 999),
  };
}

/**
 * Trimestre voisin d'un trimestre donné.
 * @param {string} periode Trimestre 'AAAA-TN'.
 * @param {number} pas Nombre de trimestres à ajouter (−1 = le précédent).
 * @return {string} Trimestre voisin, ou '' si le format est invalide.
 */
function rapprochementPeriodeVoisine_(periode, pas) {
  const canonique = rapprochementPeriodeValide_(periode);
  if (!canonique) return '';
  const annee = Number(canonique.slice(0, 4));
  const rang = Number(canonique.slice(6, 7)) - 1 + Math.round(Number(pas) || 0);
  return `${annee + Math.floor(rang / 4)}-T${(((rang % 4) + 4) % 4) + 1}`;
}

/**
 * Valide et met au format canonique un trimestre ('2026-t2' → '2026-T2').
 * @param {*} periode Trimestre, sous n'importe quelle casse.
 * @return {string} Trimestre canonique, ou '' si le format est invalide.
 */
function rapprochementPeriodeValide_(periode) {
  const trouve = /^(\d{4})\s*-?\s*T\s*([1-4])$/i.exec(rapprochementTexte_(periode));
  return trouve ? `${trouve[1]}-T${trouve[2]}` : '';
}

/**
 * Normalise le décalage d'exercice sur 0 à 11 mois.
 * @param {*} valeur Valeur brute du réglage.
 * @return {number} Décalage entre 0 et 11.
 */
function rapprochementDecalage_(valeur) {
  const brut = Math.round(Number(valeur));
  return isFinite(brut) ? (((brut % 12) + 12) % 12) : 0;
}

/**
 * Lit un solde déclaré et le ramène à la convention du classeur (§4.1) :
 * positif = vous devez encore de l'argent au client.
 * Accepte 1234.56, '1 234,56 $' et '(1 234,56)' (négatif comptable).
 * @param {*} valeur Solde tel que saisi dans Soldes_declares.
 * @param {Object} params Réglages ; SIGNE_SOLDE_CLIENT = 'Inversé' multiplie par −1.
 * @return {number} Solde en cents entiers.
 */
function normaliserSolde_(valeur, params) {
  const cents = enCents_(valeur);
  const reglage = texteNormalise_(params ? params.SIGNE_SOLDE_CLIENT : '');
  const inverse = reglage === 'INVERSE' || reglage === 'INVERSEE' || reglage === 'NEGATIF';
  const solde = inverse ? -cents : cents;
  return solde === 0 ? 0 : solde;
}

// ---------------------------------------------------------------------------
// Résumé lisible et petits utilitaires
// ---------------------------------------------------------------------------

/**
 * Rédige le résumé affiché à l'utilisateur à la fin du rapprochement.
 * @param {Object} resultat Ce que renvoie rapprocherPeriode_().
 * @param {string} relance Phrase sur les relances automatiques (peut être vide).
 * @return {string} Résumé en français clair.
 */
function rapprochementResume_(resultat, relance) {
  const periode = resultat.periode;
  const cadre = resultat.debut
    ? ` (du ${formaterDate_(resultat.debut)} au ${formaterDate_(resultat.fin)})`
    : '';
  const lignes = [`Trimestre ${periode}${cadre} — ${resultat.total} client(s) examiné(s).`, ''];
  [VERDICT.BALANCE, VERDICT.EXPLIQUE, VERDICT.INEXPLIQUE, VERDICT.NON_DECLARE]
    .forEach((verdict) => {
      const nombre = rapprochementCompteur_(resultat, verdict);
      if (nombre) lignes.push(`• ${verdict} : ${nombre}`);
    });
  if (resultat.inexpliques.length) {
    lignes.push('');
    lignes.push('Les plus gros écarts inexpliqués :');
    resultat.inexpliques.forEach((ecart) => {
      lignes.push(`• ${ecart.nom || ecart.id} (${ecart.id}) : ${ecart.montant}`);
    });
  }
  if (resultat.piecesSansDate) {
    lignes.push('');
    lignes.push(`${resultat.piecesSansDate} pièce(s) sans date comptée(s) dans le solde de ` +
      `${resultat.clientsSansDate.join(', ')} : complétez la colonne Date des onglets ` +
      `${CONFIG.ONGLETS.FACTURES.nom} et ${CONFIG.ONGLETS.PAIEMENTS.nom}. La colonne ` +
      '« Détail » du rapport nomme les lignes concernées.');
  }
  if (resultat.paiementsConfirmes || resultat.paiementsRefuses) {
    lignes.push('');
    lignes.push(`${resultat.paiementsConfirmes} paiement(s) confirmé(s) comme déduits, ` +
      `${resultat.paiementsRefuses} marqué(s) « ${RAPPROCHEMENT_DEDUIT_.NON} » dans l'onglet ` +
      `${CONFIG.ONGLETS.PAIEMENTS.nom}.`);
  }
  lignes.push('');
  lignes.push(`Ouvrez l'onglet ${CONFIG.ONGLETS.RAPPROCHEMENT.nom} : la colonne ` +
    '« Action suggérée » vous dit quoi faire, client par client. Étape suivante : ' +
    '« 8. Relancer les clients en écart ».');
  if (relance) { lignes.push(''); lignes.push(relance); }
  resultat.messages.forEach((message) => { lignes.push(''); lignes.push(message); });
  return lignes.join('\n');
}

/**
 * Nombre de clients ayant reçu un verdict donné.
 * @param {Object} resultat Ce que renvoie rapprocherPeriode_().
 * @param {string} verdict Une valeur de VERDICT.
 * @return {number} Nombre de clients.
 */
function rapprochementCompteur_(resultat, verdict) {
  return Number(resultat.compteurs[verdict]) || 0;
}

/**
 * Détail des compteurs, pour le Journal.
 * @param {Object} resultat Ce que renvoie rapprocherPeriode_().
 * @return {string} Une ligne par verdict.
 */
function rapprochementDetailCompteurs_(resultat) {
  return Object.keys(resultat.compteurs)
    .map((verdict) => `${verdict} : ${resultat.compteurs[verdict]}`)
    .join(' | ');
}

/**
 * Clé de comparaison d'un identifiant de client (« C-001 » = « c 001 »).
 * @param {*} valeur Identifiant brut.
 * @return {string} Clé normalisée, ou '' si vide.
 */
function rapprochementCle_(valeur) {
  return texteNormalise_(valeur);
}

/**
 * Convertit une cellule en texte simple, sans null ni undefined.
 * @param {*} valeur Valeur brute.
 * @return {string} Texte nettoyé.
 */
function rapprochementTexte_(valeur) {
  if (valeur === null || valeur === undefined) return '';
  if (valeur instanceof Date) return formaterDate_(valeur);
  return String(valeur).trim();
}
