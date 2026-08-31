/*
 * ===========================================================================
 *  Code.gs — FICHIER GÉNÉRÉ. NE LE MODIFIEZ PAS À LA MAIN.
 * ===========================================================================
 *
 *  Ce fichier est produit par outils/build.mjs à partir du dossier src/.
 *  Toute retouche faite ici sera écrasée à la prochaine construction :
 *  modifiez le module concerné dans src/, puis relancez  npm run build.
 *
 *  Mode d'emploi :
 *    1. Ouvrez votre classeur Google Sheets → Extensions → Apps Script.
 *    2. Collez TOUT ce fichier dans un fichier nommé Code.gs, puis enregistrez.
 *    3. Lancez la fonction installer() une première fois et autorisez le script.
 *    4. Rechargez le classeur : le menu « 📋 Automatisation » apparaît.
 *
 *  Ordre de concaténation (ordre alphabétique des noms de fichiers, 11 modules) :
 *    1. src/00_Config.gs
 *    2. src/01_Installation.gs
 *    3. src/02_Menu.gs
 *    4. src/03_Feuilles.gs
 *    5. src/04_Bilans.gs
 *    6. src/05_Factures.gs
 *    7. src/06_Paiements.gs
 *    8. src/07_Rapprochement.gs
 *    9. src/08_Courriels.gs
 *   10. src/09_Journal.gs
 *   11. src/10_Tests.gs
 *
 *  Apps Script n'a pas de modules : tous ces fichiers partagent un seul espace
 *  de noms global. L'ordre ci-dessus est celui dans lequel le code est évalué.
 *
 *  Construction reproductible : sans changement dans src/, le contenu de ce
 *  fichier est identique d'une construction à l'autre.
 * ===========================================================================
 */

// ===========================================================================
// ▼ src/00_Config.gs   (module 1 sur 11)
// ===========================================================================
/**
 * 00_Config.gs — Source de vérité unique de la structure du classeur.
 *
 * Aucun autre fichier ne doit coder en dur un nom d'onglet ou un en-tête de colonne.
 * Tout passe par CONFIG.
 */

/** Statuts d'un bilan. */
const STATUT_BILAN = {
  BROUILLON: 'Brouillon',
  ENVOYE: 'Envoyé',
  FACTURE_RECUE: 'Facture reçue',
  VERIFIE: 'Vérifié',
  PAYE: 'Payé',
  ANNULE: 'Annulé',
};

/** Statuts de vérification d'une facture. */
const STATUT_VERIF = {
  A_VERIFIER: 'À vérifier',
  CONFORME: 'Conforme',
  ECART: 'Écart de montant',
  DOUBLON: 'Doublon',
  SANS_BILAN: 'Sans bilan',
  REJETEE: 'Rejetée',
};

/** Statuts de paiement d'une facture. */
const STATUT_PAIEMENT = {
  NON_PAYEE: 'Non payée',
  A_PAYER: 'À payer',
  PAYEE: 'Payée',
  ANNULEE: 'Annulée',
};

/** Verdicts du rapprochement trimestriel. */
const VERDICT = {
  BALANCE: '✅ Balancé',
  EXPLIQUE: '⚠️ Écart expliqué',
  INEXPLIQUE: '❌ Écart inexpliqué',
  NON_DECLARE: '❓ Solde non déclaré',
};

/** Niveaux de journalisation. */
const NIVEAU = { INFO: 'INFO', AVERT: 'AVERT', ERREUR: 'ERREUR' };

const CONFIG = {

  /** Nom du menu ajouté au classeur. */
  MENU: '📋 Automatisation',

  /** Locale utilisée pour le formatage des dates et des montants. */
  LOCALE: 'fr-CA',
  FUSEAU: 'America/Toronto',

  /** Format d'affichage des montants et des dates. */
  FORMAT_MONTANT: '#,##0.00 $',
  FORMAT_DATE: 'yyyy-mm-dd',
  FORMAT_HORODATAGE: 'yyyy-mm-dd hh:mm:ss',

  /** Plafond de l'onglet Journal avant purge des plus anciennes lignes. */
  JOURNAL_MAX_LIGNES: 5000,

  /** Bornes du moteur de recherche de sous-ensemble (§4.4 de SPEC.md). */
  SOUS_ENSEMBLE_MAX_ELEMENTS: 25,
  SOUS_ENSEMBLE_MAX_CIBLE: 5000000, // 50 000,00 $ en cents
  SOUS_ENSEMBLE_MAX_TAILLE3: 200, // au-delà, on renonce aux combinaisons de 3 (O(n²))

  /** Nombre de candidats listés quand un écart reste inexpliqué. */
  CANDIDATS_INEXPLIQUE: 3,

  /** Taux de taxes du Québec, utilisés pour expliquer les écarts. */
  TAUX_TPS: 0.05,
  TAUX_TVQ: 0.09975,

  /** Paramètres modifiables par l'utilisateur dans l'onglet Paramètres. */
  PARAMETRES_DEFAUT: {
    COURRIEL_ALERTE: '',
    MODE_ENVOI: 'Brouillon',                 // Brouillon | Direct
    TOLERANCE_CENTS: '1',                    // écart accepté, en cents
    SIGNE_SOLDE_CLIENT: 'Normal',            // Normal | Inversé
    JOUR_ENVOI_BILAN: '1',                   // 1-28
    ETIQUETTE_GMAIL: 'Factures-clients',
    DOSSIER_DRIVE: 'Factures clients',
    NOM_EXPEDITEUR: '',
    SIGNATURE: '',
    DEVISE: 'CAD',
    RELANCE_AUTO: 'Non',                     // Oui | Non
    TRIMESTRE_DECALAGE_MOIS: '0',            // décalage si l'exercice ne suit pas l'année civile
    PERIODE_BILAN_AUTO: 'Mois précédent',    // Mois précédent | Mois courant
    DOSSIER_DRIVE_ID: '',                    // rempli automatiquement à la création du dossier
  },

  DESCRIPTIONS_PARAMETRES: {
    COURRIEL_ALERTE: "Adresse qui reçoit le résumé après chaque exécution automatique.",
    MODE_ENVOI: "Brouillon = les courriels sont préparés dans Gmail et vous les relisez avant d'envoyer. Direct = envoi immédiat.",
    TOLERANCE_CENTS: "Écart, en cents, en deçà duquel un solde est considéré comme balancé (1 = un cent).",
    SIGNE_SOLDE_CLIENT: "Inversé si vos clients vous envoient leur solde en négatif.",
    JOUR_ENVOI_BILAN: "Jour du mois (1 à 28) où les bilans partent automatiquement.",
    ETIQUETTE_GMAIL: "Étiquette Gmail où vous classez les factures reçues.",
    DOSSIER_DRIVE: "Dossier Google Drive où les pièces jointes sont archivées.",
    NOM_EXPEDITEUR: "Nom affiché comme expéditeur des courriels (vide = votre nom Gmail).",
    SIGNATURE: "Texte ajouté au bas de chaque courriel.",
    DEVISE: "Devise affichée dans les courriels.",
    RELANCE_AUTO: "Oui = les relances d'écart partent automatiquement après le rapprochement.",
    TRIMESTRE_DECALAGE_MOIS: "0 si vos trimestres suivent l'année civile (janv-mars = T1).",
    PERIODE_BILAN_AUTO: "Période visée par l'envoi mensuel automatique. « Mois précédent » si vous facturez le mois écoulé.",
    DOSSIER_DRIVE_ID: "Rempli tout seul par le script. Ne pas modifier : c'est l'identifiant du dossier Drive qu'il a créé.",
  },

  /**
   * Schéma des onglets. L'ordre des en-têtes fait foi à la création ;
   * ensuite les modules retrouvent les colonnes par leur nom.
   *   type : 'texte' | 'nombre' | 'montant' | 'date' | 'liste' | 'url'
   *   liste : valeurs autorisées (validation de données)
   *   largeur : largeur de colonne en pixels
   */
  ONGLETS: {

    CLIENTS: {
      nom: 'Clients',
      aide: "La liste de vos clients. Seuls les clients Actif = Oui reçoivent un bilan.",
      colonnes: [
        { nom: 'ID client', type: 'texte', largeur: 90 },
        { nom: 'Nom', type: 'texte', largeur: 220 },
        { nom: 'Courriel', type: 'texte', largeur: 220 },
        { nom: 'Courriels en copie', type: 'texte', largeur: 220 },
        { nom: 'Actif', type: 'liste', liste: ['Oui', 'Non'], largeur: 70 },
        { nom: 'Devise', type: 'texte', largeur: 70 },
        { nom: "Jour d'envoi", type: 'nombre', largeur: 100 },
        { nom: 'Notes', type: 'texte', largeur: 300 },
      ],
    },

    LIGNES_BILAN: {
      nom: 'Lignes_bilan',
      aide: "Le détail de ce que vous devez à chaque client, par période (AAAA-MM). C'est ici que vous saisissez.",
      colonnes: [
        { nom: 'ID ligne', type: 'texte', largeur: 100 },
        { nom: 'ID client', type: 'texte', largeur: 90 },
        { nom: 'Période', type: 'texte', largeur: 90 },
        { nom: 'Date', type: 'date', largeur: 100 },
        { nom: 'Description', type: 'texte', largeur: 300 },
        { nom: 'Quantité', type: 'nombre', largeur: 80 },
        { nom: 'Prix unitaire', type: 'montant', largeur: 110 },
        { nom: 'Montant', type: 'montant', largeur: 110 },
        { nom: 'ID bilan', type: 'texte', largeur: 140 },
      ],
    },

    BILANS: {
      nom: 'Bilans',
      aide: "Généré par le script. Un bilan = ce que vous devez à un client pour une période.",
      colonnes: [
        { nom: 'ID bilan', type: 'texte', largeur: 140 },
        { nom: 'ID client', type: 'texte', largeur: 90 },
        { nom: 'Nom client', type: 'texte', largeur: 200 },
        { nom: 'Période', type: 'texte', largeur: 90 },
        { nom: 'Date de génération', type: 'date', largeur: 130 },
        { nom: "Date d'envoi", type: 'date', largeur: 110 },
        { nom: 'Montant du bilan', type: 'montant', largeur: 130 },
        { nom: 'Nombre de lignes', type: 'nombre', largeur: 120 },
        { nom: 'Statut', type: 'liste', liste: Object.values(STATUT_BILAN), largeur: 120 },
        { nom: 'ID facture', type: 'texte', largeur: 110 },
        { nom: 'Notes', type: 'texte', largeur: 300 },
      ],
    },

    FACTURES: {
      nom: 'Factures',
      aide: "Les factures reçues de vos clients. Importées de Gmail ou saisies à la main.",
      colonnes: [
        { nom: 'ID facture', type: 'texte', largeur: 100 },
        { nom: 'ID client', type: 'texte', largeur: 90 },
        { nom: 'Nom client', type: 'texte', largeur: 200 },
        { nom: 'N° facture client', type: 'texte', largeur: 140 },
        { nom: 'Date facture', type: 'date', largeur: 110 },
        { nom: 'Période', type: 'texte', largeur: 90 },
        { nom: 'Montant avant taxes', type: 'montant', largeur: 140 },
        { nom: 'Taxes', type: 'montant', largeur: 100 },
        { nom: 'Montant total', type: 'montant', largeur: 120 },
        { nom: 'ID bilan', type: 'texte', largeur: 140 },
        { nom: 'Statut vérification', type: 'liste', liste: Object.values(STATUT_VERIF), largeur: 140 },
        { nom: 'Écart vs bilan', type: 'montant', largeur: 120 },
        { nom: 'Statut paiement', type: 'liste', liste: Object.values(STATUT_PAIEMENT), largeur: 120 },
        { nom: 'Lien courriel', type: 'url', largeur: 120 },
        { nom: 'Lien pièce jointe', type: 'url', largeur: 120 },
        { nom: 'Notes', type: 'texte', largeur: 350 },
      ],
    },

    PAIEMENTS: {
      nom: 'Paiements',
      aide: "Chaque paiement que vous avez fait. C'est la base du rapprochement trimestriel.",
      colonnes: [
        { nom: 'ID paiement', type: 'texte', largeur: 110 },
        { nom: 'ID client', type: 'texte', largeur: 90 },
        { nom: 'Nom client', type: 'texte', largeur: 200 },
        { nom: 'ID facture', type: 'texte', largeur: 100 },
        { nom: 'Date paiement', type: 'date', largeur: 120 },
        { nom: 'Montant', type: 'montant', largeur: 110 },
        { nom: 'Méthode', type: 'liste', liste: ['Virement', 'Chèque', 'Interac', 'Autre'], largeur: 100 },
        { nom: 'Référence', type: 'texte', largeur: 150 },
        { nom: 'Déduit par le client', type: 'liste', liste: ['À confirmer', 'Oui', 'Non'], largeur: 150 },
        { nom: 'Confirmé au rapprochement', type: 'texte', largeur: 180 },
        { nom: 'Notes', type: 'texte', largeur: 300 },
      ],
    },

    SOLDES_DECLARES: {
      nom: 'Soldes_declares',
      aide: "Le solde que le client vous annonce, trimestre par trimestre (AAAA-TN). Recopiez-le ici tel quel.",
      colonnes: [
        { nom: 'ID', type: 'texte', largeur: 100 },
        { nom: 'ID client', type: 'texte', largeur: 90 },
        { nom: 'Nom client', type: 'texte', largeur: 200 },
        { nom: 'Période', type: 'texte', largeur: 90 },
        { nom: 'Date du relevé', type: 'date', largeur: 120 },
        { nom: 'Solde déclaré', type: 'montant', largeur: 120 },
        { nom: 'Source', type: 'liste', liste: ['Courriel', 'Fichier client', 'Téléphone', 'Autre'], largeur: 120 },
        { nom: 'Notes', type: 'texte', largeur: 300 },
      ],
    },

    RAPPROCHEMENT: {
      nom: 'Rapprochement',
      aide: "Généré par le script chaque trimestre. C'est le rapport que vous lisez.",
      genere: true,
      colonnes: [
        { nom: 'Période', type: 'texte', largeur: 80 },
        { nom: 'ID client', type: 'texte', largeur: 90 },
        { nom: 'Nom client', type: 'texte', largeur: 200 },
        { nom: 'Solde théorique', type: 'montant', largeur: 120 },
        { nom: 'Solde déclaré', type: 'montant', largeur: 120 },
        { nom: 'Écart', type: 'montant', largeur: 110 },
        { nom: 'Verdict', type: 'texte', largeur: 160 },
        { nom: 'Diagnostic', type: 'texte', largeur: 320 },
        { nom: 'Détail', type: 'texte', largeur: 420 },
        { nom: 'Action suggérée', type: 'texte', largeur: 320 },
        { nom: 'Relance', type: 'texte', largeur: 120 },
        { nom: 'Exécuté le', type: 'date', largeur: 110 },
      ],
    },

    JOURNAL: {
      nom: 'Journal',
      aide: "Trace de tout ce que le script a fait. Utile quand quelque chose ne marche pas.",
      genere: true,
      colonnes: [
        { nom: 'Horodatage', type: 'date', largeur: 150 },
        { nom: 'Fonction', type: 'texte', largeur: 180 },
        { nom: 'Niveau', type: 'texte', largeur: 80 },
        { nom: 'Message', type: 'texte', largeur: 420 },
        { nom: 'Détail', type: 'texte', largeur: 420 },
      ],
    },

    PARAMETRES: {
      nom: 'Paramètres',
      aide: "Les réglages du script. Modifiez la colonne Valeur uniquement.",
      colonnes: [
        { nom: 'Clé', type: 'texte', largeur: 220 },
        { nom: 'Valeur', type: 'texte', largeur: 220 },
        { nom: 'Description', type: 'texte', largeur: 600 },
      ],
    },

    TABLEAU_DE_BORD: {
      nom: 'Tableau de bord',
      aide: "Vue d'ensemble, régénérée à chaque exécution.",
      genere: true,
      colonnes: [
        { nom: 'Indicateur', type: 'texte', largeur: 320 },
        { nom: 'Valeur', type: 'texte', largeur: 160 },
        { nom: 'Détail', type: 'texte', largeur: 520 },
      ],
    },
  },
};

/** Ordre d'affichage des onglets dans le classeur. */
const ORDRE_ONGLETS = [
  CONFIG.ONGLETS.TABLEAU_DE_BORD.nom,
  CONFIG.ONGLETS.CLIENTS.nom,
  CONFIG.ONGLETS.LIGNES_BILAN.nom,
  CONFIG.ONGLETS.BILANS.nom,
  CONFIG.ONGLETS.FACTURES.nom,
  CONFIG.ONGLETS.PAIEMENTS.nom,
  CONFIG.ONGLETS.SOLDES_DECLARES.nom,
  CONFIG.ONGLETS.RAPPROCHEMENT.nom,
  CONFIG.ONGLETS.PARAMETRES.nom,
  CONFIG.ONGLETS.JOURNAL.nom,
];

// ===========================================================================
// ▼ src/01_Installation.gs   (module 2 sur 11)
// ===========================================================================
/**
 * 01_Installation.gs — Mise en route et entretien du classeur.
 *
 * C'est le fichier qu'on lance en premier, et qu'on peut relancer autant de fois
 * qu'on veut : il ne fait qu'AJOUTER ce qui manque.
 *
 *   installer()                          crée ou répare tous les onglets
 *   installerDeclencheurs()              met l'automatisation en marche
 *   supprimerDeclencheurs()              l'arrête
 *   reparerClasseur_()                   onglets, colonnes, formats, couleurs
 *   majTableauDeBord_()                  régénère la page de synthèse
 *
 * Trois promesses :
 *   1. Rien n'est effacé. Une colonne existante n'est jamais déplacée ni supprimée ;
 *      les colonnes manquantes sont ajoutées À LA FIN. Aucune ligne de données
 *      saisie par un humain n'est touchée.
 *   2. Relancer ne double rien : mêmes onglets, mêmes règles de couleur,
 *      mêmes déclencheurs (les anciens sont retirés avant d'en recréer).
 *   3. Une valeur déjà saisie dans l'onglet Paramètres n'est jamais écrasée.
 */

/** Fond des en-têtes des onglets que vous remplissez à la main. */
const INSTALLATION_FOND_ENTETE_ = '#1c4587';

/** Fond des en-têtes des onglets générés par le script (gris = ne rien y saisir). */
const INSTALLATION_FOND_ENTETE_GENERE_ = '#5b5b5b';

/** Couleur du texte des en-têtes. */
const INSTALLATION_TEXTE_ENTETE_ = '#ffffff';

/** Couleurs des mises en forme conditionnelles. */
const INSTALLATION_VERT_ = '#d9ead3';
const INSTALLATION_ORANGE_ = '#fff2cc';
const INSTALLATION_ROUGE_ = '#f4cccc';
const INSTALLATION_GRIS_ = '#efefef';
const INSTALLATION_ROUGE_TEXTE_ = '#cc0000';

/** Fond des lignes de titre du tableau de bord. */
const INSTALLATION_FOND_SECTION_ = '#e8eaed';

/** Fond des lignes ordinaires du tableau de bord. */
const INSTALLATION_FOND_NORMAL_ = '#ffffff';

/** Heure (0-23) du passage quotidien qui prépare les bilans. */
const INSTALLATION_HEURE_BILANS_ = 7;

/** Heure (0-23) du passage quotidien qui déclenche le rapprochement trimestriel. */
const INSTALLATION_HEURE_RAPPROCHEMENT_ = 8;

/** Largeur (en pixels) à partir de laquelle on rogne le texte au lieu de l'enrouler. */
const INSTALLATION_LARGEUR_TEXTE_LONG_ = 300;

// ---------------------------------------------------------------------------
// Point d'entrée : installer ou réparer le classeur
// ---------------------------------------------------------------------------

/**
 * Prépare le classeur de bout en bout : onglets, en-têtes, largeurs, formats,
 * listes déroulantes, couleurs, ordre des onglets, réglages par défaut et
 * tableau de bord. Peut être relancé à tout moment sans rien casser.
 * @return {string} Le récapitulatif affiché à l'utilisateur.
 */
function installer() {
  const nomFonction = 'installer';
  let message = '';
  try {
    journalInfo_(nomFonction, 'Mise en route du classeur.', '');
    const rapport = reparerClasseur_();
    const parametres = installationRemplirParametres_();
    const deplaces = installationOrdonnerOnglets_();
    majTableauDeBord_();
    message = installationRecapitulatif_(rapport, parametres, deplaces);
    journalInfo_(nomFonction, 'Classeur installé ou réparé.', message);
  } catch (e) {
    message = `L'installation s'est arrêtée sur une erreur :\n\n${e.message}\n\n` +
      `Le détail complet est dans l'onglet « ${CONFIG.ONGLETS.JOURNAL.nom} ».`;
    journalErreur_(nomFonction, "Échec de l'installation du classeur.",
      installationDetailErreur_(e));
  }
  viderTamponJournal_();
  installationAlerte_('Installation du classeur', message);
  return message;
}

/**
 * Crée les onglets manquants, complète les colonnes manquantes et applique toute
 * la mise en forme. Ne supprime ni ne déplace jamais une colonne existante.
 * @return {{crees: Array<string>, existants: Array<string>,
 *           colonnes: Array<{onglet: string, colonnes: Array<string>}>}} Ce qui a été fait.
 */
function reparerClasseur_() {
  const classeur = feuillesClasseur_();
  const rapport = { crees: [], existants: [], colonnes: [] };
  Object.keys(CONFIG.ONGLETS).forEach((cle) => {
    const schema = CONFIG.ONGLETS[cle];
    const existait = !!classeur.getSheetByName(schema.nom);
    const feuille = feuille_(schema.nom);
    if (existait) rapport.existants.push(schema.nom);
    else rapport.crees.push(schema.nom);

    const ajoutees = installationCompleterColonnes_(feuille, schema);
    if (ajoutees.length) rapport.colonnes.push({ onglet: schema.nom, colonnes: ajoutees });
    installationHabiller_(feuille, schema);
    installationMiseEnFormeConditionnelle_(feuille, schema);
  });
  journalInfo_('reparerClasseur_',
    `${rapport.crees.length} onglet(s) créé(s), ${rapport.existants.length} déjà présent(s).`,
    rapport.colonnes.map((a) => `${a.onglet} : ${a.colonnes.join(', ')}`).join(' | '));
  return rapport;
}

/**
 * Ajoute, à la fin de l'onglet, les colonnes prévues par le modèle qui manquent.
 * Les colonnes existantes gardent leur place et leur contenu.
 * @param {Sheet} feuille Onglet à compléter.
 * @param {Object} schema Entrée de CONFIG.ONGLETS décrivant l'onglet.
 * @return {Array<string>} Noms des colonnes ajoutées (vide si rien à faire).
 */
function installationCompleterColonnes_(feuille, schema) {
  const entetes = entetesTable_(feuille.getName());
  const manquantes = schema.colonnes
    .map((colonne) => colonne.nom)
    .filter((nom) => entetes.indexOf(nom) < 0);
  if (!manquantes.length) return [];

  const depart = Math.max(feuille.getLastColumn(), 0) + 1;
  const necessaires = depart + manquantes.length - 1;
  if (feuille.getMaxColumns() < necessaires) {
    feuille.insertColumnsAfter(feuille.getMaxColumns(), necessaires - feuille.getMaxColumns());
  }
  feuille.getRange(1, depart, 1, manquantes.length).setValues([manquantes]);
  invaliderCacheFeuille_(feuille.getName());
  journalInfo_('installationCompleterColonnes_',
    `Colonnes ajoutées à « ${schema.nom} ».`, manquantes.join(', '));
  return manquantes;
}

// ---------------------------------------------------------------------------
// Mise en forme d'un onglet
// ---------------------------------------------------------------------------

/**
 * Applique largeurs, formats de nombre et de date, listes déroulantes, en-tête
 * en gras sur fond coloré, note d'aide sur A1 et figeage de la ligne 1.
 * @param {Sheet} feuille Onglet à habiller.
 * @param {Object} schema Entrée de CONFIG.ONGLETS décrivant l'onglet.
 * @return {void}
 */
function installationHabiller_(feuille, schema) {
  const entetes = entetesTable_(feuille.getName());
  const nbLignes = feuille.getMaxRows() - 1;
  schema.colonnes.forEach((colonne) => {
    const index = entetes.indexOf(colonne.nom) + 1;
    if (index < 1) return;
    if (colonne.largeur && feuille.getColumnWidth(index) !== colonne.largeur) {
      feuille.setColumnWidth(index, colonne.largeur);
    }
    if (nbLignes > 0) installationFormatColonne_(feuille, schema, colonne, index, nbLignes);
  });
  installationEntete_(feuille, schema, entetes.length);
  if (feuille.getFrozenRows() !== 1) feuille.setFrozenRows(1);
}

/**
 * Formate une colonne de données (de la ligne 2 au bas de l'onglet).
 * Les colonnes de texte passent en format « texte brut » : c'est ce qui empêche
 * Google de transformer une période « 2026-06 » en date.
 * @param {Sheet} feuille Onglet concerné.
 * @param {Object} schema Entrée de CONFIG.ONGLETS.
 * @param {Object} colonne Descripteur de colonne (nom, type, liste, largeur).
 * @param {number} index Numéro réel de la colonne dans l'onglet (1-indexé).
 * @param {number} nbLignes Nombre de lignes à formater sous l'en-tête.
 * @return {void}
 */
function installationFormatColonne_(feuille, schema, colonne, index, nbLignes) {
  const plage = feuille.getRange(2, index, nbLignes, 1);
  if (colonne.type === 'montant') {
    plage.setNumberFormat(CONFIG.FORMAT_MONTANT).setHorizontalAlignment('right');
  } else if (colonne.type === 'nombre') {
    plage.setNumberFormat('#,##0.##').setHorizontalAlignment('right');
  } else if (colonne.type === 'date') {
    plage.setNumberFormat(schema.nom === CONFIG.ONGLETS.JOURNAL.nom
      ? CONFIG.FORMAT_HORODATAGE
      : CONFIG.FORMAT_DATE);
  } else {
    plage.setNumberFormat('@');
  }
  if (Number(colonne.largeur) >= INSTALLATION_LARGEUR_TEXTE_LONG_) {
    plage.setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  }
  if (colonne.type === 'liste' && colonne.liste && colonne.liste.length) {
    plage.setDataValidation(installationValidation_(colonne));
  }
}

/**
 * Construit la liste déroulante d'une colonne. La saisie d'une autre valeur est
 * signalée mais pas bloquée : on n'empêche jamais l'utilisateur d'écrire.
 * @param {Object} colonne Descripteur de colonne, avec sa propriété `liste`.
 * @return {DataValidation} La règle de validation à poser.
 */
function installationValidation_(colonne) {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList(colonne.liste, true)
    .setAllowInvalid(true)
    .setHelpText(`Valeurs attendues dans « ${colonne.nom} » : ${colonne.liste.join(', ')}.`)
    .build();
}

/**
 * Met la ligne 1 en gras sur fond coloré et pose la note d'aide sur la cellule A1.
 * @param {Sheet} feuille Onglet concerné.
 * @param {Object} schema Entrée de CONFIG.ONGLETS.
 * @param {number} nbColonnes Nombre de colonnes à habiller.
 * @return {void}
 */
function installationEntete_(feuille, schema, nbColonnes) {
  const largeur = Math.max(Number(nbColonnes) || 0, 1);
  feuille.getRange(1, 1, 1, largeur)
    .setFontWeight('bold')
    .setFontColor(INSTALLATION_TEXTE_ENTETE_)
    .setBackground(schema.genere ? INSTALLATION_FOND_ENTETE_GENERE_ : INSTALLATION_FOND_ENTETE_)
    .setVerticalAlignment('middle')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  feuille.getRange(1, 1).setNote(installationNoteAide_(schema));
}

/**
 * Rédige la note d'aide affichée quand on survole la cellule A1 d'un onglet.
 * @param {Object} schema Entrée de CONFIG.ONGLETS.
 * @return {string} Le texte de la note.
 */
function installationNoteAide_(schema) {
  const lignes = [];
  if (schema.aide) lignes.push(schema.aide);
  lignes.push('');
  lignes.push(schema.genere
    ? "Onglet généré par le script : ne saisissez rien ici, il est réécrit automatiquement."
    : "Onglet que vous remplissez. Ne renommez pas les en-têtes de la ligne 1.");
  lignes.push('');
  lignes.push(`Colonnes attendues : ${schema.colonnes.map((c) => c.nom).join(' | ')}`);
  return lignes.join('\n');
}

// ---------------------------------------------------------------------------
// Mises en forme conditionnelles (les couleurs qui se mettent toutes seules)
// ---------------------------------------------------------------------------

/**
 * Applique les couleurs automatiques prévues pour l'onglet, s'il y en a.
 * @param {Sheet} feuille Onglet concerné.
 * @param {Object} schema Entrée de CONFIG.ONGLETS.
 * @return {number} Nombre de règles posées.
 */
function installationMiseEnFormeConditionnelle_(feuille, schema) {
  if (schema.nom === CONFIG.ONGLETS.FACTURES.nom) return installationReglesFactures_(feuille);
  if (schema.nom === CONFIG.ONGLETS.RAPPROCHEMENT.nom) {
    return installationReglesRapprochement_(feuille);
  }
  return 0;
}

/**
 * Colore la colonne « Statut vérification » de l'onglet Factures :
 * vert = conforme, orange = à regarder, rouge = à rejeter.
 * @param {Sheet} feuille Onglet Factures.
 * @return {number} Nombre de règles posées.
 */
function installationReglesFactures_(feuille) {
  const entetes = entetesTable_(feuille.getName());
  const index = entetes.indexOf(installationColonnes_().factureStatutVerif) + 1;
  const nbLignes = feuille.getMaxRows() - 1;
  if (index < 1 || nbLignes < 1) return 0;

  const plage = feuille.getRange(2, index, nbLignes, 1);
  const regles = [installationRegleTexte_(plage, STATUT_VERIF.CONFORME, INSTALLATION_VERT_)];
  [STATUT_VERIF.ECART, STATUT_VERIF.A_VERIFIER].forEach((valeur) => {
    regles.push(installationRegleTexte_(plage, valeur, INSTALLATION_ORANGE_));
  });
  [STATUT_VERIF.DOUBLON, STATUT_VERIF.SANS_BILAN, STATUT_VERIF.REJETEE].forEach((valeur) => {
    regles.push(installationRegleTexte_(plage, valeur, INSTALLATION_ROUGE_));
  });
  return installationRemplacerRegles_(feuille, [index], regles);
}

/**
 * Colore la colonne « Verdict » de l'onglet Rapprochement et met en rouge tout
 * écart différent de zéro.
 * @param {Sheet} feuille Onglet Rapprochement.
 * @return {number} Nombre de règles posées.
 */
function installationReglesRapprochement_(feuille) {
  const colonnesConfig = installationColonnes_();
  const entetes = entetesTable_(feuille.getName());
  const nbLignes = feuille.getMaxRows() - 1;
  if (nbLignes < 1) return 0;

  const iVerdict = entetes.indexOf(colonnesConfig.rapprochementVerdict) + 1;
  const iEcart = entetes.indexOf(colonnesConfig.rapprochementEcart) + 1;
  const colonnes = [];
  const regles = [];
  if (iVerdict > 0) {
    const plage = feuille.getRange(2, iVerdict, nbLignes, 1);
    colonnes.push(iVerdict);
    regles.push(installationRegleTexte_(plage, VERDICT.BALANCE, INSTALLATION_VERT_));
    regles.push(installationRegleTexte_(plage, VERDICT.EXPLIQUE, INSTALLATION_ORANGE_));
    regles.push(installationRegleTexte_(plage, VERDICT.INEXPLIQUE, INSTALLATION_ROUGE_));
    regles.push(installationRegleTexte_(plage, VERDICT.NON_DECLARE, INSTALLATION_GRIS_));
  }
  if (iEcart > 0) {
    colonnes.push(iEcart);
    regles.push(installationRegleEcartNonNul_(feuille, iEcart, nbLignes));
  }
  return colonnes.length ? installationRemplacerRegles_(feuille, colonnes, regles) : 0;
}

/**
 * Règle « cette cellule vaut exactement ce texte → ce fond ».
 * @param {Range} plage Plage sur laquelle la règle s'applique.
 * @param {string} valeur Texte recherché.
 * @param {string} fond Couleur de fond (hexadécimal).
 * @return {ConditionalFormatRule} La règle prête à poser.
 */
function installationRegleTexte_(plage, valeur, fond) {
  return SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(valeur)
    .setBackground(fond)
    .setRanges([plage])
    .build();
}

/**
 * Règle « écart non vide et différent de zéro → rouge gras ». La formule évite
 * de colorer les cellules encore vides.
 * @param {Sheet} feuille Onglet concerné.
 * @param {number} index Numéro de la colonne d'écart (1-indexé).
 * @param {number} nbLignes Nombre de lignes couvertes.
 * @return {ConditionalFormatRule} La règle prête à poser.
 */
function installationRegleEcartNonNul_(feuille, index, nbLignes) {
  const lettre = installationLettreColonne_(index);
  return SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=AND($${lettre}2<>"",$${lettre}2<>0)`)
    .setFontColor(INSTALLATION_ROUGE_TEXTE_)
    .setBold(true)
    .setRanges([feuille.getRange(2, index, nbLignes, 1)])
    .build();
}

/**
 * Remplace les règles de couleur portant sur certaines colonnes, en laissant
 * intactes celles que l'utilisateur a posées ailleurs. C'est ce qui rend
 * l'installation ré-exécutable sans empiler les règles.
 * @param {Sheet} feuille Onglet concerné.
 * @param {Array<number>} colonnes Numéros de colonnes gérés par le script.
 * @param {Array<ConditionalFormatRule>} nouvelles Règles à poser.
 * @return {number} Nombre de règles posées.
 */
function installationRemplacerRegles_(feuille, colonnes, nouvelles) {
  const conservees = feuille.getConditionalFormatRules()
    .filter((regle) => !installationRegleTouche_(regle, colonnes));
  feuille.setConditionalFormatRules(conservees.concat(nouvelles));
  return nouvelles.length;
}

/**
 * Vrai si une règle existante couvre au moins une des colonnes visées.
 * @param {ConditionalFormatRule} regle Règle à examiner.
 * @param {Array<number>} colonnes Numéros de colonnes (1-indexés).
 * @return {boolean}
 */
function installationRegleTouche_(regle, colonnes) {
  const plages = regle.getRanges();
  for (let i = 0; i < plages.length; i++) {
    const debut = plages[i].getColumn();
    const fin = plages[i].getLastColumn();
    for (let j = 0; j < colonnes.length; j++) {
      if (colonnes[j] >= debut && colonnes[j] <= fin) return true;
    }
  }
  return false;
}

/**
 * Convertit un numéro de colonne en lettre ('A', 'B', ... 'AA').
 * @param {number} index Numéro de colonne (1-indexé).
 * @return {string} La lettre de colonne.
 */
function installationLettreColonne_(index) {
  let reste = Math.max(1, Math.round(Number(index) || 1));
  let lettre = '';
  while (reste > 0) {
    const modulo = (reste - 1) % 26;
    lettre = String.fromCharCode(65 + modulo) + lettre;
    reste = Math.floor((reste - 1) / 26);
  }
  return lettre;
}

// ---------------------------------------------------------------------------
// Réglages et ordre des onglets
// ---------------------------------------------------------------------------

/**
 * Garnit l'onglet Paramètres : ajoute les réglages absents avec leur valeur par
 * défaut et leur description. Une valeur déjà saisie n'est JAMAIS écrasée ;
 * une description n'est complétée que si la cellule est vide.
 * @return {{ajoutes: Array<string>, completes: number}} Ce qui a été ajouté ou complété.
 */
function installationRemplirParametres_() {
  const colonnes = installationColonnes_();
  const nom = CONFIG.ONGLETS.PARAMETRES.nom;
  const index = new Map();
  lireTable_(nom).forEach((ligne) => {
    const cle = String(ligne[colonnes.parametreCle] || '').trim();
    if (cle && !index.has(cle)) index.set(cle, ligne);
  });

  const ajouts = [];
  const majs = [];
  Object.keys(CONFIG.PARAMETRES_DEFAUT).forEach((cle) => {
    const defaut = CONFIG.PARAMETRES_DEFAUT[cle];
    const description = CONFIG.DESCRIPTIONS_PARAMETRES[cle] || '';
    const ligne = index.get(cle);
    if (!ligne) {
      const nouvelle = {};
      nouvelle[colonnes.parametreCle] = cle;
      nouvelle[colonnes.parametreValeur] = defaut;
      nouvelle[colonnes.parametreDescription] = description;
      ajouts.push(nouvelle);
      return;
    }
    const patch = {};
    if (installationEstVide_(ligne[colonnes.parametreValeur]) && defaut !== '') {
      patch[colonnes.parametreValeur] = defaut;
    }
    if (installationEstVide_(ligne[colonnes.parametreDescription]) && description) {
      patch[colonnes.parametreDescription] = description;
    }
    if (Object.keys(patch).length) majs.push({ ligne: ligne._ligne, patch: patch });
  });

  if (majs.length) majLignes_(nom, majs);
  if (ajouts.length) ajouterLignes_(nom, ajouts);
  return { ajoutes: ajouts.map((o) => o[colonnes.parametreCle]), completes: majs.length };
}

/**
 * Remet les onglets dans l'ordre défini par ORDRE_ONGLETS. Les onglets que vous
 * avez ajoutés vous-même restent à la suite, sans être touchés.
 * @return {number} Nombre d'onglets déplacés.
 */
function installationOrdonnerOnglets_() {
  const classeur = feuillesClasseur_();
  const actif = classeur.getActiveSheet();
  let deplaces = 0;
  ORDRE_ONGLETS.forEach((nom, position) => {
    const feuille = classeur.getSheetByName(nom);
    if (!feuille || feuille.getIndex() === position + 1) return;
    classeur.setActiveSheet(feuille);
    classeur.moveActiveSheet(position + 1);
    deplaces++;
  });
  if (actif) classeur.setActiveSheet(actif);
  return deplaces;
}

/**
 * Rédige le récapitulatif affiché à la fin de l'installation.
 * @param {Object} rapport Résultat de reparerClasseur_().
 * @param {Object} parametres Résultat de installationRemplirParametres_().
 * @param {number} deplaces Nombre d'onglets remis dans l'ordre.
 * @return {string} Texte lisible, prêt pour l'alerte.
 */
function installationRecapitulatif_(rapport, parametres, deplaces) {
  const lignes = ['Le classeur est prêt.', ''];
  lignes.push(rapport.crees.length
    ? `Onglets créés (${rapport.crees.length}) : ${rapport.crees.join(', ')}`
    : 'Onglets créés : aucun, tout était déjà en place.');
  lignes.push(rapport.existants.length
    ? `Onglets déjà présents (${rapport.existants.length}) : ${rapport.existants.join(', ')}`
    : 'Onglets déjà présents : aucun.');
  if (rapport.colonnes.length) {
    lignes.push('');
    lignes.push("Colonnes ajoutées (aucune donnée existante n'a été touchée) :");
    rapport.colonnes.forEach((ajout) => {
      lignes.push(`   • ${ajout.onglet} : ${ajout.colonnes.join(', ')}`);
    });
  }
  lignes.push('');
  lignes.push(parametres.ajoutes.length
    ? `Réglages ajoutés (${parametres.ajoutes.length}) : ${parametres.ajoutes.join(', ')}`
    : 'Réglages : tous déjà présents, vos valeurs ont été conservées.');
  if (parametres.completes) {
    lignes.push(`Réglages complétés (valeur ou description vide) : ${parametres.completes}.`);
  }
  if (deplaces) lignes.push(`Onglets remis dans l'ordre : ${deplaces}.`);
  lignes.push('');
  lignes.push("Vous pouvez relancer cette commande autant de fois que vous voulez : " +
    "elle n'ajoute que ce qui manque et n'efface jamais rien.");
  return lignes.join('\n');
}

