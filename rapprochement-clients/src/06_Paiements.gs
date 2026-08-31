/**
 * 06_Paiements.gs — Le lot de paiements : préparer, confirmer, annuler.
 *
 * Le script ne paie JAMAIS tout seul. Il prépare la liste des factures à régler,
 * dépose un fichier CSV dans votre Drive pour que vous fassiez vos virements
 * depuis votre banque, puis enregistre les paiements une fois que vous confirmez
 * les avoir faits. Ce sont ces paiements qui servent, chaque trimestre, à vérifier
 * que le client a bien tout déduit.
 *
 * Un seul lot à la fois : tant qu'un lot est en cours (des factures « À payer »
 * ni confirmées ni annulées), un deuxième lot est refusé. C'est ce qui empêche de
 * payer deux fois la même facture.
 */

// ---------------------------------------------------------------------------
// Colonnes et constantes du module
// ---------------------------------------------------------------------------

/** Noms de colonnes utilisés ici, toujours lus dans CONFIG (jamais codés en dur). */
const PAIEMENTS_COL_ = {
  FACTURE_ID: CONFIG.ONGLETS.FACTURES.colonnes[0].nom,            // ID facture
  FACTURE_CLIENT: CONFIG.ONGLETS.FACTURES.colonnes[1].nom,        // ID client
  FACTURE_NOM: CONFIG.ONGLETS.FACTURES.colonnes[2].nom,           // Nom client
  FACTURE_NUMERO: CONFIG.ONGLETS.FACTURES.colonnes[3].nom,        // N° facture client
  FACTURE_DATE: CONFIG.ONGLETS.FACTURES.colonnes[4].nom,          // Date facture
  FACTURE_TOTAL: CONFIG.ONGLETS.FACTURES.colonnes[8].nom,         // Montant total
  FACTURE_BILAN: CONFIG.ONGLETS.FACTURES.colonnes[9].nom,         // ID bilan
  FACTURE_VERIFICATION: CONFIG.ONGLETS.FACTURES.colonnes[10].nom, // Statut vérification
  FACTURE_PAIEMENT: CONFIG.ONGLETS.FACTURES.colonnes[12].nom,     // Statut paiement

  PAIEMENT_ID: CONFIG.ONGLETS.PAIEMENTS.colonnes[0].nom,          // ID paiement
  PAIEMENT_CLIENT: CONFIG.ONGLETS.PAIEMENTS.colonnes[1].nom,      // ID client
  PAIEMENT_NOM: CONFIG.ONGLETS.PAIEMENTS.colonnes[2].nom,         // Nom client
  PAIEMENT_FACTURE: CONFIG.ONGLETS.PAIEMENTS.colonnes[3].nom,     // ID facture
  PAIEMENT_DATE: CONFIG.ONGLETS.PAIEMENTS.colonnes[4].nom,        // Date paiement
  PAIEMENT_MONTANT: CONFIG.ONGLETS.PAIEMENTS.colonnes[5].nom,     // Montant
  PAIEMENT_METHODE: CONFIG.ONGLETS.PAIEMENTS.colonnes[6].nom,     // Méthode
  PAIEMENT_REFERENCE: CONFIG.ONGLETS.PAIEMENTS.colonnes[7].nom,   // Référence
  PAIEMENT_DEDUIT: CONFIG.ONGLETS.PAIEMENTS.colonnes[8].nom,      // Déduit par le client
  PAIEMENT_NOTES: CONFIG.ONGLETS.PAIEMENTS.colonnes[10].nom,      // Notes

  BILAN_ID: CONFIG.ONGLETS.BILANS.colonnes[0].nom,                // ID bilan
  BILAN_STATUT: CONFIG.ONGLETS.BILANS.colonnes[8].nom,            // Statut

  CLIENT_ID: CONFIG.ONGLETS.CLIENTS.colonnes[0].nom,              // ID client
  CLIENT_NOM: CONFIG.ONGLETS.CLIENTS.colonnes[1].nom,             // Nom
  CLIENT_DEVISE: CONFIG.ONGLETS.CLIENTS.colonnes[5].nom,          // Devise
};

/** Méthodes de paiement acceptées (celles de la validation de l'onglet Paiements). */
const PAIEMENTS_METHODES_ = CONFIG.ONGLETS.PAIEMENTS.colonnes[6].liste;

/** Méthode proposée par défaut dans l'invite : Virement. */
const PAIEMENTS_METHODE_DEFAUT_ = PAIEMENTS_METHODES_[0];

/** Valeur posée sur un paiement neuf : le client n'a encore rien déduit. */
const PAIEMENTS_DEDUIT_DEFAUT_ = CONFIG.ONGLETS.PAIEMENTS.colonnes[8].liste[0];

/** Tolérance, en jours, pour une date de paiement dans le futur. */
const PAIEMENTS_JOURS_FUTUR_MAX_ = 7;

/** Marque de codage UTF-8, sans laquelle Excel massacre les accents. */
const PAIEMENTS_BOM_ = '\uFEFF';

/** Fin de ligne du CSV : CRLF, c'est ce qu'attendent Excel et les banques. */
const PAIEMENTS_FIN_LIGNE_ = '\r\n';

/** Séparateur du CSV. */
const PAIEMENTS_SEPARATEUR_ = ',';

/** En-têtes du fichier CSV du lot, dans l'ordre. */
const PAIEMENTS_ENTETES_CSV_ = [
  PAIEMENTS_COL_.FACTURE_ID,
  PAIEMENTS_COL_.FACTURE_CLIENT,
  PAIEMENTS_COL_.FACTURE_NOM,
  PAIEMENTS_COL_.FACTURE_NUMERO,
  PAIEMENTS_COL_.FACTURE_DATE,
  PAIEMENTS_COL_.FACTURE_TOTAL,
  PAIEMENTS_COL_.CLIENT_DEVISE,
  'Référence suggérée',
];

// ---------------------------------------------------------------------------
// Petits utilitaires du module
// ---------------------------------------------------------------------------

/**
 * Réduit une valeur de cellule à un texte propre.
 * @param {*} valeur Valeur brute.
 * @return {string} Texte sans espaces au début ni à la fin.
 */
