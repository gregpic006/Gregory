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