// ---------------------------------------------------------------------------
// Automatisation : les déclencheurs
// ---------------------------------------------------------------------------

/**
 * Met l'automatisation en marche. Les anciens déclencheurs sont d'abord retirés
 * pour éviter les doublons, puis trois sont créés : l'import Gmail toutes les
 * heures, la préparation des bilans une fois par mois (déclencheur quotidien qui
 * ne fait rien les autres jours) et le rapprochement au premier jour de chaque
 * trimestre (même principe).
 *
 * Aucun déclencheur n'est posé sur onOpen : c'est déjà un déclencheur SIMPLE
 * (02_Menu.gs), et en ajouter un installable ferait construire le menu deux fois
 * à chaque ouverture du classeur.
 * @return {string} Le récapitulatif affiché à l'utilisateur.
 */
function installerDeclencheurs() {
  const nomFonction = 'installerDeclencheurs';
  let message = '';
  try {
    const supprimes = supprimerDeclencheurs();
    const params = lireParametres_();
    const jour = installationJourEnvoiBilan_(params);
    ScriptApp.newTrigger('importerFacturesGmail').timeBased().everyHours(1).create();
    ScriptApp.newTrigger('genererEtEnvoyerBilansAuto').timeBased().everyDays(1)
      .atHour(INSTALLATION_HEURE_BILANS_).inTimezone(CONFIG.FUSEAU).create();
    ScriptApp.newTrigger('rapprochementAutoSiDebutTrimestre').timeBased().everyDays(1)
      .atHour(INSTALLATION_HEURE_RAPPROCHEMENT_).inTimezone(CONFIG.FUSEAU).create();
    message = installationTexteAutomatisation_(jour, supprimes, installationPeriodeBilansAuto_(params));
    journalInfo_(nomFonction, 'Automatisation activée (3 déclencheurs).', message);
  } catch (e) {
    message = `L'automatisation n'a pas pu être activée :\n\n${e.message}\n\n` +
      `Le détail est dans l'onglet « ${CONFIG.ONGLETS.JOURNAL.nom} ».`;
    journalErreur_(nomFonction, "Échec de l'activation de l'automatisation.",
      installationDetailErreur_(e));
  }
  viderTamponJournal_();
  installationAlerte_('Automatisation', message);
  return message;
}

/**
 * Rédige, en français clair, ce que l'automatisation fera désormais.
 * @param {number} jour Jour du mois où les bilans partent.
 * @param {number} supprimes Nombre d'anciens déclencheurs retirés.
 * @param {string} periode Période 'AAAA-MM' que le prochain passage mensuel visera.
 * @return {string} Texte lisible.
 */
function installationTexteAutomatisation_(jour, supprimes, periode) {
  const heureBilans = `${INSTALLATION_HEURE_BILANS_} h`;
  const heureRapprochement = `${INSTALLATION_HEURE_RAPPROCHEMENT_} h`;
  const cible = periode ? ` (période visée aujourd'hui : ${periode})` : '';
  return [
    "L'automatisation est active.",
    '',
    '• Toutes les heures : les nouvelles factures de votre étiquette Gmail sont importées.',
    `• Chaque jour vers ${heureBilans} : si on est le ${jour} du mois, les bilans sont ` +
      `générés puis préparés${cible} (en brouillon tant que MODE_ENVOI reste « Brouillon »).`,
    `• Chaque jour vers ${heureRapprochement} : si on est le premier jour d'un trimestre, ` +
      'le rapprochement complet est lancé.',
    "• À chaque ouverture du classeur : le menu " + CONFIG.MENU + ' est ajouté (déclencheur ' +
      'simple, aucun réglage nécessaire).',
    '',
    supprimes
      ? `${supprimes} ancien(s) déclencheur(s) ont été retirés pour éviter les doublons.`
      : "Aucun ancien déclencheur à retirer.",
    '',
    "Pour tout arrêter : Configuration → Désactiver l'automatisation.",
  ].join('\n');
}

/**
 * Retire tous les déclencheurs du projet. C'est ce qui garantit qu'on ne se
 * retrouve jamais avec deux fois le même traitement automatique.
 * @return {number} Nombre de déclencheurs supprimés.
 */
function supprimerDeclencheurs() {
  const nomFonction = 'supprimerDeclencheurs';
  let supprimes = 0;
  const noms = [];
  try {
    ScriptApp.getProjectTriggers().forEach((declencheur) => {
      noms.push(declencheur.getHandlerFunction());
      ScriptApp.deleteTrigger(declencheur);
      supprimes++;
    });
    journalInfo_(nomFonction, `${supprimes} déclencheur(s) supprimé(s).`, noms.join(', '));
  } catch (e) {
    journalErreur_(nomFonction, 'Impossible de supprimer les déclencheurs.',
      installationDetailErreur_(e));
  }
  return supprimes;
}

// ---------------------------------------------------------------------------
// Fonctions d'aiguillage appelées par les déclencheurs quotidiens
// ---------------------------------------------------------------------------

/**
 * Appelée tous les jours par un déclencheur. Elle ne fait quelque chose que le
 * jour du mois choisi dans le réglage JOUR_ENVOI_BILAN : Apps Script ne sait pas
 * planifier « le 5 de chaque mois », alors on vérifie la date et on ressort.
 * @return {string} Ce qui a été fait (ou pourquoi rien n'a été fait).
 */
function genererEtEnvoyerBilansAuto() {
  const nomFonction = 'genererEtEnvoyerBilansAuto';
  let message = '';
  try {
    const jourVoulu = installationJourEnvoiBilan_(lireParametres_());
    const aujourdhui = installationJourDuMois_(new Date());
    if (aujourdhui !== jourVoulu) {
      message = `Rien à faire aujourd'hui : les bilans partent le ${jourVoulu} du mois.`;
    } else {
      journalInfo_(nomFonction, `Jour d'envoi des bilans (${jourVoulu}) : lancement automatique.`, '');
      message = installationExecuterBilans_();
      journalInfo_(nomFonction, 'Passage mensuel terminé.', message);
    }
  } catch (e) {
    message = `Échec du passage automatique : ${e.message}`;
    journalErreur_(nomFonction, 'Échec du passage mensuel des bilans.',
      installationDetailErreur_(e));
  }
  viderTamponJournal_();
  return message;
}

/**
 * Enchaîne la génération puis l'envoi des bilans, en isolant les erreurs :
 * si la génération échoue, on le sait, et l'envoi est quand même tenté.
 *
 * La période visée est explicite (réglage PERIODE_BILAN_AUTO) : avec le réglage
 * par défaut (« Mois précédent », jour d'envoi = 1), le passage du 1er juillet
 * doit produire les bilans de juin, pas ceux d'un mois de juillet encore vide.
 * @return {string} Résumé des deux étapes.
 */
function installationExecuterBilans_() {
  const periode = installationPeriodeBilansAuto_(lireParametres_());
  const etapes = [];
  etapes.push(installationLancer_(`genererBilans (${periode})`,
    typeof genererBilans === 'function' ? () => genererBilans(periode) : null));
  installationVerifierBilansGeneres_(periode);
  etapes.push(installationLancer_('envoyerBilans',
    typeof envoyerBilans === 'function' ? envoyerBilans : null));
  return etapes.join(' ; ');
}

/**
 * Période 'AAAA-MM' que le passage mensuel automatique doit traiter, d'après le
 * réglage PERIODE_BILAN_AUTO (« Mois précédent » par défaut, ou « Mois courant »).
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {string} Période visée, ex. '2026-06'.
 */
function installationPeriodeBilansAuto_(params) {
  if (typeof periodeCourante_ !== 'function') return '';
  const reglage = texteNormalise_(
    (params || {}).PERIODE_BILAN_AUTO || CONFIG.PARAMETRES_DEFAUT.PERIODE_BILAN_AUTO);
  if (reglage === texteNormalise_('Mois courant')) return periodeCourante_();
  if (typeof periodePrecedente_ !== 'function') return periodeCourante_();
  return periodePrecedente_() || periodeCourante_();
}

/**
 * Signale au Journal le cas le plus trompeur du passage automatique : des lignes
 * existent bien pour la période visée, mais aucun bilan n'a été produit. Sans
 * cet AVERT, l'automatisation ne fait rien et ne le dit nulle part.
 * @param {string} periode Période 'AAAA-MM' que la génération vient de traiter.
 * @return {void}
 */
function installationVerifierBilansGeneres_(periode) {
  if (!periode) return;
  try {
    const colLignes = CONFIG.ONGLETS.LIGNES_BILAN.colonnes[2].nom; // Période
    const colBilans = CONFIG.ONGLETS.BILANS.colonnes[3].nom;       // Période
    const lignes = installationCompterPeriode_(
      lireTable_(CONFIG.ONGLETS.LIGNES_BILAN.nom), colLignes, periode);
    if (!lignes) return;
    const bilans = installationCompterPeriode_(
      lireTable_(CONFIG.ONGLETS.BILANS.nom), colBilans, periode);
    if (bilans) return;
    journalAvert_('genererEtEnvoyerBilansAuto',
      `Aucun bilan produit pour la période ${periode}, alors que ` +
      `${lignes} ligne(s) y figurent dans l'onglet ${CONFIG.ONGLETS.LIGNES_BILAN.nom}.`,
      "Vérifiez le réglage PERIODE_BILAN_AUTO, la colonne « ID client » de ces lignes, " +
      `et la colonne « Actif » de l'onglet ${CONFIG.ONGLETS.CLIENTS.nom}.`);
  } catch (e) {
    journalErreur_('installationVerifierBilansGeneres_',
      "Le contrôle « zéro bilan produit » n'a pas pu être fait.",
      installationDetailErreur_(e));
  }
}

/**
 * Compte les lignes d'une table dont la colonne de période vaut la période visée.
 * @param {Array<Object>} objets Lignes lues par lireTable_().
 * @param {string} champ Nom de la colonne de période.
 * @param {string} periode Période 'AAAA-MM' recherchée.
 * @return {number} Nombre de lignes correspondantes.
 */
function installationCompterPeriode_(objets, champ, periode) {
  let n = 0;
  (objets || []).forEach((objet) => {
    const valeur = objet ? objet[champ] : '';
    const normalisee = (typeof bilansPeriodeValide_ === 'function')
      ? bilansPeriodeValide_(valeur)
      : String(valeur === null || valeur === undefined ? '' : valeur).trim();
    if (normalisee === periode) n++;
  });
  return n;
}

/**
 * Appelée tous les jours par un déclencheur. Elle ne fait quelque chose que le
 * premier jour d'un trimestre (selon le réglage TRIMESTRE_DECALAGE_MOIS).
 * @return {string} Ce qui a été fait (ou pourquoi rien n'a été fait).
 */
function rapprochementAutoSiDebutTrimestre() {
  const nomFonction = 'rapprochementAutoSiDebutTrimestre';
  let message = '';
  try {
    const decalage = parametreNombre_(lireParametres_(), 'TRIMESTRE_DECALAGE_MOIS', 0);
    if (!installationEstDebutTrimestre_(new Date(), decalage)) {
      message = "Rien à faire aujourd'hui : le rapprochement est lancé le premier jour " +
        'de chaque trimestre.';
    } else {
      journalInfo_(nomFonction, "Premier jour du trimestre : rapprochement automatique.", '');
      message = installationLancer_('rapprochementTrimestriel',
        typeof rapprochementTrimestriel === 'function' ? rapprochementTrimestriel : null);
      journalInfo_(nomFonction, 'Rapprochement automatique terminé.', message);
    }
  } catch (e) {
    message = `Échec du rapprochement automatique : ${e.message}`;
    journalErreur_(nomFonction, 'Échec du rapprochement automatique.',
      installationDetailErreur_(e));
  }
  viderTamponJournal_();
  return message;
}

/**
 * Vrai si la date est le premier jour d'un trimestre.
 * @param {Date} date Date à tester.
 * @param {number} decalageMois Décalage de l'exercice, en mois (0 = année civile).
 * @return {boolean}
 */
function installationEstDebutTrimestre_(date, decalageMois) {
  if (installationJourDuMois_(date) !== 1) return false;
  const decalage = ((Math.round(Number(decalageMois) || 0) % 3) + 3) % 3;
  const mois = installationMoisDeLAnnee_(date);
  return ((((mois - 1 - decalage) % 3) + 3) % 3) === 0;
}

/**
 * Jour du mois, lu dans le fuseau horaire du projet.
 * @param {Date} date Date à lire.
 * @return {number} Jour de 1 à 31.
 */
function installationJourDuMois_(date) {
  try {
    return Number(Utilities.formatDate(date, CONFIG.FUSEAU, 'd'));
  } catch (e) {
    return date.getDate();
  }
}

/**
 * Mois de l'année, lu dans le fuseau horaire du projet.
 * @param {Date} date Date à lire.
 * @return {number} Mois de 1 à 12.
 */
function installationMoisDeLAnnee_(date) {
  try {
    return Number(Utilities.formatDate(date, CONFIG.FUSEAU, 'M'));
  } catch (e) {
    return date.getMonth() + 1;
  }
}

/**
 * Jour du mois choisi pour l'envoi des bilans, ramené entre 1 et 28.
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {number} Jour de 1 à 28.
 */
function installationJourEnvoiBilan_(params) {
  const jour = Math.round(parametreNombre_(params, 'JOUR_ENVOI_BILAN', 1));
  if (!jour || jour < 1) return 1;
  return jour > 28 ? 28 : jour;
}

// ---------------------------------------------------------------------------
// Tableau de bord
// ---------------------------------------------------------------------------

/**
 * Régénère entièrement l'onglet Tableau de bord : compteurs par statut, montants
 * en attente, écarts non résolus du dernier trimestre, date de dernière
 * exécution et quota de courriels restant.
 * @return {number} Nombre de lignes écrites.
 */
function majTableauDeBord_() {
  const nom = CONFIG.ONGLETS.TABLEAU_DE_BORD.nom;
  try {
    const colonnes = installationColonnes_();
    const lignes = []
      .concat(installationBlocSysteme_(colonnes))
      .concat(installationBlocClients_(colonnes))
      .concat(installationBlocBilans_(colonnes))
      .concat(installationBlocFactures_(colonnes))
      .concat(installationBlocPaiements_(colonnes))
      .concat(installationBlocRapprochement_(colonnes));
    installationViderTableauDeBord_(nom);
    ajouterLignes_(nom, lignes);
    installationHabillerTableauDeBord_(nom, lignes, colonnes);
    journalInfo_('majTableauDeBord_',
      `Tableau de bord régénéré (${lignes.length} lignes).`, '');
    return lignes.length;
  } catch (e) {
    journalErreur_('majTableauDeBord_', "Le tableau de bord n'a pas pu être régénéré.",
      installationDetailErreur_(e));
    return 0;
  }
}

/**
 * Efface le contenu du tableau de bord sous l'en-tête. C'est un onglet généré :
 * il ne contient aucune saisie humaine.
 * @param {string} nom Nom de l'onglet.
 * @return {void}
 */
function installationViderTableauDeBord_(nom) {
  const feuille = feuille_(nom);
  const derniere = feuille.getLastRow();
  if (derniere > 1) {
    const plage = feuille.getRange(2, 1, derniere - 1, Math.max(feuille.getLastColumn(), 1));
    plage.clearContent();
    plage.setFontWeight('normal').setBackground(null);
  }
  invaliderCacheFeuille_(nom);
}

/**
 * Met les lignes de titre du tableau de bord en gras sur fond gris, en deux
 * écritures groupées (jamais une cellule à la fois).
 * @param {string} nom Nom de l'onglet.
 * @param {Array<Object>} lignes Lignes qui viennent d'être écrites.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {void}
 */
function installationHabillerTableauDeBord_(nom, lignes, colonnes) {
  if (!lignes.length) return;
  const feuille = feuille_(nom);
  const nbColonnes = CONFIG.ONGLETS.TABLEAU_DE_BORD.colonnes.length;
  const poids = [];
  const fonds = [];
  lignes.forEach((ligne) => {
    const section = installationEstVide_(ligne[colonnes.tdbValeur]) &&
      String(ligne[colonnes.tdbIndicateur] || '').indexOf('—') === 0;
    const rangeePoids = [];
    const rangeeFonds = [];
    for (let i = 0; i < nbColonnes; i++) {
      rangeePoids.push(section ? 'bold' : 'normal');
      rangeeFonds.push(section ? INSTALLATION_FOND_SECTION_ : INSTALLATION_FOND_NORMAL_);
    }
    poids.push(rangeePoids);
    fonds.push(rangeeFonds);
  });
  feuillesGarantirLignes_(feuille, 1 + lignes.length);
  feuillesGarantirColonnes_(feuille, nbColonnes);
  const plage = feuille.getRange(2, 1, lignes.length, nbColonnes);
  plage.setFontWeights(poids);
  plage.setBackgrounds(fonds);
}

/**
 * Bloc « État du système » : dernière exécution, quota de courriels,
 * automatisation, mode d'envoi.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {Array<Object>} Lignes du tableau de bord.
 */
function installationBlocSysteme_(colonnes) {
  const params = lireParametres_();
  const quota = installationQuotaCourriel_();
  const declencheurs = installationCompterDeclencheurs_();
  return [
    installationSectionTdb_(colonnes, 'État du système'),
    installationLigneTdb_(colonnes, 'Dernière mise à jour', installationHorodatage_(new Date()),
      'Cette page est régénérée à chaque exécution du script.'),
    installationLigneTdb_(colonnes, "Courriels encore envoyables aujourd'hui",
      quota === null ? 'inconnu' : quota,
      'Quota quotidien de Google, remis à zéro chaque nuit.'),
    installationLigneTdb_(colonnes, 'Automatisation',
      declencheurs === null ? 'inconnue' : (declencheurs > 0 ? 'Active' : 'Inactive'),
      declencheurs ? `${declencheurs} déclencheur(s) installé(s).`
        : `Menu ${CONFIG.MENU} → Configuration → Activer l'automatisation.`),
    installationLigneTdb_(colonnes, "Mode d'envoi des courriels", params.MODE_ENVOI,
      CONFIG.DESCRIPTIONS_PARAMETRES.MODE_ENVOI),
  ];
}

/**
 * Bloc « Clients » : combien de clients reçoivent un bilan.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {Array<Object>} Lignes du tableau de bord.
 */
function installationBlocClients_(colonnes) {
  const clients = lireTable_(CONFIG.ONGLETS.CLIENTS.nom);
  const parActif = installationCompterPar_(clients, colonnes.clientActif, '');
  const actifs = installationEntree_(parActif, colonnes.clientActifOui).n;
  return [
    installationSectionTdb_(colonnes, 'Vos clients'),
    installationLigneTdb_(colonnes, 'Clients actifs', actifs,
      `${clients.length} client(s) enregistré(s), dont ${clients.length - actifs} inactif(s).`),
  ];
}

/**
 * Bloc « Bilans » : un compteur et un montant par statut.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {Array<Object>} Lignes du tableau de bord.
 */
function installationBlocBilans_(colonnes) {
  const bilans = lireTable_(CONFIG.ONGLETS.BILANS.nom);
  const parStatut = installationCompterPar_(bilans, colonnes.bilanStatut, colonnes.bilanMontant);
  const lignes = [installationSectionTdb_(colonnes, 'Bilans envoyés aux clients')];
  Object.keys(STATUT_BILAN).forEach((cle) => {
    const statut = STATUT_BILAN[cle];
    const entree = installationEntree_(parStatut, statut);
    lignes.push(installationLigneTdb_(colonnes, `Bilans « ${statut} »`, entree.n,
      `Total : ${formaterMontant_(entree.cents)}`));
  });
  return lignes;
}

/**
 * Bloc « Factures » : compteurs par statut de vérification, montant en attente
 * de vérification et montant en attente de paiement.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {Array<Object>} Lignes du tableau de bord.
 */
function installationBlocFactures_(colonnes) {
  const factures = lireTable_(CONFIG.ONGLETS.FACTURES.nom);
  const parStatut = installationCompterPar_(factures, colonnes.factureStatutVerif,
    colonnes.factureMontant);
  const lignes = [installationSectionTdb_(colonnes, 'Factures reçues')];
  Object.keys(STATUT_VERIF).forEach((cle) => {
    const statut = STATUT_VERIF[cle];
    const entree = installationEntree_(parStatut, statut);
    lignes.push(installationLigneTdb_(colonnes, `Factures « ${statut} »`, entree.n,
      `Total : ${formaterMontant_(entree.cents)}`));
  });
  const aVerifier = installationEntree_(parStatut, STATUT_VERIF.A_VERIFIER);
  const aPayer = installationMontantsAPayer_(factures, colonnes);
  lignes.push(installationLigneTdb_(colonnes, 'Montant en attente de vérification',
    formaterMontant_(aVerifier.cents),
    `${aVerifier.n} facture(s) que le script n'a pas encore pu valider.`));
  lignes.push(installationLigneTdb_(colonnes, 'Montant en attente de paiement',
    formaterMontant_(aPayer.nonPayee.cents),
    `${aPayer.nonPayee.n} facture(s) conforme(s) pas encore payée(s).`));
  lignes.push(installationLigneTdb_(colonnes, 'Montant dans le lot de paiement en cours',
    formaterMontant_(aPayer.aPayer.cents),
    `${aPayer.aPayer.n} facture(s) marquée(s) « ${STATUT_PAIEMENT.A_PAYER} ».`));
  return lignes;
}

/**
 * Additionne les factures conformes qui restent à payer, en cents entiers.
 * @param {Array<Object>} factures Lignes de l'onglet Factures.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {{nonPayee: {n: number, cents: number}, aPayer: {n: number, cents: number}}}
 */
function installationMontantsAPayer_(factures, colonnes) {
  const resultat = { nonPayee: { n: 0, cents: 0 }, aPayer: { n: 0, cents: 0 } };
  factures.forEach((facture) => {
    const verification = String(facture[colonnes.factureStatutVerif] || '').trim();
    if (verification !== STATUT_VERIF.CONFORME) return;
    const paiement = String(facture[colonnes.factureStatutPaiement] || '').trim();
    const cents = enCents_(facture[colonnes.factureMontant]);
    if (paiement === STATUT_PAIEMENT.A_PAYER) {
      resultat.aPayer.n++;
      resultat.aPayer.cents += cents;
    } else if (paiement !== STATUT_PAIEMENT.PAYEE && paiement !== STATUT_PAIEMENT.ANNULEE) {
      resultat.nonPayee.n++;
      resultat.nonPayee.cents += cents;
    }
  });
  return resultat;
}

/**
 * Bloc « Paiements » : ce qui a été payé, et ce que les clients n'ont pas encore
 * confirmé avoir déduit de leur solde.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {Array<Object>} Lignes du tableau de bord.
 */
function installationBlocPaiements_(colonnes) {
  const paiements = lireTable_(CONFIG.ONGLETS.PAIEMENTS.nom);
  const parDeduction = installationCompterPar_(paiements, colonnes.paiementDeduit,
    colonnes.paiementMontant);
  let total = 0;
  paiements.forEach((paiement) => { total += enCents_(paiement[colonnes.paiementMontant]); });
  const confirmes = installationEntree_(parDeduction, colonnes.paiementDeduitOui);
  const nonConfirmes = paiements.length - confirmes.n;
  return [
    installationSectionTdb_(colonnes, 'Paiements que vous avez faits'),
    installationLigneTdb_(colonnes, 'Paiements enregistrés', paiements.length,
      `Total : ${formaterMontant_(total)}`),
    installationLigneTdb_(colonnes, 'Paiements pas encore confirmés par le client', nonConfirmes,
      `Total non confirmé : ${formaterMontant_(total - confirmes.cents)}`),
  ];
}

/**
 * Bloc « Rapprochement » : l'état du dernier trimestre rapproché et le nombre
 * d'écarts qui restent à régler.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @return {Array<Object>} Lignes du tableau de bord.
 */
function installationBlocRapprochement_(colonnes) {
  const toutes = lireTable_(CONFIG.ONGLETS.RAPPROCHEMENT.nom);
  const periodes = toutes
    .map((ligne) => String(ligne[colonnes.rapprochementPeriode] || '').trim())
    .filter((periode) => periode !== '')
    .sort();
  const derniere = periodes.length ? periodes[periodes.length - 1] : '';
  const lignes = [installationSectionTdb_(colonnes, 'Rapprochement trimestriel')];
  if (!derniere) {
    lignes.push(installationLigneTdb_(colonnes, 'Dernier trimestre rapproché', 'aucun',
      `Lancez le rapprochement depuis le menu ${CONFIG.MENU}.`));
    return lignes;
  }
  const duTrimestre = toutes.filter((ligne) =>
    String(ligne[colonnes.rapprochementPeriode] || '').trim() === derniere);
  const parVerdict = installationCompterPar_(duTrimestre, colonnes.rapprochementVerdict, '');
  const nonResolus = duTrimestre.length -
    installationEntree_(parVerdict, VERDICT.BALANCE).n;
  lignes.push(installationLigneTdb_(colonnes, 'Dernier trimestre rapproché', derniere,
    `${duTrimestre.length} client(s) analysé(s), ` +
    `${installationEntree_(parVerdict, VERDICT.BALANCE).n} balancé(s).`));
  lignes.push(installationLigneTdb_(colonnes, 'Écarts non résolus', nonResolus,
    installationDetailVerdicts_(parVerdict)));
  return lignes;
}

/**
 * Détaille les verdicts autres que « balancé », pour la ligne des écarts.
 * @param {Map} parVerdict Comptage renvoyé par installationCompterPar_().
 * @return {string} Texte lisible.
 */
function installationDetailVerdicts_(parVerdict) {
  return [VERDICT.EXPLIQUE, VERDICT.INEXPLIQUE, VERDICT.NON_DECLARE]
    .map((verdict) => `${installationEntree_(parVerdict, verdict).n} × ${verdict}`)
    .join('   ');
}

// ---------------------------------------------------------------------------
// Petits utilitaires du module
// ---------------------------------------------------------------------------

/**
 * Noms de colonnes utilisés par ce module, lus une seule fois depuis CONFIG.
 * Les regrouper ici évite de disperser des positions dans tout le fichier :
 * si l'ordre des colonnes change dans 00_Config.gs, c'est le seul endroit à relire.
 * @return {Object} Dictionnaire de noms de colonnes.
 */
function installationColonnes_() {
  const onglets = CONFIG.ONGLETS;
  return {
    clientActif: onglets.CLIENTS.colonnes[4].nom,                 // Actif
    clientActifOui: onglets.CLIENTS.colonnes[4].liste[0],         // Oui
    bilanMontant: onglets.BILANS.colonnes[6].nom,                 // Montant du bilan
    bilanStatut: onglets.BILANS.colonnes[8].nom,                  // Statut
    factureMontant: onglets.FACTURES.colonnes[8].nom,             // Montant total
    factureStatutVerif: onglets.FACTURES.colonnes[10].nom,        // Statut vérification
    factureStatutPaiement: onglets.FACTURES.colonnes[12].nom,     // Statut paiement
    paiementMontant: onglets.PAIEMENTS.colonnes[5].nom,           // Montant
    paiementDeduit: onglets.PAIEMENTS.colonnes[8].nom,            // Déduit par le client
    paiementDeduitOui: onglets.PAIEMENTS.colonnes[8].liste[1],    // Oui
    rapprochementPeriode: onglets.RAPPROCHEMENT.colonnes[0].nom,  // Période
    rapprochementEcart: onglets.RAPPROCHEMENT.colonnes[5].nom,    // Écart
    rapprochementVerdict: onglets.RAPPROCHEMENT.colonnes[6].nom,  // Verdict
    parametreCle: onglets.PARAMETRES.colonnes[0].nom,             // Clé
    parametreValeur: onglets.PARAMETRES.colonnes[1].nom,          // Valeur
    parametreDescription: onglets.PARAMETRES.colonnes[2].nom,     // Description
    tdbIndicateur: onglets.TABLEAU_DE_BORD.colonnes[0].nom,       // Indicateur
    tdbValeur: onglets.TABLEAU_DE_BORD.colonnes[1].nom,           // Valeur
    tdbDetail: onglets.TABLEAU_DE_BORD.colonnes[2].nom,           // Détail
  };
}

/**
 * Compte les lignes par valeur d'une colonne, et additionne un montant en cents.
 * @param {Array<Object>} objets Lignes lues par lireTable_().
 * @param {string} champCle Colonne qui sert de clé de regroupement.
 * @param {string} [champMontant] Colonne de montant à additionner (facultatif).
 * @return {Map<string, {n: number, cents: number}>} Comptage par valeur.
 */
function installationCompterPar_(objets, champCle, champMontant) {
  const compte = new Map();
  (objets || []).forEach((objet) => {
    const brut = objet[champCle];
    const cle = String(brut === null || brut === undefined ? '' : brut).trim();
    const entree = compte.get(cle) || { n: 0, cents: 0 };
    entree.n += 1;
    if (champMontant) entree.cents += enCents_(objet[champMontant]);
    compte.set(cle, entree);
  });
  return compte;
}

/**
 * Lit une entrée du comptage, avec des zéros par défaut.
 * @param {Map<string, {n: number, cents: number}>} compte Comptage.
 * @param {string} cle Valeur cherchée.
 * @return {{n: number, cents: number}}
 */
function installationEntree_(compte, cle) {
  return compte.get(cle) || { n: 0, cents: 0 };
}

/**
 * Construit une ligne du tableau de bord.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @param {string} indicateur Libellé affiché.
 * @param {*} valeur Valeur affichée.
 * @param {string} [detail] Explication en clair.
 * @return {Object} Ligne prête pour ajouterLignes_().
 */
function installationLigneTdb_(colonnes, indicateur, valeur, detail) {
  const ligne = {};
  ligne[colonnes.tdbIndicateur] = indicateur;
  ligne[colonnes.tdbValeur] = (valeur === null || valeur === undefined) ? '' : valeur;
  ligne[colonnes.tdbDetail] = detail || '';
  return ligne;
}

/**
 * Construit une ligne de titre du tableau de bord.
 * @param {Object} colonnes Noms de colonnes renvoyés par installationColonnes_().
 * @param {string} titre Titre de la section.
 * @return {Object} Ligne prête pour ajouterLignes_().
 */
function installationSectionTdb_(colonnes, titre) {
  return installationLigneTdb_(colonnes, `— ${titre} —`, '', '');
}

/**
 * Nombre de courriels que Google accepte encore d'envoyer aujourd'hui.
 * @return {number|null} Le quota restant, ou null s'il est illisible.
 */
function installationQuotaCourriel_() {
  try {
    if (typeof quotaCourrielRestant_ === 'function') return quotaCourrielRestant_();
    return MailApp.getRemainingDailyQuota();
  } catch (e) {
    journalAvert_('installationQuotaCourriel_', 'Quota de courriels illisible.',
      installationDetailErreur_(e));
    return null;
  }
}

/**
 * Nombre de déclencheurs installés sur le projet.
 * @return {number|null} Le nombre, ou null si l'information est inaccessible.
 */
function installationCompterDeclencheurs_() {
  try {
    return ScriptApp.getProjectTriggers().length;
  } catch (e) {
    return null;
  }
}

/**
 * Appelle une fonction d'un autre module en isolant ses erreurs : un échec ne
 * doit jamais empêcher la suite d'un traitement automatique.
 * @param {string} nom Nom de la fonction, pour le journal.
 * @param {Function|null} appel La fonction elle-même, ou null si absente.
 * @return {string} Ce qui s'est passé, en clair.
 */
function installationLancer_(nom, appel) {
  if (typeof appel !== 'function') {
    journalAvert_('installationLancer_', `La fonction ${nom} est absente : étape ignorée.`, '');
    return `${nom} : étape ignorée (fonction absente)`;
  }
  try {
    appel();
    return `${nom} : fait`;
  } catch (e) {
    journalErreur_('installationLancer_', `Échec de ${nom}.`, installationDetailErreur_(e));
    return `${nom} : échec (${e.message})`;
  }
}

/**
 * Met une erreur à plat pour le journal : message ET pile d'appels.
 * @param {*} e Erreur attrapée.
 * @return {string} Texte à journaliser.
 */
function installationDetailErreur_(e) {
  if (!e) return '';
  const message = e.message === undefined ? String(e) : e.message;
  const pile = e.stack === undefined ? '' : e.stack;
  return `${message}\n${pile}`.trim();
}

/**
 * Vrai si la valeur est vide (rien, chaîne vide ou seulement des espaces).
 * @param {*} valeur Valeur à tester.
 * @return {boolean}
 */
function installationEstVide_(valeur) {
  if (valeur === null || valeur === undefined) return true;
  return String(valeur).trim() === '';
}

/**
 * Horodatage lisible « AAAA-MM-JJ HH:MM », dans le fuseau du projet.
 * @param {Date} date Date à formater.
 * @return {string} Texte lisible.
 */
function installationHorodatage_(date) {
  try {
    return Utilities.formatDate(date, CONFIG.FUSEAU, 'yyyy-MM-dd HH:mm');
  } catch (e) {
    return formaterDate_(date);
  }
}

/**
 * Affiche un message à l'utilisateur, s'il y a bien quelqu'un devant l'écran.
 *
 * Deux cas où l'on n'ouvre pas de fenêtre, et ce n'est pas une erreur :
 *   - l'appel vient du menu : c'est executer_() (02_Menu.gs) qui affiche déjà le
 *     texte renvoyé, une deuxième fenêtre identique n'apporterait rien ;
 *   - l'appel vient d'un déclencheur : il n'y a tout simplement pas d'interface,
 *     et SpreadsheetApp.getUi() lève, ce que le catch absorbe.
 * Dans les deux cas le récapitulatif reste renvoyé par la fonction et écrit
 * dans le Journal. Reste le cas visé ici : installer() lancé À LA MAIN depuis
 * l'éditeur Apps Script, comme le README l'indique au premier démarrage. Là,
 * la fenêtre s'ouvre bel et bien.
 * @param {string} titre Titre de la fenêtre.
 * @param {string} message Texte affiché.
 * @return {void}
 */
function installationAlerte_(titre, message) {
  if (installationAppelDepuisMenu_()) return;
  try {
    const ui = SpreadsheetApp.getUi();
    ui.alert(titre, message, ui.ButtonSet.OK);
  } catch (e) {
    journalSecours_('installationAlerte_', `${titre}\n${message}`);
  }
}

/**
 * Vrai si l'exécution en cours passe par le menu, c'est-à-dire si executer_()
 * (02_Menu.gs) est présent dans la pile d'appels — c'est lui qui affichera le
 * résultat. Tester `typeof executer_ === 'function'` ne dit rien : la fonction
 * est globale et donc toujours présente dans un projet complet.
 *
 * Si la pile n'est pas lisible, on considère qu'on n'est PAS dans le menu :
 * mieux vaut une fenêtre de trop qu'un utilisateur qui ne voit rien.
 * @return {boolean} Vrai quand une action du menu est en cours.
 */
function installationAppelDepuisMenu_() {
  try {
    const pile = String(new Error().stack || '');
    return pile.indexOf('executer_') >= 0 || pile.indexOf('menuAppeler_') >= 0;
  } catch (e) {
    return false;
  }
}

// ===========================================================================
// ▼ src/02_Menu.gs   (module 3 sur 11)
// ===========================================================================
/**
 * 02_Menu.gs — Le menu « 📋 Automatisation » et tous les points d'entrée humains.
 *
 * Ce fichier ne contient AUCUNE logique métier. Il numérote les actions dans
 * l'ordre réel du travail, annonce ce qui va se passer (combien d'éléments,
 * mode Brouillon ou Direct), demande confirmation avant tout envoi de courriel
 * ou tout changement de statut en masse, puis délègue au module concerné.
 *
 * Tous les points d'entrée passent par executer_() : trace de début, exécution,
 * capture des erreurs (message ET pile dans l'onglet Journal, jamais à l'écran),
 * vidage du tampon du journal dans tous les cas, puis une alerte finale rédigée
 * pour quelqu'un qui n'est pas informaticien.
 */

/**
 * Colonnes lues par les compteurs du menu. Les noms viennent tous de CONFIG :
 * aucun en-tête n'est écrit en dur ici.
 */