function paiementsTexte_(valeur) {
  if (valeur === null || valeur === undefined) return '';
  return String(valeur).trim();
}

/**
 * Compare deux statuts sans se soucier des accents, de la casse ni des espaces.
 * @param {*} valeur Statut lu dans la feuille.
 * @param {string} attendu Statut de référence (constante STATUT_*).
 * @return {boolean} Vrai si c'est le même statut.
 */
function paiementsMemeStatut_(valeur, attendu) {
  return texteNormalise_(valeur) === texteNormalise_(attendu);
}

/**
 * Filtre les factures sur leur statut de vérification et/ou de paiement.
 * @param {Array<Object>} factures Lignes de l'onglet Factures.
 * @param {string|null} statutVerification Statut attendu, ou null pour ne pas filtrer.
 * @param {string|null} statutPaiement Statut attendu, ou null pour ne pas filtrer.
 * @return {Array<Object>} Factures retenues.
 */
function paiementsFiltrerFactures_(factures, statutVerification, statutPaiement) {
  return (factures || []).filter((facture) => {
    if (statutVerification &&
        !paiementsMemeStatut_(facture[PAIEMENTS_COL_.FACTURE_VERIFICATION], statutVerification)) {
      return false;
    }
    if (statutPaiement &&
        !paiementsMemeStatut_(facture[PAIEMENTS_COL_.FACTURE_PAIEMENT], statutPaiement)) {
      return false;
    }
    return true;
  });
}

/**
 * Indexe les clients par ID. Accepte indifféremment la liste lue par lireTable_
 * ou une Map déjà construite.
 * @param {Array<Object>|Map<string, Object>} clients Clients.
 * @return {Map<string, Object>} ID client vers ligne client.
 */
function paiementsIndexClients_(clients) {
  if (clients instanceof Map) return clients;
  return indexerPar_(clients || [], PAIEMENTS_COL_.CLIENT_ID);
}

/**
 * Nom lisible du client : celui de la facture, sinon celui de la fiche client.
 * @param {Object} facture Ligne de l'onglet Factures.
 * @param {Object} [client] Ligne de l'onglet Clients.
 * @return {string} Nom du client, ou chaîne vide.
 */
function paiementsNomClient_(facture, client) {
  const surFacture = paiementsTexte_((facture || {})[PAIEMENTS_COL_.FACTURE_NOM]);
  if (surFacture) return surFacture;
  return paiementsTexte_((client || {})[PAIEMENTS_COL_.CLIENT_NOM]);
}

/**
 * Devise du classeur, quand la fiche client n'en précise aucune.
 * @return {string} Code de devise (CAD par défaut).
 */
function paiementsDeviseDefaut_() {
  try {
    return paiementsTexte_(lireParametres_().DEVISE) || CONFIG.PARAMETRES_DEFAUT.DEVISE;
  } catch (e) {
    journalAvert_('paiementsDeviseDefaut_',
      'Devise du classeur illisible : la devise par défaut est utilisée.', `${e.message}\n${e.stack}`);
    return CONFIG.PARAMETRES_DEFAUT.DEVISE;
  }
}

/**
 * Devise d'un client.
 * @param {Object} [client] Ligne de l'onglet Clients.
 * @return {string} Code de devise.
 */
function paiementsDevise_(client) {
  return paiementsTexte_((client || {})[PAIEMENTS_COL_.CLIENT_DEVISE]) || paiementsDeviseDefaut_();
}

/**
 * Additionne des montants en cents, devise par devise (un lot peut mélanger
 * plusieurs devises : on ne fabrique jamais un total qui n'aurait aucun sens).
 * @param {Array<Object>} lignes Lignes portant un client et un montant.
 * @param {Map<string, Object>} index Clients indexés par ID.
 * @param {string} colClient Nom de la colonne d'ID client.
 * @param {string} colMontant Nom de la colonne de montant.
 * @return {Map<string, number>} Devise vers total en cents.
 */
function paiementsTotauxParDevise_(lignes, index, colClient, colMontant) {
  const totaux = new Map();
  (lignes || []).forEach((ligne) => {
    const client = index ? index.get(paiementsTexte_(ligne[colClient])) : null;
    const devise = paiementsDevise_(client);
    totaux.set(devise, (totaux.get(devise) || 0) + enCents_(ligne[colMontant]));
  });
  return totaux;
}

/**
 * Met en forme les totaux d'un lot pour l'affichage.
 * @param {Map<string, number>} totaux Devise vers total en cents.
 * @return {string} Ex. « 12 340,00 $ » ou « 12 340,00 $ + 500,00 € ».
 */
function paiementsFormaterTotaux_(totaux) {
  const morceaux = [];
  if (totaux) totaux.forEach((cents, devise) => morceaux.push(formaterMontant_(cents, devise)));
  if (!morceaux.length) return formaterMontant_(0, paiementsDeviseDefaut_());
  return morceaux.join(' + ');
}

/**
 * Énumère quelques éléments d'une liste, sans noyer le lecteur.
 * @param {Array<string>} elements Éléments à citer.
 * @param {number} [maximum] Nombre d'éléments cités (5 par défaut).
 * @return {string} Ex. « F-000001, F-000002 et 3 autre(s) ».
 */
function paiementsListeCourte_(elements, maximum) {
  const liste = (elements || []).map((e) => paiementsTexte_(e)).filter((e) => e !== '');
  const limite = Math.max(1, Number(maximum) || 5);
  if (liste.length <= limite) return liste.join(', ');
  return `${liste.slice(0, limite).join(', ')} et ${liste.length - limite} autre(s)`;
}

/**
 * Construit un patch de statut de paiement pour une facture.
 * @param {string} statut Statut à poser (constante STATUT_PAIEMENT).
 * @return {Object} Patch prêt pour majLignes_.
 */
function paiementsPatchStatutFacture_(statut) {
  const patch = {};
  patch[PAIEMENTS_COL_.FACTURE_PAIEMENT] = statut;
  return patch;
}

// ---------------------------------------------------------------------------
// 5. Préparer le lot de paiements
// ---------------------------------------------------------------------------

