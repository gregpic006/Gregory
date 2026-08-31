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

  test_('Sous-ensemble : liste plus longue que SOUS_ENSEMBLE_MAX_ELEMENTS', () => {
    const trop = [];
    for (let i = 0; i <= CONFIG.SOUS_ENSEMBLE_MAX_ELEMENTS; i++) trop.push(100);
    assertEgal_(trop.length, CONFIG.SOUS_ENSEMBLE_MAX_ELEMENTS + 1,
      'Le jeu d\'essai dépasse bien la borne de un élément.');
    assertNull_(trouverSousEnsemble_(trop, 100),
      'Au-delà de la borne, on abandonne proprement — même si une réponse évidente existe.');
  });

  test_('Sous-ensemble : borne maxElements passée explicitement', () => {
    assertNull_(trouverSousEnsemble_([100, 200], 300, 1),
      'Deux montants pour une borne de un : la fonction renonce.');
    assertEgal_(trouverSousEnsemble_([100, 200], 300, 2), [0, 1],
      'La même recherche aboutit quand la borne le permet.');
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
 * diagnostiquerEcart_ — hypothèse 3 : un paiement compté deux fois, ou deux
 * paiements de même montant dont un seul a été enregistré.
 * @return {void}
 */
function testsDiagnosticPaiementDouble_() {
  test_('Diagnostic 3 : un paiement compté deux fois par le client', () => {
    const paiement = testsPaiement_({ id: 'P-000077', client: 'C-001', date: '2026-05-05',
      montant: 500, reference: 'CHQ-114' });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 100000, declareCents: 0, paiements: [paiement],
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'Le double d\'un paiement explique l\'écart.');
    testsAssertContient_(diag.diagnostic, 'deux fois', 'Le diagnostic dit ce qui s\'est passé.');
    testsAssertContient_(diag.detail, 'P-000077', 'Le détail nomme le paiement compté deux fois.');
  });

  test_('Diagnostic 3 : deux paiements identiques, un seul pris en compte', () => {
    const paiements = [
      testsPaiement_({ id: 'P-000021', client: 'C-001', date: '2026-04-08', montant: 300 }),
      testsPaiement_({ id: 'P-000022', client: 'C-001', date: '2026-05-08', montant: 300 }),
    ];
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 30000, declareCents: 0, paiements: paiements,
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'Le montant apparaît deux fois : c\'est la piste.');
    testsAssertContient_(diag.detail, 'P-000021', 'Le détail nomme le premier paiement.');
    testsAssertContient_(diag.detail, 'P-000022', 'Le détail nomme le second paiement.');
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

}

/**
 * diagnostiquerEcart_ — hypothèse 5 : le client comptabilise une facture que
 * vous avez écartée (Doublon ou Sans bilan), et qui n'est pas dans votre solde.
 * @return {void}
 */
function testsDiagnosticFactureEcartee_() {
  test_('Diagnostic 5 : le client compte une facture classée Doublon', () => {
    const facture = testsFacture_({
      id: 'F-000055', client: 'C-001', numero: 'INV-900', periode: '2026-05', total: 750,
      verification: STATUT_VERIF.DOUBLON,
    });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 75000, declareCents: 0, factures: [facture],
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'La facture écartée explique l\'écart.');
    testsAssertContient_(diag.diagnostic, STATUT_VERIF.DOUBLON,
      'Le diagnostic nomme le statut en cause.');
    testsAssertContient_(diag.detail, 'F-000055', 'Le détail nomme la facture doublon.');
    testsAssertContient_(diag.action, CONFIG.ONGLETS.FACTURES.nom,
      'L\'action dit dans quel onglet corriger si la facture est valable.');
  });

  test_('Diagnostic 5 : même chose pour une facture classée Sans bilan', () => {
    const facture = testsFacture_({
      id: 'F-000056', client: 'C-001', periode: '2026-04', total: 320,
      verification: STATUT_VERIF.SANS_BILAN,
    });
    const diag = diagnostiquerEcart_(testsContexteEcart_({
      theoriqueCents: 32000, declareCents: 0, factures: [facture],
    }));
    assertEgal_(diag.verdict, VERDICT.EXPLIQUE, 'Une facture sans bilan explique aussi un écart.');
    testsAssertContient_(diag.diagnostic, STATUT_VERIF.SANS_BILAN,
      'Le diagnostic nomme le statut « Sans bilan ».');
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