const MENU_COL_ = {
  BILAN_STATUT: CONFIG.ONGLETS.BILANS.colonnes[8].nom,              // Statut
  BILAN_MONTANT: CONFIG.ONGLETS.BILANS.colonnes[6].nom,             // Montant du bilan
  FACTURE_ID: CONFIG.ONGLETS.FACTURES.colonnes[0].nom,              // ID facture
  FACTURE_CLIENT: CONFIG.ONGLETS.FACTURES.colonnes[1].nom,          // ID client
  FACTURE_VERIFICATION: CONFIG.ONGLETS.FACTURES.colonnes[10].nom,   // Statut vérification
  FACTURE_PAIEMENT: CONFIG.ONGLETS.FACTURES.colonnes[12].nom,       // Statut paiement
  FACTURE_TOTAL: CONFIG.ONGLETS.FACTURES.colonnes[8].nom,           // Montant total
  RAPPROCHEMENT_PERIODE: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[0].nom,
  RAPPROCHEMENT_VERDICT: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[6].nom,
};

// ---------------------------------------------------------------------------
// Construction du menu
// ---------------------------------------------------------------------------

/**
 * Ajoute le menu du classeur à chaque ouverture. Ne doit jamais échouer :
 * si le classeur n'est pas encore installé, le menu s'affiche quand même et
 * propose l'installation en premier.
 * @param {Object} [e] Événement d'ouverture fourni par Google (non utilisé).
 * @return {void}
 */
function onOpen(e) {
  try {
    const ui = SpreadsheetApp.getUi();
    menuConstruire_(ui).addToUi();
  } catch (erreur) {
    menuSecours_(erreur);
  }
}

/**
 * Construit le menu complet, dans l'ordre réel du travail.
 * @param {Object} ui Interface renvoyée par SpreadsheetApp.getUi().
 * @return {Object} Le menu, prêt à recevoir addToUi().
 */
function menuConstruire_(ui) {
  const menu = ui.createMenu(CONFIG.MENU);
  if (!menuClasseurInstalle_()) {
    menu.addItem('⚠️ Commencer ici : installer le classeur', 'menuInstaller');
    menu.addSeparator();
  }
  menu.addItem('1. Générer les bilans du mois', 'menuGenererBilans');
  menu.addItem('2. Envoyer les bilans', 'menuEnvoyerBilans');
  menu.addItem('3. Importer les factures reçues (Gmail)', 'menuImporterFactures');
  menu.addItem('4. Vérifier les factures', 'menuVerifierFactures');
  menu.addItem('5. Préparer le lot de paiements', 'menuPreparerLotPaiements');
  menu.addItem('6. Confirmer les paiements du lot', 'menuConfirmerLotPaiements');
  menu.addItem('Annuler le lot de paiements en cours', 'menuAnnulerLotPaiements');
  menu.addSeparator();
  menu.addItem('7. Rapprochement trimestriel', 'menuRapprochementTrimestriel');
  menu.addItem('8. Relancer les clients en écart', 'menuRelancerEcarts');
  menu.addSeparator();
  menu.addSubMenu(ui.createMenu('Configuration')
    .addItem('Installer ou réparer le classeur', 'menuInstaller')
    .addItem("Activer l'automatisation", 'menuActiverAutomatisation')
    .addItem("Désactiver l'automatisation", 'menuDesactiverAutomatisation')
    .addItem('Vider le journal', 'menuViderJournal'));
  menu.addSubMenu(ui.createMenu('Aide')
    .addItem("Mode d'emploi", 'afficherModeEmploi')
    .addItem('Lancer les tests', 'menuLancerTests'));
  return menu;
}

/**
 * Menu minimal, posé quand la construction normale a échoué : l'utilisateur
 * garde toujours de quoi installer le classeur et lire l'aide.
 * @param {*} erreur Erreur d'origine, tracée dans le journal d'exécution.
 * @return {void}
 */
function menuSecours_(erreur) {
  journalSecours_('onOpen', erreur);
  try {
    SpreadsheetApp.getUi().createMenu(CONFIG.MENU)
      .addItem('Installer ou réparer le classeur', 'menuInstaller')
      .addItem("Mode d'emploi", 'afficherModeEmploi')
      .addToUi();
  } catch (e) {
    journalSecours_('onOpen', e);
  }
}

/**
 * Dit si le classeur a déjà été installé, sans rien créer : on regarde
 * simplement si l'onglet Paramètres existe. (Seul endroit du module qui touche
 * SpreadsheetApp : toute lecture de données passe par 03_Feuilles.gs.)
 * @return {boolean} Vrai si le classeur semble installé.
 */
function menuClasseurInstalle_() {
  try {
    const classeur = SpreadsheetApp.getActiveSpreadsheet();
    if (!classeur) return false;
    return !!classeur.getSheetByName(CONFIG.ONGLETS.PARAMETRES.nom);
  } catch (e) {
    return false;
  }
}

/**
 * Interrompt une action avec un message clair si le classeur n'est pas installé.
 * @return {void}
 */
function menuExigerInstallation_() {
  if (menuClasseurInstalle_()) return;
  throw new Error("Le classeur n'est pas encore préparé. Ouvrez « " + CONFIG.MENU +
    " → Configuration → Installer ou réparer le classeur », puis recommencez cette action.");
}

// ---------------------------------------------------------------------------
// Enveloppe commune à tous les points d'entrée
// ---------------------------------------------------------------------------

/**
 * Exécute une action du menu de bout en bout : journalise le début, exécute,
 * attrape toute erreur (message + pile dans le Journal), vide le tampon du
 * journal dans tous les cas, puis affiche un résultat lisible.
 * @param {string} nom Nom de l'action, tel qu'il apparaît dans le menu.
 * @param {function():*} fn Traitement à exécuter. Peut renvoyer une chaîne ou
 *     un objet {titre, message} qui devient le contenu de l'alerte.
 * @return {*} Ce qu'a renvoyé fn, ou null en cas d'erreur.
 */
function executer_(nom, fn) {
  const debut = new Date();
  let resultat = null;
  let alerte = { titre: '✅ Terminé', message: 'Le traitement est terminé.' };
  try {
    journalInfo_(nom, 'Début du traitement.');
    resultat = fn();
    alerte = menuResultatAlerte_(resultat);
    journalInfo_(nom, `Traitement terminé en ${menuDuree_(debut)}.`, alerte.message);
  } catch (e) {
    const pile = (e && e.stack) ? `${e.message}\n${e.stack}` : e;
    journalErreur_(nom, `Échec : ${menuTexteCourt_(e && e.message ? e.message : e, 300)}`, pile);
    alerte = { titre: '❌ Cette action n\'a pas abouti', message: menuMessageErreur_(e) };
    resultat = null;
  } finally {
    try {
      viderTamponJournal_();
    } catch (eJournal) {
      journalSecours_(nom, eJournal);
    }
  }
  menuAlerte_(`${nom} — ${alerte.titre}`, alerte.message);
  return resultat;
}

/**
 * Traduit ce qu'a renvoyé un module en titre et message d'alerte.
 * @param {*} resultat Chaîne, objet {titre, message}, autre objet, ou rien.
 * @return {{titre: string, message: string}} Contenu de l'alerte.
 */
function menuResultatAlerte_(resultat) {
  const titreDefaut = '✅ Terminé';
  if (resultat === null || resultat === undefined || resultat === '') {
    return { titre: titreDefaut, message: 'Le traitement s\'est terminé sans anomalie.' };
  }
  if (typeof resultat === 'string') return { titre: titreDefaut, message: resultat };
  if (typeof resultat === 'object') {
    const titre = resultat.titre ? String(resultat.titre) : titreDefaut;
    if (resultat.message !== null && resultat.message !== undefined) {
      return { titre: titre, message: String(resultat.message) };
    }
    return { titre: titre, message: menuObjetEnTexte_(resultat) };
  }
  return { titre: titreDefaut, message: String(resultat) };
}

/**
 * Met en forme un objet de résultat en lignes « clé : valeur » lisibles.
 * @param {Object} objet Résultat renvoyé par un module.
 * @return {string} Texte affichable, ou un message générique.
 */
function menuObjetEnTexte_(objet) {
  const lignes = [];
  Object.keys(objet).forEach((cle) => {
    if (lignes.length >= 12 || cle.charAt(0) === '_') return;
    const valeur = objet[cle];
    if (valeur === null || valeur === undefined) return;
    if (Array.isArray(valeur)) {
      lignes.push(`${cle} : ${valeur.length}`);
    } else if (typeof valeur !== 'object' && typeof valeur !== 'function') {
      lignes.push(`${cle} : ${menuTexteCourt_(valeur, 120)}`);
    }
  });
  return lignes.length ? lignes.join('\n') : 'Le traitement s\'est terminé sans anomalie.';
}

/**
 * Compose le message affiché quand une action a échoué. Jamais de pile
 * d'exécution à l'écran : elle est dans le Journal.
 * @param {*} e Erreur attrapée.
 * @return {string} Message rassurant et actionnable.
 */
function menuMessageErreur_(e) {
  const brut = (e && e.message) ? String(e.message) : String(e || 'raison inconnue');
  const propre = brut.replace(/\s+/g, ' ').trim();
  return "Le traitement n'a pas pu aller jusqu'au bout.\n\nRaison : " +
    menuTexteCourt_(propre, 400) +
    "\n\nAucune donnée que vous avez saisie n'a été supprimée. Corrigez le point " +
    "signalé, puis relancez la même action : elle peut être relancée sans risque.";
}

/**
 * Durée écoulée depuis un instant donné, en texte court.
 * @param {Date} debut Instant de départ.
 * @return {string} Ex. « 3 s ».
 */
function menuDuree_(debut) {
  const secondes = Math.max(0, Math.round((new Date().getTime() - debut.getTime()) / 1000));
  return `${secondes} s`;
}

// ---------------------------------------------------------------------------
// Dialogues (alerte, confirmation)
// ---------------------------------------------------------------------------

/**
 * Renvoie l'interface du classeur, ou null quand il n'y en a pas (exécution
 * déclenchée automatiquement, ou lancée depuis l'éditeur de script).
 * @return {Object|null} L'objet Ui, ou null.
 */
function menuUi_() {
  try {
    return SpreadsheetApp.getUi();
  } catch (e) {
    return null;
  }
}

/**
 * Affiche le résultat d'une action. Sans interface, le message part dans le
 * journal d'exécution plutôt que de faire échouer le traitement.
 * @param {string} titre Titre de la fenêtre.
 * @param {string} message Message déjà rédigé en français clair.
 * @return {void}
 */
function menuAlerte_(titre, message) {
  const texte = `${menuTexteCourt_(message, 1200)}\n\n` +
    'Le détail de ce qui a été fait est dans l\'onglet « ' + CONFIG.ONGLETS.JOURNAL.nom + ' ».';
  const ui = menuUi_();
  if (!ui) {
    journalSecours_(titre, texte);
    return;
  }
  try {
    ui.alert(menuTexteCourt_(titre, 120), texte, ui.ButtonSet.OK);
  } catch (e) {
    journalSecours_(titre, e);
  }
}

/**
 * Pose une question Oui/Non avant une action qui envoie des courriels ou qui
 * modifie des statuts en masse. Sans interface, on répond Non (on ne lance
 * jamais un envoi que personne n'a validé).
 * @param {string} titre Titre de la fenêtre.
 * @param {string} question Texte annonçant précisément ce qui va se passer.
 * @return {boolean} Vrai si l'utilisateur a répondu Oui.
 */
function menuConfirmer_(titre, question) {
  const ui = menuUi_();
  if (!ui) {
    journalAvert_('menuConfirmer_', 'Aucune interface disponible : action annulée par sécurité.', titre);
    return false;
  }
  const reponse = ui.alert(menuTexteCourt_(titre, 120), question, ui.ButtonSet.YES_NO);
  return reponse === ui.Button.YES;
}

/**
 * Raccourcit un texte pour l'affichage.
 * @param {*} texte Texte d'origine.
 * @param {number} max Longueur maximale.
 * @return {string} Texte, tronqué avec « … » si nécessaire.
 */
function menuTexteCourt_(texte, max) {
  const brut = (texte === null || texte === undefined) ? '' : String(texte);
  const limite = Number(max) || 500;
  return brut.length > limite ? `${brut.slice(0, limite - 1)}…` : brut;
}

// ---------------------------------------------------------------------------
// Lecture des compteurs annoncés dans les confirmations
// ---------------------------------------------------------------------------

/**
 * Appelle une fonction métier définie dans un autre fichier du projet.
 * Si le fichier n'a pas été copié dans l'éditeur, le message reste
 * compréhensible au lieu d'être une erreur technique.
 * @param {string} nomFonction Nom de la fonction globale à exécuter.
 * @return {*} Ce que renvoie la fonction métier.
 */
function menuAppeler_(nomFonction) {
  const portee = (typeof globalThis !== 'undefined') ? globalThis : this;
  const fn = portee ? portee[nomFonction] : null;
  if (typeof fn !== 'function') {
    throw new Error(`L'action « ${nomFonction} » n'est pas disponible dans ce classeur : ` +
      'le fichier du module correspondant n\'a pas été copié dans l\'éditeur Apps Script. ' +
      'Recopiez tous les fichiers du dossier src, enregistrez, puis rechargez le classeur.');
  }
  return fn();
}

/**
 * Lit un onglet et ne garde que les lignes correspondant à tous les critères.
 * @param {string} nomOnglet Nom de l'onglet (via CONFIG).
 * @param {Array<{colonne: string, valeurs: Array<string>}>} criteres Filtres.
 * @return {Array<Object>} Lignes retenues.
 */
function menuLignesFiltrees_(nomOnglet, criteres) {
  const attendus = (criteres || []).map((critere) => ({
    colonne: critere.colonne,
    valeurs: (critere.valeurs || []).map((valeur) => texteNormalise_(valeur)),
  }));
  return lireTable_(nomOnglet).filter((ligne) => attendus.every(
    (critere) => critere.valeurs.indexOf(texteNormalise_(ligne[critere.colonne])) >= 0));
}

/**
 * Factures que la vérification va réellement traiter. On délègue à
 * facturesAVerifier_ (05_Factures.gs) pour que le compteur annoncé à
 * l'utilisateur ne puisse jamais diverger de ce que fait le moteur. Si le
 * module des factures n'a pas été copié, on retombe sur le filtre par statut.
 * @return {Array<Object>} Les factures à vérifier.
 */
function menuFacturesAVerifier_() {
  const factures = lireTable_(CONFIG.ONGLETS.FACTURES.nom);
  if (typeof facturesAVerifier_ === 'function') return facturesAVerifier_(factures);
  const acceptes = ['', STATUT_VERIF.A_VERIFIER, STATUT_VERIF.SANS_BILAN,
    STATUT_VERIF.ECART, STATUT_VERIF.DOUBLON].map((valeur) => texteNormalise_(valeur));
  return factures.filter((ligne) => {
    if (!String(ligne[MENU_COL_.FACTURE_ID] || '').trim() &&
        !String(ligne[MENU_COL_.FACTURE_CLIENT] || '').trim()) return false;
    return acceptes.indexOf(texteNormalise_(ligne[MENU_COL_.FACTURE_VERIFICATION])) >= 0;
  });
}

/**
 * Additionne une colonne de montants, en cents entiers.
 * @param {Array<Object>} lignes Lignes lues par lireTable_.
 * @param {string} colonne Nom de la colonne de montants.
 * @return {number} Total en cents.
 */
function menuTotalCents_(lignes, colonne) {
  return (lignes || []).reduce((total, ligne) => total + enCents_(ligne[colonne]), 0);
}

/**
 * Décrit le mode d'envoi courant, pour l'annoncer avant tout courriel.
 * @return {string} Phrase prête à afficher.
 */
function menuTexteMode_() {
  const params = lireParametres_();
  const direct = texteNormalise_(params.MODE_ENVOI) === 'DIRECT';
  return direct
    ? 'Mode d\'envoi : DIRECT — les courriels partiront tout de suite chez vos clients.'
    : 'Mode d\'envoi : BROUILLON — les courriels seront seulement préparés dans Gmail, ' +
      'vous les relirez avant de les envoyer vous-même.';
}

/**
 * Devise à utiliser pour l'affichage des montants dans les fenêtres du menu.
 * @return {string} Code de devise (CAD par défaut).
 */
function menuDevise_() {
  return lireParametres_().DEVISE || CONFIG.PARAMETRES_DEFAUT.DEVISE;
}

/**
 * Lignes du dernier rapprochement qui présentent un écart (expliqué ou non).
 * @return {{periode: string, lignes: Array<Object>}} Période la plus récente
 *     présente dans l'onglet Rapprochement, et ses lignes en écart.
 */
function menuEcartsDernierePeriode_() {
  const lignes = lireTable_(CONFIG.ONGLETS.RAPPROCHEMENT.nom);
  const periodes = lignes
    .map((ligne) => String(ligne[MENU_COL_.RAPPROCHEMENT_PERIODE] || '').trim())
    .filter((periode) => periode !== '')
    .sort();
  const derniere = periodes.length ? periodes[periodes.length - 1] : '';
  const enEcart = [VERDICT.EXPLIQUE, VERDICT.INEXPLIQUE].map((v) => texteNormalise_(v));
  const retenues = lignes.filter((ligne) =>
    String(ligne[MENU_COL_.RAPPROCHEMENT_PERIODE] || '').trim() === derniere &&
    enEcart.indexOf(texteNormalise_(ligne[MENU_COL_.RAPPROCHEMENT_VERDICT])) >= 0);
  return { periode: derniere, lignes: retenues };
}

// ---------------------------------------------------------------------------
// 1 à 6 — le cycle mensuel
// ---------------------------------------------------------------------------

/**
 * 1. Génère les bilans du mois à partir de l'onglet Lignes_bilan.
 * @return {void}
 */
function menuGenererBilans() {
  executer_('1. Générer les bilans du mois', () => {
    menuExigerInstallation_();
    return menuAppeler_('genererBilans');
  });
}

/**
 * 2. Envoie (ou prépare en brouillon) les bilans encore au statut Brouillon.
 * @return {void}
 */
function menuEnvoyerBilans() {
  executer_('2. Envoyer les bilans', () => {
    menuExigerInstallation_();
    const bilans = menuLignesFiltrees_(CONFIG.ONGLETS.BILANS.nom, [
      { colonne: MENU_COL_.BILAN_STATUT, valeurs: [STATUT_BILAN.BROUILLON] },
    ]);
    if (!bilans.length) {
      return 'Aucun bilan au statut « ' + STATUT_BILAN.BROUILLON + ' » : il n\'y a rien à envoyer. ' +
        'Lancez d\'abord « 1. Générer les bilans du mois ».';
    }
    const total = formaterMontant_(menuTotalCents_(bilans, MENU_COL_.BILAN_MONTANT), menuDevise_());
    const question = `${bilans.length} bilan(s) sont prêts, pour un total de ${total}.\n\n` +
      `${menuTexteMode_()}\n\nUn courriel sera préparé par client, et chaque bilan passera au ` +
      `statut « ${STATUT_BILAN.ENVOYE} ».\n\nVoulez-vous continuer ?`;
    if (!menuConfirmer_('Envoyer les bilans', question)) {
      return 'Envoi annulé : aucun courriel n\'a été préparé, aucun statut n\'a changé.';
    }
    return menuAppeler_('envoyerBilans');
  });
}

/**
 * 3. Importe les factures reçues depuis l'étiquette Gmail configurée.
 * @return {void}
 */
function menuImporterFactures() {
  executer_('3. Importer les factures reçues (Gmail)', () => {
    menuExigerInstallation_();
    return menuAppeler_('importerFacturesGmail');
  });
}

/**
 * 4. Vérifie les factures « À vérifier » et les compare à leur bilan.
 * @return {void}
 */
function menuVerifierFactures() {
  executer_('4. Vérifier les factures', () => {
    menuExigerInstallation_();
    // Exactement le même critère que le moteur (facturesAVerifier_ de
    // 05_Factures.gs) : une facture saisie à la main dont le statut de
    // vérification est resté vide doit être comptée, sinon le menu affirmerait
    // « tout est déjà vérifié » alors que le travail n'a pas été fait.
    const factures = menuFacturesAVerifier_();
    if (!factures.length) {
      return 'Aucune facture à vérifier : tout est déjà vérifié ou tranché à la main ' +
        `(« ${STATUT_VERIF.CONFORME} », « ${STATUT_VERIF.REJETEE} »).`;
    }
    const question = `${factures.length} facture(s) vont être comparées à leur bilan, et leur ` +
      'statut de vérification sera mis à jour automatiquement.\n\n' +
      'Vos décisions manuelles ne sont jamais réécrites : une facture que vous avez passée à ' +
      `« ${STATUT_VERIF.CONFORME} » ou « ${STATUT_VERIF.REJETEE} » reste telle quelle.\n\n` +
      'Aucun courriel n\'est envoyé. Voulez-vous continuer ?';
    if (!menuConfirmer_('Vérifier les factures', question)) {
      return 'Vérification annulée : aucun statut n\'a changé.';
    }
    return menuAppeler_('verifierFactures');
  });
}

/**
 * 5. Prépare le lot de paiements : factures conformes non payées + CSV sur Drive.
 * @return {void}
 */
function menuPreparerLotPaiements() {
  executer_('5. Préparer le lot de paiements', () => {
    menuExigerInstallation_();
    const factures = menuLignesFiltrees_(CONFIG.ONGLETS.FACTURES.nom, [
      { colonne: MENU_COL_.FACTURE_VERIFICATION, valeurs: [STATUT_VERIF.CONFORME] },
      { colonne: MENU_COL_.FACTURE_PAIEMENT, valeurs: [STATUT_PAIEMENT.NON_PAYEE] },
    ]);
    if (!factures.length) {
      return 'Aucune facture « ' + STATUT_VERIF.CONFORME + ' » et « ' + STATUT_PAIEMENT.NON_PAYEE +
        '» : il n\'y a rien à préparer pour le moment.';
    }
    const total = formaterMontant_(menuTotalCents_(factures, MENU_COL_.FACTURE_TOTAL), menuDevise_());
    const question = `${factures.length} facture(s) conformes et non payées, pour un total de ${total}.\n\n` +
      `Elles passeront au statut « ${STATUT_PAIEMENT.A_PAYER} » et un fichier CSV sera déposé ` +
      'dans votre Drive pour préparer vos virements.\n\n' +
      'Le script n\'envoie jamais d\'argent : c\'est vous qui payez depuis votre banque.\n\n' +
      'Voulez-vous continuer ?';
    if (!menuConfirmer_('Préparer le lot de paiements', question)) {
      return 'Préparation annulée : aucun statut n\'a changé, aucun fichier n\'a été créé.';
    }
    return menuAppeler_('preparerLotDePaiements');
  });
}

/**
 * 6. Confirme les paiements du lot : enregistre les paiements réellement faits.
 * @return {void}
 */
function menuConfirmerLotPaiements() {
  executer_('6. Confirmer les paiements du lot', () => {
    menuExigerInstallation_();
    const factures = menuLignesFiltrees_(CONFIG.ONGLETS.FACTURES.nom, [
      { colonne: MENU_COL_.FACTURE_PAIEMENT, valeurs: [STATUT_PAIEMENT.A_PAYER] },
    ]);
    if (!factures.length) {
      return 'Aucune facture au statut « ' + STATUT_PAIEMENT.A_PAYER + ' » : lancez d\'abord ' +
        '« 5. Préparer le lot de paiements ».';
    }
    const total = formaterMontant_(menuTotalCents_(factures, MENU_COL_.FACTURE_TOTAL), menuDevise_());
    const question = `Confirmez-vous avoir réellement payé ${factures.length} facture(s), ` +
      `pour un total de ${total} ?\n\n` +
      `Un paiement sera enregistré pour chacune, et les factures passeront à ` +
      `« ${STATUT_PAIEMENT.PAYEE} ».\n\n` +
      'Répondez Non si les virements ne sont pas encore faits.';
    if (!menuConfirmer_('Confirmer les paiements du lot', question)) {
      return 'Confirmation annulée : aucun paiement n\'a été enregistré.';
    }
    return menuAppeler_('confirmerLotDePaiements');
  });
}

/**
 * Annule le lot de paiements en cours : les factures « À payer » qui n'ont pas
 * encore été réglées reviennent à « Non payée », de sorte qu'un lot préparé par
 * erreur puisse être défait sans passer par l'éditeur de script et sans
 * confirmer des virements qui n'ont pas eu lieu.
 * @return {void}
 */
function menuAnnulerLotPaiements() {
  executer_('Annuler le lot de paiements en cours', () => {
    menuExigerInstallation_();
    const factures = menuLignesFiltrees_(CONFIG.ONGLETS.FACTURES.nom, [
      { colonne: MENU_COL_.FACTURE_PAIEMENT, valeurs: [STATUT_PAIEMENT.A_PAYER] },
    ]);
    if (!factures.length) {
      return 'Aucun lot en cours : aucune facture n\'est au statut « ' +
        STATUT_PAIEMENT.A_PAYER + ' ». Il n\'y a rien à annuler.';
    }
    const total = formaterMontant_(menuTotalCents_(factures, MENU_COL_.FACTURE_TOTAL), menuDevise_());
    const question = `${factures.length} facture(s) sont actuellement au statut ` +
      `« ${STATUT_PAIEMENT.A_PAYER} », pour un total de ${total}.\n\n` +
      `Elles reviendront toutes au statut « ${STATUT_PAIEMENT.NON_PAYEE} », et vous pourrez ` +
      'préparer un nouveau lot.\n\n' +
      'Aucun paiement déjà enregistré n\'est supprimé, aucune facture déjà ' +
      `« ${STATUT_PAIEMENT.PAYEE} » n'est touchée, et aucun courriel n'est envoyé.\n\n` +
      'Répondez Non si vous avez déjà fait ces virements : dans ce cas, utilisez plutôt ' +
      '« 6. Confirmer les paiements du lot ».\n\nVoulez-vous annuler le lot ?';
    if (!menuConfirmer_('Annuler le lot de paiements en cours', question)) {
      return 'Annulation abandonnée : le lot reste en cours, aucun statut n\'a changé.';
    }
    return menuAppeler_('annulerLot');
  });
}

// ---------------------------------------------------------------------------
// 7 et 8 — le cycle trimestriel
// ---------------------------------------------------------------------------

/**
 * 7. Rapprochement trimestriel : compare le solde théorique au solde déclaré
 * par chaque client et explique chaque écart.
 * @return {void}
 */
function menuRapprochementTrimestriel() {
  executer_('7. Rapprochement trimestriel', () => {
    menuExigerInstallation_();
    const relanceAuto = texteNormalise_(lireParametres_().RELANCE_AUTO) === 'OUI';
    if (relanceAuto) {
      const question = 'Le réglage RELANCE_AUTO est à « Oui » : après le calcul, un courriel de ' +
        'relance sera préparé pour chaque client en écart.\n\n' + menuTexteMode_() +
        '\n\nVoulez-vous lancer le rapprochement ?';
      if (!menuConfirmer_('Rapprochement trimestriel', question)) {
        return 'Rapprochement annulé : rien n\'a été calculé ni envoyé.';
      }
    }
    return menuAppeler_('rapprochementTrimestriel');
  });
}

/**
 * 8. Prépare un courriel de relance pour chaque client en écart au dernier
 * rapprochement.
 * @return {void}
 */