/**
 * Prépare le lot : toutes les factures « Conforme » et « Non payée » passent à
 * « À payer » et sont exportées dans un fichier CSV déposé sur votre Drive.
 * Aucun argent n'est envoyé : c'est vous qui payez depuis votre banque.
 * @return {string} Résumé lisible, affiché par le menu.
 */
function preparerLotDePaiements() {
  const params = lireParametres_();
  const factures = lireTable_(CONFIG.ONGLETS.FACTURES.nom);
  const index = paiementsIndexClients_(lireTable_(CONFIG.ONGLETS.CLIENTS.nom));

  const enCours = paiementsFiltrerFactures_(factures, null, STATUT_PAIEMENT.A_PAYER);
  if (enCours.length) return paiementsMessageLotEnCours_(enCours, index);

  const aPayer = paiementsFiltrerFactures_(
    factures, STATUT_VERIF.CONFORME, STATUT_PAIEMENT.NON_PAYEE);
  if (!aPayer.length) return paiementsMessageRienAPreparer_();

  const contenu = construireCsvLot_(aPayer, index);
  let fichier = null;
  try {
    fichier = paiementsCreerFichierCsv_(contenu, params);
  } catch (e) {
    journalErreur_('preparerLotDePaiements',
      `Le fichier CSV du lot n'a pas pu être créé : ${e.message}`, `${e.message}\n${e.stack}`);
    return 'Le lot n\'a PAS été préparé : le fichier CSV n\'a pas pu être déposé dans votre ' +
      `Drive (dossier « ${paiementsTexte_(params.DOSSIER_DRIVE)} »). Aucun statut n'a changé, ` +
      `vous pouvez relancer sans risque.\n\nDétail technique : ${e.message}`;
  }

  const majs = aPayer.map((facture) => ({
    ligne: facture._ligne,
    patch: paiementsPatchStatutFacture_(STATUT_PAIEMENT.A_PAYER),
  }));
  majLignes_(CONFIG.ONGLETS.FACTURES.nom, majs);

  const totaux = paiementsTotauxParDevise_(
    aPayer, index, PAIEMENTS_COL_.FACTURE_CLIENT, PAIEMENTS_COL_.FACTURE_TOTAL);
  journalInfo_('preparerLotDePaiements',
    `${aPayer.length} facture(s) passée(s) à « ${STATUT_PAIEMENT.A_PAYER} », total ` +
    `${paiementsFormaterTotaux_(totaux)}.`,
    `Fichier ${fichier.nom} — ${fichier.url}`);
  return paiementsResumePreparation_(aPayer, totaux, fichier);
}

/**
 * Message affiché quand un lot est déjà en cours : on refuse d'en préparer un
 * deuxième, mais proprement, sans erreur technique.
 * @param {Array<Object>} enCours Factures encore au statut « À payer ».
 * @param {Map<string, Object>} index Clients indexés par ID.
 * @return {string} Explication et marche à suivre.
 */
function paiementsMessageLotEnCours_(enCours, index) {
  const totaux = paiementsTotauxParDevise_(
    enCours, index, PAIEMENTS_COL_.FACTURE_CLIENT, PAIEMENTS_COL_.FACTURE_TOTAL);
  const ids = enCours.map((facture) => paiementsTexte_(facture[PAIEMENTS_COL_.FACTURE_ID]));
  journalAvert_('preparerLotDePaiements',
    `Préparation refusée : ${enCours.length} facture(s) sont encore « ${STATUT_PAIEMENT.A_PAYER} ».`,
    paiementsListeCourte_(ids, 20));
  return [
    `Un lot de paiements est déjà en cours : ${enCours.length} facture(s) sont au statut ` +
      `« ${STATUT_PAIEMENT.A_PAYER} », pour ${paiementsFormaterTotaux_(totaux)}.`,
    '',
    `Factures concernées : ${paiementsListeCourte_(ids)}.`,
    '',
    'Aucun nouveau lot ne peut être préparé tant que celui-là n\'est pas réglé. Deux choix :',
    `• vous avez fait les virements → lancez « 6. Confirmer les paiements du lot » ;`,
    `• vous ne les avez pas faits → annulez le lot (fonction annulerLot), les factures ` +
      `reviendront à « ${STATUT_PAIEMENT.NON_PAYEE} ».`,
    '',
    'Rien n\'a été modifié, aucun fichier n\'a été créé.',
  ].join('\n');
}

/**
 * Message affiché quand il n'y a tout simplement rien à payer.
 * @return {string} Explication et marche à suivre.
 */
function paiementsMessageRienAPreparer_() {
  return [
    `Aucune facture à payer pour le moment : il n'y en a aucune qui soit à la fois ` +
      `« ${STATUT_VERIF.CONFORME} » et « ${STATUT_PAIEMENT.NON_PAYEE} ».`,
    '',
    'À vérifier dans l\'onglet ' + CONFIG.ONGLETS.FACTURES.nom + ' :',
    `• la colonne « ${PAIEMENTS_COL_.FACTURE_VERIFICATION} » doit être à ` +
      `« ${STATUT_VERIF.CONFORME} » (lancez « 4. Vérifier les factures ») ;`,
    `• la colonne « ${PAIEMENTS_COL_.FACTURE_PAIEMENT} » doit être à ` +
      `« ${STATUT_PAIEMENT.NON_PAYEE} » et non vide.`,
    '',
    'Rien n\'a été modifié.',
  ].join('\n');
}

/**
 * Rédige le résumé de la préparation du lot.
 * @param {Array<Object>} factures Factures du lot.
 * @param {Map<string, number>} totaux Totaux par devise, en cents.
 * @param {{nom: string, url: string, dossier: string}} fichier Fichier CSV créé.
 * @return {string} Texte affiché dans l'alerte du menu.
 */
