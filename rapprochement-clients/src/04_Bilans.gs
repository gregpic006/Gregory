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