function menuRelancerEcarts() {
  executer_('8. Relancer les clients en écart', () => {
    menuExigerInstallation_();
    const ecarts = menuEcartsDernierePeriode_();
    if (!ecarts.lignes.length) {
      return 'Aucun client en écart à relancer. Si vous venez d\'ajouter des soldes déclarés, ' +
        'lancez d\'abord « 7. Rapprochement trimestriel ».';
    }
    const question = `${ecarts.lignes.length} client(s) présentent un écart pour la période ` +
      `${ecarts.periode || '(période la plus récente)'}.\n\n` +
      'Un seul courriel sera préparé par client, listant précisément les pièces à vérifier ' +
      '(dates, montants, références).\n\n' + menuTexteMode_() + '\n\nVoulez-vous continuer ?';
    if (!menuConfirmer_('Relancer les clients en écart', question)) {
      return 'Relance annulée : aucun courriel n\'a été préparé.';
    }
    return menuAppeler_('relancerClientsEnEcart');
  });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Crée ou répare tous les onglets du classeur, sans toucher aux données saisies.
 * @return {void}
 */
function menuInstaller() {
  executer_('Installer ou réparer le classeur', () => menuAppeler_('installer'));
}

/**
 * Met en place les exécutions automatiques (import Gmail, bilans, rapprochement).
 * @return {void}
 */
function menuActiverAutomatisation() {
  executer_("Activer l'automatisation", () => {
    menuExigerInstallation_();
    const params = lireParametres_();
    const question = 'Le script fonctionnera ensuite tout seul :\n' +
      '• toutes les heures : import des factures de l\'étiquette Gmail ;\n' +
      `• le ${params.JOUR_ENVOI_BILAN} de chaque mois : génération et envoi des bilans ;\n` +
      '• au début de chaque trimestre : rapprochement complet.\n\n' + menuTexteMode_() +
      '\n\nVoulez-vous activer l\'automatisation ?';
    if (!menuConfirmer_("Activer l'automatisation", question)) {
      return 'Activation annulée : rien n\'a été modifié.';
    }
    return menuAppeler_('installerDeclencheurs');
  });
}

/**
 * Supprime les exécutions automatiques : tout redevient manuel.
 * @return {void}
 */
function menuDesactiverAutomatisation() {
  executer_("Désactiver l'automatisation", () => {
    menuExigerInstallation_();
    const question = 'Plus rien ne se lancera tout seul : vous devrez utiliser le menu pour ' +
      'chaque étape. Vos données ne sont pas touchées.\n\nVoulez-vous désactiver l\'automatisation ?';
    if (!menuConfirmer_("Désactiver l'automatisation", question)) {
      return 'Désactivation annulée : l\'automatisation reste active.';
    }
    return menuAppeler_('supprimerDeclencheurs');
  });
}

/**
 * Vide l'onglet Journal (les onglets de données ne sont jamais touchés).
 * @return {void}
 */
function menuViderJournal() {
  executer_('Vider le journal', () => {
    menuExigerInstallation_();
    const nomOnglet = CONFIG.ONGLETS.JOURNAL.nom;
    const feuille = feuille_(nomOnglet);
    const nombre = feuille.getLastRow() - 1;
    if (nombre <= 0) return 'Le journal est déjà vide.';
    const question = `Le journal contient ${nombre} ligne(s) d'historique.\n\n` +
      'Elles seront effacées. Aucun client, bilan, facture ou paiement n\'est touché.\n\n' +
      'Voulez-vous vider le journal ?';
    if (!menuConfirmer_('Vider le journal', question)) return 'Le journal n\'a pas été vidé.';
    feuille.deleteRows(2, nombre);
    invaliderCacheFeuille_(nomOnglet);
    return `${nombre} ligne(s) d'historique ont été effacées.`;
  });
}

// ---------------------------------------------------------------------------
// Aide
// ---------------------------------------------------------------------------

/**
 * Exécute les tests internes et affiche un résumé compréhensible.
 * @return {void}
 */
function menuLancerTests() {
  executer_('Lancer les tests', () => menuResumeTests_(menuAppeler_('lancerTests')));
}

/**
 * Met en forme le résultat de lancerTests().
 * @param {Object} resultat Objet {total, reussis, echecs}.
 * @return {{titre: string, message: string}} Contenu de l'alerte.
 */
function menuResumeTests_(resultat) {
  if (!resultat || typeof resultat !== 'object') {
    return { titre: '✅ Tests terminés', message: 'Les tests ont été exécutés.' };
  }
  const total = Number(resultat.total) || 0;
  const reussis = Number(resultat.reussis) || 0;
  const echecs = Array.isArray(resultat.echecs) ? resultat.echecs : [];
  if (!echecs.length) {
    return {
      titre: '✅ Tests réussis',
      message: `${reussis} vérification(s) sur ${total} ont réussi. Les calculs internes ` +
        '(soldes, écarts, montants) se comportent comme prévu.',
    };
  }
  const liste = echecs.slice(0, 8).map((echec) => {
    const texte = (typeof echec === 'string') ? echec : (echec && (echec.nom || echec.message)) || '';
    return `• ${menuTexteCourt_(texte, 140)}`;
  }).join('\n');
  return {
    titre: '⚠️ Des vérifications ont échoué',
    message: `${reussis} réussite(s) sur ${total}.\n\n${liste}\n\n` +
      'Signalez ces lignes à la personne qui a installé le script.',
  };
}

/**
 * Affiche le mode d'emploi dans une fenêtre non bloquante : l'utilisateur peut
 * continuer à travailler dans le classeur pendant qu'elle est ouverte.
 * @return {void}
 */
function afficherModeEmploi() {
  try {
    const fenetre = HtmlService.createHtmlOutput(menuModeEmploiHtml_())
      .setWidth(600)
      .setHeight(640);
    SpreadsheetApp.getUi().showModelessDialog(fenetre, "Mode d'emploi");
  } catch (e) {
    const pile = (e && e.stack) ? `${e.message}\n${e.stack}` : e;
    journalErreur_("Mode d'emploi", "Le mode d'emploi n'a pas pu s'afficher.", pile);
    viderTamponJournal_();
    menuAlerte_("Mode d'emploi", "La fenêtre d'aide n'a pas pu s'ouvrir. Le mode d'emploi complet " +
      'se trouve aussi dans le fichier README du projet.');
  }
}

/**
 * Construit la page HTML du mode d'emploi.
 * @return {string} Page complète, prête pour HtmlService.
 */
function menuModeEmploiHtml_() {
  const etapes = menuEtapesMensuelles_().concat(menuEtapesTrimestrielles_());
  const blocs = etapes.map((etape) => `
    <div class="etape">
      <h3><span class="num">${etape.numero}</span> ${etape.titre}</h3>
      <p class="vous"><b>Vous :</b> ${etape.vous}</p>
      <p class="script"><b>Le script :</b> ${etape.script}</p>
    </div>`).join('');
  return `${menuModeEmploiStyle_()}
    <h2>Comment ça marche</h2>
    <p class="intro">Le cycle est toujours le même : vous annoncez ce que vous devez, le client
      vous facture, vous vérifiez, vous payez, et chaque trimestre on s'assure que le client a
      bien tout déduit. Les entrées du menu sont numérotées dans cet ordre : suivez les numéros.</p>
    <div class="avant">
      <b>Une fois pour toutes :</b> remplissez l'onglet <i>${CONFIG.ONGLETS.CLIENTS.nom}</i>
      (un client par ligne, <i>Actif = Oui</i>) et vérifiez l'onglet
      <i>${CONFIG.ONGLETS.PARAMETRES.nom}</i>. Tant que <i>MODE_ENVOI</i> vaut
      <i>Brouillon</i>, aucun courriel ne part sans que vous l'ayez relu dans Gmail.
    </div>
    ${blocs}
    ${menuModeEmploiFin_()}`;
}

/**
 * Les six étapes du cycle mensuel, décrites en français simple.
 * @return {Array<{numero: string, titre: string, vous: string, script: string}>}
 */
function menuEtapesMensuelles_() {
  const onglets = CONFIG.ONGLETS;
  return [
    { numero: '1', titre: 'Générer les bilans du mois',
      vous: `saisir dans l'onglet <i>${onglets.LIGNES_BILAN.nom}</i> ce que vous devez à chaque client (ID client, Période au format AAAA-MM, description, montant).`,
      script: `regroupe vos lignes par client et crée un bilan au statut « ${STATUT_BILAN.BROUILLON} » dans l'onglet <i>${onglets.BILANS.nom}</i>.` },
    { numero: '2', titre: 'Envoyer les bilans',
      vous: 'relire les courriels dans Gmail puis les envoyer (en mode Brouillon), ou ne rien faire (en mode Direct).',
      script: `prépare un courriel par client actif et passe le bilan à « ${STATUT_BILAN.ENVOYE} ». Il vous dit toujours combien de courriels sont concernés avant de commencer.` },
    { numero: '3', titre: 'Importer les factures reçues (Gmail)',
      vous: `classer les factures de vos clients sous l'étiquette Gmail indiquée dans <i>${onglets.PARAMETRES.nom}</i>.`,
      script: `crée une ligne par facture dans <i>${onglets.FACTURES.nom}</i>, range la pièce jointe dans votre Drive et ignore ce qui a déjà été importé.` },
    { numero: '4', titre: 'Vérifier les factures',
      vous: `trancher les cas douteux : « ${STATUT_VERIF.ECART} », « ${STATUT_VERIF.DOUBLON} », « ${STATUT_VERIF.SANS_BILAN} ». Ce que vous décidez à la main n'est jamais réécrit.`,
      script: `compare chaque facture à son bilan, explique l'écart quand il y en a un (TPS, TVQ, ligne oubliée) et marque « ${STATUT_VERIF.CONFORME} » ce qui correspond.` },
    { numero: '5', titre: 'Préparer le lot de paiements',
      vous: 'faire vos virements dans votre banque, à partir du fichier CSV déposé sur votre Drive.',
      script: `liste les factures conformes non payées, les passe à « ${STATUT_PAIEMENT.A_PAYER} » et prépare le CSV. Il ne déplace jamais d'argent.` },
    { numero: '6', titre: 'Confirmer les paiements du lot',
      vous: 'confirmer, une fois les virements réellement faits.',
      script: `enregistre un paiement par facture dans <i>${onglets.PAIEMENTS.nom}</i> et marque les factures « ${STATUT_PAIEMENT.PAYEE} ».` },
  ];
}

/**
 * Les deux étapes trimestrielles : le cœur de l'outil.
 * @return {Array<{numero: string, titre: string, vous: string, script: string}>}
 */
function menuEtapesTrimestrielles_() {
  const onglets = CONFIG.ONGLETS;
  return [
    { numero: '7', titre: 'Rapprochement trimestriel',
      vous: `recopier le solde que chaque client vous annonce dans l'onglet <i>${onglets.SOLDES_DECLARES.nom}</i> (Période au format AAAA-TN, par exemple 2026-T2).`,
      script: `calcule ce que vous devriez encore devoir, le compare au solde du client, et pour chaque écart cherche la cause exacte : paiement non déduit, facture oubliée, paiement compté deux fois, erreur de taxes, signe inversé… Le résultat est écrit dans l'onglet <i>${onglets.RAPPROCHEMENT.nom}</i>.` },
    { numero: '8', titre: 'Relancer les clients en écart',
      vous: 'relire les courriels et les envoyer.',
      script: `prépare un seul courriel par client, qui liste précisément les pièces à vérifier (date, montant, référence, n° de facture) au lieu d'un vague « merci de vérifier ».` },
  ];
}

/**
 * Bloc de fin du mode d'emploi : les repères utiles au quotidien.
 * @return {string} Fragment HTML.
 */
function menuModeEmploiFin_() {
  return `
    <h2>Bon à savoir</h2>
    <ul>
      <li>Vous pouvez relancer n'importe quelle étape autant de fois que vous voulez : elle ne
        crée pas de doublon.</li>
      <li>Le script ne paie jamais rien tout seul et ne supprime jamais ce que vous avez saisi.</li>
      <li>Vous avez préparé un lot de paiements par erreur ? <i>Annuler le lot de paiements en
        cours</i> remet les factures « ${STATUT_PAIEMENT.A_PAYER} » à
        « ${STATUT_PAIEMENT.NON_PAYEE} », sans toucher aux paiements déjà enregistrés.</li>
      <li>Avant tout envoi de courriel ou tout changement de statut en masse, une fenêtre vous
        annonce combien d'éléments sont concernés et si vous êtes en mode Brouillon ou Direct.</li>
      <li>Si quelque chose se passe mal, le message reste en français et le détail technique est
        écrit dans l'onglet <i>${CONFIG.ONGLETS.JOURNAL.nom}</i>.</li>
      <li>Le menu <i>Configuration</i> sert à installer ou réparer le classeur, à activer ou
        désactiver les exécutions automatiques, et à vider le journal.</li>
    </ul>
    <p class="fin">Un doute ? Commencez toujours par regarder l'onglet
      <i>${CONFIG.ONGLETS.RAPPROCHEMENT.nom}</i> : la colonne <i>Action suggérée</i> vous dit quoi
      faire, client par client.</p>`;
}

/**
 * Feuille de style du mode d'emploi.
 * @return {string} Balise <style> complète.
 */
function menuModeEmploiStyle_() {
  return `<style>
    body { font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #202124;
           margin: 0 14px 20px 14px; line-height: 1.45; }
    h2 { font-size: 16px; margin: 18px 0 8px 0; border-bottom: 1px solid #dadce0; padding-bottom: 4px; }
    h3 { font-size: 13px; margin: 0 0 6px 0; }
    p { margin: 4px 0; }
    .intro { color: #444; }
    .avant { background: #e8f0fe; border-left: 4px solid #1a73e8; padding: 8px 10px; margin: 12px 0; }
    .etape { border: 1px solid #dadce0; border-radius: 6px; padding: 10px 12px; margin: 10px 0; }
    .num { display: inline-block; background: #1a73e8; color: #fff; border-radius: 50%;
           width: 20px; height: 20px; line-height: 20px; text-align: center; margin-right: 6px; }
    .vous { color: #b06000; }
    .script { color: #137333; }
    ul { padding-left: 20px; }
    li { margin: 4px 0; }
    .fin { background: #f1f3f4; padding: 8px 10px; border-radius: 6px; }
  </style>`;
}

// ===========================================================================
// ▼ src/03_Feuilles.gs   (module 4 sur 11)
// ===========================================================================
/**
 * 03_Feuilles.gs — Couche d'accès aux données du classeur.
 *
 * Tous les autres modules passent par ici pour lire ou écrire : aucun d'eux ne
 * connaît un numéro de colonne. Les noms de colonnes viennent de CONFIG.ONGLETS.
 *
 * Trois garanties :
 *   1. Une seule lecture getDataRange().getValues() par onglet et par exécution
 *      (cache mémoire). Toute écriture invalide le cache de l'onglet touché.
 *   2. Les écritures sont groupées : jamais de setValue() dans une boucle.
 *   3. Rien n'est détruit : seul remplacerPeriode_ supprime des lignes, et
 *      uniquement celles de la période qu'il réécrit.
 *
 * La fin du fichier regroupe les utilitaires partagés d'argent, de dates et de
 * texte. Ces fonctions sont PURES (aucun appel à SpreadsheetApp) : elles sont
 * testables hors de Google.
 */

/** Cache mémoire, valable le temps d'une seule exécution du script. */
const FEUILLES_CACHE_ = {
  classeur: null,
  tables: {},
  parametres: null,
};

/** Longueur maximale écrite dans une cellule (limite Google Sheets : 50 000). */
const FEUILLES_MAX_CARACTERES_ = 45000;

// ---------------------------------------------------------------------------
// Accès au classeur et aux onglets
// ---------------------------------------------------------------------------

/**
 * Renvoie le classeur actif (mis en cache pour l'exécution).
 * @return {Spreadsheet} Le classeur Google Sheets actif.
 */
function feuillesClasseur_() {
  if (!FEUILLES_CACHE_.classeur) {
    FEUILLES_CACHE_.classeur = SpreadsheetApp.getActiveSpreadsheet();
  }
  return FEUILLES_CACHE_.classeur;
}

/**
 * Retrouve le schéma d'un onglet à partir de son nom.
 * @param {string} nom Nom de l'onglet tel qu'il apparaît dans le classeur.
 * @return {Object|null} L'entrée de CONFIG.ONGLETS, ou null si inconnue.
 */
function feuillesSchema_(nom) {
  const cles = Object.keys(CONFIG.ONGLETS);
  for (let i = 0; i < cles.length; i++) {
    const schema = CONFIG.ONGLETS[cles[i]];
    if (schema && schema.nom === nom) return schema;
  }
  return null;
}

/**
 * Renvoie l'onglet demandé. S'il n'existe pas, il est créé avec ses en-têtes
 * (et seulement ses en-têtes) d'après CONFIG.ONGLETS, plutôt que d'échouer.
 * @param {string} nom Nom de l'onglet.
 * @return {Sheet} L'onglet, garanti existant.
 */
function feuille_(nom) {
  const classeur = feuillesClasseur_();
  const existante = classeur.getSheetByName(nom);
  if (existante) return existante;

  const schema = feuillesSchema_(nom);
  if (!schema) {
    throw new Error(
      `L'onglet « ${nom} » est introuvable et aucun modèle ne le décrit dans la configuration.`);
  }
  const nouvelle = classeur.insertSheet(nom);
  const noms = schema.colonnes.map((c) => c.nom);
  feuillesGarantirColonnes_(nouvelle, noms.length);
  const plage = nouvelle.getRange(1, 1, 1, noms.length);
  plage.setValues([noms]);
  plage.setFontWeight('bold');
  nouvelle.setFrozenRows(1);
  journalInfo_('feuille_', `Onglet « ${nom} » créé automatiquement.`, '');
  return nouvelle;
}

/**
 * Oublie le cache d'un onglet (à appeler après toute écriture directe).
 * @param {string} nom Nom de l'onglet, ou rien pour tout oublier.
 * @return {void}
 */
function invaliderCacheFeuille_(nom) {
  if (nom === undefined || nom === null || nom === '') {
    FEUILLES_CACHE_.tables = {};
    FEUILLES_CACHE_.parametres = null;
    return;
  }
  delete FEUILLES_CACHE_.tables[nom];
  if (nom === CONFIG.ONGLETS.PARAMETRES.nom) FEUILLES_CACHE_.parametres = null;
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/**
 * Lit la ligne 1 d'un onglet. Si elle est vide et qu'un modèle existe, les
 * en-têtes du modèle y sont écrits (réparation non destructive : l'onglet est vide).
 * @param {Sheet} feuille Onglet concerné.
 * @param {Array<Array<*>>} valeurs Contenu brut de getDataRange().
 * @return {Array<string>} Les noms d'en-tête, nettoyés.
 */
function feuillesEntetes_(feuille, valeurs) {
  const brut = valeurs.length ? valeurs[0] : [];
  const entetes = brut.map((v) => (v === null || v === undefined ? '' : String(v).trim()));
  if (entetes.some((e) => e !== '')) return entetes;

  const schema = feuillesSchema_(feuille.getName());
  if (!schema) return entetes;
  const noms = schema.colonnes.map((c) => c.nom);
  feuillesGarantirColonnes_(feuille, noms.length);
  feuille.getRange(1, 1, 1, noms.length).setValues([noms]);
  feuille.getRange(1, 1, 1, noms.length).setFontWeight('bold');
  feuille.setFrozenRows(1);
  return noms;
}

/**
 * Vrai si toutes les cellules de la ligne sont vides.
 * @param {Array<*>} ligne Valeurs d'une ligne.
 * @return {boolean}
 */
function feuillesLigneVide_(ligne) {
  for (let i = 0; i < ligne.length; i++) {
    const v = ligne[i];
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return false;
  }
  return true;
}

/**
 * Lit un onglet en entier, une seule fois par exécution, et le met en cache.
 * @param {string} nom Nom de l'onglet.
 * @return {{entetes: Array<string>, objets: Array<Object>}}
 */
function feuillesTable_(nom) {
  const enCache = FEUILLES_CACHE_.tables[nom];
  if (enCache) return enCache;

  const feuille = feuille_(nom);
  const valeurs = feuille.getDataRange().getValues();
  const entetes = feuillesEntetes_(feuille, valeurs);
  const objets = [];
  for (let i = 1; i < valeurs.length; i++) {
    const ligne = valeurs[i];
    if (feuillesLigneVide_(ligne)) continue;
    const objet = { _ligne: i + 1 };
    for (let c = 0; c < entetes.length; c++) {
      if (!entetes[c]) continue;
      objet[entetes[c]] = ligne[c] === undefined ? '' : ligne[c];
    }
    objets.push(objet);
  }
  FEUILLES_CACHE_.tables[nom] = { entetes: entetes, objets: objets };
  return FEUILLES_CACHE_.tables[nom];
}

/**
 * Lit un onglet sous forme d'objets clés par le NOM d'en-tête lu en ligne 1.
 * Chaque objet porte en plus `_ligne`, le numéro de ligne réel dans la feuille.
 * Les lignes entièrement vides sont ignorées.
 * @param {string} nom Nom de l'onglet.
 * @return {Array<Object>} Les lignes de données.
 */
function lireTable_(nom) {
  return feuillesTable_(nom).objets;
}

/**
 * Renvoie les noms d'en-tête réels d'un onglet.
 * @param {string} nom Nom de l'onglet.
 * @return {Array<string>} Les en-têtes, dans l'ordre des colonnes.
 */
function entetesTable_(nom) {
  return feuillesTable_(nom).entetes.slice();
}

/**
 * Indexe une liste d'objets par la valeur d'un champ (le dernier gagne).
 *
 * Une clé présente sur plusieurs lignes est une faute de saisie qui fait
 * silencieusement disparaître une ligne (le bilan part alors à la mauvaise
 * adresse) : chaque doublon est donc signalé au Journal, en nommant les lignes.
 * @param {Array<Object>} objets Lignes à indexer.
 * @param {string} champ Nom du champ servant de clé.
 * @return {Map<string, Object>} Clé (texte, nettoyée) vers objet.
 */
function indexerPar_(objets, champ) {
  const index = new Map();
  const lignesParCle = new Map();
  (objets || []).forEach((objet) => {
    if (!objet) return;
    const brut = objet[champ];
    if (brut === null || brut === undefined) return;
    const cle = String(brut).trim();
    if (cle === '') return;
    if (!lignesParCle.has(cle)) lignesParCle.set(cle, []);
    lignesParCle.get(cle).push(objet._ligne === undefined ? '?' : objet._ligne);
    index.set(cle, objet);
  });
  feuillesSignalerDoublons_(champ, lignesParCle);
  return index;
}

/**
 * Journalise un AVERT par clé présente plus d'une fois, en nommant toutes les
 * lignes concernées et celle qui l'emporte réellement.
 * @param {string} champ Nom du champ servant de clé.
 * @param {Map<string, Array<*>>} lignesParCle Clé vers numéros de ligne rencontrés.
 * @return {number} Nombre de clés en double.
 */
function feuillesSignalerDoublons_(champ, lignesParCle) {
  let doublons = 0;
  lignesParCle.forEach((lignes, cle) => {
    if (lignes.length < 2) return;
    doublons++;
    const retenue = lignes[lignes.length - 1];
    const debut = lignes.slice(0, lignes.length - 1).join(', ');
    journalAvert_('indexerPar_',
      `${champ} ${cle} présent en lignes ${debut} et ${retenue} : ` +
      `seule la ligne ${retenue} est utilisée.`,
      'Supprimez ou corrigez la ligne en trop : tant que le doublon existe, les lignes ' +
      'précédentes sont ignorées partout (bilans, envois, rapprochement).');
  });
  return doublons;
}

/**
 * Regroupe une liste d'objets par la valeur d'un champ (utile pour les lignes
 * d'un même client ou d'une même période).
 * @param {Array<Object>} objets Lignes à regrouper.
 * @param {string} champ Nom du champ servant de clé.
 * @return {Map<string, Array<Object>>} Clé vers tableau d'objets.
 */
function indexerGroupesPar_(objets, champ) {
  const groupes = new Map();
  (objets || []).forEach((objet) => {
    if (!objet) return;
    const brut = objet[champ];
    if (brut === null || brut === undefined) return;
    const cle = String(brut).trim();
    if (cle === '') return;
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(objet);
  });
  return groupes;
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

/**
 * Agrandit la grille de l'onglet si l'écriture prévue dépasse sa dernière ligne.
 * Une feuille neuve n'a que 1000 lignes : sans cela, setValues() lève
 * « The coordinates or dimensions of the range are invalid » et l'écriture est
 * perdue (journal muet, rapport de trimestre effacé puis non réécrit).
 * @param {Sheet} feuille Onglet concerné.
 * @param {number} derniereLigne Numéro de la dernière ligne qui sera écrite.
 * @return {number} Nombre de lignes ajoutées à la grille.
 */
function feuillesGarantirLignes_(feuille, derniereLigne) {
  const maximum = feuille.getMaxRows();
  const manquantes = Math.ceil(Number(derniereLigne) || 0) - maximum;
  if (manquantes <= 0) return 0;
  feuille.insertRowsAfter(maximum, manquantes);
  return manquantes;
}

/**
 * Agrandit la grille de l'onglet si l'écriture prévue dépasse sa dernière colonne.
 * @param {Sheet} feuille Onglet concerné.
 * @param {number} derniereColonne Numéro de la dernière colonne qui sera écrite.
 * @return {number} Nombre de colonnes ajoutées à la grille.
 */
function feuillesGarantirColonnes_(feuille, derniereColonne) {
  const maximum = feuille.getMaxColumns();
  const manquantes = Math.ceil(Number(derniereColonne) || 0) - maximum;
  if (manquantes <= 0) return 0;
  feuille.insertColumnsAfter(maximum, manquantes);
  return manquantes;
}

/**
 * Prépare une valeur avant écriture dans une cellule.
 * @param {*} valeur Valeur brute.
 * @return {*} Valeur acceptée par setValues().
 */
function feuillesValeurSortie_(valeur) {
  if (valeur === null || valeur === undefined) return '';
  if (typeof valeur === 'string' && valeur.length > FEUILLES_MAX_CARACTERES_) {
    return valeur.slice(0, FEUILLES_MAX_CARACTERES_ - 1) + '…';
  }
  return valeur;
}

/**
 * Ajoute des lignes à la suite des données existantes, en UNE seule écriture.
 * Les clés des objets doivent être des noms d'en-tête ; les clés inconnues sont
 * ignorées et signalées au journal.
 * @param {string} nom Nom de l'onglet.
 * @param {Array<Object>} objets Lignes à ajouter.
 * @return {number} Nombre de lignes réellement ajoutées.
 */
function ajouterLignes_(nom, objets) {
  if (!objets || !objets.length) return 0;
  const feuille = feuille_(nom);
  const entetes = feuillesTable_(nom).entetes.filter((e) => e !== '');
  if (!entetes.length) {
    throw new Error(`L'onglet « ${nom} » n'a aucun en-tête : impossible d'y ajouter des lignes.`);
  }
  const inconnues = {};
  const matrice = objets.map((objet) => {
    Object.keys(objet || {}).forEach((cle) => {
      if (cle !== '_ligne' && entetes.indexOf(cle) < 0) inconnues[cle] = true;
    });
    return entetes.map((entete) => feuillesValeurSortie_((objet || {})[entete]));
  });
  const premiereLigne = Math.max(feuille.getLastRow(), 1) + 1;
  feuillesGarantirLignes_(feuille, premiereLigne + matrice.length - 1);
  feuille.getRange(premiereLigne, 1, matrice.length, entetes.length).setValues(matrice);
  invaliderCacheFeuille_(nom);

  const listeInconnues = Object.keys(inconnues);
  if (listeInconnues.length) {
    journalAvert_('ajouterLignes_',
      `Colonnes inconnues ignorées dans l'onglet « ${nom} ».`, listeInconnues.join(', '));
  }
  return matrice.length;
}

/**
 * Met à jour une seule ligne.
 * @param {string} nom Nom de l'onglet.
 * @param {number} ligne Numéro de ligne réel dans la feuille (celui de `_ligne`).
 * @param {Object} patch Couples {nom d'en-tête: nouvelle valeur}.
 * @return {number} Nombre de cellules écrites.
 */
function majLigne_(nom, ligne, patch) {
  return majLignes_(nom, [{ ligne: ligne, patch: patch }]);
}

/**
 * Met à jour plusieurs lignes. Les écritures sont regroupées par colonne puis
 * par plages de lignes contiguës : quelques setValues() au lieu d'un par cellule.
 * @param {string} nom Nom de l'onglet.
 * @param {Array<{ligne: number, patch: Object}>} majs Mises à jour à appliquer.
 * @return {number} Nombre de cellules écrites.
 */
function majLignes_(nom, majs) {
  if (!majs || !majs.length) return 0;
  const feuille = feuille_(nom);
  const entetes = feuillesTable_(nom).entetes;
  const parColonne = new Map();
  const inconnues = {};

  majs.forEach((maj) => {
    if (!maj || !maj.patch) return;
    const ligne = Number(maj.ligne);
    if (!ligne || ligne < 2) return;
    Object.keys(maj.patch).forEach((cle) => {
      const colonne = entetes.indexOf(cle);
      if (colonne < 0) { inconnues[cle] = true; return; }
      if (!parColonne.has(colonne)) parColonne.set(colonne, new Map());
      parColonne.get(colonne).set(ligne, feuillesValeurSortie_(maj.patch[cle]));
    });
  });

  let cellules = 0;
  parColonne.forEach((valeursParLigne, colonne) => {
    cellules += feuillesEcrireColonne_(feuille, colonne + 1, valeursParLigne);
  });
  if (cellules) invaliderCacheFeuille_(nom);

  const listeInconnues = Object.keys(inconnues);
  if (listeInconnues.length) {
    journalAvert_('majLignes_',
      `Colonnes inconnues ignorées dans l'onglet « ${nom} ».`, listeInconnues.join(', '));
  }
  return cellules;
}

/**
 * Écrit une colonne par blocs de lignes contiguës.
 * @param {Sheet} feuille Onglet visé.
 * @param {number} colonne Numéro de colonne (1-indexé).
 * @param {Map<number, *>} valeursParLigne Numéro de ligne vers valeur.
 * @return {number} Nombre de cellules écrites.
 */
function feuillesEcrireColonne_(feuille, colonne, valeursParLigne) {
  const lignes = Array.from(valeursParLigne.keys()).sort((a, b) => a - b);
  let cellules = 0;
  let i = 0;
  while (i < lignes.length) {
    let j = i;
    while (j + 1 < lignes.length && lignes[j + 1] === lignes[j] + 1) j++;
    const bloc = [];
    for (let k = i; k <= j; k++) bloc.push([valeursParLigne.get(lignes[k])]);
    feuille.getRange(lignes[i], colonne, bloc.length, 1).setValues(bloc);
    cellules += bloc.length;
    i = j + 1;
  }
  return cellules;
}

/**
 * Réécrit un onglet généré pour UNE période : les lignes de cette période sont
 * supprimées puis remplacées, les autres périodes restent intactes. C'est ce qui
 * rend les onglets générés idempotents (relancer deux fois ne crée pas de doublon).
 * @param {string} nom Nom de l'onglet.
 * @param {string} colPeriode Nom de la colonne qui porte la période.
 * @param {string} periode Période à remplacer (ex. '2026-T2').
 * @param {Array<Object>} objets Nouvelles lignes de cette période.
 * @return {number} Nombre de lignes écrites.
 */
function remplacerPeriode_(nom, colPeriode, periode, objets) {
  const feuille = feuille_(nom);
  const table = feuillesTable_(nom);
  if (table.entetes.indexOf(colPeriode) < 0) {
    throw new Error(`La colonne « ${colPeriode} » n'existe pas dans l'onglet « ${nom} ».`);
  }
  const cible = String(periode === null || periode === undefined ? '' : periode).trim();
  const aSupprimer = table.objets
    .filter((o) => {
      const v = o[colPeriode];
      return String(v === null || v === undefined ? '' : v).trim() === cible;
    })
    .map((o) => o._ligne)
    .sort((a, b) => b - a);

  let i = 0;
  while (i < aSupprimer.length) {
    let j = i;
    while (j + 1 < aSupprimer.length && aSupprimer[j + 1] === aSupprimer[j] - 1) j++;
    feuille.deleteRows(aSupprimer[j], j - i + 1);
    i = j + 1;
  }
  if (aSupprimer.length) invaliderCacheFeuille_(nom);
  return ajouterLignes_(nom, objets || []);
}

/**
 * Calcule le prochain identifiant d'un onglet (ex. 'F-000042').
 * Le plus grand suffixe numérique existant est repris et incrémenté ; les
 * identifiants saisis à la main ou mal formés sont simplement ignorés.
 * @param {string} nom Nom de l'onglet.
 * @param {string} colonne Nom de la colonne d'identifiants.
 * @param {string} prefixe Préfixe des identifiants (ex. 'F-').
 * @param {number} largeur Nombre de chiffres, complétés par des zéros.
 * @return {string} Le prochain identifiant disponible.
 */
function prochainId_(nom, colonne, prefixe, largeur) {
  const chiffres = Math.max(1, Number(largeur) || 6);
  const prefixeTexte = String(prefixe === null || prefixe === undefined ? '' : prefixe);
  const prefixeHaut = prefixeTexte.toUpperCase();
  const table = feuillesTable_(nom);
  if (table.entetes.indexOf(colonne) < 0) {
    throw new Error(`La colonne « ${colonne} » n'existe pas dans l'onglet « ${nom} ».`);
  }
  let maximum = 0;
  table.objets.forEach((objet) => {
    const brut = objet[colonne];
    if (brut === null || brut === undefined) return;
    const texte = String(brut).trim();
    if (!texte) return;
    if (prefixeHaut && texte.toUpperCase().indexOf(prefixeHaut) !== 0) return;
    const trouve = /(\d+)\s*$/.exec(texte);
    if (!trouve) return;
    const numero = parseInt(trouve[1], 10);
    if (!isNaN(numero) && numero > maximum) maximum = numero;
  });
  let suffixe = String(maximum + 1);
  while (suffixe.length < chiffres) suffixe = '0' + suffixe;
  return prefixeTexte + suffixe;
}

// ---------------------------------------------------------------------------
// Paramètres
// ---------------------------------------------------------------------------

/**
 * Lit les réglages : CONFIG.PARAMETRES_DEFAUT complété par l'onglet Paramètres.
 * La valeur saisie dans la feuille l'emporte, sauf si elle est vide.
 * @return {Object} Dictionnaire {CLE: valeur}.
 */
function lireParametres_() {
  if (FEUILLES_CACHE_.parametres) return FEUILLES_CACHE_.parametres;
  const params = {};
  Object.keys(CONFIG.PARAMETRES_DEFAUT).forEach((cle) => {
    params[cle] = CONFIG.PARAMETRES_DEFAUT[cle];
  });
  const onglet = CONFIG.ONGLETS.PARAMETRES;
  const colCle = onglet.colonnes[0].nom;
  const colValeur = onglet.colonnes[1].nom;
  lireTable_(onglet.nom).forEach((ligne) => {
    const cle = String(ligne[colCle] === null || ligne[colCle] === undefined ? '' : ligne[colCle]).trim();
    if (!cle) return;
    const valeur = ligne[colValeur];
    if (valeur === null || valeur === undefined) return;
    if (typeof valeur === 'string' && valeur.trim() === '') return;
    params[cle] = typeof valeur === 'string' ? valeur.trim() : valeur;
  });
  FEUILLES_CACHE_.parametres = params;
  return params;
}

/**
 * Écrit un réglage dans l'onglet Paramètres (mise à jour ou ajout).
 * @param {string} cle Nom du réglage (ex. 'MODE_ENVOI').
 * @param {*} valeur Nouvelle valeur.
 * @return {void}
 */
function ecrireParametre_(cle, valeur) {
  const onglet = CONFIG.ONGLETS.PARAMETRES;
  const colCle = onglet.colonnes[0].nom;
  const colValeur = onglet.colonnes[1].nom;
  const colDescription = onglet.colonnes[2].nom;
  const cleTexte = String(cle).trim();
  const existante = lireTable_(onglet.nom).filter((ligne) => {
    const v = ligne[colCle];
    return String(v === null || v === undefined ? '' : v).trim() === cleTexte;
  })[0];

  const patch = {};
  patch[colValeur] = valeur;
  if (existante) {
    majLigne_(onglet.nom, existante._ligne, patch);
  } else {
    patch[colCle] = cleTexte;
    patch[colDescription] = CONFIG.DESCRIPTIONS_PARAMETRES[cleTexte] || '';
    ajouterLignes_(onglet.nom, [patch]);
  }
  FEUILLES_CACHE_.parametres = null;
}

/**
 * Lit un réglage comme un nombre (accepte '1 234,56' comme 1234.56).
 * @param {Object} params Résultat de lireParametres_().
 * @param {string} cle Nom du réglage.
 * @param {number} defaut Valeur de repli si le réglage est vide ou illisible.
 * @return {number}
 */
function parametreNombre_(params, cle, defaut) {
  const secours = (defaut === null || defaut === undefined) ? 0 : Number(defaut);
  const brut = params ? params[cle] : undefined;
  if (typeof brut === 'number') return isFinite(brut) ? brut : secours;
  if (brut === null || brut === undefined) return secours;
  const texte = String(brut).trim();
  if (!texte) return secours;
  const negatif = /^-/.test(texte) || /^\(.*\)$/.test(texte);
  const nombre = feuillesNombreDecimal_(texte.replace(/[^0-9.,]/g, ''));
  if (nombre === null) return secours;
  return negatif ? -nombre : nombre;
}

/**
 * Lit un réglage comme un oui/non. 'Oui' et 'Direct' valent vrai.
 * @param {Object} params Résultat de lireParametres_().
 * @param {string} cle Nom du réglage.
 * @return {boolean}
 */
function parametreBooleen_(params, cle) {
  const brut = params ? params[cle] : undefined;
  if (typeof brut === 'boolean') return brut;
  const texte = texteNormalise_(brut);
  return texte === 'OUI' || texte === 'DIRECT' || texte === 'VRAI' ||
         texte === 'TRUE' || texte === 'ACTIF' || texte === 'X' || texte === '1';
}

// ---------------------------------------------------------------------------
// Utilitaires partagés — argent, dates, texte (fonctions PURES, testables)
// ---------------------------------------------------------------------------

/**
 * Interprète une chaîne composée de chiffres, de points et de virgules.
 * Le dernier séparateur est décimal, sauf s'il sépare visiblement des milliers.
 * @param {string} texte Chaîne déjà débarrassée des symboles et des espaces.
 * @return {number|null} Le nombre lu, ou null si illisible.
 */
function feuillesNombreDecimal_(texte) {
  const points = (texte.match(/\./g) || []).length;
  const virgules = (texte.match(/,/g) || []).length;
  let entier = texte;
  let decimales = '';
  if (points + virgules > 0) {
    const position = Math.max(texte.lastIndexOf('.'), texte.lastIndexOf(','));
    const apres = texte.slice(position + 1);
    const avant = texte.slice(0, position);
    const memeSeparateur = (points === 0 || virgules === 0);
    const milliers = memeSeparateur && (
      (points + virgules) >= 2 ||
      (/^\d{3}$/.test(apres) && avant !== '' && avant !== '0'));
    if (milliers || !/^\d+$/.test(apres)) {
      entier = texte;
    } else {
      entier = avant;
      decimales = apres;
    }
  }
  entier = entier.replace(/[.,]/g, '');
  if (!/^\d*$/.test(entier)) return null;
  if (entier === '' && decimales === '') return null;
  const nombre = Number((entier || '0') + (decimales ? '.' + decimales : ''));
  return isFinite(nombre) ? nombre : null;
}

/**
 * Convertit un montant en cents entiers. C'est la seule façon de manipuler de
 * l'argent dans le projet : on ne compare jamais deux flottants.
 * Accepte un nombre, '1 234,56 $', '1,234.56', '-45,00', '(120,00)' (négatif).
 * @param {*} valeur Montant sous n'importe quelle forme.
 * @return {number} Montant en cents (entier), 0 si illisible.
 */
function enCents_(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return 0;
  if (typeof valeur === 'number') return isFinite(valeur) ? Math.round(valeur * 100) : 0;
  if (typeof valeur === 'boolean' || valeur instanceof Date) return 0;
  const brut = String(valeur).trim();
  if (!brut) return 0;
  const negatif = /^\(.*\)$/.test(brut) || /^-/.test(brut) || /-$/.test(brut);
  const nombre = feuillesNombreDecimal_(brut.replace(/[^0-9.,]/g, ''));
  if (nombre === null) return 0;
  const cents = Math.round(Math.abs(nombre) * 100);
  return negatif ? -cents : cents;
}

/**
 * Convertit des cents entiers en montant décimal, pour écriture dans la feuille.
 * @param {number} cents Montant en cents.
 * @return {number} Montant en dollars (2 décimales).
 */
function enDollars_(cents) {
  const entier = Math.round(Number(cents) || 0);
  return entier / 100;
}

/**
 * Symbole ou code affiché après un montant.
 * @param {string} devise Code de devise (CAD, USD, EUR...).
 * @return {string} Symbole à afficher.
 */
function feuillesSymboleDevise_(devise) {
  const code = String(devise === null || devise === undefined ? '' : devise).trim().toUpperCase();
  if (code === '' || code === 'CAD' || code === '$') return '$';
  if (code === 'USD') return '$ US';
  if (code === 'EUR') return '€';
  return code;
}

/**
 * Formate un montant en cents pour l'affichage humain : '1 234,56 $'.
 * @param {number} cents Montant en cents.
 * @param {string} [devise] Code de devise ; CAD par défaut.
 * @return {string} Montant lisible.
 */
function formaterMontant_(cents, devise) {
  const entier = Math.round(Number(cents) || 0);
  const negatif = entier < 0;
  const absolu = Math.abs(entier);
  const partieEntiere = String(Math.floor(absolu / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  let decimales = String(absolu % 100);
  while (decimales.length < 2) decimales = '0' + decimales;
  return `${negatif ? '-' : ''}${partieEntiere},${decimales} ${feuillesSymboleDevise_(devise)}`;
}

/**
 * Convertit une valeur en date, ou null si ce n'en est pas une.
 * Accepte un objet Date, un numéro de série Google Sheets, 'AAAA-MM-JJ',
 * 'AAAA/MM/JJ', 'JJ-MM-AAAA' et 'JJ/MM/AAAA'.
 * @param {*} valeur Valeur à convertir.
 * @return {Date|null} La date (à minuit, heure locale) ou null.
 */
function versDate_(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return null;
  if (valeur instanceof Date) return isNaN(valeur.getTime()) ? null : valeur;
  if (typeof valeur === 'number') {
    if (!isFinite(valeur)) return null;
    if (valeur > 100000000000) return new Date(valeur);
    if (valeur > 0 && valeur < 2958466) {
      const serie = new Date(1899, 11, 30);
      serie.setDate(serie.getDate() + Math.round(valeur));
      return serie;
    }
    return null;
  }
  const texte = String(valeur).trim();
  if (!texte) return null;
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(texte);
  if (iso) return feuillesDateValide_(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const fr = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(texte);
  if (fr) return feuillesDateValide_(Number(fr[3]), Number(fr[2]), Number(fr[1]));
  const analysee = new Date(texte);
  return isNaN(analysee.getTime()) ? null : analysee;
}

/**
 * Construit une date en vérifiant que les composantes existent vraiment.
 * @param {number} annee Année sur 4 chiffres.
 * @param {number} mois Mois de 1 à 12.
 * @param {number} jour Jour du mois.
 * @return {Date|null} La date, ou null si la combinaison n'existe pas.
 */
function feuillesDateValide_(annee, mois, jour) {
  if (!annee || !mois || !jour || mois < 1 || mois > 12 || jour < 1 || jour > 31) return null;
  const date = new Date(annee, mois - 1, jour);
  if (date.getFullYear() !== annee || date.getMonth() !== mois - 1 || date.getDate() !== jour) {
    return null;
  }
  return date;
}

/**
 * Formate une date en 'AAAA-MM-JJ'. Renvoie '' si la valeur n'est pas une date.
 * @param {*} date Date ou valeur convertible.
 * @return {string} Date lisible, ou chaîne vide.
 */
function formaterDate_(date) {
  const valeur = versDate_(date);
  if (!valeur) return '';
  const mois = String(valeur.getMonth() + 1);
  const jour = String(valeur.getDate());
  return `${valeur.getFullYear()}-${mois.length < 2 ? '0' + mois : mois}-${jour.length < 2 ? '0' + jour : jour}`;
}

/**
 * Remplace les accents sans dépendre de String.normalize (filet de sécurité).
 * @param {string} texte Texte en majuscules.
 * @return {string} Texte sans accents.
 */
function feuillesSansAccents_(texte) {
  const accents = 'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝŸ';
  const simples = 'AAAAAACEEEEIIIINOOOOOUUUUYY';
  let sortie = '';
  for (let i = 0; i < texte.length; i++) {
    const position = accents.indexOf(texte.charAt(i));
    sortie += position >= 0 ? simples.charAt(position) : texte.charAt(i);
  }
  return sortie;
}

/**
 * Normalise un texte pour la comparaison : sans espaces, sans ponctuation,
 * sans accents, en majuscules. Sert notamment à comparer deux n° de facture
 * (« INV 2026-001 » et « inv2026001 » sont alors identiques).
 * @param {*} texte Texte à normaliser.
 * @return {string} Texte comparable (A-Z et 0-9 seulement).
 */
function texteNormalise_(texte) {
  if (texte === null || texte === undefined) return '';
  let sortie = String(texte).trim().toUpperCase();
  try {
    sortie = sortie.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (e) {
    sortie = feuillesSansAccents_(sortie);
  }
  return sortie.replace(/[^A-Z0-9]/g, '');
}

// ===========================================================================
// ▼ src/04_Bilans.gs   (module 5 sur 11)
// ===========================================================================
/**
 * 04_Bilans.gs — Étapes 1 et 2 du cycle : générer les bilans du mois, puis les envoyer.
 *
 * Un bilan = ce que Grégory doit à un client pour une période (AAAA-MM). Il est
 * agrégé à partir des lignes saisies dans l'onglet Lignes_bilan, puis envoyé au
 * client pour qu'il émette sa facture.
 *
 * Deux garanties, parce que ces deux fonctions sont relancées souvent :
 *   1. IDEMPOTENCE : un bilan existant pour (client, période) est mis à jour tant
 *      qu'il est au statut Brouillon ; dès qu'il est Envoyé ou plus avancé, il
 *      n'est plus touché. Jamais de doublon, jamais de réécriture d'un envoi.
 *   2. REPRISE : l'envoi respecte le quota Gmail du jour, s'arrête proprement
 *      quand il approche de la limite, et le passage suivant reprend là où il
 *      s'était arrêté (les bilans non envoyés restent au statut Brouillon).
 *
 * L'argent est manipulé en cents entiers (enCents_ / enDollars_) : aucune
 * comparaison de flottants. Toutes les données passent par 03_Feuilles.gs.
 */

/**
 * Colonnes utilisées par ce module. Les noms viennent tous de CONFIG : aucun
 * en-tête n'est écrit en dur ici.
 */
const BILANS_COL_ = {
  CLIENT_ID: CONFIG.ONGLETS.CLIENTS.colonnes[0].nom,          // ID client
  CLIENT_NOM: CONFIG.ONGLETS.CLIENTS.colonnes[1].nom,         // Nom
  CLIENT_COURRIEL: CONFIG.ONGLETS.CLIENTS.colonnes[2].nom,    // Courriel
  CLIENT_COPIE: CONFIG.ONGLETS.CLIENTS.colonnes[3].nom,       // Courriels en copie
  CLIENT_ACTIF: CONFIG.ONGLETS.CLIENTS.colonnes[4].nom,       // Actif
  CLIENT_DEVISE: CONFIG.ONGLETS.CLIENTS.colonnes[5].nom,      // Devise

  LIGNE_ID: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[0].nom,      // ID ligne
  LIGNE_CLIENT: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[1].nom,  // ID client
  LIGNE_PERIODE: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[2].nom, // Période
  LIGNE_DESCRIPTION: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[4].nom,
  LIGNE_QUANTITE: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[5].nom,
  LIGNE_PRIX: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[6].nom,    // Prix unitaire
  LIGNE_MONTANT: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[7].nom, // Montant
  LIGNE_BILAN: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[8].nom,   // ID bilan

  BILAN_ID: CONFIG.ONGLETS.BILANS.colonnes[0].nom,            // ID bilan
  BILAN_CLIENT: CONFIG.ONGLETS.BILANS.colonnes[1].nom,        // ID client
  BILAN_NOM: CONFIG.ONGLETS.BILANS.colonnes[2].nom,           // Nom client
  BILAN_PERIODE: CONFIG.ONGLETS.BILANS.colonnes[3].nom,       // Période
  BILAN_GENERATION: CONFIG.ONGLETS.BILANS.colonnes[4].nom,    // Date de génération
  BILAN_ENVOI: CONFIG.ONGLETS.BILANS.colonnes[5].nom,         // Date d'envoi
  BILAN_MONTANT: CONFIG.ONGLETS.BILANS.colonnes[6].nom,       // Montant du bilan
  BILAN_NB_LIGNES: CONFIG.ONGLETS.BILANS.colonnes[7].nom,     // Nombre de lignes
  BILAN_STATUT: CONFIG.ONGLETS.BILANS.colonnes[8].nom,        // Statut
};

/** Résultats possibles de envoyerOuBrouillonner_ (08_Courriels.gs). */
const BILANS_ENVOI_ = {
  ENVOYE: 'Envoyé',
  BROUILLON: 'Brouillon créé',
  ECHEC: 'Échec',
};

/** Courriels gardés en réserve sur le quota du jour (marge de sécurité). */
const BILANS_MARGE_QUOTA_ = 5;

/** Nombre maximal de lignes détaillées dans le courriel (le total les inclut toutes). */
const BILANS_MAX_LIGNES_COURRIEL_ = 200;

/** Noms des mois, pour écrire la période en toutes lettres. */
const BILANS_MOIS_ = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Styles en ligne du courriel : Gmail ignore toute feuille de style externe. */
const BILANS_STYLE_ = {
  corps: 'max-width:600px;margin:0 auto;padding:0 8px;font-family:Arial,Helvetica,sans-serif;' +
         'font-size:14px;line-height:1.5;color:#222222;',
  paragraphe: 'margin:0 0 14px 0;',
  tableau: 'width:100%;max-width:600px;border-collapse:collapse;font-size:13px;margin:0 0 14px 0;',
  entete: 'padding:6px 8px;border-bottom:2px solid #333333;text-align:left;font-weight:bold;',
  enteteDroite: 'padding:6px 8px;border-bottom:2px solid #333333;text-align:right;font-weight:bold;',
  cellule: 'padding:6px 8px;border-bottom:1px solid #dddddd;text-align:left;vertical-align:top;',
  celluleDroite: 'padding:6px 8px;border-bottom:1px solid #dddddd;text-align:right;vertical-align:top;',
  total: 'padding:8px;border-top:2px solid #333333;text-align:right;font-weight:bold;',
  discret: 'margin:18px 0 0 0;font-size:12px;color:#777777;',
};

// ---------------------------------------------------------------------------
// Périodes (fonctions PURES : aucune lecture de feuille, donc testables)
// ---------------------------------------------------------------------------

/**
 * Période du mois d'une date, au format 'AAAA-MM'.
 * @param {Date|*} [date] Date de référence ; le jour même par défaut.
 * @return {string} La période, ex. '2026-06'.
 */
function periodeCourante_(date) {
  const reference = versDate_(date) || new Date();
  return `${reference.getFullYear()}-${bilansDeuxChiffres_(reference.getMonth() + 1)}`;
}

/**
 * Période du mois qui précède celle passée en argument.
 * @param {string|Date} [periode] Période 'AAAA-MM' ou date ; mois courant par défaut.
 * @return {string} La période précédente, ou '' si l'argument est illisible.
 */
function periodePrecedente_(periode) {
  const base = (periode === null || periode === undefined || periode === '')
    ? periodeCourante_()
    : bilansPeriodeValide_(periode);
  if (!base) return '';
  const annee = Number(base.slice(0, 4));
  const mois = Number(base.slice(5, 7));
  const moisPrecedent = mois === 1 ? 12 : mois - 1;
  const anneePrecedente = mois === 1 ? annee - 1 : annee;
  return `${anneePrecedente}-${bilansDeuxChiffres_(moisPrecedent)}`;
}

/**
 * Complète un nombre sur deux chiffres ('6' devient '06').
 * @param {number} nombre Nombre à formater.
 * @return {string} Deux chiffres.
 */
function bilansDeuxChiffres_(nombre) {
  const texte = String(Math.abs(Math.round(Number(nombre) || 0)));
  return texte.length < 2 ? `0${texte}` : texte;
}

/**
 * Ramène une valeur à une période 'AAAA-MM'. Accepte '2026-6', '2026/06' et un
 * objet Date (Google Sheets transforme parfois « 2026-06 » en date).
 * @param {*} valeur Valeur saisie.
 * @return {string} Période normalisée, ou '' si ce n'en est pas une.
 */
function bilansPeriodeValide_(valeur) {
  if (valeur === null || valeur === undefined) return '';
  if (valeur instanceof Date) return isNaN(valeur.getTime()) ? '' : periodeCourante_(valeur);
  const trouve = /^(\d{4})[-/](\d{1,2})$/.exec(String(valeur).trim());
  if (!trouve) return '';
  const mois = Number(trouve[2]);
  if (mois < 1 || mois > 12) return '';
  return `${trouve[1]}-${bilansDeuxChiffres_(mois)}`;
}

/**
 * Écrit une période en toutes lettres, ex. « juin 2026 ».
 * @param {string} periode Période 'AAAA-MM'.
 * @return {string} Période lisible ; la valeur brute si elle est illisible.
 */
function bilansPeriodeEnLettres_(periode) {
  const valide = bilansPeriodeValide_(periode);
  if (!valide) return String(periode === null || periode === undefined ? '' : periode).trim();
  return `${BILANS_MOIS_[Number(valide.slice(5, 7)) - 1]} ${valide.slice(0, 4)}`;
}

// ---------------------------------------------------------------------------
// Petits utilitaires internes
// ---------------------------------------------------------------------------

/**
 * Vrai si la cellule est vide (rien saisi), par opposition à un zéro saisi.
 * @param {*} valeur Contenu de la cellule.
 * @return {boolean}
 */
function bilansCelluleVide_(valeur) {
  if (valeur === null || valeur === undefined) return true;
  return typeof valeur === 'string' && valeur.trim() === '';
}

/**
 * Lit un nombre saisi (quantité), en tolérant '2,5' et '1 000'.
 * @param {*} valeur Contenu de la cellule.
 * @return {number|null} Le nombre, ou null s'il n'y en a pas.
 */
function bilansNombre_(valeur) {
  if (typeof valeur === 'number') return isFinite(valeur) ? valeur : null;
  if (bilansCelluleVide_(valeur) || valeur instanceof Date || typeof valeur === 'boolean') return null;
  if (!/\d/.test(String(valeur))) return null;
  return enCents_(valeur) / 100;
}

/**
 * Texte nettoyé d'une cellule.
 * @param {*} valeur Contenu de la cellule.
 * @return {string} Texte sans espaces superflus.
 */
function bilansTexte_(valeur) {
  return String(valeur === null || valeur === undefined ? '' : valeur).trim();
}

/**
 * Échappe un texte destiné au HTML d'un courriel.
 * @param {*} texte Texte brut (saisi par un humain).
 * @return {string} Texte sûr à insérer dans du HTML.
 */
function bilansEchapper_(texte) {
  return bilansTexte_(texte)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Devise à afficher pour un client (sa devise, sinon celle des Paramètres).
 * @param {Object} client Ligne de l'onglet Clients.
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {string} Code de devise, ex. 'CAD'.
 */
function bilansDevise_(client, params) {
  return bilansTexte_((client || {})[BILANS_COL_.CLIENT_DEVISE]) ||
         bilansTexte_((params || {}).DEVISE) ||
         CONFIG.PARAMETRES_DEFAUT.DEVISE;
}

/**
 * Montant d'une ligne de bilan, en cents. Si la colonne Montant est vide, on
 * calcule Quantité × Prix unitaire (une quantité vide vaut 1).
 * @param {Object} ligne Ligne de l'onglet Lignes_bilan.
 * @return {number} Montant en cents entiers.
 */
function bilansMontantLigneCents_(ligne) {
  if (!ligne) return 0;
  const montant = ligne[BILANS_COL_.LIGNE_MONTANT];
  if (!bilansCelluleVide_(montant)) return enCents_(montant);
  const brutQuantite = ligne[BILANS_COL_.LIGNE_QUANTITE];
  const quantite = bilansCelluleVide_(brutQuantite) ? 1 : bilansNombre_(brutQuantite);
  if (quantite === null) return 0;
  return Math.round(quantite * enCents_(ligne[BILANS_COL_.LIGNE_PRIX]));
}

/**
 * Somme des montants d'une liste de lignes, en cents.
 * @param {Array<Object>} lignes Lignes de l'onglet Lignes_bilan.
 * @return {number} Total en cents entiers.
 */
function bilansTotalLignesCents_(lignes) {
  return (lignes || []).reduce((total, ligne) => total + bilansMontantLigneCents_(ligne), 0);
}

/**
 * Construit l'identifiant d'un bilan, ex. 'B-C001-2026-06'.
 * @param {string} idClient Identifiant du client ('C-001').
 * @param {string} periode Période 'AAAA-MM'.
 * @return {string} Identifiant du bilan.
 */
function bilansConstruireId_(idClient, periode) {
  return `B-${texteNormalise_(idClient) || 'CLIENT'}-${periode}`;
}

/**
 * Énumère quelques éléments d'une liste, sans noyer l'utilisateur.
 * @param {Array<string>} elements Éléments à citer.
 * @param {number} [maximum] Nombre d'éléments cités ; 5 par défaut.
 * @return {string} Liste lisible, ex. « A, B et 3 autres ».
 */
function bilansListeCourte_(elements, maximum) {
  const liste = (elements || []).map((element) => String(element));
  const plafond = Math.max(1, Number(maximum) || 5);
  if (liste.length <= plafond) return liste.join(', ');
  return `${liste.slice(0, plafond).join(', ')} et ${liste.length - plafond} autre(s)`;
}

// ---------------------------------------------------------------------------
// 1. Génération des bilans
// ---------------------------------------------------------------------------

/**
 * Génère (ou met à jour) les bilans d'une période à partir de l'onglet
 * Lignes_bilan. Un bilan déjà envoyé n'est jamais modifié : il est signalé.
 * @param {string} [periode] Période 'AAAA-MM' ; le mois courant par défaut.
 * @return {string} Résumé lisible, affiché par le menu.
 */
function genererBilans(periode) {
  const periodeCible = bilansPeriodeValide_(periode) || periodeCourante_();
  const params = lireParametres_();
  const contexte = {
    periode: periodeCible,
    indexClients: indexerPar_(lireTable_(CONFIG.ONGLETS.CLIENTS.nom), BILANS_COL_.CLIENT_ID),
    bilansParCle: bilansIndexerParClientPeriode_(lireTable_(CONFIG.ONGLETS.BILANS.nom)),
    ajouts: [],
    majsBilans: [],
    majsLignes: [],
    resume: bilansNouveauResumeGeneration_(periodeCible, params),
  };
  const groupes = bilansRegrouperLignes_(
    lireTable_(CONFIG.ONGLETS.LIGNES_BILAN.nom), periodeCible,
    contexte.indexClients, contexte.resume);

  groupes.forEach((lignesClient, idClient) => {
    try {
      bilansTraiterClient_(contexte, idClient, lignesClient);
    } catch (e) {
      contexte.resume.erreurs.push(idClient);
      journalErreur_('genererBilans',
        `Le bilan du client ${idClient} n'a pas pu être calculé : ${e.message}`,
        `${e.message}\n${e.stack}`);
    }
  });

  bilansEcrireGeneration_(contexte);
  journalInfo_('genererBilans',
    `Période ${periodeCible} : ${contexte.resume.crees} bilan(s) créé(s), ` +
    `${contexte.resume.misAJour} mis à jour, ` +
    `${contexte.resume.verrouilles.length} déjà envoyé(s) et laissé(s) intact(s).`,
    `Total ${formaterMontant_(contexte.resume.totalCents, contexte.resume.devise)} ` +
    `sur ${contexte.resume.lignesTraitees} ligne(s).`);
  return bilansResumeGeneration_(contexte.resume);
}

/**
 * Prépare le compteur de résultats de la génération.
 * @param {string} periode Période traitée.
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {Object} Résumé vierge.
 */
function bilansNouveauResumeGeneration_(periode, params) {
  return {
    periode: periode,
    devise: bilansTexte_((params || {}).DEVISE) || CONFIG.PARAMETRES_DEFAUT.DEVISE,
    crees: 0,
    misAJour: 0,
    lignesTraitees: 0,
    totalCents: 0,
    verrouilles: [],
    inactifs: [],
    inconnus: [],
    montantsNuls: [],
    erreurs: [],
  };
}

/**
 * Regroupe par client les lignes de la période. Les lignes dont l'ID client est
 * vide ou introuvable sont écartées et signalées nommément : c'est une faute de
 * saisie qu'il faut voir.
 * @param {Array<Object>} lignes Toutes les lignes de l'onglet Lignes_bilan.
 * @param {string} periode Période visée.
 * @param {Map<string, Object>} indexClients Clients indexés par ID.
 * @param {Object} resume Compteur de résultats, complété au passage.
 * @return {Map<string, Array<Object>>} ID client vers ses lignes.
 */
function bilansRegrouperLignes_(lignes, periode, indexClients, resume) {
  const groupes = new Map();
  (lignes || []).forEach((ligne) => {
    if (bilansPeriodeValide_(ligne[BILANS_COL_.LIGNE_PERIODE]) !== periode) return;
    const idLigne = bilansTexte_(ligne[BILANS_COL_.LIGNE_ID]) || `ligne ${ligne._ligne}`;
    const idClient = bilansTexte_(ligne[BILANS_COL_.LIGNE_CLIENT]);
    if (!idClient || !indexClients.has(idClient)) {
      const raison = idClient
        ? `ID client « ${idClient} » introuvable dans l'onglet ${CONFIG.ONGLETS.CLIENTS.nom}`
        : 'aucun ID client';
      resume.inconnus.push(`${idLigne} (${raison})`);
      journalAvert_('genererBilans',
        `Ligne ${idLigne} ignorée : ${raison}.`,
        `Onglet ${CONFIG.ONGLETS.LIGNES_BILAN.nom}, ligne ${ligne._ligne}, période ${periode}.`);
      return;
    }
    if (!groupes.has(idClient)) groupes.set(idClient, []);
    groupes.get(idClient).push(ligne);
  });
  return groupes;
}

/**
 * Indexe les bilans existants par couple (ID client, période).
 * @param {Array<Object>} bilans Lignes de l'onglet Bilans.
 * @return {Map<string, Array<Object>>} Clé 'ID|période' vers bilans.
 */
function bilansIndexerParClientPeriode_(bilans) {
  const index = new Map();
  (bilans || []).forEach((bilan) => {
    const idClient = bilansTexte_(bilan[BILANS_COL_.BILAN_CLIENT]);
    const periode = bilansPeriodeValide_(bilan[BILANS_COL_.BILAN_PERIODE]);
    if (!idClient || !periode) return;
    const cle = `${idClient}|${periode}`;
    if (!index.has(cle)) index.set(cle, []);
    index.get(cle).push(bilan);
  });
  return index;
}

/**
 * Retrouve le bilan déjà enregistré pour un client et une période, en ignorant
 * les bilans annulés. Un bilan déjà avancé l'emporte sur un brouillon en double.
 * @param {Map<string, Array<Object>>} bilansParCle Index des bilans existants.
 * @param {string} idClient Identifiant du client.
 * @param {string} periode Période visée.
 * @return {Object|null} Le bilan existant, ou null.
 */
function bilansBilanExistant_(bilansParCle, idClient, periode) {
  const candidats = (bilansParCle.get(`${idClient}|${periode}`) || []).filter(
    (bilan) => texteNormalise_(bilan[BILANS_COL_.BILAN_STATUT]) !== texteNormalise_(STATUT_BILAN.ANNULE));
  if (!candidats.length) return null;
  if (candidats.length > 1) {
    journalAvert_('genererBilans',
      `Plusieurs bilans existent pour ${idClient} et la période ${periode}.`,
      `Lignes ${candidats.map((bilan) => bilan._ligne).join(', ')} de l'onglet ` +
      `${CONFIG.ONGLETS.BILANS.nom} : le plus avancé est conservé, aucun doublon n'est créé.`);
  }
  const avances = candidats.filter((bilan) => !bilansEstModifiable_(bilan));
  return avances.length ? avances[0] : candidats[0];
}

/**
 * Dit si un bilan peut encore être recalculé (brouillon, ou statut non renseigné).
 * @param {Object} bilan Ligne de l'onglet Bilans.
 * @return {boolean} Vrai tant que le bilan n'est pas parti chez le client.
 */
function bilansEstModifiable_(bilan) {
  const statut = texteNormalise_(bilan[BILANS_COL_.BILAN_STATUT]);
  return statut === '' || statut === texteNormalise_(STATUT_BILAN.BROUILLON);
}

/**
 * Calcule le bilan d'un client pour la période et prépare les écritures.
 * @param {Object} contexte État partagé de la génération.
 * @param {string} idClient Identifiant du client.
 * @param {Array<Object>} lignesClient Ses lignes pour la période.
 * @return {void}
 */
function bilansTraiterClient_(contexte, idClient, lignesClient) {
  const resume = contexte.resume;
  const client = contexte.indexClients.get(idClient);
  const nom = bilansTexte_(client[BILANS_COL_.CLIENT_NOM]) || idClient;
  if (texteNormalise_(client[BILANS_COL_.CLIENT_ACTIF]) !== 'OUI') {
    resume.inactifs.push(nom);
    return;
  }
  const existant = bilansBilanExistant_(contexte.bilansParCle, idClient, contexte.periode);
  if (existant && !bilansEstModifiable_(existant)) {
    resume.verrouilles.push(`${nom} (${bilansTexte_(existant[BILANS_COL_.BILAN_STATUT])})`);
    journalInfo_('genererBilans',
      `Le bilan de ${nom} pour ${contexte.periode} est déjà « ` +
      `${bilansTexte_(existant[BILANS_COL_.BILAN_STATUT])} » : il n'a pas été modifié.`,
      `${lignesClient.length} ligne(s) de cette période n'ont pas été rattachées.`);
    return;
  }
  const totalCents = bilansTotalLignesCents_(lignesClient);
  const idBilan = (existant && bilansTexte_(existant[BILANS_COL_.BILAN_ID])) ||
    bilansConstruireId_(idClient, contexte.periode);
  const donnees = bilansDonneesBilan_(idBilan, idClient, nom, contexte.periode, totalCents, lignesClient.length);
  if (existant) {
    contexte.majsBilans.push({ ligne: existant._ligne, patch: donnees });
    resume.misAJour++;
  } else {
    contexte.ajouts.push(donnees);
    resume.crees++;
  }
  bilansMarquerLignes_(contexte.majsLignes, lignesClient, idBilan);
  resume.lignesTraitees += lignesClient.length;
  resume.totalCents += totalCents;
  if (totalCents <= 0) {
    resume.montantsNuls.push(`${nom} : ${formaterMontant_(totalCents, bilansDevise_(client, {}))}`);
  }
}

/**
 * Compose la ligne de l'onglet Bilans. Les colonnes non citées (Notes, ID
 * facture, Date d'envoi) ne sont jamais écrasées lors d'une mise à jour.
 * @param {string} idBilan Identifiant du bilan.
 * @param {string} idClient Identifiant du client.
 * @param {string} nom Nom du client.
 * @param {string} periode Période 'AAAA-MM'.
 * @param {number} totalCents Montant du bilan en cents.
 * @param {number} nombreLignes Nombre de lignes agrégées.
 * @return {Object} Ligne prête pour ajouterLignes_ ou majLignes_.
 */
function bilansDonneesBilan_(idBilan, idClient, nom, periode, totalCents, nombreLignes) {
  const donnees = {};
  donnees[BILANS_COL_.BILAN_ID] = idBilan;
  donnees[BILANS_COL_.BILAN_CLIENT] = idClient;
  donnees[BILANS_COL_.BILAN_NOM] = nom;
  donnees[BILANS_COL_.BILAN_PERIODE] = periode;
  donnees[BILANS_COL_.BILAN_GENERATION] = new Date();
  donnees[BILANS_COL_.BILAN_MONTANT] = enDollars_(totalCents);
  donnees[BILANS_COL_.BILAN_NB_LIGNES] = nombreLignes;
  donnees[BILANS_COL_.BILAN_STATUT] = STATUT_BILAN.BROUILLON;
  return donnees;
}

/**
 * Note l'ID du bilan dans chaque ligne traitée, sans réécrire celles qui le
 * portent déjà (moins d'écritures, et rien n'est détruit).
 * @param {Array<Object>} majsLignes Liste de mises à jour à compléter.
 * @param {Array<Object>} lignesClient Lignes rattachées au bilan.
 * @param {string} idBilan Identifiant du bilan.
 * @return {void}
 */
function bilansMarquerLignes_(majsLignes, lignesClient, idBilan) {
  lignesClient.forEach((ligne) => {
    if (bilansTexte_(ligne[BILANS_COL_.LIGNE_BILAN]) === idBilan) return;
    const patch = {};
    patch[BILANS_COL_.LIGNE_BILAN] = idBilan;
    majsLignes.push({ ligne: ligne._ligne, patch: patch });
  });
}

/**
 * Applique en trois écritures groupées tout ce que la génération a préparé.
 * @param {Object} contexte État partagé de la génération.
 * @return {void}
 */
function bilansEcrireGeneration_(contexte) {
  if (contexte.ajouts.length) {
    ajouterLignes_(CONFIG.ONGLETS.BILANS.nom, contexte.ajouts);
  }
  if (contexte.majsBilans.length) {
    majLignes_(CONFIG.ONGLETS.BILANS.nom, contexte.majsBilans);
  }
  if (contexte.majsLignes.length) {
    majLignes_(CONFIG.ONGLETS.LIGNES_BILAN.nom, contexte.majsLignes);
  }
}

/**
 * Rédige le résumé de la génération, pour quelqu'un qui n'est pas informaticien.
 * @param {Object} resume Compteur de résultats.
 * @return {string} Texte affiché dans l'alerte du menu.
 */
function bilansResumeGeneration_(resume) {
  const lettres = bilansPeriodeEnLettres_(resume.periode);
  const texte = [`Bilans de ${lettres} (${resume.periode}).`, ''];
  if (!resume.crees && !resume.misAJour) {
    texte.push(`Aucun bilan créé : il n'y a aucune ligne à traiter pour ${lettres} dans ` +
      `l'onglet ${CONFIG.ONGLETS.LIGNES_BILAN.nom}, ou tous les bilans sont déjà partis.`);
  } else {
    texte.push(`• ${resume.crees} bilan(s) créé(s) au statut « ${STATUT_BILAN.BROUILLON} ».`);
    texte.push(`• ${resume.misAJour} bilan(s) déjà en brouillon mis à jour (aucun doublon).`);
    texte.push(`• ${resume.lignesTraitees} ligne(s) rattachée(s), pour un total de ` +
      `${formaterMontant_(resume.totalCents, resume.devise)}.`);
  }
  if (resume.verrouilles.length) {
    texte.push(`• ${resume.verrouilles.length} bilan(s) déjà envoyé(s) : laissés intacts — ` +
      `${bilansListeCourte_(resume.verrouilles)}.`);
  }
  if (resume.montantsNuls.length) {
    texte.push(`• À vérifier, montant nul ou négatif : ${bilansListeCourte_(resume.montantsNuls)}.`);
  }
  if (resume.inconnus.length) {
    texte.push(`• ${resume.inconnus.length} ligne(s) ignorée(s), ID client absent ou inconnu : ` +
      `${bilansListeCourte_(resume.inconnus, 3)}. Corrigez-les puis relancez.`);
  }
  if (resume.inactifs.length) {
    texte.push(`• Client(s) non actif(s), donc sans bilan : ${bilansListeCourte_(resume.inactifs)}.`);
  }
  if (resume.erreurs.length) {
    texte.push(`• ${resume.erreurs.length} client(s) en erreur : ${bilansListeCourte_(resume.erreurs)} ` +
      `(le détail est dans l'onglet ${CONFIG.ONGLETS.JOURNAL.nom}).`);
  }
  texte.push('', 'Prochaine étape : « 2. Envoyer les bilans ».');
  return texte.join('\n');
}

// ---------------------------------------------------------------------------
// 2. Envoi des bilans
// ---------------------------------------------------------------------------

/**
 * Envoie (ou prépare en brouillon, selon le réglage MODE_ENVOI) tous les bilans
 * au statut Brouillon. Un envoi qui échoue laisse le bilan en Brouillon pour
 * être repris plus tard ; le quota Gmail du jour est respecté.
 * @return {string} Résumé lisible, affiché par le menu.
 */
function envoyerBilans() {
  const enAttente = bilansBrouillons_();
  if (!enAttente.length) {
    return `Aucun bilan au statut « ${STATUT_BILAN.BROUILLON} » : il n'y a rien à envoyer. ` +
      'Lancez d\'abord « 1. Générer les bilans du mois ».';
  }
  const contexte = {
    params: lireParametres_(),
    indexClients: indexerPar_(lireTable_(CONFIG.ONGLETS.CLIENTS.nom), BILANS_COL_.CLIENT_ID),
    lignesParBilan: indexerGroupesPar_(
      lireTable_(CONFIG.ONGLETS.LIGNES_BILAN.nom), BILANS_COL_.LIGNE_BILAN),
    majs: [],
    resume: bilansNouveauResumeEnvoi_(enAttente.length),
  };
  const disponible = bilansQuotaDisponible_(enAttente.length, contexte.resume, contexte.params);
  try {
    for (let i = 0; i < enAttente.length; i++) {
      if (contexte.resume.traites >= disponible) {
        contexte.resume.restants = enAttente.length - i;
        contexte.resume.quotaAtteint = true;
        break;
      }
      bilansEnvoyerUn_(contexte, enAttente[i]);
    }
  } finally {
    // Même si quelque chose casse en route, les bilans réellement partis sont
    // marqués « Envoyé » : on ne les enverra pas deux fois.
    if (contexte.majs.length) majLignes_(CONFIG.ONGLETS.BILANS.nom, contexte.majs);
  }
  bilansJournaliserEnvoi_(contexte.resume);
  return bilansResumeEnvoi_(contexte.resume);
}

/**
 * Liste les bilans encore au statut Brouillon, dans l'ordre de l'onglet.
 * @return {Array<Object>} Bilans à envoyer.
 */
function bilansBrouillons_() {
  const cible = texteNormalise_(STATUT_BILAN.BROUILLON);
  return lireTable_(CONFIG.ONGLETS.BILANS.nom).filter(
    (bilan) => texteNormalise_(bilan[BILANS_COL_.BILAN_STATUT]) === cible);
}

/**
 * Prépare le compteur de résultats de l'envoi.
 * @param {number} total Nombre de bilans à traiter.
 * @return {Object} Résumé vierge.
 */
function bilansNouveauResumeEnvoi_(total) {
  return {
    total: total,
    traites: 0,
    envoyes: 0,
    brouillons: 0,
    echecs: [],
    ignores: [],
    restants: 0,
    quota: 0,
    quotaLisible: true,
    quotaAtteint: false,
  };
}

/**
 * Nombre de courriels que l'on s'autorise aujourd'hui : le quota Gmail restant,
 * moins une marge de sécurité. Un quota illisible vaut zéro (on ne risque rien).
 *
 * En mode Brouillon — le mode par défaut — rien ne part : GmailApp.createDraft
 * ne consomme pas le quota d'envoi, donc on ne bride rien (même règle que
 * courrielsContexte_ dans 08_Courriels.gs).
 * @param {number} total Nombre de bilans à envoyer.
 * @param {Object} resume Compteur de résultats, complété au passage.
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {number} Nombre maximal d'envois pour ce passage.
 */
function bilansQuotaDisponible_(total, resume, params) {
  if (texteNormalise_((params || {}).MODE_ENVOI) !== 'DIRECT') return total;
  let quota = 0;
  try {
    quota = Number(quotaCourrielRestant_());
  } catch (e) {
    resume.quotaLisible = false;
    journalErreur_('envoyerBilans', `Le quota de courriels n'a pas pu être lu : ${e.message}`,
      `${e.message}\n${e.stack}`);
  }
  if (!isFinite(quota) || quota < 0) quota = 0;
  resume.quota = quota;
  const disponible = Math.max(0, quota - BILANS_MARGE_QUOTA_);
  if (disponible < total) {
    journalAvert_('envoyerBilans',
      `Quota de courriels insuffisant : ${disponible} envoi(s) possible(s) pour ${total} bilan(s).`,
      `Quota restant annoncé par Gmail : ${quota}, marge de sécurité conservée : ${BILANS_MARGE_QUOTA_}.`);
  }
  return disponible;
}

/**
 * Traite un bilan : construit le courriel, l'envoie via 08_Courriels.gs, et ne
 * marque « Envoyé » que si le courriel est bien parti (ou bien en brouillon).
 * @param {Object} contexte État partagé de l'envoi.
 * @param {Object} bilan Ligne de l'onglet Bilans.
 * @return {void}
 */
function bilansEnvoyerUn_(contexte, bilan) {
  const resume = contexte.resume;
  const idBilan = bilansTexte_(bilan[BILANS_COL_.BILAN_ID]);
  const idClient = bilansTexte_(bilan[BILANS_COL_.BILAN_CLIENT]);
  const nom = bilansTexte_(bilan[BILANS_COL_.BILAN_NOM]) || idClient || idBilan;
  const client = contexte.indexClients.get(idClient);
  if (!client) {
    resume.ignores.push(`${nom} : ID client « ${idClient} » introuvable`);
    journalAvert_('envoyerBilans', `Bilan ${idBilan} non envoyé : client « ${idClient} » introuvable.`,
      `Onglet ${CONFIG.ONGLETS.BILANS.nom}, ligne ${bilan._ligne}.`);
    return;
  }
  const destinataire = bilansTexte_(client[BILANS_COL_.CLIENT_COURRIEL]);
  if (!destinataire) {
    resume.ignores.push(`${nom} : aucune adresse courriel`);
    journalAvert_('envoyerBilans', `Bilan ${idBilan} non envoyé : ${nom} n'a pas d'adresse courriel.`,
      `Complétez la colonne « ${BILANS_COL_.CLIENT_COURRIEL} » de l'onglet ${CONFIG.ONGLETS.CLIENTS.nom}.`);
    return;
  }
  const etat = bilansTenterEnvoi_(contexte, bilan, client, destinataire, nom);
  resume.traites++;
  const resultat = texteNormalise_(etat);
  if (resultat === texteNormalise_(BILANS_ENVOI_.BROUILLON)) resume.brouillons++;
  else if (resultat === texteNormalise_(BILANS_ENVOI_.ENVOYE)) resume.envoyes++;
  else {
    resume.echecs.push(nom);
    journalAvert_('envoyerBilans',
      `L'envoi du bilan de ${nom} n'a pas abouti : il reste « ${STATUT_BILAN.BROUILLON} ».`,
      `Bilan ${idBilan}, destinataire ${destinataire}, résultat renvoyé : ${etat}.`);
    return;
  }
  const patch = {};
  patch[BILANS_COL_.BILAN_STATUT] = STATUT_BILAN.ENVOYE;
  patch[BILANS_COL_.BILAN_ENVOI] = new Date();
  contexte.majs.push({ ligne: bilan._ligne, patch: patch });
}

/**
 * Construit le courriel d'un bilan et le confie à 08_Courriels.gs.
 * @param {Object} contexte État partagé de l'envoi.
 * @param {Object} bilan Ligne de l'onglet Bilans.
 * @param {Object} client Ligne de l'onglet Clients.
 * @param {string} destinataire Adresse principale.
 * @param {string} nom Nom du client, pour les messages.
 * @return {string} 'Envoyé', 'Brouillon créé' ou 'Échec'.
 */
function bilansTenterEnvoi_(contexte, bilan, client, destinataire, nom) {
  try {
    const lignes = contexte.lignesParBilan.get(bilansTexte_(bilan[BILANS_COL_.BILAN_ID])) || [];
    const html = construireBilanHtml_(client, bilan, lignes, contexte.params);
    return envoyerOuBrouillonner_(destinataire, bilansSujet_(client, bilan, contexte.params), html, {
      copie: bilansTexte_(client[BILANS_COL_.CLIENT_COPIE]),
      nomExpediteur: bilansTexte_(contexte.params.NOM_EXPEDITEUR),
    });
  } catch (e) {
    journalErreur_('envoyerBilans', `Le courriel de ${nom} n'a pas pu être préparé : ${e.message}`,
      `${e.message}\n${e.stack}`);
    return BILANS_ENVOI_.ECHEC;
  }
}

/**
 * Journalise le déroulement de l'envoi, y compris ce qui reste à faire.
 * @param {Object} resume Compteur de résultats.
 * @return {void}
 */
function bilansJournaliserEnvoi_(resume) {
  journalInfo_('envoyerBilans',
    `${resume.envoyes} courriel(s) envoyé(s), ${resume.brouillons} brouillon(s) préparé(s), ` +
    `${resume.echecs.length} échec(s), ${resume.ignores.length} ignoré(s).`,
    `${resume.total} bilan(s) au statut « ${STATUT_BILAN.BROUILLON} » au départ.`);
  if (resume.quotaAtteint) {
    journalAvert_('envoyerBilans',
      `Quota de courriels atteint : ${resume.restants} bilan(s) restent à envoyer.`,
      `Ils gardent le statut « ${STATUT_BILAN.BROUILLON} » : le prochain passage reprendra ` +
      `exactement là où celui-ci s'est arrêté. Quota annoncé : ${resume.quota}.`);
  }
}

/**
 * Rédige le résumé de l'envoi.
 * @param {Object} resume Compteur de résultats.
 * @return {string} Texte affiché dans l'alerte du menu.
 */
function bilansResumeEnvoi_(resume) {
  const texte = [`${resume.total} bilan(s) étaient au statut « ${STATUT_BILAN.BROUILLON} ».`, ''];
  if (resume.brouillons) {
    texte.push(`• ${resume.brouillons} courriel(s) préparé(s) en brouillon dans Gmail : ` +
      'relisez-les, puis envoyez-les depuis Gmail.');
  }
  if (resume.envoyes) texte.push(`• ${resume.envoyes} courriel(s) envoyé(s) directement.`);
  if (resume.envoyes + resume.brouillons) {
    texte.push(`• ${resume.envoyes + resume.brouillons} bilan(s) sont passés au statut ` +
      `« ${STATUT_BILAN.ENVOYE} », avec la date du jour.`);
  }
  if (resume.echecs.length) {
    texte.push(`• ${resume.echecs.length} envoi(s) en échec : ${bilansListeCourte_(resume.echecs)}. ` +
      `Ces bilans restent « ${STATUT_BILAN.BROUILLON} » : relancez cette action plus tard.`);
  }
  if (resume.ignores.length) {
    texte.push(`• ${resume.ignores.length} bilan(s) sans destinataire : ` +
      `${bilansListeCourte_(resume.ignores, 3)}. Complétez l'onglet ` +
      `${CONFIG.ONGLETS.CLIENTS.nom}, puis relancez.`);
  }
  if (!resume.quotaLisible) {
    texte.push('• Le quota de courriels de Gmail n\'a pas pu être lu : par prudence, aucun ' +
      `courriel n'a été préparé (détail dans l'onglet ${CONFIG.ONGLETS.JOURNAL.nom}).`);
  } else if (resume.quotaAtteint) {
    texte.push(`• Quota Gmail atteint (${resume.quota} courriel(s) restants aujourd'hui, dont une ` +
      `marge de ${BILANS_MARGE_QUOTA_} conservée) : ${resume.restants} bilan(s) restent à envoyer. ` +
      'Relancez « 2. Envoyer les bilans » demain, la reprise se fera exactement là où on s\'est arrêté.');
  }
  return texte.join('\n');
}

// ---------------------------------------------------------------------------
// Le courriel de bilan
// ---------------------------------------------------------------------------

/**
 * Objet du courriel de bilan.
 * @param {Object} client Ligne de l'onglet Clients.
 * @param {Object} bilan Ligne de l'onglet Bilans.
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {string} Objet, ex. « Bilan de juin 2026 — montant à facturer : 2 480,00 $ ».
 */
function bilansSujet_(client, bilan, params) {
  const devise = bilansDevise_(client, params);
  const montant = formaterMontant_(enCents_(bilan[BILANS_COL_.BILAN_MONTANT]), devise);
  const lettres = bilansPeriodeEnLettres_(bilan[BILANS_COL_.BILAN_PERIODE]);
  return `Bilan de ${lettres} — montant à facturer : ${montant}`;
}

/**
 * Construit le courriel HTML envoyé au client : ce qu'on lui doit pour la
 * période, ligne par ligne, et la demande de facture correspondante.
 * Styles en ligne uniquement et largeur limitée à 600 px, pour rester lisible
 * dans Gmail comme sur téléphone.
 * @param {Object} client Ligne de l'onglet Clients.
 * @param {Object} bilan Ligne de l'onglet Bilans.
 * @param {Array<Object>} lignes Lignes de l'onglet Lignes_bilan rattachées.
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {string} Le corps HTML complet du courriel.
 */
function construireBilanHtml_(client, bilan, lignes, params) {
  const fiche = client || {};
  const entete = bilan || {};
  const reglages = params || {};
  const detail = (lignes || []).slice();
  const devise = bilansDevise_(fiche, reglages);
  const lettres = bilansPeriodeEnLettres_(entete[BILANS_COL_.BILAN_PERIODE]);
  const totalCents = enCents_(entete[BILANS_COL_.BILAN_MONTANT]) || bilansTotalLignesCents_(detail);
  const montant = formaterMontant_(totalCents, devise);
  const nom = bilansTexte_(fiche[BILANS_COL_.CLIENT_NOM]) || bilansTexte_(entete[BILANS_COL_.BILAN_NOM]);
  const p = BILANS_STYLE_.paragraphe;
  return [
    `<div style="${BILANS_STYLE_.corps}">`,
    `<p style="${p}">Bonjour${nom ? ` ${bilansEchapper_(nom)}` : ''},</p>`,
    `<p style="${p}">Voici le bilan de <strong>${bilansEchapper_(lettres)}</strong> : le détail de ` +
      'ce que nous vous devons pour cette période.</p>',
    bilansHtmlTableau_(detail, devise, totalCents),
    bilansHtmlAppelAction_(totalCents, montant, lettres),
    bilansHtmlSignature_(reglages),
    bilansHtmlReference_(entete, detail.length, devise),
    '</div>',
  ].filter((bloc) => bloc !== '').join('\n');
}

/**
 * Ce qu'on demande au client : sa facture pour le montant du bilan. Un bilan
 * nul ou négatif ne réclame évidemment aucune facture ; on le dit clairement
 * plutôt que de demander une facture d'un montant absurde.
 * @param {number} totalCents Montant du bilan, en cents.
 * @param {string} montant Montant déjà formaté pour l'affichage.
 * @param {string} lettres Période en toutes lettres.
 * @return {string} Le bloc HTML d'appel à l'action.
 */
function bilansHtmlAppelAction_(totalCents, montant, lettres) {
  const p = BILANS_STYLE_.paragraphe;
  if (totalCents <= 0) {
    return `<p style="${p}">Ce bilan ne présente <strong>aucun montant à facturer</strong> pour ` +
      `${bilansEchapper_(lettres)} (total : ${bilansEchapper_(montant)}) : aucune facture n'est ` +
      'attendue de votre part. Si cela ne correspond pas à vos registres, répondez simplement à ' +
      'ce courriel.</p>';
  }
  return `<p style="${p}">Merci de nous faire parvenir <strong>votre facture au montant de ` +
    `${bilansEchapper_(montant)}</strong> pour la période de ${bilansEchapper_(lettres)}.</p>\n` +
    `<p style="${p}">Si une ligne ne correspond pas à vos registres, répondez simplement à ce ` +
    'courriel avant d\'établir votre facture : nous corrigerons le bilan ensemble.</p>';
}

/**
 * Tableau des lignes du bilan, avec le total en gras.
 * @param {Array<Object>} lignes Lignes rattachées au bilan.
 * @param {string} devise Code de devise affiché.
 * @param {number} totalCents Total du bilan, en cents.
 * @return {string} Le tableau HTML.
 */
function bilansHtmlTableau_(lignes, devise, totalCents) {
  const visibles = lignes.slice(0, BILANS_MAX_LIGNES_COURRIEL_);
  const reste = lignes.length - visibles.length;
  const corps = visibles.length
    ? visibles.map((ligne) => bilansHtmlLigne_(ligne, devise)).join('\n')
    : `<tr><td colspan="4" style="${BILANS_STYLE_.cellule}">Aucun détail pour cette période.</td></tr>`;
  const note = reste > 0
    ? `<tr><td colspan="4" style="${BILANS_STYLE_.cellule}">… et ${reste} autre(s) ligne(s), ` +
      'toutes comprises dans le total ci-dessous.</td></tr>'
    : '';
  return [
    `<table role="presentation" cellspacing="0" cellpadding="0" style="${BILANS_STYLE_.tableau}">`,
    '<tr>',
    `<th style="${BILANS_STYLE_.entete}">Description</th>`,
    `<th style="${BILANS_STYLE_.enteteDroite}">Quantité</th>`,
    `<th style="${BILANS_STYLE_.enteteDroite}">Prix unitaire</th>`,
    `<th style="${BILANS_STYLE_.enteteDroite}">Montant</th>`,
    '</tr>',
    corps,
    note,
    '<tr>',
    `<td colspan="3" style="${BILANS_STYLE_.total}">Total (${bilansEchapper_(devise)})</td>`,
    `<td style="${BILANS_STYLE_.total}">${bilansEchapper_(formaterMontant_(totalCents, devise))}</td>`,
    '</tr>',
    '</table>',
  ].filter((bloc) => bloc !== '').join('\n');
}

/**
 * Une ligne du tableau du courriel.
 * @param {Object} ligne Ligne de l'onglet Lignes_bilan.
 * @param {string} devise Code de devise affiché.
 * @return {string} La ligne HTML.
 */
function bilansHtmlLigne_(ligne, devise) {
  const description = bilansEchapper_(ligne[BILANS_COL_.LIGNE_DESCRIPTION]) || '—';
  const quantite = bilansFormaterQuantite_(ligne[BILANS_COL_.LIGNE_QUANTITE]);
  const prix = bilansCelluleVide_(ligne[BILANS_COL_.LIGNE_PRIX])
    ? '—'
    : bilansEchapper_(formaterMontant_(enCents_(ligne[BILANS_COL_.LIGNE_PRIX]), devise));
  const montant = bilansEchapper_(formaterMontant_(bilansMontantLigneCents_(ligne), devise));
  return `<tr><td style="${BILANS_STYLE_.cellule}">${description}</td>` +
    `<td style="${BILANS_STYLE_.celluleDroite}">${quantite}</td>` +
    `<td style="${BILANS_STYLE_.celluleDroite}">${prix}</td>` +
    `<td style="${BILANS_STYLE_.celluleDroite}">${montant}</td></tr>`;
}

/**
 * Affiche une quantité à la française ('2,5'), ou un tiret si elle est absente.
 * @param {*} valeur Contenu de la colonne Quantité.
 * @return {string} Quantité prête à afficher (déjà échappée).
 */
function bilansFormaterQuantite_(valeur) {
  if (bilansCelluleVide_(valeur)) return '—';
  const nombre = bilansNombre_(valeur);
  if (nombre === null) return bilansEchapper_(valeur);
  return String(Math.round(nombre * 1000) / 1000).replace('.', ',');
}

/**
 * Formule de politesse et signature venant des Paramètres.
 * @param {Object} params Réglages lus par lireParametres_().
 * @return {string} Le bloc HTML de signature.
 */
function bilansHtmlSignature_(params) {
  const signature = bilansTexte_(params.SIGNATURE) || bilansTexte_(params.NOM_EXPEDITEUR);
  const blocs = [`<p style="${BILANS_STYLE_.paragraphe}">Merci, et bonne journée.</p>`];
  if (signature) {
    blocs.push(`<p style="${BILANS_STYLE_.paragraphe}">` +
      `${bilansEchapper_(signature).replace(/\r?\n/g, '<br>')}</p>`);
  }
  return blocs.join('\n');
}

/**
 * Bas de courriel : référence du bilan, nombre de lignes et devise.
 * @param {Object} bilan Ligne de l'onglet Bilans.
 * @param {number} nombreLignes Nombre de lignes détaillées.
 * @param {string} devise Code de devise affiché.
 * @return {string} Le bloc HTML de référence.
 */
function bilansHtmlReference_(bilan, nombreLignes, devise) {
  const reference = bilansEchapper_(bilan[BILANS_COL_.BILAN_ID]);
  const morceaux = [];
  if (reference) morceaux.push(`Référence du bilan : ${reference}`);
  morceaux.push(`${nombreLignes} ligne(s)`);
  morceaux.push(`montants en ${bilansEchapper_(devise)}`);
  return `<p style="${BILANS_STYLE_.discret}">${morceaux.join(' — ')}.</p>`;
}

// ===========================================================================
// ▼ src/05_Factures.gs   (module 6 sur 11)
// ===========================================================================
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

// ===========================================================================
// ▼ src/06_Paiements.gs   (module 7 sur 11)
// ===========================================================================
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
    `• vous avez fait les virements → menu « 📋 Automatisation » → ` +
      `« 6. Confirmer les paiements du lot » ;`,
    `• vous ne les avez pas faits → menu « 📋 Automatisation » → ` +
      `« Annuler le lot de paiements en cours » : les ${enCours.length} facture(s) ` +
      `reviendront à « ${STATUT_PAIEMENT.NON_PAYEE} » et vous pourrez repréparer un lot.`,
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
  // Résolution du dossier Drive : une SEULE fonction pour tout le classeur
  // (resoudreDossierDrive_, dans 05_Factures.gs), sans quoi les pièces jointes
  // et les fichiers de lot finissent dans deux dossiers différents.
  const dossier = resoudreDossierDrive_(params || {}, '');
  const nom = `Lot-de-paiements-${paiementsHorodatageFichier_(new Date())}.csv`;
  const fichier = dossier.createFile(nom, contenu, 'text/csv');
  return { nom: nom, url: fichier.getUrl(), dossier: dossier.getName() };
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
 * Accessible par le menu (« Annuler le lot de paiements en cours ») ou à la main
 * depuis l'éditeur de script. Elle écrit elle-même son journal mais N'AFFICHE
 * PAS son résultat : c'est executer_() qui présente la chaîne renvoyée, sans
 * quoi l'utilisateur recevrait deux fenêtres successives portant le même texte.
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

// ===========================================================================
// ▼ src/07_Rapprochement.gs   (module 8 sur 11)
// ===========================================================================
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

// ===========================================================================
// ▼ src/08_Courriels.gs   (module 9 sur 11)
// ===========================================================================
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

// ===========================================================================
// ▼ src/09_Journal.gs   (module 10 sur 11)
// ===========================================================================
/**
 * 09_Journal.gs — Trace de tout ce que le script fait, dans l'onglet Journal.
 *
 * Les messages s'accumulent en mémoire pendant l'exécution ; ils sont écrits
 * d'un coup par viderTamponJournal_(), que chaque point d'entrée du menu appelle
 * à la fin (y compris en cas d'erreur). Journaliser ne doit JAMAIS faire échouer
 * un traitement : toutes les fonctions d'ici avalent leurs propres erreurs.
 */

/** Messages en attente d'écriture, pour l'exécution en cours. */
const JOURNAL_TAMPON_ = [];

/** Au-delà de ce nombre de messages en attente, on vide le tampon en route. */
const JOURNAL_TAMPON_MAX_ = 400;

/** Longueur maximale d'un message ou d'un détail écrit dans une cellule. */
const JOURNAL_TEXTE_MAX_ = 8000;

/**
 * Réduit n'importe quelle valeur à un texte court, lisible dans la feuille.
 * Un objet Error est rendu avec son message ET sa pile d'appels.
 * @param {*} valeur Détail à journaliser (texte, objet, Error...).
 * @return {string} Texte prêt à écrire.
 */
function journalTexte_(valeur) {
  let texte = '';
  try {
    if (valeur === null || valeur === undefined) return '';
    if (typeof valeur === 'string') {
      texte = valeur;
    } else if (valeur instanceof Error || (valeur && valeur.stack && valeur.message)) {
      texte = `${valeur.message}\n${valeur.stack}`;
    } else if (typeof valeur === 'object') {
      texte = JSON.stringify(valeur);
    } else {
      texte = String(valeur);
    }
  } catch (e) {
    texte = '(détail illisible)';
  }
  if (texte.length > JOURNAL_TEXTE_MAX_) {
    texte = texte.slice(0, JOURNAL_TEXTE_MAX_ - 1) + '…';
  }
  return texte;
}

/**
 * Écrit une trace de secours dans le journal d'exécution Apps Script, quand
 * l'écriture dans la feuille est elle-même impossible.
 * @param {string} fonction Nom de la fonction concernée.
 * @param {*} detail Message ou erreur.
 * @return {void}
 */
function journalSecours_(fonction, detail) {
  try {
    if (typeof Logger !== 'undefined' && Logger && Logger.log) {
      Logger.log(`[${fonction}] ${journalTexte_(detail)}`);
    }
  } catch (e) {
    // On ne peut plus rien faire : on n'interrompt surtout pas le traitement.
  }
}

/**
 * Ajoute un message au tampon du journal.
 * @param {string} fonction Nom de la fonction qui journalise.
 * @param {string} niveau Un des NIVEAU (INFO, AVERT, ERREUR).
 * @param {string} message Message court, en français, lisible par l'utilisateur.
 * @param {*} [detail] Complément : texte, objet ou objet Error.
 * @return {void}
 */
function journaliser_(fonction, niveau, message, detail) {
  try {
    JOURNAL_TAMPON_.push({
      horodatage: new Date(),
      fonction: journalTexte_(fonction),
      niveau: niveau || NIVEAU.INFO,
      message: journalTexte_(message),
      detail: journalTexte_(detail),
    });
    if (JOURNAL_TAMPON_.length >= JOURNAL_TAMPON_MAX_) viderTamponJournal_();
  } catch (e) {
    journalSecours_('journaliser_', e);
  }
}

/**
 * Journalise une information (déroulement normal).
 * @param {string} fonction Nom de la fonction qui journalise.
 * @param {string} message Message lisible.
 * @param {*} [detail] Complément facultatif.
 * @return {void}
 */
function journalInfo_(fonction, message, detail) {
  journaliser_(fonction, NIVEAU.INFO, message, detail);
}

/**
 * Journalise un avertissement (le traitement continue, mais il faut regarder).
 * @param {string} fonction Nom de la fonction qui journalise.
 * @param {string} message Message lisible.
 * @param {*} [detail] Complément facultatif.
 * @return {void}
 */
function journalAvert_(fonction, message, detail) {
  journaliser_(fonction, NIVEAU.AVERT, message, detail);
}

/**
 * Journalise une erreur. Ne lève jamais d'exception : un échec de
 * journalisation ne doit jamais casser le traitement en cours.
 * @param {string} fonction Nom de la fonction qui journalise.
 * @param {string} message Message lisible.
 * @param {*} [detail] Objet Error (message + pile) ou texte.
 * @return {void}
 */
function journalErreur_(fonction, message, detail) {
  try {
    journaliser_(fonction, NIVEAU.ERREUR, message, detail);
  } catch (e) {
    journalSecours_(fonction, e);
  }
}

/**
 * Écrit tout le tampon dans l'onglet Journal en une seule opération, puis purge
 * les lignes les plus anciennes si le plafond est dépassé.
 * À appeler à la fin de chaque point d'entrée du menu.
 * @return {number} Nombre de lignes écrites.
 */
function viderTamponJournal_() {
  if (!JOURNAL_TAMPON_.length) return 0;
  const lot = JOURNAL_TAMPON_.splice(0, JOURNAL_TAMPON_.length);
  try {
    const onglet = CONFIG.ONGLETS.JOURNAL;
    const colHorodatage = onglet.colonnes[0].nom;
    const colFonction = onglet.colonnes[1].nom;
    const colNiveau = onglet.colonnes[2].nom;
    const colMessage = onglet.colonnes[3].nom;
    const colDetail = onglet.colonnes[4].nom;
    const objets = lot.map((entree) => {
      const ligne = {};
      ligne[colHorodatage] = entree.horodatage;
      ligne[colFonction] = entree.fonction;
      ligne[colNiveau] = entree.niveau;
      ligne[colMessage] = entree.message;
      ligne[colDetail] = entree.detail;
      return ligne;
    });
    const ecrites = ajouterLignes_(onglet.nom, objets);
    purgerJournal_();
    return ecrites;
  } catch (e) {
    journalSecours_('viderTamponJournal_', e);
    lot.forEach((entree) => journalSecours_(entree.fonction, entree.message));
    return 0;
  }
}

/**
 * Supprime les lignes les plus anciennes du Journal au-delà de
 * CONFIG.JOURNAL_MAX_LIGNES. L'en-tête est toujours conservé.
 * @return {number} Nombre de lignes supprimées.
 */
function purgerJournal_() {
  try {
    const onglet = CONFIG.ONGLETS.JOURNAL;
    const feuille = feuille_(onglet.nom);
    const plafond = Number(CONFIG.JOURNAL_MAX_LIGNES) || 5000;
    const lignesDonnees = feuille.getLastRow() - 1;
    if (lignesDonnees <= plafond) return 0;
    const aSupprimer = lignesDonnees - plafond;
    feuille.deleteRows(2, aSupprimer);
    invaliderCacheFeuille_(onglet.nom);
    return aSupprimer;
  } catch (e) {
    journalSecours_('purgerJournal_', e);
    return 0;
  }
}

// ===========================================================================
// ▼ src/10_Tests.gs   (module 11 sur 11)
// ===========================================================================
/**
 * 10_Tests.gs — La suite de tests du classeur.
 *
 * Elle vérifie les calculs sur lesquels tout repose : la recherche de
 * sous-ensemble, le moteur de diagnostic des écarts, le solde théorique, les
 * trimestres, les soldes déclarés, l'arithmétique en cents, la vérification des
 * factures et la normalisation des n° de facture.
 *
 * DEUX FAÇONS DE LA LANCER :
 *   • depuis le classeur : menu 📋 Automatisation → Aide → « Lancer les tests » ;
 *   • hors de Google : `npm test` (outils/test.mjs appelle lancerTests()).
 *
 * RÈGLE ABSOLUE DE CE FICHIER : lancerTests() ne touche à AUCUNE feuille, à
 * aucun courriel, à aucun fichier Drive. Tous les jeux d'essai sont écrits en
 * dur ci-dessous, avec les mêmes clés que les en-têtes de CONFIG. C'est ce qui
 * permet de lancer les tests n'importe où, sans rien abîmer.
 *
 * Chaque test porte un nom en français : quand il échoue, le nom seul doit déjà
 * dire à un humain ce qui ne va plus.
 */

// ---------------------------------------------------------------------------
// Le mini-cadre de test : test_, assertEgal_, assertVrai_, assertNull_,
// assertProche_. Volontairement minuscule — il ne doit rien apprendre à
// personne, seulement dire ce qui a échoué et ce qui était attendu.
// ---------------------------------------------------------------------------

/** État de l'exécution en cours ; null tant que lancerTests() n'a pas démarré. */
const TESTS_ETAT_ = { courant: null };

/** Longueur maximale d'une valeur affichée dans un rapport d'échec. */
const TESTS_TEXTE_MAX_ = 300;

/**
 * Exécute un cas de test et enregistre son résultat.
 * @param {string} nom Nom du cas, en français, compréhensible sans le code.
 * @param {function()} fn Corps du test ; il échoue en levant une assertion.
 * @return {void}
 */
function test_(nom, fn) {
  const etat = TESTS_ETAT_.courant;
  if (!etat) throw new Error('test_() ne peut être appelé que depuis lancerTests().');
  etat.total++;
  try {
    fn();
    etat.reussis++;
  } catch (e) {
    etat.echecs.push({
      nom: nom,
      attendu: (e && e.assertion) ? e.testAttendu : 'aucune erreur pendant le test',
      obtenu: (e && e.assertion) ? e.testObtenu : testsErreurTexte_(e),
    });
    if (!(e && e.assertion)) testsJournaliserErreur_(nom, e);
  }
}

/**
 * Vérifie que deux valeurs sont identiques (nombres, textes, tableaux, objets).
 * @param {*} obtenu Valeur produite par le code testé.
 * @param {*} attendu Valeur attendue.
 * @param {string} [message] Ce que le test cherchait à démontrer.
 * @return {void}
 */
function assertEgal_(obtenu, attendu, message) {
  if (!testsMemeValeur_(obtenu, attendu)) {
    throw testsErreurAssertion_(message || 'Les deux valeurs devraient être identiques.',
      attendu, obtenu);
  }
}

/**
 * Vérifie qu'une condition est vraie.
 * @param {*} condition Condition à vérifier.
 * @param {string} [message] Ce que le test cherchait à démontrer.
 * @return {void}
 */
function assertVrai_(condition, message) {
  if (!condition) {
    throw testsErreurAssertion_(message || 'La condition devrait être vraie.', true, condition);
  }
}

/**
 * Vérifie qu'une valeur est bien nulle (null ou undefined).
 * @param {*} valeur Valeur à vérifier.
 * @param {string} [message] Ce que le test cherchait à démontrer.
 * @return {void}
 */
function assertNull_(valeur, message) {
  if (valeur !== null && valeur !== undefined) {
    throw testsErreurAssertion_(message || 'La valeur devrait être nulle.', null, valeur);
  }
}

/**
 * Compare deux montants en cents entiers, avec une tolérance en cents.
 * On ne compare jamais deux flottants : les deux valeurs sont d'abord
 * converties en cents (× 100 arrondi), comme partout ailleurs dans le projet.
 * @param {number} obtenu Montant produit par le code testé, en dollars.
 * @param {number} attendu Montant attendu, en dollars.
 * @param {number} [toleranceCents] Écart accepté, en cents (0 par défaut).
 * @param {string} [message] Ce que le test cherchait à démontrer.
 * @return {void}
 */
function assertProche_(obtenu, attendu, toleranceCents, message) {
  const centsObtenu = Math.round((Number(obtenu) || 0) * 100);
  const centsAttendu = Math.round((Number(attendu) || 0) * 100);
  const marge = Math.max(0, Math.round(Number(toleranceCents) || 0));
  if (Math.abs(centsObtenu - centsAttendu) > marge) {
    throw testsErreurAssertion_(message || 'Les deux montants devraient concorder.',
      `${centsAttendu} cents (± ${marge})`, `${centsObtenu} cents`);
  }
}

/**
 * Vérifie qu'un texte contient un fragment donné (les messages destinés à
 * l'utilisateur doivent nommer la bonne pièce, pas seulement exister).
 * @param {*} texte Texte produit par le code testé.
 * @param {string} fragment Fragment attendu.
 * @param {string} [message] Ce que le test cherchait à démontrer.
 * @return {void}
 */
function testsAssertContient_(texte, fragment, message) {
  const brut = (texte === null || texte === undefined) ? '' : String(texte);
  if (brut.indexOf(fragment) < 0) {
    throw testsErreurAssertion_(message || 'Le texte devrait nommer cette pièce.',
      `un texte contenant « ${fragment} »`, brut);
  }
}

/**
 * Vérifie qu'un texte ne contient PAS un fragment donné.
 * @param {*} texte Texte produit par le code testé.
 * @param {string} fragment Fragment interdit.
 * @param {string} [message] Ce que le test cherchait à démontrer.
 * @return {void}
 */
function testsAssertNeContientPas_(texte, fragment, message) {
  const brut = (texte === null || texte === undefined) ? '' : String(texte);
  if (brut.indexOf(fragment) >= 0) {
    throw testsErreurAssertion_(message || 'Le texte ne devrait pas citer cette pièce.',
      `un texte sans « ${fragment} »`, brut);
  }
}

/**
 * Fabrique l'erreur levée par une assertion en échec.
 * @param {string} message Ce que le test cherchait à démontrer.
 * @param {*} attendu Valeur attendue.
 * @param {*} obtenu Valeur obtenue.
 * @return {Error} Erreur enrichie, reconnue par test_().
 */
function testsErreurAssertion_(message, attendu, obtenu) {
  const erreur = new Error(message);
  erreur.assertion = true;
  erreur.testAttendu = `${message} — attendu : ${testsDecrire_(attendu)}`;
  erreur.testObtenu = testsDecrire_(obtenu);
  return erreur;
}

/**
 * Compare deux valeurs en profondeur, sans dépendre de l'ordre des clés.
 * @param {*} a Première valeur.
 * @param {*} b Seconde valeur.
 * @return {boolean} Vrai si les deux valeurs sont équivalentes.
 */
function testsMemeValeur_(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return isNaN(a) && isNaN(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((valeur, i) => testsMemeValeur_(valeur, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const clesA = Object.keys(a);
    const clesB = Object.keys(b);
    return clesA.length === clesB.length &&
      clesA.every((cle) => testsMemeValeur_(a[cle], b[cle]));
  }
  return false;
}

/**
 * Décrit une valeur en une ligne lisible, pour le rapport d'échec.
 * @param {*} valeur Valeur à décrire.
 * @return {string} Description courte.
 */
function testsDecrire_(valeur) {
  let texte;
  if (valeur === null) texte = 'null';
  else if (valeur === undefined) texte = 'undefined';
  else if (valeur instanceof Date) texte = testsDateTexte_(valeur);
  else if (typeof valeur === 'string') texte = `« ${valeur} »`;
  else if (typeof valeur === 'object') {
    try { texte = JSON.stringify(valeur); } catch (e) { texte = '(objet illisible)'; }
  } else texte = String(valeur);
  return texte.length > TESTS_TEXTE_MAX_ ? texte.slice(0, TESTS_TEXTE_MAX_ - 1) + '…' : texte;
}

/**
 * Formate une date en 'AAAA-MM-JJ hh:mm:ss.mmm' sans passer par le code testé.
 * @param {Date} date Date à formater.
 * @return {string} Date lisible, ou '(pas une date)'.
 */
function testsDateTexte_(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return '(pas une date)';
  const deux = (nombre) => (nombre < 10 ? '0' : '') + nombre;
  const trois = (nombre) => (nombre < 100 ? (nombre < 10 ? '00' : '0') : '') + nombre;
  return `${date.getFullYear()}-${deux(date.getMonth() + 1)}-${deux(date.getDate())} ` +
    `${deux(date.getHours())}:${deux(date.getMinutes())}:${deux(date.getSeconds())}.` +
    `${trois(date.getMilliseconds())}`;
}

/**
 * Réduit une erreur inattendue à un texte court (message + première ligne de pile).
 * @param {*} e Erreur attrapée.
 * @return {string} Texte lisible.
 */
function testsErreurTexte_(e) {
  if (!e) return 'erreur inconnue';
  const message = e.message ? String(e.message) : String(e);
  const pile = e.stack ? String(e.stack).split('\n').slice(0, 2).join(' | ') : '';
  return testsDecrire_(pile ? `${message} (${pile})` : message);
}

/**
 * Journalise une erreur inattendue survenue pendant les tests, avec sa pile.
 * Ne touche à aucune feuille : le journal est un simple tampon en mémoire.
 * @param {string} nom Nom du cas ou de la suite concernée.
 * @param {*} e Erreur attrapée.
 * @return {void}
 */
function testsJournaliserErreur_(nom, e) {
  try {
    if (typeof journalErreur_ !== 'function') return;
    journalErreur_('lancerTests', `Erreur inattendue pendant « ${nom} ».`,
      `${e && e.message}\n${e && e.stack}`);
  } catch (ignore) {
    // Un test ne doit jamais échouer à cause de la journalisation.
  }
}

// ---------------------------------------------------------------------------
// Colonnes et constructeurs de jeux d'essai — les clés viennent de CONFIG,
// jamais d'un nom d'en-tête recopié à la main.
// ---------------------------------------------------------------------------

/** Noms de colonnes utilisés par les jeux d'essai. */
const TESTS_COL_ = {
  FACTURE: {
    ID: CONFIG.ONGLETS.FACTURES.colonnes[0].nom,
    CLIENT: CONFIG.ONGLETS.FACTURES.colonnes[1].nom,
    NOM: CONFIG.ONGLETS.FACTURES.colonnes[2].nom,
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
    NOTES: CONFIG.ONGLETS.FACTURES.colonnes[15].nom,
  },
  PAIEMENT: {
    ID: CONFIG.ONGLETS.PAIEMENTS.colonnes[0].nom,
    CLIENT: CONFIG.ONGLETS.PAIEMENTS.colonnes[1].nom,
    NOM: CONFIG.ONGLETS.PAIEMENTS.colonnes[2].nom,
    FACTURE: CONFIG.ONGLETS.PAIEMENTS.colonnes[3].nom,
    DATE: CONFIG.ONGLETS.PAIEMENTS.colonnes[4].nom,
    MONTANT: CONFIG.ONGLETS.PAIEMENTS.colonnes[5].nom,
    METHODE: CONFIG.ONGLETS.PAIEMENTS.colonnes[6].nom,
    REFERENCE: CONFIG.ONGLETS.PAIEMENTS.colonnes[7].nom,
    DEDUIT: CONFIG.ONGLETS.PAIEMENTS.colonnes[8].nom,
  },
  BILAN: {
    ID: CONFIG.ONGLETS.BILANS.colonnes[0].nom,
    CLIENT: CONFIG.ONGLETS.BILANS.colonnes[1].nom,
    NOM: CONFIG.ONGLETS.BILANS.colonnes[2].nom,
    PERIODE: CONFIG.ONGLETS.BILANS.colonnes[3].nom,
    MONTANT: CONFIG.ONGLETS.BILANS.colonnes[6].nom,
    LIGNES: CONFIG.ONGLETS.BILANS.colonnes[7].nom,
    STATUT: CONFIG.ONGLETS.BILANS.colonnes[8].nom,
    FACTURE: CONFIG.ONGLETS.BILANS.colonnes[9].nom,
  },
  SOLDE: {
    CLIENT: CONFIG.ONGLETS.SOLDES_DECLARES.colonnes[1].nom,
    NOM: CONFIG.ONGLETS.SOLDES_DECLARES.colonnes[2].nom,
    PERIODE: CONFIG.ONGLETS.SOLDES_DECLARES.colonnes[3].nom,
    DATE: CONFIG.ONGLETS.SOLDES_DECLARES.colonnes[4].nom,
    MONTANT: CONFIG.ONGLETS.SOLDES_DECLARES.colonnes[5].nom,
  },
  RAPPRO: {
    PERIODE: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[0].nom,
    CLIENT: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[1].nom,
    NOM: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[2].nom,
    RELANCE: CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[10].nom,
  },
  LIGNE: {
    ID: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[0].nom,
    CLIENT: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[1].nom,
    PERIODE: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[2].nom,
    DESCRIPTION: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[4].nom,
    QUANTITE: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[5].nom,
    PRIX: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[6].nom,
    MONTANT: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[7].nom,
    BILAN: CONFIG.ONGLETS.LIGNES_BILAN.colonnes[8].nom,
  },
};

/**
 * Construit une ligne de l'onglet Factures pour les tests.
 * @param {Object} champs {id, client, nom, numero, date, periode, taxes, total,
 *     bilan, verification, ecart, paiement}. Les montants sont en dollars.
 * @return {Object} Ligne prête à passer au code testé.
 */
function testsFacture_(champs) {
  const c = TESTS_COL_.FACTURE;
  const s = champs || {};
  const facture = {};
  facture[c.ID] = s.id || '';
  facture[c.CLIENT] = s.client || '';
  facture[c.NOM] = s.nom || '';
  facture[c.NUMERO] = s.numero || '';
  facture[c.DATE] = s.date || '';
  facture[c.PERIODE] = s.periode || '';
  facture[c.AVANT_TAXES] = s.avantTaxes === undefined ? '' : s.avantTaxes;
  facture[c.TAXES] = s.taxes === undefined ? 0 : s.taxes;
  facture[c.TOTAL] = s.total === undefined ? 0 : s.total;
  facture[c.BILAN] = s.bilan || '';
  facture[c.VERIFICATION] = s.verification || STATUT_VERIF.A_VERIFIER;
  facture[c.ECART] = s.ecart === undefined ? 0 : s.ecart;
  facture[c.PAIEMENT] = s.paiement || STATUT_PAIEMENT.NON_PAYEE;
  facture[c.NOTES] = s.notes || '';
  return facture;
}

/**
 * Construit une ligne de l'onglet Paiements pour les tests.
 * @param {Object} champs {id, client, nom, facture, date, montant, reference, deduit}.
 * @return {Object} Ligne prête à passer au code testé.
 */
function testsPaiement_(champs) {
  const c = TESTS_COL_.PAIEMENT;
  const s = champs || {};
  const paiement = {};
  paiement[c.ID] = s.id || '';
  paiement[c.CLIENT] = s.client || '';
  paiement[c.NOM] = s.nom || '';
  paiement[c.FACTURE] = s.facture || '';
  paiement[c.DATE] = s.date || '';
  paiement[c.MONTANT] = s.montant === undefined ? 0 : s.montant;
  paiement[c.METHODE] = s.methode || 'Virement';
  paiement[c.REFERENCE] = s.reference || '';
  paiement[c.DEDUIT] = s.deduit || CONFIG.ONGLETS.PAIEMENTS.colonnes[8].liste[0];
  return paiement;
}

/**
 * Construit une ligne de l'onglet Bilans pour les tests.
 * @param {Object} champs {id, client, nom, periode, montant, statut, facture}.
 * @return {Object} Ligne prête à passer au code testé.
 */
function testsBilan_(champs) {
  const c = TESTS_COL_.BILAN;
  const s = champs || {};
  const bilan = {};
  bilan[c.ID] = s.id || '';
  bilan[c.CLIENT] = s.client || '';
  bilan[c.NOM] = s.nom || '';
  bilan[c.PERIODE] = s.periode || '';
  bilan[c.MONTANT] = s.montant === undefined ? 0 : s.montant;
  bilan[c.LIGNES] = s.lignes === undefined ? 1 : s.lignes;
  bilan[c.STATUT] = s.statut || STATUT_BILAN.ENVOYE;
  bilan[c.FACTURE] = s.facture || '';
  return bilan;
}

/**
 * Construit une ligne de l'onglet Lignes_bilan pour les tests.
 * @param {Object} champs {id, client, periode, description, quantite, prix, montant, bilan}.
 * @return {Object} Ligne prête à passer au code testé.
 */
function testsLigneBilan_(champs) {
  const c = TESTS_COL_.LIGNE;
  const s = champs || {};
  const ligne = {};
  ligne[c.ID] = s.id || '';
  ligne[c.CLIENT] = s.client || '';
  ligne[c.PERIODE] = s.periode || '';
  ligne[c.DESCRIPTION] = s.description || '';
  ligne[c.QUANTITE] = s.quantite === undefined ? '' : s.quantite;
  ligne[c.PRIX] = s.prix === undefined ? '' : s.prix;
  ligne[c.MONTANT] = s.montant === undefined ? '' : s.montant;
  ligne[c.BILAN] = s.bilan || '';
  return ligne;
}

/**
 * Construit une ligne de l'onglet Soldes_declares pour les tests.
 * @param {Object} champs {client, nom, periode, date, montant}.
 * @return {Object} Ligne prête à passer au code testé.
 */
function testsSolde_(champs) {
  const c = TESTS_COL_.SOLDE;
  const s = champs || {};
  const solde = {};
  solde[c.CLIENT] = s.client || '';
  solde[c.NOM] = s.nom || '';
  solde[c.PERIODE] = s.periode || '';
  solde[c.DATE] = s.date || '';
  solde[c.MONTANT] = s.montant === undefined ? 0 : s.montant;
  return solde;
}

/**
 * Construit une ligne DÉJÀ écrite dans l'onglet Rapprochement, telle que la
 * relirait rapprochementLireDonnees_ avant de réécrire la période.
 * @param {Object} champs {periode, client, nom, relance}.
 * @return {Object} Ligne prête à passer au code testé.
 */
function testsLigneRapprochement_(champs) {
  const c = TESTS_COL_.RAPPRO;
  const s = champs || {};
  const ligne = {};
  ligne[c.PERIODE] = s.periode || '';
  ligne[c.CLIENT] = s.client || '';
  ligne[c.NOM] = s.nom || '';
  ligne[c.RELANCE] = s.relance === undefined ? '—' : s.relance;
  return ligne;
}

/**
 * Bornes du trimestre 2026-T2 (1er avril au 30 juin), calculées ici sans passer
 * par bornesTrimestre_ : les tests de diagnostic ne doivent pas dépendre du
 * code qu'ils ne visent pas.
 * @return {{debut: Date, fin: Date}} Bornes du trimestre d'essai.
 */
function testsBornesT2_() {
  return {
    debut: new Date(2026, 3, 1, 0, 0, 0, 0),
    fin: new Date(2026, 5, 30, 23, 59, 59, 999),
  };
}

/**
 * Contexte complet pour diagnostiquerEcart_, avec des valeurs par défaut
 * réalistes (client C-001, trimestre 2026-T2, tolérance d'un cent).
 * @param {Object} champs {theoriqueCents, declareCents, soldeDeclareConnu,
 *     factures, paiements, bilans}.
 * @return {Object} Contexte prêt à passer à diagnostiquerEcart_.
 */
function testsContexteEcart_(champs) {
  const s = champs || {};
  return {
    clientId: 'C-001',
    nomClient: 'Boulangerie Petit',
    devise: 'CAD',
    periode: '2026-T2',
    bornes: testsBornesT2_(),
    decalageMois: 0,
    toleranceCents: 1,
    soldeDeclareConnu: s.soldeDeclareConnu !== false,
    soldeTheoriqueCents: Math.round(Number(s.theoriqueCents) || 0),
    soldeDeclareCents: Math.round(Number(s.declareCents) || 0),
    factures: s.factures || [],
    paiements: s.paiements || [],
    bilans: s.bilans || [],
  };
}

// ---------------------------------------------------------------------------
// §4.4 — trouverSousEnsemble_ : les tailles trouvées
// ---------------------------------------------------------------------------

/**
 * Vérifie qu'un résultat de trouverSousEnsemble_ est bien un tableau d'INDICES
 * distincts, dans la liste, et dont la somme vaut EXACTEMENT la cible.
 * @param {*} indices Résultat renvoyé par trouverSousEnsemble_.
 * @param {Array<number>} montants Liste passée à la fonction.
 * @param {number} cible Somme recherchée, en cents.
 * @param {string} message Nom du cas, repris dans les échecs.
 * @return {void}
 */
function testsSousEnsembleValide_(indices, montants, cible, message) {
  assertVrai_(Array.isArray(indices), `${message} : un tableau d'indices est attendu.`);
  assertVrai_(indices.length > 0, `${message} : un sous-ensemble vide n'est jamais une réponse.`);
  const vus = {};
  let somme = 0;
  indices.forEach((indice) => {
    assertVrai_(typeof indice === 'number' && indice === Math.floor(indice) &&
      indice >= 0 && indice < montants.length,
      `${message} : « ${indice} » n'est pas un indice de la liste.`);
    assertVrai_(!vus[indice], `${message} : l'indice ${indice} est retenu deux fois.`);
    vus[indice] = true;
    somme += montants[indice];
  });
  assertEgal_(somme, cible, `${message} : la somme des montants retenus doit valoir la cible.`);
}

/**
 * trouverSousEnsemble_ — cibles atteintes par 1, 2, 3 puis 4 éléments.
 * @return {void}
 */
function testsSousEnsembleTailles_() {
  test_('Sous-ensemble : un seul paiement fait la cible', () => {
    const montants = [12500, 30000, 4500];
    const indices = trouverSousEnsemble_(montants, 30000, 25);
    assertEgal_(indices, [1], 'Le paiement de 300,00 $ explique seul la cible.');
    testsSousEnsembleValide_(indices, montants, 30000, 'Cible atteinte par un élément');
  });

  test_('Sous-ensemble : deux paiements font la cible', () => {
    const montants = [12500, 30000, 4500];
    const indices = trouverSousEnsemble_(montants, 17000, 25);
    assertEgal_(indices, [0, 2], '125,00 $ + 45,00 $ = 170,00 $.');
    testsSousEnsembleValide_(indices, montants, 17000, 'Cible atteinte par deux éléments');
  });

  test_('Sous-ensemble : trois paiements font la cible', () => {
    const montants = [1000, 2000, 3000, 9000];
    const indices = trouverSousEnsemble_(montants, 6000, 25);
    assertEgal_(indices, [0, 1, 2], 'Seule la combinaison de trois éléments donne 60,00 $.');
    testsSousEnsembleValide_(indices, montants, 6000, 'Cible atteinte par trois éléments');
  });

  test_('Sous-ensemble : cible atteinte seulement par quatre éléments (programmation dynamique)',
    () => {
      const montants = [100, 200, 400, 800, 1600];
      const indices = trouverSousEnsemble_(montants, 1500, 25);
      testsSousEnsembleValide_(indices, montants, 1500,
        'Cible atteinte par quatre éléments');
      assertEgal_(indices.length, 4, 'Aucune combinaison de 1, 2 ou 3 éléments ne donne 15,00 $.');
      assertEgal_(indices, [0, 1, 2, 3], 'Les indices sont rendus en ordre croissant.');
    });

  test_('Sous-ensemble : deux montants en double, un seul suffit', () => {
    const montants = [50000, 50000, 20000];
    const indices = trouverSousEnsemble_(montants, 50000, 25);
    testsSousEnsembleValide_(indices, montants, 50000, 'Montants en double');
    assertEgal_(indices.length, 1, 'Un seul des deux paiements identiques suffit.');
  });

  test_('Sous-ensemble : deux montants en double additionnés', () => {
    const montants = [50000, 50000, 20000];
    const indices = trouverSousEnsemble_(montants, 100000, 25);
    assertEgal_(indices, [0, 1], 'Les deux paiements identiques sont retenus, chacun une fois.');
    testsSousEnsembleValide_(indices, montants, 100000, 'Montants en double additionnés');
  });
}

// ---------------------------------------------------------------------------
// §4.4 — trouverSousEnsemble_ : tous les refus
// ---------------------------------------------------------------------------

/**
 * trouverSousEnsemble_ — les cas où la réponse doit être null, sans à-peu-près.
 * @return {void}
 */
function testsSousEnsembleRefus_() {
  test_('Sous-ensemble : aucune combinaison possible', () => {
    assertNull_(trouverSousEnsemble_([300, 700, 1100], 550, 25),
      'Aucune somme de ces montants ne donne 5,50 $.');
    assertNull_(trouverSousEnsemble_([200, 400, 600, 800, 1000], 1501, 25),
      'Une cible impaire est hors d\'atteinte avec des montants pairs (chemin dynamique).');
  });

  test_('Sous-ensemble : liste vide', () => {
    assertNull_(trouverSousEnsemble_([], 5000, 25), 'Sans paiement, rien à expliquer.');
    assertNull_(trouverSousEnsemble_(null, 5000, 25), 'Une liste absente ne fait pas échouer.');
  });

  test_('Sous-ensemble : cible nulle ou négative', () => {
    assertNull_(trouverSousEnsemble_([50000, -50000, 100000], 0, 25),
      'Une cible de zéro n\'explique rien, même si deux montants s\'annulent.');
    assertNull_(trouverSousEnsemble_([-100000, 50000], -100000, 25),
      'Une cible négative est refusée, pas contournée, même si un montant lui correspond.');
  });

  test_('Sous-ensemble : au-delà de SOUS_ENSEMBLE_MAX_ELEMENTS, seule la programmation ' +
    'dynamique renonce', () => {
    const trop = [];
    for (let i = 0; i <= CONFIG.SOUS_ENSEMBLE_MAX_ELEMENTS; i++) trop.push(100);
    assertEgal_(trop.length, CONFIG.SOUS_ENSEMBLE_MAX_ELEMENTS + 1,
      'Le jeu d\'essai dépasse bien la borne de un élément.');
    assertEgal_(trouverSousEnsemble_(trop, 100), [0],
      'La recherche exhaustive de taille 1 a TOUJOURS lieu (§4.4) : elle ne dépend pas du ' +
      'nombre de pièces.');
    assertEgal_(trouverSousEnsemble_(trop, 200).length, 2,
      'La recherche exhaustive de taille 2 a lieu elle aussi.');
    assertNull_(trouverSousEnsemble_(trop, 400),
      'Quatre éléments relèvent de la programmation dynamique : elle, et elle seule, ' +
      'renonce au-delà de la borne.');
  });

  test_('Sous-ensemble : la borne maxElements ne s\'applique qu\'à la programmation dynamique',
    () => {
      const montants = [100, 200, 400, 800, 1600];
      assertEgal_(trouverSousEnsemble_(montants, 300, 1), [0, 1],
        'Deux montants font la cible : la borne de un ne peut pas empêcher la recherche ' +
        'exhaustive de les trouver.');
      assertNull_(trouverSousEnsemble_(montants, 1500, 4),
        'Seuls quatre éléments donnent 15,00 $ : avec cinq montants et une borne de quatre, ' +
        'la programmation dynamique renonce.');
      testsSousEnsembleValide_(trouverSousEnsemble_(montants, 1500, 5), montants, 1500,
        'La même recherche aboutit quand la borne le permet');
    });

  test_('Sous-ensemble : 60 montants dont deux font la cible', () => {
    const montants = [];
    for (let i = 0; i < 60; i++) montants.push(100000 + i * 700);
    assertVrai_(montants.length > CONFIG.SOUS_ENSEMBLE_MAX_ELEMENTS,
      'Le jeu d\'essai dépasse largement la borne de la programmation dynamique.');
    const cible = montants[3] + montants[47];
    const indices = trouverSousEnsemble_(montants, cible, CONFIG.SOUS_ENSEMBLE_MAX_ELEMENTS);
    testsSousEnsembleValide_(indices, montants, cible, '60 montants, deux font la cible');
    assertEgal_(indices.length, 2,
      'Deux pièces suffisent : abandonner ici reviendrait à déclarer « inexpliqué » un écart ' +
      'que le rapport sait pourtant nommer.');
  });

  test_('Sous-ensemble : 60 montants dont TROIS font la cible', () => {
    const montants = [];
    for (let i = 0; i < 60; i++) montants.push(100000 + i * 700);
    const cible = montants[3] + montants[20] + montants[47];
    const indices = trouverSousEnsemble_(montants, cible, CONFIG.SOUS_ENSEMBLE_MAX_ELEMENTS);
    testsSousEnsembleValide_(indices, montants, cible, '60 montants, trois font la cible');
    assertEgal_(indices.length, 3,
      'La recherche exhaustive de taille 3 doit avoir lieu même bien au-delà de la borne de ' +
      'la programmation dynamique : trois pièces, c\'est encore vérifiable à la main.');
  });

  test_('Sous-ensemble : 500 montants, trois font la cible dans les 200 premiers', () => {
    const montants = [];
    for (let i = 0; i < 500; i++) montants.push(100000 + i * 700);
    const cible = montants[3] + montants[20] + montants[47];
    const indices = trouverSousEnsemble_(montants, cible, CONFIG.SOUS_ENSEMBLE_MAX_ELEMENTS);
    testsSousEnsembleValide_(indices, montants, cible, '500 montants, trois font la cible');
    assertEgal_(indices.length, 3, 'Un très gros trimestre reste diagnosticable.');
  });

  test_('Sous-ensemble : cible au-delà de SOUS_ENSEMBLE_MAX_CIBLE', () => {
    const montants = [1500000, 1500000, 1500000, 1500000, 1500000];
    const cible = 6000000;
    assertVrai_(cible > CONFIG.SOUS_ENSEMBLE_MAX_CIBLE,
      'Le jeu d\'essai vise bien au-delà du plafond de mémoire.');
    assertNull_(trouverSousEnsemble_(montants, cible, 25),
      'Au-delà du plafond, la programmation dynamique renonce au lieu de saturer la mémoire.');
  });
}

// ---------------------------------------------------------------------------
// §4.4 — diagnostiquerEcart_ : cas 0 et solde non déclaré
// ---------------------------------------------------------------------------

/**
 * diagnostiquerEcart_ — hypothèse 0 (rien à expliquer) et solde non déclaré.
 * @return {void}
 */
function testsDiagnosticSansEcart_() {
  test_('Diagnostic 0 : tout concorde, le solde est à zéro', () => {
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 0, declareCents: 0,
    }));
    assertEgal_(diag.verdict, VERDICT.BALANCE, 'Un écart nul se solde par « Balancé ».');
    testsAssertContient_(diag.action, 'Rien à faire', 'Aucune action n\'est demandée.');
  });

  test_('Diagnostic 0 : écart d\'un cent absorbé par la tolérance', () => {
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 100000, declareCents: 99999,
    }));
    assertEgal_(diag.verdict, VERDICT.BALANCE, 'Un cent d\'écart reste dans la tolérance.');
    testsAssertContient_(diag.detail, '1 000,00 $', 'Le détail cite le solde théorique.');
  });

  test_('Diagnostic 0 : deux cents d\'écart sortent de la tolérance', () => {
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 100000, declareCents: 99998,
    }));
    assertVrai_(diag.verdict !== VERDICT.BALANCE,
      'Au-delà de la tolérance, l\'écart doit être examiné, pas ignoré.');
  });

  test_('Diagnostic : aucun solde déclaré par le client', () => {
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 45000, declareCents: 0, soldeDeclareConnu: false,
    }));
    assertEgal_(diag.verdict, VERDICT.NON_DECLARE, 'Sans solde déclaré, rien à comparer.');
    testsAssertContient_(diag.detail, '450,00 $', 'Le détail rappelle ce que disent vos livres.');
    testsAssertContient_(diag.detail, CONFIG.ONGLETS.SOLDES_DECLARES.nom,
      'Le détail nomme l\'onglet où recopier le solde.');
    testsAssertContient_(diag.action, '2026-T2', 'L\'action rappelle le trimestre concerné.');
  });
}