function paiementsResumePreparation_(factures, totaux, fichier) {
  return [
    `Lot préparé : ${factures.length} facture(s) à payer, pour un total de ` +
      `${paiementsFormaterTotaux_(totaux)}.`,
    '',
    `Ces factures sont passées au statut « ${STATUT_PAIEMENT.A_PAYER} ».`,
    '',
    `Votre fichier est dans le dossier Drive « ${fichier.dossier} » :`,
    fichier.nom,
    fichier.url,
    '',
    'Marche à suivre :',
    '1. ouvrez le fichier et faites vos virements depuis votre banque ;',
    '2. revenez ici et lancez « 6. Confirmer les paiements du lot ».',
    '',
    'Tant que ce lot n\'est ni confirmé ni annulé, aucun autre lot ne peut être préparé.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Le fichier CSV
// ---------------------------------------------------------------------------

/**
 * Construit le contenu du fichier CSV du lot : UTF-8 avec BOM (sinon Excel
 * massacre les accents), séparateur virgule, fins de ligne CRLF, guillemets et
 * virgules échappés selon la norme RFC 4180. Les montants sont écrits en chiffres
 * bruts (1234.56), sans séparateur de milliers, pour rester lisibles par un
 * logiciel bancaire.
 * @param {Array<Object>} factures Factures du lot (lignes de l'onglet Factures).
 * @param {Array<Object>|Map<string, Object>} clients Clients, pour le nom et la devise.
 * @return {string} Contenu complet du fichier.
 */
function construireCsvLot_(factures, clients) {
  const index = paiementsIndexClients_(clients);
  const lignes = [PAIEMENTS_ENTETES_CSV_
    .map((entete) => paiementsEchapperCsv_(entete))
    .join(PAIEMENTS_SEPARATEUR_)];

  (factures || []).forEach((facture) => {
    const client = index.get(paiementsTexte_(facture[PAIEMENTS_COL_.FACTURE_CLIENT])) || null;
    const champs = [
      paiementsTexte_(facture[PAIEMENTS_COL_.FACTURE_ID]),
      paiementsTexte_(facture[PAIEMENTS_COL_.FACTURE_CLIENT]),
      paiementsNomClient_(facture, client),
      paiementsTexte_(facture[PAIEMENTS_COL_.FACTURE_NUMERO]),
      formaterDate_(facture[PAIEMENTS_COL_.FACTURE_DATE]),
      paiementsMontantCsv_(enCents_(facture[PAIEMENTS_COL_.FACTURE_TOTAL])),
      paiementsDevise_(client),
      paiementsReferenceSuggeree_(facture),
    ];
    lignes.push(champs.map((champ) => paiementsEchapperCsv_(champ)).join(PAIEMENTS_SEPARATEUR_));
  });

  return PAIEMENTS_BOM_ + lignes.join(PAIEMENTS_FIN_LIGNE_) + PAIEMENTS_FIN_LIGNE_;
}

/**
 * Échappe un champ CSV : mis entre guillemets s'il contient un séparateur, un
 * guillemet ou un saut de ligne ; les guillemets internes sont doublés.
 * @param {*} valeur Contenu du champ.
 * @return {string} Champ prêt à écrire.
 */
function paiementsEchapperCsv_(valeur) {
  const texte = paiementsTexte_(valeur);
  if (!/[",;\r\n]/.test(texte)) return texte;
  return `"${texte.replace(/"/g, '""')}"`;
}

/**
 * Écrit un montant pour le CSV : chiffres bruts à deux décimales, point décimal,
 * sans espace ni symbole (c'est ce qu'attendent les logiciels bancaires).
 * @param {number} cents Montant en cents entiers.
 * @return {string} Ex. « 1234.56 ».
 */
function paiementsMontantCsv_(cents) {
  return (Math.round(Number(cents) || 0) / 100).toFixed(2);
}

/**
 * Référence à indiquer au client lors du virement, pour qu'il reconnaisse
 * immédiatement ce que vous payez.
 * @param {Object} facture Ligne de l'onglet Factures.
 * @return {string} Ex. « INV-2026-001 (F-000042) ».
 */
function paiementsReferenceSuggeree_(facture) {
  const numero = paiementsTexte_((facture || {})[PAIEMENTS_COL_.FACTURE_NUMERO]);
  const id = paiementsTexte_((facture || {})[PAIEMENTS_COL_.FACTURE_ID]);
  if (numero && id) return `${numero} (${id})`;
  return numero || id;
}

/**
 * Dépose le CSV dans le dossier Drive des factures et renvoie de quoi le
 * retrouver.
 * @param {string} contenu Contenu du fichier (déjà avec son BOM).
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {{nom: string, url: string, dossier: string}} Le fichier créé.
 */
function paiementsCreerFichierCsv_(contenu, params) {
  const dossier = paiementsDossierDrive_((params || {}).DOSSIER_DRIVE);
  const nom = `Lot-de-paiements-${paiementsHorodatageFichier_(new Date())}.csv`;
  const fichier = dossier.createFile(nom, contenu, 'text/csv');
  return { nom: nom, url: fichier.getUrl(), dossier: dossier.getName() };
}

/**
 * Retrouve (ou crée) le dossier Drive où sont déposés les fichiers.
 * @param {string} nom Nom du dossier, réglage DOSSIER_DRIVE.
 * @return {Folder} Le dossier, garanti existant.
 */
function paiementsDossierDrive_(nom) {
  const cible = paiementsTexte_(nom) || CONFIG.PARAMETRES_DEFAUT.DOSSIER_DRIVE;
  const existants = DriveApp.getFoldersByName(cible);
  while (existants.hasNext()) {
    const dossier = existants.next();
    if (typeof dossier.isTrashed === 'function' && dossier.isTrashed()) continue;
    return dossier;
  }
  journalInfo_('paiementsDossierDrive_', `Dossier Drive « ${cible} » créé.`);
  return DriveApp.createFolder(cible);
}

/**
 * Horodatage lisible pour le nom du fichier : « 2026-08-31_14h05 ».
 * @param {Date} date Date de référence.
 * @return {string} Horodatage.
 */
function paiementsHorodatageFichier_(date) {
  const valeur = versDate_(date) || new Date();
  const deux = (nombre) => (nombre < 10 ? `0${nombre}` : String(nombre));
  return `${valeur.getFullYear()}-${deux(valeur.getMonth() + 1)}-${deux(valeur.getDate())}` +
    `_${deux(valeur.getHours())}h${deux(valeur.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// 6. Confirmer les paiements du lot
// ---------------------------------------------------------------------------

/**
 * Enregistre les paiements du lot en cours : chaque facture « À payer » reçoit
 * une ligne dans l'onglet Paiements, passe à « Payée », et son bilan passe à
 * « Payé ». Une facture qui a déjà un paiement enregistré n'en reçoit jamais un
 * deuxième : elle est simplement signalée.
 *
 * Sans argument, les trois renseignements sont demandés dans des fenêtres.
 * Avec au moins un argument, rien n'est demandé : la fonction est alors
 * appelable par programme.
 *
 * @param {string} [reference] Référence commune du lot (n° de virement, de chèque…).
 *     Vide = la référence suggérée de chaque facture est utilisée.
 * @param {string|Date} [datePaiement] Date des paiements, au format AAAA-MM-JJ.
 *     Vide = aujourd'hui.
 * @param {string} [methode] Virement, Chèque, Interac ou Autre. Vide = Virement.
 * @return {string} Résumé lisible, affiché par le menu.
 */
function confirmerLotDePaiements(reference, datePaiement, methode) {
  const factures = paiementsFiltrerFactures_(
    lireTable_(CONFIG.ONGLETS.FACTURES.nom), null, STATUT_PAIEMENT.A_PAYER);
  if (!factures.length) {
    return `Aucune facture au statut « ${STATUT_PAIEMENT.A_PAYER} » : il n'y a pas de lot à ` +
      'confirmer. Lancez d\'abord « 5. Préparer le lot de paiements ». Rien n\'a été modifié.';
  }

  const saisie = paiementsSaisie_(reference, datePaiement, methode);
  if (saisie.message) {
    journalAvert_('confirmerLotDePaiements', 'Confirmation interrompue.', saisie.message);
    return saisie.message;
  }

  const contexte = paiementsNouveauContexte_(saisie, factures.length);
  paiementsPreparerEcritures_(contexte, factures);
  paiementsEcrireConfirmation_(contexte);
  paiementsJournaliserConfirmation_(contexte);
  return paiementsResumeConfirmation_(contexte);
}

/**
 * Prépare tout ce dont la confirmation a besoin, en une seule lecture par onglet.
 * @param {Object} saisie Référence, date et méthode validées.
 * @param {number} total Nombre de factures du lot.
 * @return {Object} Contexte de travail.
 */
function paiementsNouveauContexte_(saisie, total) {
  return {
    saisie: saisie,
    index: paiementsIndexClients_(lireTable_(CONFIG.ONGLETS.CLIENTS.nom)),
    dejaPayees: paiementsPaiementsParFacture_(lireTable_(CONFIG.ONGLETS.PAIEMENTS.nom)),
    bilans: indexerPar_(lireTable_(CONFIG.ONGLETS.BILANS.nom), PAIEMENTS_COL_.BILAN_ID),
    bilansTraites: new Set(),
    ajouts: [],
    majsFactures: [],
    majsBilans: [],
    resume: {
      total: total,
      crees: 0,
      doublons: [],
      sansIdentifiant: [],
      bilans: 0,
      bilansIntrouvables: [],
      totaux: new Map(),
    },
  };
}

/**
 * Recense les paiements déjà enregistrés, par facture. C'est le garde-fou qui
 * empêche de payer deux fois la même facture.
 * @param {Array<Object>} paiements Lignes de l'onglet Paiements.
 * @return {Map<string, Object>} ID facture normalisé vers le premier paiement trouvé.
 */
function paiementsPaiementsParFacture_(paiements) {
  const index = new Map();
  (paiements || []).forEach((paiement) => {
    const cle = texteNormalise_(paiement[PAIEMENTS_COL_.PAIEMENT_FACTURE]);
    if (!cle || index.has(cle)) return;
    index.set(cle, paiement);
  });
  return index;
}

/**
 * Parcourt les factures du lot et prépare, sans rien écrire, les lignes de
 * paiement et les mises à jour de statuts.
 * @param {Object} contexte Contexte de la confirmation.
 * @param {Array<Object>} factures Factures « À payer ».
 * @return {void}
 */
function paiementsPreparerEcritures_(contexte, factures) {
  const ids = paiementsSerieIds_(
    prochainId_(CONFIG.ONGLETS.PAIEMENTS.nom, PAIEMENTS_COL_.PAIEMENT_ID, 'P-', 6),
    factures.length);
  let rang = 0;

  factures.forEach((facture) => {
    const idFacture = paiementsTexte_(facture[PAIEMENTS_COL_.FACTURE_ID]);
    const cle = texteNormalise_(idFacture);
    const existant = cle ? contexte.dejaPayees.get(cle) : null;
    if (existant) {
      contexte.resume.doublons.push(`${idFacture} (déjà ` +
        `${paiementsTexte_(existant[PAIEMENTS_COL_.PAIEMENT_ID])})`);
    } else {
      if (!cle) contexte.resume.sansIdentifiant.push(paiementsNomClient_(facture, null) || '?');
      contexte.ajouts.push(paiementsLignePaiement_(contexte, facture, ids[rang]));
      rang++;
      contexte.resume.crees++;
    }
    contexte.majsFactures.push({
      ligne: facture._ligne,
      patch: paiementsPatchStatutFacture_(STATUT_PAIEMENT.PAYEE),
    });
    paiementsMarquerBilanPaye_(contexte, facture);
  });

  contexte.resume.totaux = paiementsTotauxParDevise_(
    contexte.ajouts, contexte.index,
    PAIEMENTS_COL_.PAIEMENT_CLIENT, PAIEMENTS_COL_.PAIEMENT_MONTANT);
}

/**
 * Fabrique la ligne de l'onglet Paiements correspondant à une facture.
 * @param {Object} contexte Contexte de la confirmation.
 * @param {Object} facture Facture réglée.
 * @param {string} idPaiement Identifiant du nouveau paiement.
 * @return {Object} Ligne prête pour ajouterLignes_.
 */
function paiementsLignePaiement_(contexte, facture, idPaiement) {
  const idClient = paiementsTexte_(facture[PAIEMENTS_COL_.FACTURE_CLIENT]);
  const client = contexte.index.get(idClient) || null;
  const cents = enCents_(facture[PAIEMENTS_COL_.FACTURE_TOTAL]);
  const ligne = {};
  ligne[PAIEMENTS_COL_.PAIEMENT_ID] = idPaiement;
  ligne[PAIEMENTS_COL_.PAIEMENT_CLIENT] = idClient;
  ligne[PAIEMENTS_COL_.PAIEMENT_NOM] = paiementsNomClient_(facture, client);
  ligne[PAIEMENTS_COL_.PAIEMENT_FACTURE] = paiementsTexte_(facture[PAIEMENTS_COL_.FACTURE_ID]);
  ligne[PAIEMENTS_COL_.PAIEMENT_DATE] = contexte.saisie.date;
  ligne[PAIEMENTS_COL_.PAIEMENT_MONTANT] = enDollars_(cents);
  ligne[PAIEMENTS_COL_.PAIEMENT_METHODE] = contexte.saisie.methode;
  ligne[PAIEMENTS_COL_.PAIEMENT_REFERENCE] =
    contexte.saisie.reference || paiementsReferenceSuggeree_(facture);
  // « Déduit par le client » reste à confirmer : c'est le rapprochement
  // trimestriel qui dira si le client a bien retranché ce paiement.
  ligne[PAIEMENTS_COL_.PAIEMENT_DEDUIT] = PAIEMENTS_DEDUIT_DEFAUT_;
  ligne[PAIEMENTS_COL_.PAIEMENT_NOTES] =
    `Lot de paiements confirmé le ${formaterDate_(new Date())}.`;
  return ligne;
}

/**
 * Passe à « Payé » le bilan rattaché à une facture réglée. Un bilan annulé ou
 * déjà payé n'est pas touché.
 * @param {Object} contexte Contexte de la confirmation.
 * @param {Object} facture Facture réglée.
 * @return {void}
 */
function paiementsMarquerBilanPaye_(contexte, facture) {
  const idBilan = paiementsTexte_(facture[PAIEMENTS_COL_.FACTURE_BILAN]);
  if (!idBilan || contexte.bilansTraites.has(idBilan)) return;
  const bilan = contexte.bilans.get(idBilan);
  if (!bilan) {
    contexte.resume.bilansIntrouvables.push(idBilan);
    return;
  }
  const statut = bilan[PAIEMENTS_COL_.BILAN_STATUT];
  if (paiementsMemeStatut_(statut, STATUT_BILAN.PAYE) ||
      paiementsMemeStatut_(statut, STATUT_BILAN.ANNULE)) {
    return;
  }
  const patch = {};
  patch[PAIEMENTS_COL_.BILAN_STATUT] = STATUT_BILAN.PAYE;
  contexte.majsBilans.push({ ligne: bilan._ligne, patch: patch });
  contexte.bilansTraites.add(idBilan);
  contexte.resume.bilans++;
}

/**
 * Écrit tout d'un coup : les paiements, puis les statuts des factures, puis ceux
 * des bilans. Jamais une cellule à la fois.
 * @param {Object} contexte Contexte de la confirmation.
 * @return {void}
 */
function paiementsEcrireConfirmation_(contexte) {
  if (contexte.ajouts.length) {
    ajouterLignes_(CONFIG.ONGLETS.PAIEMENTS.nom, contexte.ajouts);
  }
  if (contexte.majsFactures.length) {
    majLignes_(CONFIG.ONGLETS.FACTURES.nom, contexte.majsFactures);
  }
  if (contexte.majsBilans.length) {
    majLignes_(CONFIG.ONGLETS.BILANS.nom, contexte.majsBilans);
  }
}

/**
 * Trace la confirmation dans le Journal.
 * @param {Object} contexte Contexte de la confirmation.
 * @return {void}
 */
function paiementsJournaliserConfirmation_(contexte) {
  const resume = contexte.resume;
  journalInfo_('confirmerLotDePaiements',
    `${resume.crees} paiement(s) enregistré(s) sur ${resume.total} facture(s) du lot, ` +
    `total ${paiementsFormaterTotaux_(resume.totaux)}.`,
    `Date ${formaterDate_(contexte.saisie.date)}, méthode ${contexte.saisie.methode}, ` +
    `référence « ${contexte.saisie.reference || '(référence de chaque facture)'} », ` +
    `${resume.bilans} bilan(s) passé(s) à « ${STATUT_BILAN.PAYE} ».`);
  if (resume.doublons.length) {
    journalAvert_('confirmerLotDePaiements',
      `${resume.doublons.length} facture(s) avaient déjà un paiement : aucun doublon créé.`,
      paiementsListeCourte_(resume.doublons, 30));
  }
  if (resume.bilansIntrouvables.length) {
    journalAvert_('confirmerLotDePaiements',
      `${resume.bilansIntrouvables.length} bilan(s) rattaché(s) sont introuvables.`,
      paiementsListeCourte_(resume.bilansIntrouvables, 30));
  }
}

/**
 * Rédige le résumé de la confirmation, pour quelqu'un qui n'est pas informaticien.
 * @param {Object} contexte Contexte de la confirmation.
 * @return {string} Texte affiché dans l'alerte du menu.
 */
function paiementsResumeConfirmation_(contexte) {
  const resume = contexte.resume;
  const texte = [
    `${resume.crees} paiement(s) enregistré(s), pour un total de ` +
      `${paiementsFormaterTotaux_(resume.totaux)}.`,
    '',
    `• Date des paiements : ${formaterDate_(contexte.saisie.date)}`,
    `• Méthode : ${contexte.saisie.methode}`,
    `• Référence : ${contexte.saisie.reference ||
      'celle suggérée pour chaque facture (n° de facture du client)'}`,
    `• ${resume.total} facture(s) sont passées à « ${STATUT_PAIEMENT.PAYEE} ».`,
  ];
  if (resume.bilans) {
    texte.push(`• ${resume.bilans} bilan(s) passé(s) à « ${STATUT_BILAN.PAYE} ».`);
  }
  if (resume.doublons.length) {
    texte.push('', `⚠️ ${resume.doublons.length} facture(s) avaient DÉJÀ un paiement ` +
      'enregistré : aucun deuxième paiement n\'a été créé pour elles, elles sont simplement ' +
      `passées à « ${STATUT_PAIEMENT.PAYEE} ». Détail : ${paiementsListeCourte_(resume.doublons)}.`);
  }
  if (resume.sansIdentifiant.length) {
    texte.push('', `⚠️ ${resume.sansIdentifiant.length} facture(s) n'ont pas d'` +
      `« ${PAIEMENTS_COL_.FACTURE_ID} » : leur paiement a été créé, mais le doublon ne peut ` +
      `pas être détecté pour elles (${paiementsListeCourte_(resume.sansIdentifiant)}).`);
  }
  if (resume.bilansIntrouvables.length) {
    texte.push('', `⚠️ Bilan(s) rattaché(s) introuvable(s), statut non modifié : ` +
      `${paiementsListeCourte_(resume.bilansIntrouvables)}.`);
  }
  texte.push('', 'Le lot est terminé : vous pouvez en préparer un nouveau.',
    'Prochaine étape, chaque trimestre : « 7. Rapprochement trimestriel ».');
  return texte.join('\n');
}

// ---------------------------------------------------------------------------
// Saisie de la date, de la méthode et de la référence
// ---------------------------------------------------------------------------

/**
 * Rassemble et valide les trois renseignements du lot. Si aucun argument n'est
 * fourni, ils sont demandés à l'écran ; sinon rien n'est demandé.
 * @param {string} [reference] Référence commune du lot.
 * @param {string|Date} [datePaiement] Date au format AAAA-MM-JJ.
 * @param {string} [methode] Méthode de paiement.
 * @return {Object} {reference, date, methode} ou {message} si la saisie est
 *     annulée ou refusée.
 */
function paiementsSaisie_(reference, datePaiement, methode) {
  const parProgramme =
    reference !== undefined || datePaiement !== undefined || methode !== undefined;
  const brut = parProgramme
    ? { reference: reference, date: datePaiement, methode: methode }
    : paiementsInviterUtilisateur_();
  if (!brut) {
    return { message: 'Confirmation annulée : aucun paiement n\'a été enregistré, ' +
      'aucun statut n\'a changé.' };
  }

  const date = paiementsDateValide_(brut.date);
  if (date.message) return { message: date.message };

  const methodeRetenue = paiementsMethodeValide_(brut.methode);
  if (!methodeRetenue) {
    return { message: `La méthode de paiement « ${paiementsTexte_(brut.methode)} » n'existe ` +
      `pas. Écrivez exactement l'une de celles-ci : ${PAIEMENTS_METHODES_.join(', ')}. ` +
      'Aucun paiement n\'a été enregistré.' };
  }
  return {
    reference: paiementsTexte_(brut.reference),
    date: date.date,
    methode: methodeRetenue,
  };
}

/**
 * Pose les trois questions à l'écran. Sans interface (exécution depuis
 * l'éditeur), les valeurs par défaut sont utilisées et c'est journalisé.
 * @return {Object|null} Réponses brutes, ou null si l'utilisateur a annulé.
 */
function paiementsInviterUtilisateur_() {
  const ui = menuUi_();
  if (!ui) {
    journalAvert_('confirmerLotDePaiements',
      'Aucune fenêtre disponible : valeurs par défaut utilisées.',
      `Date du jour et méthode « ${PAIEMENTS_METHODE_DEFAUT_} ».`);
    return { reference: '', date: '', methode: PAIEMENTS_METHODE_DEFAUT_ };
  }
  const reference = paiementsDemander_(ui, 'Référence du lot (1 sur 3)',
    'Quelle référence avez-vous indiquée à votre banque (n° de virement, de chèque, de lot) ?\n\n' +
    'Laissez vide pour utiliser, pour chaque paiement, le n° de facture du client.', '');
  if (reference === null) return null;

  const parDefaut = formaterDate_(paiementsAujourdhui_());
  const date = paiementsDemander_(ui, 'Date des paiements (2 sur 3)',
    `À quelle date avez-vous payé ? Format AAAA-MM-JJ (exemple : ${parDefaut}).\n\n` +
    `Laissez vide pour aujourd'hui (${parDefaut}).`, parDefaut);
  if (date === null) return null;

  const methode = paiementsDemander_(ui, 'Méthode de paiement (3 sur 3)',
    `Comment avez-vous payé ? ${PAIEMENTS_METHODES_.join(', ')}.\n\n` +
    `Laissez vide pour « ${PAIEMENTS_METHODE_DEFAUT_} ».`, PAIEMENTS_METHODE_DEFAUT_);
  if (methode === null) return null;

  return { reference: reference, date: date, methode: methode };
}

/**
 * Pose une question à l'écran et renvoie la réponse.
 * @param {Object} ui Interface du classeur.
 * @param {string} titre Titre de la fenêtre.
 * @param {string} question Question, rédigée en français clair.
 * @param {string} defaut Valeur retenue si la réponse est vide.
 * @return {string|null} La réponse, ou null si l'utilisateur a annulé.
 */
function paiementsDemander_(ui, titre, question, defaut) {
  const reponse = ui.prompt(titre, question, ui.ButtonSet.OK_CANCEL);
  if (reponse.getSelectedButton() !== ui.Button.OK) return null;
  const texte = paiementsTexte_(reponse.getResponseText());
  return texte === '' ? paiementsTexte_(defaut) : texte;
}

/**
 * Aujourd'hui, à minuit (pour comparer des dates sans se soucier de l'heure).
 * @return {Date} La date du jour.
 */
function paiementsAujourdhui_() {
  return paiementsMinuit_(new Date());
}

/**
 * Ramène une date à minuit.
 * @param {Date} date Date à ramener.
 * @return {Date} Nouvelle date, à 00:00:00.
 */
function paiementsMinuit_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Valide la date de paiement : format AAAA-MM-JJ, date réellement existante, et
 * pas à plus de PAIEMENTS_JOURS_FUTUR_MAX_ jours dans le futur.
 * @param {string|Date} valeur Date saisie ; vide = aujourd'hui.
 * @return {{date: Date}|{message: string}} La date validée, ou l'explication du refus.
 */
function paiementsDateValide_(valeur) {
  const saisi = paiementsTexte_(valeur);
  if (valeur === null || valeur === undefined || saisi === '') {
    return { date: paiementsAujourdhui_() };
  }
  let date = null;
  if (valeur instanceof Date) {
    date = versDate_(valeur);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(saisi)) {
    date = versDate_(saisi);
  }
  if (!date) {
    return { message: `La date « ${saisi} » n'est pas une date valide. Écrivez-la au format ` +
      `AAAA-MM-JJ, par exemple ${formaterDate_(paiementsAujourdhui_())}. ` +
      'Aucun paiement n\'a été enregistré, aucun statut n\'a changé.' };
  }
  const limite = paiementsAujourdhui_();
  limite.setDate(limite.getDate() + PAIEMENTS_JOURS_FUTUR_MAX_);
  if (paiementsMinuit_(date).getTime() > limite.getTime()) {
    return { message: `La date ${formaterDate_(date)} est à plus de ` +
      `${PAIEMENTS_JOURS_FUTUR_MAX_} jours dans le futur : on n'enregistre pas un paiement qui ` +
      'n\'a pas encore été fait. Corrigez la date, ou attendez d\'avoir vraiment payé. ' +
      'Aucun paiement n\'a été enregistré.' };
  }
  return { date: paiementsMinuit_(date) };
}

/**
 * Retrouve la méthode de paiement exacte à partir de ce qui a été saisi
 * (« virement », « VIREMENT » et « Virement » sont acceptés).
 * @param {string} valeur Méthode saisie ; vide = Virement.
 * @return {string|null} La méthode telle qu'écrite dans CONFIG, ou null si inconnue.
 */
function paiementsMethodeValide_(valeur) {
  const texte = paiementsTexte_(valeur);
  if (!texte) return PAIEMENTS_METHODE_DEFAUT_;
  const cible = texteNormalise_(texte);
  for (let i = 0; i < PAIEMENTS_METHODES_.length; i++) {
    if (texteNormalise_(PAIEMENTS_METHODES_[i]) === cible) return PAIEMENTS_METHODES_[i];
  }
  return null;
}

/**
 * Fabrique une suite d'identifiants successifs à partir du premier libre.
 * Indispensable pour numéroter tout un lot en une seule écriture.
 * @param {string} premierId Premier identifiant libre (ex. 'P-000042').
 * @param {number} nombre Nombre d'identifiants voulus.
 * @return {Array<string>} Les identifiants, dans l'ordre.
 */
function paiementsSerieIds_(premierId, nombre) {
  const trouve = /^(.*?)(\d+)\s*$/.exec(paiementsTexte_(premierId));
  const prefixe = trouve ? trouve[1] : 'P-';
  const largeur = trouve ? trouve[2].length : 6;
  const debut = trouve ? parseInt(trouve[2], 10) : 1;
  const ids = [];
  for (let i = 0; i < Math.max(0, Number(nombre) || 0); i++) {
    let suffixe = String(debut + i);
    while (suffixe.length < largeur) suffixe = `0${suffixe}`;
    ids.push(prefixe + suffixe);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Annuler le lot en cours
// ---------------------------------------------------------------------------

/**
 * Annule le lot en cours : les factures « À payer » repassent à « Non payée ».
 * Rien n'est détruit — les factures déjà « Payée » ne sont pas touchées et aucun
 * paiement déjà enregistré n'est supprimé. À utiliser quand un lot a été préparé
 * par erreur, ou quand les virements n'ont finalement pas été faits.
 * Conçue pour être lancée à la main depuis l'éditeur de script : elle affiche
 * elle-même son résultat et écrit elle-même son journal.
 * @return {string} Résumé lisible.
 */
function annulerLot() {
  let resume = '';
  try {
    const factures = paiementsFiltrerFactures_(
      lireTable_(CONFIG.ONGLETS.FACTURES.nom), null, STATUT_PAIEMENT.A_PAYER);
    if (!factures.length) {
      resume = `Aucun lot en cours : aucune facture n'est au statut ` +
        `« ${STATUT_PAIEMENT.A_PAYER} ». Rien n'a été modifié.`;
    } else {
      resume = paiementsAnnulerFactures_(factures);
    }
  } catch (e) {
    journalErreur_('annulerLot', `Échec de l'annulation du lot : ${e.message}`,
      `${e.message}\n${e.stack}`);
    resume = 'Le lot n\'a pas pu être annulé. Le détail technique est dans l\'onglet ' +
      `${CONFIG.ONGLETS.JOURNAL.nom}.\n\nDétail : ${e.message}`;
  } finally {
    viderTamponJournal_();
  }
  menuAlerte_('Annuler le lot de paiements', resume);
  return resume;
}

/**
 * Remet les factures d'un lot à « Non payée », en une seule écriture.
 * @param {Array<Object>} factures Factures encore « À payer ».
 * @return {string} Résumé lisible.
 */
function paiementsAnnulerFactures_(factures) {
  const index = paiementsIndexClients_(lireTable_(CONFIG.ONGLETS.CLIENTS.nom));
  const totaux = paiementsTotauxParDevise_(
    factures, index, PAIEMENTS_COL_.FACTURE_CLIENT, PAIEMENTS_COL_.FACTURE_TOTAL);
  const majs = factures.map((facture) => ({
    ligne: facture._ligne,
    patch: paiementsPatchStatutFacture_(STATUT_PAIEMENT.NON_PAYEE),
  }));
  majLignes_(CONFIG.ONGLETS.FACTURES.nom, majs);

  const ids = factures.map((facture) => paiementsTexte_(facture[PAIEMENTS_COL_.FACTURE_ID]));
  journalInfo_('annulerLot',
    `Lot annulé : ${factures.length} facture(s) remises à « ${STATUT_PAIEMENT.NON_PAYEE} », ` +
    `total ${paiementsFormaterTotaux_(totaux)}.`, paiementsListeCourte_(ids, 30));
  return [
    `Lot annulé : ${factures.length} facture(s) sont revenues au statut ` +
      `« ${STATUT_PAIEMENT.NON_PAYEE} », pour ${paiementsFormaterTotaux_(totaux)}.`,
    '',
    `Factures concernées : ${paiementsListeCourte_(ids)}.`,
    '',
    'Aucun paiement n\'a été supprimé et aucune facture déjà ' +
      `« ${STATUT_PAIEMENT.PAYEE} » n'a été touchée.`,
    'Vous pouvez maintenant préparer un nouveau lot.',
  ].join('\n');
}