// ---------------------------------------------------------------------------
// §4.4 — diagnostiquerEcart_ : hypothèses 1 et 3 (les paiements)
// ---------------------------------------------------------------------------

/**
 * diagnostiquerEcart_ — hypothèse 1 : un ou plusieurs paiements que le client
 * n'a pas déduits de son solde. C'est la cause la plus fréquente.
 * @return {void}
 */
function testsDiagnosticPaiements_() {
  test_('Diagnostic 1 : un paiement que le client n\'a pas déduit', () => {
    const paiement = testsPaiement_({
      id: 'P-000042', client: 'C-001', date: '2026-05-12', montant: 1250,
      reference: 'VIR-8891', deduit: 'À confirmer',
    });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 0, declareCents: 125000, paiements: [paiement],
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'Le paiement oublié explique l\'écart.');
    testsAssertContient_(diag.detail, 'P-000042', 'Le détail nomme le paiement en cause.');
    testsAssertContient_(diag.detail, 'VIR-8891', 'Le détail donne la référence du virement.');
    testsAssertContient_(diag.detail, '1 250,00 $', 'Le détail donne le montant exact.');
    assertEgal_(diag.paiementsNonDeduits, ['P-000042'],
      'Le paiement est signalé pour la mise à jour de la colonne « Déduit par le client ».');
  });

  test_('Diagnostic 1 : deux paiements additionnés expliquent l\'écart', () => {
    const paiements = [
      testsPaiement_({ id: 'P-000010', client: 'C-001', date: '2026-04-15', montant: 300 }),
      testsPaiement_({ id: 'P-000011', client: 'C-001', date: '2026-05-20', montant: 450 }),
    ];
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 0, declareCents: 75000, paiements: paiements,
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, '300 $ + 450 $ = 750 $ d\'écart.');
    assertEgal_(diag.paiementsNonDeduits, ['P-000010', 'P-000011'],
      'Les deux paiements sont nommés.');
  });

  test_('Diagnostic 1 : un écart de signe opposé n\'accuse jamais un paiement non déduit', () => {
    const paiement = testsPaiement_({
      id: 'P-000042', client: 'C-001', date: '2026-05-12', montant: 1250, reference: 'VIR-8891',
    });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 125000, declareCents: 0, paiements: [paiement],
    }));
    testsAssertNeContientPas_(diag.diagnostic, 'déduit',
      'Un paiement que le client n\'a pas déduit ÉLÈVE son solde au-dessus du vôtre ' +
      '(écart < 0). Ici son solde est plus bas : l\'hypothèse 1 est impossible.');
    assertEgal_(diag.paiementsNonDeduits, [],
      'Aucun paiement n\'est marqué « Non » sur la foi d\'un écart de mauvais signe.');
  });
}

/**
 * diagnostiquerEcart_ — la priorité donnée aux paiements non déduits et
 * l'ordre des hypothèses du §4.4.
 * @return {void}
 */
function testsDiagnosticPriorites_() {
  test_('Diagnostic 1 : deux paiements de même montant, le non déduit est retenu', () => {
    const paiements = [
      testsPaiement_({ id: 'P-000001', client: 'C-001', date: '2026-04-03', montant: 500,
        deduit: 'Oui' }),
      testsPaiement_({ id: 'P-000002', client: 'C-001', date: '2026-06-02', montant: 500,
        deduit: 'Non' }),
    ];
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 0, declareCents: 50000, paiements: paiements,
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'L\'écart vaut un des deux paiements.');
    testsAssertContient_(diag.detail, 'P-000002', 'Le paiement non déduit est cité en premier.');
    testsAssertNeContientPas_(diag.detail, 'P-000001',
      'Le paiement déjà déduit par le client ne doit pas être mis en cause.');
  });

  test_('Diagnostic : les hypothèses sont testées dans l\'ordre du §4.4', () => {
    const paiements = [
      testsPaiement_({ id: 'P-000123', client: 'C-001', date: '2026-05-04', montant: 1000,
        reference: 'VIR-4004' }),
      testsPaiement_({ id: 'P-000124', client: 'C-001', date: '2026-07-15', montant: 1000,
        reference: 'VIR-4005' }),
    ];
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: -50000, declareCents: 50000, paiements: paiements,
    }));
    testsAssertContient_(diag.diagnostic, 'déduit',
      'Le paiement non déduit (hypothèse 1) l\'emporte sur le signe inversé (7) et sur ' +
      'le décalage de période (8), qui pourraient tous deux s\'appliquer ici.');
    assertEgal_(diag.paiementsNonDeduits, ['P-000123'],
      'Le paiement retenu est celui du trimestre, pas son jumeau du trimestre suivant.');
  });

}

/**
 * diagnostiquerEcart_ — hypothèse 3 : un paiement DÉDUIT DEUX FOIS par le
 * client. Signe imposé par le §4.4 : écart > 0, et l'écart vaut LE montant du
 * paiement, pas son double — le paiement légitime est déjà déduit des deux
 * côtés, seule la déduction en trop reste.
 * @return {void}
 */
function testsDiagnosticPaiementDouble_() {
  test_('Diagnostic 3 : un paiement déduit deux fois par le client', () => {
    // Factures 1 000 $, un paiement de 1 000 $ : le vrai solde est 0. Le client
    // retranche le paiement deux fois, il déclare donc −1 000 $.
    // écart = 0 − (−100 000) = +100 000 cents = LE montant du paiement.
    const paiement = testsPaiement_({ id: 'P-000077', client: 'C-001', date: '2026-05-05',
      montant: 1000, reference: 'CHQ-114' });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 0, declareCents: -100000, paiements: [paiement],
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'Le paiement déduit deux fois explique l\'écart.');
    testsAssertContient_(diag.diagnostic, 'deux fois', 'Le diagnostic dit ce qui s\'est passé.');
    testsAssertContient_(diag.detail, 'P-000077', 'Le détail nomme le paiement en cause.');
    testsAssertContient_(diag.detail, 'CHQ-114', 'Le détail donne la référence du chèque.');
    testsAssertContient_(diag.detail, '1 000,00 $',
      'L\'écart vaut le montant du paiement, pas son double.');
  });

  test_('Diagnostic 3 : le double d\'un paiement n\'est PAS l\'hypothèse 3', () => {
    const paiement = testsPaiement_({ id: 'P-000077', client: 'C-001', date: '2026-05-05',
      montant: 500, reference: 'CHQ-114' });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 100000, declareCents: 0, paiements: [paiement],
    }));
    testsAssertNeContientPas_(diag.diagnostic, 'deux fois',
      'Un écart valant deux fois le paiement ne correspond à aucune erreur du client : ' +
      'déduire un paiement une fois de trop creuse l\'écart d\'UN montant, pas de deux.');
  });

  test_('Diagnostic 3 : un écart de signe opposé n\'est jamais « compté deux fois »', () => {
    const paiement = testsPaiement_({ id: 'P-000077', client: 'C-001', date: '2026-05-05',
      montant: 500, reference: 'CHQ-114' });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 0, declareCents: 100000, paiements: [paiement],
    }));
    testsAssertNeContientPas_(diag.diagnostic, 'deux fois',
      'Un paiement déduit deux fois ABAISSE le solde du client. Son solde étant ici plus ' +
      'élevé que le vôtre, l\'hypothèse 3 est arithmétiquement impossible.');
    assertEgal_(diag.verdict, VERDICT.INEXPLIQUE,
      'Mieux vaut un écart inexpliqué qu\'un diagnostic exactement inverse de la réalité.');
  });

  test_('Diagnostic 3 : deux paiements de même montant, un semble compté deux fois', () => {
    const paiements = [
      testsPaiement_({ id: 'P-000021', client: 'C-001', date: '2026-04-08', montant: 300 }),
      testsPaiement_({ id: 'P-000022', client: 'C-001', date: '2026-05-08', montant: 300 }),
    ];
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 30000, declareCents: 0, paiements: paiements,
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'Le client a retranché 300,00 $ de trop.');
    testsAssertContient_(diag.diagnostic, 'deux fois', 'Le diagnostic dit ce qui s\'est passé.');
    testsAssertContient_(diag.detail, 'P-000021', 'Le détail nomme un paiement de ce montant.');
  });
}

// ---------------------------------------------------------------------------
// §4.4 — diagnostiquerEcart_ : hypothèses 2, 4 et 5 (les factures)
// ---------------------------------------------------------------------------

/**
 * diagnostiquerEcart_ — hypothèses 2 (facture non comptabilisée) et 4 (écart
 * de facturation constaté à la vérification).
 * @return {void}
 */
function testsDiagnosticFactures_() {
  test_('Diagnostic 2 : une facture que le client n\'a pas comptabilisée', () => {
    const factures = [
      testsFacture_({ id: 'F-000031', client: 'C-001', numero: 'INV-501', periode: '2026-05',
        total: 1000, verification: STATUT_VERIF.CONFORME }),
      testsFacture_({ id: 'F-000032', client: 'C-001', numero: 'INV-502', periode: '2026-05',
        total: 1000, verification: STATUT_VERIF.DOUBLON }),
    ];
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 250000, declareCents: 150000, factures: factures,
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'La facture manquante explique l\'écart.');
    testsAssertContient_(diag.diagnostic, 'comptabilisée',
      'La facture conforme non comptabilisée (hypothèse 2) l\'emporte sur la facture ' +
      'écartée du même montant (hypothèse 5).');
    testsAssertContient_(diag.detail, 'F-000031', 'Le détail nomme la facture oubliée.');
    testsAssertContient_(diag.detail, 'INV-501', 'Le détail donne le n° du client.');
    testsAssertNeContientPas_(diag.detail, 'F-000032',
      'La facture classée Doublon n\'est pas celle qui explique l\'écart.');
  });

  test_('Diagnostic 4 : l\'écart vaut la somme des écarts de facturation', () => {
    const facture = testsFacture_({
      id: 'F-000044', client: 'C-001', numero: 'INV-777', periode: '2026-06', total: 1050,
      verification: STATUT_VERIF.ECART, ecart: 50,
    });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 5000, declareCents: 0, factures: [facture],
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'L\'écart constaté à la vérification revient ici.');
    testsAssertContient_(diag.diagnostic, 'facturation', 'Le diagnostic parle de facturation.');
    testsAssertContient_(diag.detail, 'F-000044', 'Le détail nomme la facture en écart.');
    testsAssertContient_(diag.detail, '50,00 $', 'Le détail chiffre l\'écart de la facture.');
  });

  test_('Diagnostic 2 : un écart de signe opposé n\'accuse jamais une facture non comptabilisée',
    () => {
      const facture = testsFacture_({
        id: 'F-000031', client: 'C-001', numero: 'INV-501', periode: '2026-05', total: 1000,
        verification: STATUT_VERIF.CONFORME,
      });
      const diag = diagnostiquerEcart_(testsContexteEcart_({
        theoriqueCents: 0, declareCents: 100000, factures: [facture],
      }));
      testsAssertNeContientPas_(diag.diagnostic, 'comptabilisée',
        'Une facture que le client a oubliée ABAISSE son solde sous le vôtre (écart > 0). ' +
        'Ici son solde est plus élevé : l\'hypothèse 2 est impossible.');
      assertEgal_(diag.verdict, VERDICT.INEXPLIQUE, 'Aucune hypothèse ne s\'applique.');
    });

  test_('Diagnostic 2 : une facture annulée n\'explique jamais un écart', () => {
    const factures = [
      testsFacture_({ id: 'F-000201', client: 'C-001', periode: '2026-04', total: 1000,
        verification: STATUT_VERIF.CONFORME, paiement: STATUT_PAIEMENT.NON_PAYEE }),
      testsFacture_({ id: 'F-000202', client: 'C-001', periode: '2026-05', total: 500,
        verification: STATUT_VERIF.CONFORME, paiement: STATUT_PAIEMENT.ANNULEE }),
    ];
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 100000, declareCents: 50000, factures: factures,
    }));
    testsAssertNeContientPas_(diag.diagnostic, 'comptabilisée',
      'Une facture annulée n\'entre pas non plus dans VOTRE solde théorique (§4.2) : ' +
      'le client a raison de ne pas la compter, elle ne peut pas expliquer l\'écart.');
    assertEgal_(diag.verdict, VERDICT.INEXPLIQUE,
      'La vraie cause reste à chercher : on ne clôt pas le dossier sur une facture annulée.');
  });

  test_('Diagnostic 4 : un écart de facturation de sens contraire n\'explique rien', () => {
    const facture = testsFacture_({
      id: 'F-000010', client: 'C-001', numero: 'INV-778', periode: '2026-06', total: 900,
      verification: STATUT_VERIF.ECART, ecart: -250,
    });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 100000, declareCents: 75000, factures: [facture],
    }));
    testsAssertNeContientPas_(diag.diagnostic, 'facturation',
      'La somme des « Écart vs bilan » a un sens déterminé : un écart de −250 $ ne peut pas ' +
      'expliquer un écart de +250 $. La comparer en valeur absolue retourne l\'explication.');
    assertEgal_(diag.verdict, VERDICT.INEXPLIQUE, 'Mieux vaut inexpliqué qu\'à l\'envers.');
  });

  test_('Diagnostic 4 : une facture annulée ne compte pas dans la somme des écarts', () => {
    const factures = [
      testsFacture_({ id: 'F-000401', client: 'C-001', periode: '2026-04', total: 1000,
        verification: STATUT_VERIF.CONFORME }),
      testsFacture_({ id: 'F-000403', client: 'C-001', periode: '2026-05', total: 900,
        verification: STATUT_VERIF.ECART, ecart: 123.45,
        paiement: STATUT_PAIEMENT.ANNULEE }),
    ];
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 100000, declareCents: 87655, factures: factures,
    }));
    testsAssertNeContientPas_(diag.diagnostic, 'facturation',
      'Une facture annulée ne contribue à aucun des deux soldes : son écart de vérification ' +
      'tombe pourtant pile sur l\'écart, et ne l\'explique pas pour autant.');
    assertEgal_(diag.verdict, VERDICT.INEXPLIQUE,
      'La coïncidence de montant ne vaut pas explication : la vraie cause reste à chercher.');
  });
}

/**
 * diagnostiquerEcart_ — hypothèse 5 : le client comptabilise une facture que
 * vous avez écartée (Doublon ou Sans bilan), et qui n'est pas dans votre solde.
 * Signe imposé par le §4.4 : écart < 0, puisque compter une facture de plus
 * ÉLÈVE le solde du client au-dessus du vôtre.
 * @return {void}
 */
function testsDiagnosticFactureEcartee_() {
  test_('Diagnostic 5 : le client compte une facture classée Doublon', () => {
    const facture = testsFacture_({
      id: 'F-000055', client: 'C-001', numero: 'INV-900', periode: '2026-05', total: 750,
      verification: STATUT_VERIF.DOUBLON,
    });
    // Vous n'inscrivez rien (la facture est écartée), le client inscrit 750 $ :
    // son solde est plus ÉLEVÉ que le vôtre, écart = 0 − 75 000 = −75 000.
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 0, declareCents: 75000, factures: [facture],
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'La facture écartée explique l\'écart.');
    testsAssertContient_(diag.diagnostic, STATUT_VERIF.DOUBLON,
      'Le diagnostic nomme le statut en cause.');
    testsAssertContient_(diag.detail, 'F-000055', 'Le détail nomme la facture doublon.');
    testsAssertContient_(diag.detail, 'plus élevé',
      'Le détail dit le bon sens : le solde du client est au-dessus du vôtre.');
    testsAssertContient_(diag.action, CONFIG.ONGLETS.FACTURES.nom,
      'L\'action dit dans quel onglet corriger si la facture est valable.');
  });

  test_('Diagnostic 5 : même chose pour une facture classée Sans bilan', () => {
    const facture = testsFacture_({
      id: 'F-000056', client: 'C-001', periode: '2026-04', total: 320,
      verification: STATUT_VERIF.SANS_BILAN,
    });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 0, declareCents: 32000, factures: [facture],
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'Une facture sans bilan explique aussi un écart.');
    testsAssertContient_(diag.diagnostic, STATUT_VERIF.SANS_BILAN,
      'Le diagnostic nomme le statut « Sans bilan ».');
  });

  test_('Diagnostic 5 : un écart de signe opposé n\'accuse jamais une facture écartée', () => {
    const facture = testsFacture_({
      id: 'F-000055', client: 'C-001', numero: 'INV-900', periode: '2026-05', total: 750,
      verification: STATUT_VERIF.DOUBLON,
    });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 75000, declareCents: 0, factures: [facture],
    }));
    testsAssertNeContientPas_(diag.diagnostic, STATUT_VERIF.DOUBLON,
      'Si le client comptait cette facture, son solde serait plus ÉLEVÉ que le vôtre. ' +
      'Ici il est plus bas : l\'explication se contredirait elle-même.');
    assertEgal_(diag.verdict, VERDICT.INEXPLIQUE,
      'Sans explication valable, on le dit franchement plutôt que d\'en inventer une.');
  });
}

// ---------------------------------------------------------------------------
// §4.4 — diagnostiquerEcart_ : hypothèses 6 à 9
// ---------------------------------------------------------------------------

/**
 * diagnostiquerEcart_ — hypothèses 6 (taxes), 7 (signe inversé),
 * 8 (décalage de période) et 9 (inexpliqué).
 * @return {void}
 */
function testsDiagnosticDivers_() {
  test_('Diagnostic 6 : l\'écart vaut la TPS d\'une facture du trimestre', () => {
    const facture = testsFacture_({
      id: 'F-000061', client: 'C-001', periode: '2026-05', total: 1000, taxes: 0,
      verification: STATUT_VERIF.CONFORME,
    });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 5000, declareCents: 0, factures: [facture],
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'Une erreur de taxes explique l\'écart.');
    testsAssertContient_(diag.diagnostic, 'taxes', 'Le diagnostic parle de taxes.');
    testsAssertContient_(diag.detail, 'TPS', 'Le détail nomme la taxe en cause.');
    testsAssertContient_(diag.detail, 'F-000061', 'Le détail nomme la pièce concernée.');
  });

  test_('Diagnostic 7 : le client a déclaré son solde à l\'envers', () => {
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 200000, declareCents: -200000,
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'Un solde opposé n\'est pas un vrai écart.');
    testsAssertContient_(diag.detail, '-2 000,00 $', 'Le détail montre le solde déclaré négatif.');
    testsAssertContient_(diag.action, 'SIGNE_SOLDE_CLIENT',
      'L\'action indique le réglage à changer.');
  });

  test_('Diagnostic 8 : la pièce appartient au trimestre suivant', () => {
    const paiement = testsPaiement_({
      id: 'P-000088', client: 'C-001', date: '2026-07-10', montant: 800, reference: 'VIR-2201',
    });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 80000, declareCents: 0, paiements: [paiement],
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'Un décalage de coupure explique l\'écart.');
    testsAssertContient_(diag.diagnostic, 'Décalage', 'Le diagnostic parle de décalage.');
    testsAssertContient_(diag.detail, 'P-000088', 'Le détail nomme la pièce décalée.');
    testsAssertContient_(diag.detail, '2026-T3', 'Le détail dit à quel trimestre elle appartient.');
  });

  test_('Diagnostic 2 : une facture « Écart de montant » compte comme non comptabilisée', () => {
    // §4.2 : une facture « Écart de montant » entre dans le solde théorique.
    // La restreindre aux « Conforme » rendait le rapport contradictoire avec
    // son propre calcul : il comptait la facture, mais refusait de la nommer.
    const facture = testsFacture_({
      id: 'F-000210', client: 'C-001', numero: 'INV-810', periode: '2026-05', total: 1000,
      verification: STATUT_VERIF.ECART, ecart: 0,
    });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 100000, declareCents: 0, factures: [facture],
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'La facture reconnue explique l\'écart.');
    testsAssertContient_(diag.diagnostic, 'comptabilisée',
      'Une facture reconnue, même en écart de montant, peut être celle que le client a omise.');
    testsAssertContient_(diag.detail, 'F-000210', 'Le détail la nomme.');
  });

  test_('Diagnostic 6 : une facture annulée n\'explique jamais un écart de taxes', () => {
    // La facture annulée n'entre pas dans le solde théorique : l'accuser
    // enverrait le client vérifier les taxes d'une pièce qu'aucun des deux
    // ne compte, pendant que la vraie cause reste dans le classeur.
    const factures = [
      testsFacture_({ id: 'F-000220', client: 'C-001', periode: '2026-04', total: 1000, taxes: 0,
        verification: STATUT_VERIF.CONFORME }),
      testsFacture_({ id: 'F-000221', client: 'C-001', periode: '2026-05', total: 2000, taxes: 0,
        verification: STATUT_VERIF.CONFORME, paiement: STATUT_PAIEMENT.ANNULEE }),
    ];
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 100000, declareCents: 90000, factures: factures,
    }));
    testsAssertNeContientPas_(diag.diagnostic, 'taxes',
      'L\'écart vaut pile la TPS de la facture ANNULÉE : c\'est une coïncidence, pas une cause.');
    testsAssertNeContientPas_(diag.detail, 'F-000221',
      'Une facture hors du solde théorique n\'est jamais nommée comme explication.');
    assertEgal_(diag.verdict, VERDICT.INEXPLIQUE, 'Mieux vaut « inexpliqué » qu\'un faux coupable.');
  });

  test_('Diagnostic 8 : une facture écartée du trimestre voisin n\'explique aucun décalage', () => {
    const facture = testsFacture_({
      id: 'F-000230', client: 'C-001', date: '2026-07-10', periode: '2026-07', total: 800,
      verification: STATUT_VERIF.DOUBLON,
    });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 80000, declareCents: 0, factures: [facture],
    }));
    testsAssertNeContientPas_(diag.diagnostic, 'Décalage',
      'Le décalage de période porte sur la DATE d\'une pièce reconnue, jamais sur son statut.');
    testsAssertNeContientPas_(diag.detail, 'F-000230', 'La facture Doublon n\'est pas nommée.');
    assertEgal_(diag.verdict, VERDICT.INEXPLIQUE, 'Aucune hypothèse ne s\'applique.');
  });

  test_('Diagnostic 9 : les montants proches ne citent pas de pièce hors du solde', () => {
    const factures = [
      testsFacture_({ id: 'F-000240', client: 'C-001', periode: '2026-05', total: 1000, taxes: 0,
        verification: STATUT_VERIF.CONFORME }),
      testsFacture_({ id: 'F-000241', client: 'C-001', periode: '2026-05', total: 1234.6,
        taxes: 0, verification: STATUT_VERIF.CONFORME, paiement: STATUT_PAIEMENT.ANNULEE }),
    ];
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 23334, declareCents: 0, factures: factures,
    }));
    assertEgal_(diag.verdict, VERDICT.INEXPLIQUE, 'Aucune combinaison exacte.');
    testsAssertNeContientPas_(diag.detail, 'F-000241',
      'Proposer une facture annulée comme « montant proche » envoie vérifier à la main une ' +
      'pièce que le solde ne compte pas.');
  });

  test_('Pièces sans date : une facture écartée n\'est pas annoncée comme comptant', () => {
    const factures = [
      testsFacture_({ id: 'F-000250', client: 'C-001', periode: '', date: '', total: 400,
        verification: STATUT_VERIF.REJETEE }),
    ];
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 0, declareCents: 0, factures: factures,
    }));
    assertEgal_(diag.verdict, VERDICT.BALANCE, 'Une facture rejetée ne déséquilibre rien.');
    testsAssertNeContientPas_(diag.detail, 'F-000250',
      'Annoncer « cette pièce compte dans votre solde » d\'une facture rejetée est faux, et ' +
      'laisse un avertissement que rien ne fera disparaître.');
  });

  test_('Pièces sans date : une facture reconnue, elle, est bien signalée', () => {
    const factures = [
      testsFacture_({ id: 'F-000251', client: 'C-001', periode: '', date: '', total: 400,
        verification: STATUT_VERIF.CONFORME }),
    ];
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 40000, declareCents: 40000, factures: factures,
    }));
    testsAssertContient_(diag.detail, 'F-000251',
      'Une pièce comptée dans le solde mais non datable doit être nommée, sans quoi son écart ' +
      'serait un jour déclaré « inexpliqué » alors que la cause est dans le classeur.');
  });

  test_('Diagnostic 9 : aucun montant n\'explique l\'écart', () => {
    const facture = testsFacture_({
      id: 'F-000099', client: 'C-001', periode: '2026-05', total: 900, taxes: 0,
      verification: STATUT_VERIF.CONFORME,
    });
    const paiement = testsPaiement_({
      id: 'P-000099', client: 'C-001', date: '2026-06-01', montant: 500,
    });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 12345, declareCents: 0, factures: [facture], paiements: [paiement],
    }));
    assertEgal_(diag.verdict, VERDICT.INEXPLIQUE, 'Sans correspondance exacte, on le dit.');
    testsAssertContient_(diag.detail, '123,45 $', 'Le détail chiffre l\'écart inexpliqué.');
    testsAssertContient_(diag.detail, 'P-000099', 'Le détail propose les montants les plus proches.');
    assertEgal_(diag.paiementsNonDeduits, [],
      'Aucun paiement n\'est mis en cause quand rien n\'est démontré.');
  });
}

// ---------------------------------------------------------------------------
// §4.4 — pièces sans date : comptées dans le solde, donc nommables
// ---------------------------------------------------------------------------

/**
 * diagnostiquerEcart_ — une pièce sans date compte dans le solde théorique
 * (§4.2) : elle est rattachée au trimestre traité pour que les hypothèses
 * puissent la nommer, et le rapport signale la ligne à compléter (§4.4).
 * @return {void}
 */
function testsDiagnosticSansDate_() {
  test_('Pièces sans date : une facture sans date reste nommable', () => {
    // Facture saisie à la main, sans « Date facture » NI « Période » : elle
    // compte dans le solde théorique, elle doit donc rester visible du moteur.
    const facture = testsFacture_({
      id: 'F-000050', client: 'C-001', numero: 'INV-050', total: 500,
      verification: STATUT_VERIF.CONFORME,
    });
    facture._ligne = 14;
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 50000, declareCents: 0, factures: [facture],
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE,
      'La seule pièce du dossier explique la totalité de l\'écart : la déclarer ' +
      '« inexpliquée » serait faux.');
    testsAssertContient_(diag.detail, 'F-000050', 'Le détail nomme la facture en cause.');
    assertEgal_(diag.piecesSansDate, 1, 'La pièce sans date est comptée.');
    testsAssertContient_(diag.detail, 'ligne 14',
      'Le détail dit quelle ligne du classeur compléter.');
    testsAssertContient_(diag.detail, CONFIG.ONGLETS.FACTURES.nom,
      'Le détail nomme l\'onglet concerné.');
  });

  test_('Pièces sans date : un paiement sans date reste nommable', () => {
    const facture = testsFacture_({
      id: 'F-000060', client: 'C-001', periode: '2026-05', total: 1000,
      verification: STATUT_VERIF.CONFORME,
    });
    const paiement = testsPaiement_({ id: 'P-000001', client: 'C-001', montant: 400 });
    paiement._ligne = 27;
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 60000, declareCents: 100000,
      factures: [facture], paiements: [paiement],
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE,
      'Le paiement sans date est bien celui qui crée l\'écart : il doit être nommé.');
    testsAssertContient_(diag.detail, 'P-000001', 'Le détail nomme le paiement en cause.');
    testsAssertContient_(diag.detail, CONFIG.ONGLETS.PAIEMENTS.nom,
      'Le détail nomme l\'onglet où compléter la date.');
  });

  test_('Pièces sans date : le détail les énumère ligne par ligne', () => {
    const premier = testsPaiement_({ id: 'P-000001', client: 'C-001', montant: 100 });
    const second = testsPaiement_({ id: 'P-000002', client: 'C-001', montant: 250 });
    premier._ligne = 14;
    second._ligne = 27;
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 0, declareCents: 0, paiements: [premier, second],
    }));
    assertEgal_(diag.verdict, VERDICT.BALANCE,
      'Même quand tout balance, les lignes à compléter sont signalées.');
    assertEgal_(diag.piecesSansDate, 2, 'Les deux pièces sans date sont comptées.');
    testsAssertContient_(diag.detail,
      `2 pièce(s) sans date : lignes 14 et 27 de l'onglet ${CONFIG.ONGLETS.PAIEMENTS.nom}`,
      'Le détail nomme les lignes exactes, comme l\'exige le §4.4.');
    testsAssertContient_(diag.detail, 'complétez la colonne Date',
      'Le détail dit quoi faire pour que la pièce redevienne datable.');
  });
}

// ---------------------------------------------------------------------------
// §2 — idempotence : relancer un trimestre ne réarme pas les relances
// ---------------------------------------------------------------------------

/**
 * rapprocherPeriode_ — la colonne « Relance » d'un trimestre déjà traité est
 * reportée sur les nouvelles lignes : relancer deux fois le rapprochement du
 * même trimestre ne doit pas provoquer un second courriel (§2).
 * @return {void}
 */
function testsRapprochementRelance_() {
  const dossier = (relanceExistante) => ({
    clients: [],
    bilans: [],
    factures: [testsFacture_({ id: 'F-000501', client: 'C-001', nom: 'Boulangerie Petit',
      periode: '2026-05', total: 1000, verification: STATUT_VERIF.CONFORME })],
    paiements: [],
    soldes: [testsSolde_({ client: 'C-001', nom: 'Boulangerie Petit', periode: '2026-T2',
      date: '2026-06-30', montant: 0 })],
    rapprochements: relanceExistante
      ? [testsLigneRapprochement_({ periode: '2026-T2', client: 'C-001',
        nom: 'Boulangerie Petit', relance: relanceExistante })]
      : [],
    params: {},
    maintenant: new Date(2026, 5, 30, 12, 0, 0, 0),
  });
  const relanceDe = (resultat) =>
    resultat.lignes[0][CONFIG.ONGLETS.RAPPROCHEMENT.colonnes[10].nom];

  test_('Rapprochement : un client déjà relancé garde son état de relance', () => {
    const resultat = rapprocherPeriode_('2026-T2', dossier('Envoyée'));
    assertEgal_(resultat.total, 1, 'Le client en écart figure bien au rapport.');
    assertEgal_(relanceDe(resultat), 'Envoyée',
      'Remettre « — » ferait repartir un second courriel identique au premier.');
  });

  test_('Rapprochement : un brouillon déjà créé est reporté lui aussi', () => {
    assertEgal_(relanceDe(rapprocherPeriode_('2026-T2', dossier('Brouillon créé'))),
      'Brouillon créé', 'Le brouillon déjà préparé ne doit pas être recréé.');
  });

  test_('Rapprochement : un client nouvellement en écart part de « — »', () => {
    assertEgal_(relanceDe(rapprocherPeriode_('2026-T2', dossier(''))), '—',
      'Sans relance antérieure, la ligne est neuve : elle doit pouvoir être relancée.');
  });

  test_('Rapprochement : une relance en échec peut être retentée', () => {
    assertEgal_(relanceDe(rapprocherPeriode_('2026-T2', dossier('Échec'))), '—',
      'Un envoi manqué n\'est pas un envoi : il doit rester possible de réessayer.');
  });

  test_('Rapprochement : la relance d\'un AUTRE trimestre n\'est pas reprise', () => {
    const donnees = dossier('');
    donnees.rapprochements = [testsLigneRapprochement_({ periode: '2026-T1', client: 'C-001',
      relance: 'Envoyée' })];
    assertEgal_(relanceDe(rapprocherPeriode_('2026-T2', donnees)), '—',
      'Un courriel envoyé pour 2026-T1 ne dispense pas de relancer 2026-T2.');
  });
}

// ---------------------------------------------------------------------------
// §4.2 — calculerSoldeTheorique_
// ---------------------------------------------------------------------------

/**
 * calculerSoldeTheorique_ — exclusion des factures non reconnues et filtrage
 * par client.
 * @return {void}
 */
function testsSoldeTheoriqueExclusions_() {
  const fin = new Date(2026, 5, 30, 23, 59, 59, 999);

  test_('Solde théorique : les factures Doublon, Sans bilan et Rejetée sont exclues', () => {
    const donnees = { factures: [
      testsFacture_({ id: 'F-1', client: 'C-001', periode: '2026-05', total: 1000,
        verification: STATUT_VERIF.CONFORME }),
      testsFacture_({ id: 'F-2', client: 'C-001', periode: '2026-05', total: 500,
        verification: STATUT_VERIF.DOUBLON }),
      testsFacture_({ id: 'F-3', client: 'C-001', periode: '2026-05', total: 300,
        verification: STATUT_VERIF.SANS_BILAN }),
      testsFacture_({ id: 'F-4', client: 'C-001', periode: '2026-05', total: 200,
        verification: STATUT_VERIF.REJETEE }),
    ], paiements: [] };
    assertEgal_(calculerSoldeTheorique_('C-001', fin, donnees), 100000,
      'Seule la facture Conforme est une dette reconnue.');
  });

  test_('Solde théorique : une facture Conforme mais annulée ne compte pas', () => {
    const donnees = { factures: [
      testsFacture_({ id: 'F-5', client: 'C-001', periode: '2026-05', total: 700,
        verification: STATUT_VERIF.CONFORME, paiement: STATUT_PAIEMENT.ANNULEE }),
      testsFacture_({ id: 'F-6', client: 'C-001', periode: '2026-05', total: 400,
        verification: STATUT_VERIF.ECART }),
    ], paiements: [] };
    assertEgal_(calculerSoldeTheorique_('C-001', fin, donnees), 40000,
      'La facture annulée sort du solde ; celle en écart de montant y reste.');
  });

  test_('Solde théorique : les pièces des autres clients sont ignorées', () => {
    const donnees = {
      factures: [
        testsFacture_({ id: 'F-7', client: 'C-001', periode: '2026-04', total: 600,
          verification: STATUT_VERIF.CONFORME }),
        testsFacture_({ id: 'F-8', client: 'C-002', periode: '2026-04', total: 9000,
          verification: STATUT_VERIF.CONFORME }),
      ],
      paiements: [
        testsPaiement_({ id: 'P-1', client: 'C-002', date: '2026-05-01', montant: 250 }),
      ],
    };
    assertEgal_(calculerSoldeTheorique_('C-001', fin, donnees), 60000,
      'Le solde d\'un client ne mélange jamais les factures ni les paiements d\'un autre.');
    assertEgal_(calculerSoldeTheorique_('C-002', fin, donnees), 875000,
      'Et le solde de l\'autre client ne reprend pas non plus les pièces du premier.');
  });
}

/**
 * calculerSoldeTheorique_ — borne de date, solde nul et trop-payé.
 * @return {void}
 */
function testsSoldeTheoriqueBornes_() {
  const fin = new Date(2026, 5, 30, 23, 59, 59, 999);

  test_('Solde théorique : une facture et un paiement postérieurs ne comptent pas', () => {
    const donnees = {
      factures: [
        testsFacture_({ id: 'F-9', client: 'C-001', periode: '2026-05', total: 1000,
          verification: STATUT_VERIF.CONFORME }),
        testsFacture_({ id: 'F-10', client: 'C-001', periode: '2026-07', total: 400,
          verification: STATUT_VERIF.CONFORME }),
      ],
      paiements: [
        testsPaiement_({ id: 'P-2', client: 'C-001', date: '2026-06-15', montant: 250 }),
        testsPaiement_({ id: 'P-3', client: 'C-001', date: '2026-07-05', montant: 900 }),
      ],
    };
    assertEgal_(calculerSoldeTheorique_('C-001', fin, donnees), 75000,
      'Ce qui vient après le trimestre appartient au trimestre suivant.');
  });

  test_('Solde théorique : tout est payé, le solde tombe à zéro', () => {
    const donnees = {
      factures: [
        testsFacture_({ id: 'F-11', client: 'C-001', periode: '2026-04', total: 1234.56,
          verification: STATUT_VERIF.CONFORME }),
      ],
      paiements: [
        testsPaiement_({ id: 'P-4', client: 'C-001', date: '2026-05-02', montant: 1234.56 }),
      ],
    };
    assertEgal_(calculerSoldeTheorique_('C-001', fin, donnees), 0,
      'Un client entièrement payé affiche un solde de zéro, au cent près.');
  });

  test_('Solde théorique : un trop-payé donne un solde négatif', () => {
    const donnees = {
      factures: [
        testsFacture_({ id: 'F-12', client: 'C-001', periode: '2026-04', total: 500,
          verification: STATUT_VERIF.CONFORME }),
      ],
      paiements: [
        testsPaiement_({ id: 'P-5', client: 'C-001', date: '2026-04-20', montant: 800 }),
      ],
    };
    const solde = calculerSoldeTheorique_('C-001', fin, donnees);
    assertEgal_(solde, -30000, 'Payer 800 $ pour 500 $ dus laisse 300 $ d\'avance au client.');
    assertProche_(enDollars_(solde), -300, 0, 'Le trop-payé vaut bien −300,00 $.');
  });
}

// ---------------------------------------------------------------------------
// Trimestres : periodeTrimestre_ et bornesTrimestre_
// ---------------------------------------------------------------------------

/**
 * periodeTrimestre_ — les quatre trimestres, les bords d'année, l'année
 * bissextile et le décalage d'exercice.
 * @return {void}
 */
function testsPeriodeTrimestre_() {
  test_('Trimestre : les quatre trimestres civils', () => {
    assertEgal_(periodeTrimestre_('2026-02-10', 0), '2026-T1', 'Février est au premier trimestre.');
    assertEgal_(periodeTrimestre_('2026-04-01', 0), '2026-T2', 'Avril ouvre le deuxième.');
    assertEgal_(periodeTrimestre_('2026-09-30', 0), '2026-T3', 'Septembre ferme le troisième.');
    assertEgal_(periodeTrimestre_('2026-10-01', 0), '2026-T4', 'Octobre ouvre le quatrième.');
  });

  test_('Trimestre : le 31 décembre et le 1er janvier changent d\'année', () => {
    assertEgal_(periodeTrimestre_('2026-12-31', 0), '2026-T4',
      'Le 31 décembre appartient encore au T4 de son année.');
    assertEgal_(periodeTrimestre_('2027-01-01', 0), '2027-T1',
      'Le 1er janvier ouvre le T1 de l\'année suivante.');
  });

  test_('Trimestre : le 29 février d\'une année bissextile', () => {
    assertEgal_(periodeTrimestre_('2024-02-29', 0), '2024-T1',
      'Le 29 février 2024 existe et tombe au premier trimestre.');
    assertEgal_(periodeTrimestre_('2023-02-29', 0), '',
      'Le 29 février 2023 n\'existe pas : aucune période n\'est inventée.');
  });

  test_('Trimestre : exercice décalé de trois mois (début en avril)', () => {
    assertEgal_(periodeTrimestre_('2026-04-01', 3), '2026-T1',
      'Avril ouvre le premier trimestre de l\'exercice décalé.');
    assertEgal_(periodeTrimestre_('2026-02-15', 3), '2025-T4',
      'Février appartient encore à l\'exercice ouvert en avril 2025.');
    assertEgal_(periodeTrimestre_('2026-03-31', 3), '2025-T4',
      'Le 31 mars ferme l\'exercice précédent.');
  });

  test_('Trimestre : une valeur illisible ne produit pas de période', () => {
    assertEgal_(periodeTrimestre_('', 0), '', 'Une cellule vide ne donne pas de trimestre.');
    assertEgal_(periodeTrimestre_('pas une date', 0), '',
      'Un texte quelconque ne donne pas de trimestre.');
  });
}

/**
 * bornesTrimestre_ — premier et dernier instant, décalage d'exercice, année
 * bissextile, formats invalides.
 * @return {void}
 */
function testsBornesTrimestre_() {
  test_('Bornes : les quatre trimestres civils', () => {
    const t1 = bornesTrimestre_('2026-T1', 0);
    assertEgal_(testsDateTexte_(t1.debut), '2026-01-01 00:00:00.000', 'Le T1 ouvre le 1er janvier.');
    assertEgal_(testsDateTexte_(t1.fin), '2026-03-31 23:59:59.999', 'Le T1 ferme le 31 mars.');
    assertEgal_(testsDateTexte_(bornesTrimestre_('2026-T2', 0).fin), '2026-06-30 23:59:59.999',
      'Le T2 ferme le 30 juin.');
    assertEgal_(testsDateTexte_(bornesTrimestre_('2026-T3', 0).debut), '2026-07-01 00:00:00.000',
      'Le T3 ouvre le 1er juillet.');
  });

  test_('Bornes : le T4 se termine le 31 décembre, sans déborder sur l\'an prochain', () => {
    const t4 = bornesTrimestre_('2026-T4', 0);
    assertEgal_(testsDateTexte_(t4.debut), '2026-10-01 00:00:00.000', 'Le T4 ouvre le 1er octobre.');
    assertEgal_(testsDateTexte_(t4.fin), '2026-12-31 23:59:59.999', 'Le T4 ferme le 31 décembre.');
  });

  test_('Bornes : exercice décalé de trois mois', () => {
    const t1 = bornesTrimestre_('2026-T1', 3);
    assertEgal_(testsDateTexte_(t1.debut), '2026-04-01 00:00:00.000',
      'L\'exercice décalé ouvre en avril.');
    assertEgal_(testsDateTexte_(t1.fin), '2026-06-30 23:59:59.999',
      'Son premier trimestre ferme le 30 juin.');
    assertEgal_(testsDateTexte_(bornesTrimestre_('2026-T4', 3).fin), '2027-03-31 23:59:59.999',
      'Son quatrième trimestre déborde sur l\'année suivante.');
  });

  test_('Bornes : un trimestre qui finit en février, bissextile ou non', () => {
    assertEgal_(testsDateTexte_(bornesTrimestre_('2023-T1', 11).fin), '2024-02-29 23:59:59.999',
      '2024 est bissextile : le trimestre ferme le 29 février.');
    assertEgal_(testsDateTexte_(bornesTrimestre_('2022-T1', 11).fin), '2023-02-28 23:59:59.999',
      '2023 ne l\'est pas : il ferme le 28 février.');
  });

  test_('Bornes : un trimestre invalide ne donne pas de bornes', () => {
    assertNull_(bornesTrimestre_('2026-T5', 0), 'Il n\'existe pas de cinquième trimestre.');
    assertNull_(bornesTrimestre_('', 0), 'Une période vide ne donne pas de bornes.');
    assertNull_(bornesTrimestre_('2026-06', 0), 'Un mois n\'est pas un trimestre.');
  });

  test_('Bornes : une date de fin de trimestre y est bien comprise', () => {
    const bornes = bornesTrimestre_('2026-T2', 0);
    const dernierJour = new Date(2026, 5, 30, 17, 30, 0, 0);
    assertVrai_(dernierJour.getTime() >= bornes.debut.getTime() &&
      dernierJour.getTime() <= bornes.fin.getTime(),
      'Un paiement fait le dernier jour du trimestre appartient à ce trimestre.');
  });
}

// ---------------------------------------------------------------------------
// §4.1 — normaliserSolde_
// ---------------------------------------------------------------------------

/**
 * normaliserSolde_ — convention de signe et formats de saisie.
 * @return {void}
 */
function testsNormaliserSolde_() {
  test_('Solde déclaré : mode Normal', () => {
    assertEgal_(normaliserSolde_(1234.56, { SIGNE_SOLDE_CLIENT: 'Normal' }), 123456,
      'En mode Normal, le montant est repris tel quel, en cents.');
    assertEgal_(normaliserSolde_(0, { SIGNE_SOLDE_CLIENT: 'Normal' }), 0,
      'Un solde à zéro reste à zéro.');
  });

  test_('Solde déclaré : mode Inversé', () => {
    assertEgal_(normaliserSolde_(1234.56, { SIGNE_SOLDE_CLIENT: 'Inversé' }), -123456,
      'En mode Inversé, un montant positif devient une dette éteinte.');
    assertEgal_(normaliserSolde_(-500, { SIGNE_SOLDE_CLIENT: 'Inversé' }), 50000,
      'Le client qui déclare −500 $ attend bien 500 $.');
  });

  test_('Solde déclaré : montant saisi en texte avec devise', () => {
    assertEgal_(normaliserSolde_('1 234,56 $', {}), 123456,
      'Un montant recopié avec son symbole reste lisible.');
    assertEgal_(normaliserSolde_('1,234.56', {}), 123456,
      'La notation anglaise donne le même montant.');
  });

  test_('Solde déclaré : négatif écrit entre parenthèses', () => {
    assertEgal_(normaliserSolde_('(1 234,56)', {}), -123456,
      'Les parenthèses comptables valent un montant négatif.');
    assertEgal_(normaliserSolde_('(500,00)', { SIGNE_SOLDE_CLIENT: 'Inversé' }), 50000,
      'Parenthèses et mode Inversé se combinent sans se contredire.');
  });

  test_('Solde déclaré : cellule vide', () => {
    assertEgal_(normaliserSolde_('', {}), 0, 'Une cellule vide vaut zéro, pas une erreur.');
    assertEgal_(normaliserSolde_(null, null), 0, 'Sans réglage ni valeur, le solde vaut zéro.');
  });
}

// ---------------------------------------------------------------------------
// Argent : enCents_ et enDollars_
// ---------------------------------------------------------------------------

/**
 * enCents_ — arrondis, valeurs vides, textes mal formés, virgule et point.
 * @return {void}
 */
function testsEnCents_() {
  test_('Cents : arrondi au cent le plus proche', () => {
    assertEgal_(enCents_(1234.56), 123456, '1 234,56 $ font 123 456 cents.');
    assertEgal_(enCents_(1234.567), 123457, 'La troisième décimale est arrondie.');
    assertEgal_(enCents_(-45), -4500, 'Un montant négatif reste négatif.');
  });

  test_('Cents : valeurs vides et illisibles', () => {
    assertEgal_(enCents_(''), 0, 'Une cellule vide vaut zéro.');
    assertEgal_(enCents_(null), 0, 'Une valeur absente vaut zéro.');
    assertEgal_(enCents_(undefined), 0, 'Une colonne manquante vaut zéro.');
    assertEgal_(enCents_('à venir'), 0, 'Un texte sans chiffre vaut zéro, sans lever d\'erreur.');
  });

  test_('Cents : virgule ou point comme séparateur décimal', () => {
    assertEgal_(enCents_('12,50'), 1250, 'La virgule est décimale.');
    assertEgal_(enCents_('12.50'), 1250, 'Le point aussi.');
    assertEgal_(enCents_('1 234,56 $'), 123456, 'Les espaces des milliers sont ignorés.');
    assertEgal_(enCents_('1,234.56'), 123456, 'La notation anglaise donne le même résultat.');
    assertEgal_(enCents_('1.234,56'), 123456, 'La notation européenne aussi.');
    assertEgal_(enCents_('1.234'), 123400, 'Trois chiffres après le point : ce sont des milliers.');
  });

  test_('Cents : les parenthèses et le signe marquent le négatif', () => {
    assertEgal_(enCents_('(120,00)'), -12000, 'Les parenthèses comptables valent un négatif.');
    assertEgal_(enCents_('-45,00'), -4500, 'Le signe devant vaut un négatif.');
  });

  test_('Cents : aucune erreur de virgule flottante', () => {
    assertEgal_(enCents_(0.1) + enCents_(0.2), enCents_(0.3),
      '0,10 $ + 0,20 $ font exactement 0,30 $ en cents.');
    assertEgal_(enCents_(0.1 + 0.2), 30,
      'Même le résultat flottant 0,30000000000000004 revient à 30 cents.');
    const total = [19.99, 0.01, 0.1, 0.2].reduce((somme, montant) => somme + enCents_(montant), 0);
    assertEgal_(total, 2030, 'Une addition de quatre montants reste exacte au cent.');
  });
}

/**
 * enDollars_ — conversion inverse, pour l'écriture dans la feuille.
 * @return {void}
 */
function testsEnDollars_() {
  test_('Dollars : conversion depuis les cents', () => {
    assertProche_(enDollars_(123456), 1234.56, 0, '123 456 cents font 1 234,56 $.');
    assertProche_(enDollars_(1), 0.01, 0, 'Un cent vaut 0,01 $.');
    assertProche_(enDollars_(-5), -0.05, 0, 'Cinq cents négatifs valent −0,05 $.');
  });

  test_('Dollars : valeurs vides et arrondis', () => {
    assertEgal_(enDollars_(0), 0, 'Zéro cent vaut zéro dollar.');
    assertEgal_(enDollars_(''), 0, 'Une valeur vide vaut zéro dollar.');
    assertEgal_(enDollars_(null), 0, 'Une valeur absente vaut zéro dollar.');
    assertProche_(enDollars_(1234.7), 12.35, 0, 'Une fraction de cent est arrondie au cent.');
  });

  test_('Dollars : aller-retour cents → dollars → cents', () => {
    [0, 1, 999, 123456, -7500].forEach((cents) => {
      assertEgal_(enCents_(enDollars_(cents)), cents,
        `Le montant de ${cents} cents doit revenir intact après conversion.`);
    });
  });
}

// ---------------------------------------------------------------------------
// §4.3 — verifierUneFacture_
// ---------------------------------------------------------------------------

/**
 * Contexte de vérification d'une facture, avec les réglages par défaut.
 * @param {Array<Object>} bilans Bilans connus.
 * @param {Array<Object>} facturesExistantes Factures déjà enregistrées.
 * @param {Array<Object>} lignesBilan Lignes de bilan connues.
 * @return {Object} Contexte attendu par verifierUneFacture_.
 */
function testsContexteFacture_(bilans, facturesExistantes, lignesBilan) {
  return {
    bilans: bilans || [],
    facturesExistantes: facturesExistantes || [],
    lignesBilan: lignesBilan || [],
    params: { DEVISE: 'CAD', TOLERANCE_CENTS: '1' },
  };
}

/**
 * verifierUneFacture_ — facture conforme et écart de montant expliqué.
 * @return {void}
 */
function testsVerifierFacture_() {
  const bilan = testsBilan_({ id: 'B-C001-2026-05', client: 'C-001', nom: 'Boulangerie Petit',
    periode: '2026-05', montant: 1000 });

  test_('Vérification : une facture qui correspond au bilan est Conforme', () => {
    const facture = testsFacture_({ id: 'F-000010', client: 'C-001', numero: 'INV-2026-001',
      periode: '2026-05', total: 1000 });
    const resultat = verifierUneFacture_(facture, testsContexteFacture_([bilan], [facture]));
    assertEgal_(resultat.statut, STATUT_VERIF.CONFORME, 'Les deux montants sont identiques.');
    assertEgal_(resultat.idBilan, 'B-C001-2026-05', 'La facture est rattachée à son bilan.');
    assertEgal_(resultat.ecartCents, 0, 'Il n\'y a aucun écart.');
    testsAssertContient_(resultat.notes, 'peut être payée',
      'La note dit clairement que la facture peut être payée.');
  });

  test_('Vérification : une facture plus basse que le bilan est en Écart de montant', () => {
    const facture = testsFacture_({ id: 'F-000011', client: 'C-001', numero: 'INV-2026-002',
      periode: '2026-05', total: 900 });
    const ligne = testsLigneBilan_({ id: 'L-000001', client: 'C-001', periode: '2026-05',
      description: 'Frais de service', montant: 100, bilan: 'B-C001-2026-05' });
    const resultat = verifierUneFacture_(facture,
      testsContexteFacture_([bilan], [facture], [ligne]));
    assertEgal_(resultat.statut, STATUT_VERIF.ECART, 'Cent dollars manquent sur la facture.');
    assertEgal_(resultat.ecartCents, -10000, 'L\'écart est de −100,00 $, en cents.');
    testsAssertContient_(resultat.notes, 'Frais de service',
      'La note nomme la ligne du bilan qui explique l\'écart.');
    testsAssertContient_(resultat.notes, 'oubliée',
      'La note dit que la ligne semble avoir été oubliée.');
  });

  test_('Vérification : un écart d\'un cent reste Conforme (tolérance)', () => {
    const facture = testsFacture_({ id: 'F-000012', client: 'C-001', numero: 'INV-2026-003',
      periode: '2026-05', total: 1000.01 });
    const resultat = verifierUneFacture_(facture, testsContexteFacture_([bilan], [facture]));
    assertEgal_(resultat.statut, STATUT_VERIF.CONFORME,
      'Un cent d\'écart ne justifie pas de bloquer un paiement.');
    assertEgal_(resultat.ecartCents, 1, 'L\'écart d\'un cent est tout de même reporté.');
  });
}

/**
 * verifierUneFacture_ — détection des doublons (§4.3 règle 1).
 * @return {void}
 */
function testsVerifierFactureDoublons_() {
  const origine = testsFacture_({ id: 'F-000001', client: 'C-001', numero: 'INV-2026-001',
    periode: '2026-05', total: 1000, verification: STATUT_VERIF.CONFORME });

  test_('Vérification : doublon repéré par le n° de facture, malgré la mise en forme', () => {
    const copie = testsFacture_({ id: 'F-000002', client: 'C-001', numero: 'inv 2026 001',
      periode: '2026-06', total: 1400 });
    const resultat = verifierUneFacture_(copie,
      testsContexteFacture_([], [origine, copie]));
    assertEgal_(resultat.statut, STATUT_VERIF.DOUBLON,
      '« inv 2026 001 » et « INV-2026-001 » sont le même numéro.');
    testsAssertContient_(resultat.notes, 'F-000001', 'La note renvoie à la facture d\'origine.');
    testsAssertContient_(resultat.notes, 'même n° de facture', 'La note donne le motif exact.');
    assertEgal_(resultat.ecartCents, 0, 'Un doublon n\'a pas d\'écart de montant à signaler.');
  });

  test_('Vérification : doublon repéré par montant et période identiques', () => {
    const jumelle = testsFacture_({ id: 'F-000003', client: 'C-001', numero: 'AUTRE-99',
      periode: '2026-05', total: 1000 });
    const resultat = verifierUneFacture_(jumelle,
      testsContexteFacture_([], [origine, jumelle]));
    assertEgal_(resultat.statut, STATUT_VERIF.DOUBLON,
      'Même client, même montant, même période : c\'est deux fois la même facture.');
    testsAssertContient_(resultat.notes, 'même montant', 'La note donne le motif exact.');
  });

  test_('Vérification : un autre client avec le même n° n\'est pas un doublon', () => {
    const autre = testsFacture_({ id: 'F-000004', client: 'C-999', numero: 'INV-2026-001',
      periode: '2026-05', total: 1000 });
    const resultat = verifierUneFacture_(autre, testsContexteFacture_([], [origine, autre]));
    assertVrai_(resultat.statut !== STATUT_VERIF.DOUBLON,
      'Deux clients différents peuvent numéroter leurs factures de la même façon.');
  });

  test_('Vérification : une facture différente du même client n\'est pas un doublon', () => {
    const bilan = testsBilan_({ id: 'B-C001-2026-06', client: 'C-001', periode: '2026-06',
      montant: 400 });
    const suivante = testsFacture_({ id: 'F-000005', client: 'C-001', numero: 'INV-2026-002',
      periode: '2026-06', total: 400 });
    const resultat = verifierUneFacture_(suivante,
      testsContexteFacture_([bilan], [origine, suivante]));
    assertEgal_(resultat.statut, STATUT_VERIF.CONFORME,
      'Un autre numéro, une autre période : c\'est une nouvelle facture.');
  });
}

/**
 * verifierUneFacture_ — rattachement au bilan (§4.3 règle 2).
 * @return {void}
 */
function testsVerifierFactureRattachement_() {
  test_('Vérification : aucun bilan disponible pour ce client', () => {
    const bilan = testsBilan_({ id: 'B-C001-2026-05', client: 'C-001', periode: '2026-05',
      montant: 1000 });
    const orpheline = testsFacture_({ id: 'F-000020', client: 'C-777', numero: 'X-1',
      periode: '2026-05', total: 1000 });
    const resultat = verifierUneFacture_(orpheline,
      testsContexteFacture_([bilan], [orpheline]));
    assertEgal_(resultat.statut, STATUT_VERIF.SANS_BILAN, 'Ce client n\'a aucun bilan.');
    assertEgal_(resultat.idBilan, '', 'Aucun bilan n\'est rattaché.');
    testsAssertContient_(resultat.notes, 'Aucun bilan disponible',
      'La note explique ce qui manque et comment le corriger.');
  });

  test_('Vérification : rattachement approximatif à moins de 2 % d\'écart', () => {
    const bilan = testsBilan_({ id: 'B-C001-2026-05', client: 'C-001', periode: '2026-05',
      montant: 1010 });
    const facture = testsFacture_({ id: 'F-000021', client: 'C-001', numero: 'INV-88',
      periode: '2026-06', total: 1000 });
    const resultat = verifierUneFacture_(facture, testsContexteFacture_([bilan], [facture]));
    assertEgal_(resultat.idBilan, 'B-C001-2026-05',
      'Un écart de 0,99 % reste sous la barre des 2 % : le bilan est retenu.');
    assertEgal_(resultat.statut, STATUT_VERIF.ECART, 'Les dix dollars d\'écart sont signalés.');
    assertEgal_(resultat.ecartCents, -1000, 'L\'écart vaut −10,00 $, en cents.');
    testsAssertContient_(resultat.notes, 'Rattachement approximatif',
      'La note signale que le rattachement demande confirmation.');
  });

  test_('Vérification : au-delà de 2 % d\'écart, aucun rattachement approximatif', () => {
    const bilan = testsBilan_({ id: 'B-C001-2026-05', client: 'C-001', periode: '2026-05',
      montant: 1500 });
    const facture = testsFacture_({ id: 'F-000022', client: 'C-001', numero: 'INV-89',
      periode: '2026-06', total: 1000 });
    const resultat = verifierUneFacture_(facture, testsContexteFacture_([bilan], [facture]));
    assertEgal_(resultat.statut, STATUT_VERIF.SANS_BILAN,
      'Un tiers d\'écart, ce n\'est plus un rapprochement : c\'est une supposition.');
  });

  test_('Vérification : un bilan déjà rattaché à une autre facture n\'est pas réutilisé', () => {
    const bilan = testsBilan_({ id: 'B-C001-2026-05', client: 'C-001', periode: '2026-05',
      montant: 1000, facture: 'F-000030' });
    const facture = testsFacture_({ id: 'F-000031', client: 'C-001', numero: 'INV-90',
      periode: '2026-05', total: 1000 });
    const resultat = verifierUneFacture_(facture, testsContexteFacture_([bilan], [facture]));
    assertEgal_(resultat.statut, STATUT_VERIF.SANS_BILAN,
      'Le bilan est déjà pris : la seconde facture reste à traiter à la main.');
  });
}

// ---------------------------------------------------------------------------
// Normalisation des n° de facture
// ---------------------------------------------------------------------------

/**
 * facturesNormaliserNumero_ — accents, espaces, tirets, casse.
 * @return {void}
 */
function testsNumeroFacture_() {
  test_('N° de facture : accents, espaces et tirets sont ignorés', () => {
    assertEgal_(facturesNormaliserNumero_(' Réf-2026 / 001 '), 'REF2026001',
      'Accents, espaces, tirets et barres obliques disparaissent.');
    assertEgal_(facturesNormaliserNumero_('Fàctûre 12'), 'FACTURE12',
      'Les accents sont ramenés à leur lettre de base.');
  });

  test_('N° de facture : la casse ne change rien', () => {
    assertEgal_(facturesNormaliserNumero_('inv2026001'), 'INV2026001', 'Tout passe en majuscules.');
    assertEgal_(facturesNormaliserNumero_('INV 2026-001'),
      facturesNormaliserNumero_('inv2026001'),
      'Deux écritures du même numéro doivent se rejoindre.');
  });

  test_('N° de facture : deux numéros différents restent différents', () => {
    assertVrai_(facturesNormaliserNumero_('INV-001') !== facturesNormaliserNumero_('INV-002'),
      'La normalisation ne doit jamais confondre deux factures distinctes.');
  });

  test_('N° de facture : une cellule vide donne un numéro vide', () => {
    assertEgal_(facturesNormaliserNumero_(''), '', 'Une cellule vide ne donne aucun numéro.');
    assertEgal_(facturesNormaliserNumero_(null), '', 'Une valeur absente non plus.');
    assertEgal_(facturesNormaliserNumero_('   '), '', 'Des espaces seuls non plus.');
  });
}

// ---------------------------------------------------------------------------
// Points d'entrée
// ---------------------------------------------------------------------------

/**
 * Liste des suites de tests, dans l'ordre d'exécution.
 * @return {Array<{nom: string, fn: function()}>} Suites à exécuter.
 */
function testsSuites_() {
  return [
    { nom: 'Recherche de sous-ensemble — tailles', fn: testsSousEnsembleTailles_ },
    { nom: 'Recherche de sous-ensemble — refus', fn: testsSousEnsembleRefus_ },
    { nom: 'Diagnostic — sans écart', fn: testsDiagnosticSansEcart_ },
    { nom: 'Diagnostic — paiements non déduits', fn: testsDiagnosticPaiements_ },
    { nom: 'Diagnostic — priorités et ordre des hypothèses', fn: testsDiagnosticPriorites_ },
    { nom: 'Diagnostic — paiement compté deux fois', fn: testsDiagnosticPaiementDouble_ },
    { nom: 'Diagnostic — factures oubliées ou mal facturées', fn: testsDiagnosticFactures_ },
    { nom: 'Diagnostic — factures écartées', fn: testsDiagnosticFactureEcartee_ },
    { nom: 'Diagnostic — taxes, signe, période, inexpliqué', fn: testsDiagnosticDivers_ },
    { nom: 'Diagnostic — pièces sans date', fn: testsDiagnosticSansDate_ },
    { nom: 'Rapprochement — report des relances', fn: testsRapprochementRelance_ },
    { nom: 'Solde théorique — exclusions', fn: testsSoldeTheoriqueExclusions_ },
    { nom: 'Solde théorique — bornes de date', fn: testsSoldeTheoriqueBornes_ },
    { nom: 'Trimestres — période', fn: testsPeriodeTrimestre_ },
    { nom: 'Trimestres — bornes', fn: testsBornesTrimestre_ },
    { nom: 'Soldes déclarés', fn: testsNormaliserSolde_ },
    { nom: 'Argent — cents', fn: testsEnCents_ },
    { nom: 'Argent — dollars', fn: testsEnDollars_ },
    { nom: 'Vérification des factures', fn: testsVerifierFacture_ },
    { nom: 'Vérification — doublons', fn: testsVerifierFactureDoublons_ },
    { nom: 'Vérification — rattachement', fn: testsVerifierFactureRattachement_ },
    { nom: 'N° de facture', fn: testsNumeroFacture_ },
  ];
}

/**
 * Exécute une suite ; une suite qui s'interrompt compte comme un échec, elle
 * n'arrête jamais les autres.
 * @param {{nom: string, fn: function()}} suite Suite à exécuter.
 * @return {void}
 */
function testsLancerSuite_(suite) {
  try {
    suite.fn();
  } catch (e) {
    const etat = TESTS_ETAT_.courant;
    etat.total++;
    etat.echecs.push({
      nom: `${suite.nom} (suite interrompue)`,
      attendu: 'la suite s\'exécute en entier',
      obtenu: testsErreurTexte_(e),
    });
    testsJournaliserErreur_(suite.nom, e);
  }
}

/**
 * Exécute toute la suite de tests. Aucune feuille n'est lue ni écrite :
 * la fonction est utilisable depuis le classeur comme depuis Node.
 * @return {{total: number, reussis: number,
 *     echecs: Array<{nom: string, attendu: string, obtenu: string}>}}
 *     Nombre de vérifications, réussites, et détail de chaque échec.
 */
function lancerTests() {
  const etat = { total: 0, reussis: 0, echecs: [] };
  const precedent = TESTS_ETAT_.courant;
  TESTS_ETAT_.courant = etat;
  try {
    testsSuites_().forEach((suite) => testsLancerSuite_(suite));
  } finally {
    TESTS_ETAT_.courant = precedent;
  }
  return { total: etat.total, reussis: etat.reussis, echecs: etat.echecs };
}

/**
 * Met en forme le résultat des tests pour une alerte lisible.
 * @param {Object} resultat Objet renvoyé par lancerTests().
 * @return {{titre: string, message: string}} Titre et corps de l'alerte.
 */
function testsMessageResultats_(resultat) {
  const total = Number(resultat.total) || 0;
  const reussis = Number(resultat.reussis) || 0;
  const echecs = resultat.echecs || [];
  if (!echecs.length) {
    return {
      titre: '✅ Vérifications réussies',
      message: `Les ${reussis} vérifications sur ${total} ont réussi.\n\n` +
        'Les calculs du classeur (soldes, écarts, trimestres, montants) se comportent ' +
        'comme prévu. Vous pouvez utiliser le menu normalement.',
    };
  }
  const lignes = echecs.slice(0, 10).map((echec) =>
    `• ${echec.nom}\n   attendu : ${echec.attendu}\n   obtenu : ${echec.obtenu}`);
  const reste = echecs.length > 10 ? `\n\n… et ${echecs.length - 10} autre(s).` : '';
  return {
    titre: '⚠️ Des vérifications ont échoué',
    message: `${reussis} réussite(s) sur ${total}, ${echecs.length} échec(s) :\n\n` +
      `${lignes.join('\n')}${reste}\n\n` +
      'Transmettez ce texte à la personne qui a installé le script : il dit précisément ' +
      'quel calcul ne se comporte pas comme prévu.',
  };
}

/**
 * Lance les tests et affiche le résultat dans une alerte du classeur.
 * Hors de Google (Node), il n'y a pas d'interface : le texte est simplement
 * renvoyé à l'appelant.
 * @return {string} Le texte affiché, utilisable tel quel dans un rapport.
 */
function afficherResultatsTests() {
  const resultat = lancerTests();
  const alerte = testsMessageResultats_(resultat);
  try {
    const ui = (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.getUi)
      ? SpreadsheetApp.getUi() : null;
    if (ui && typeof ui.alert === 'function') ui.alert(alerte.titre, alerte.message, ui.ButtonSet.OK);
  } catch (e) {
    testsJournaliserErreur_('afficherResultatsTests', e);
  }
  try {
    if (typeof viderTamponJournal_ === 'function') viderTamponJournal_();
  } catch (e) {
    testsJournaliserErreur_('afficherResultatsTests', e);
  }
  return `${alerte.titre}\n\n${alerte.message}`;
}
