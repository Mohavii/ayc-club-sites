// AG-only workspace template based on the supplied "Procès-verbal de
// l'Assemblée Générale Extraordinaire Juillet 2026" PDF.
//
// IMPORTANT: this data is intentionally scoped to NATIONAL AGs. Local AL/PV
// workflows do not use this template.

const AG_MOTION_CATALOG = [
  { key: 'motion_1', label: "Motion 1", title: "Ouverture de l'AGE", plenary: 1 },
  { key: 'proc_1', label: 'Motion de procédure 1', title: "Suspension du point 2.4 du 2eme article du 2eme titre du règlement intérieur de l'association YOUTH CLUBs", plenary: 1 },
  { key: 'motion_3', label: 'Motion 3', title: "Vote sur les postes vacants de l'Équipe Plénière Nationale", plenary: 1 },
  { key: 'motion_4', label: 'Motion 4', title: 'Présentation du rapport préliminaire du CSCY', plenary: 1 },
  { key: 'proc_2', label: 'Motion de procédure 2', title: "Le changement de l’agenda ; Ajout de motion : Ouverture d'une LOR , Sujet : Extension deadline cotisation nationale Durée totale : 10mn , Durée par orateur: 2mn", plenary: 1 },
  { key: 'proc_3', label: 'Motion de procédure 3', title: "Le changement de l’agenda ; Ajout d’une motion vote sur la nouvelle deadline du paiement de la cotisation", plenary: 1 },
  { key: 'motion_7', label: 'Motion 7', title: 'Adoption du rapport préliminaire de CSCY', plenary: 1 },
  { key: 'motion_8', label: 'Motion 8', title: 'Clôture de la première plénière', plenary: 1 },

  { key: 'motion_9', label: 'Motion 9', title: 'Ouverture de la deuxième plénière', plenary: 2 },
  { key: 'motion_10', label: 'Motion 10', title: "Présentation de l’agenda", plenary: 2 },
  { key: 'motion_11', label: 'Motion 11', title: "Adoption de l’agenda", plenary: 2 },
  { key: 'motion_12', label: 'Motion 12', title: "Présentation du PV de l’AGOMM 25-26", plenary: 2 },
  { key: 'motion_13', label: 'Motion 13', title: "Présentation du rapport fin mandat de l'EPN de l’AGOMM 25-26", plenary: 2 },
  { key: 'motion_14', label: 'Motion 14', title: 'Présentation des changements grammaticaux du document de réglementation', plenary: 2 },
  { key: 'motion_15', label: 'Motion 15', title: 'Présentation des amendements du statut', plenary: 2 },
  { key: 'motion_16', label: 'Motion 16', title: "Présentation des amendements du règlement intérieur de l'AssoYCS", plenary: 2 },
  { key: 'motion_17', label: 'Motion 17', title: 'Présentation des amendements du système de mise à jour', plenary: 2 },
  { key: 'motion_18', label: 'Motion 18', title: 'Présentation des amendements du règlement intérieur des clubs', plenary: 2 },
  { key: 'proc_4', label: 'Motion de procédure 4', title: "Le changement de l’agenda ; Ajout de motion : Ouverture d'une LOR , sujet : la compétition de l'EPL 6mn total, 2 par orateur.", plenary: 2 },
  { key: 'proc_5', label: 'Motion de procédure 5', title: "La suspension d’un point ou d’un sous-point du règlement jusqu'à la fin de l'Assemblée Générale ou jusqu'à ce qu'il soit repris par l'Assemblée Générale : suspension Du point 3.2.2.1du guide de système de mise à jour.", plenary: 2 },
  { key: 'proc_6', label: 'Motion de procédure 6', title: "La réouverture d’une motion; Réouverture de la motion de la présentation du PV de l’AGOMM 25-26.", plenary: 2 },
  { key: 'proc_7', label: 'Motion de procédure 7', title: "Ajout de motion : Ouverture d’une LOR Sujet : Avancement du GDT de réforme du règlement Durée totale : 15 mn / Durée par orateur: 3mn", plenary: 2 },
  { key: 'motion_23', label: 'Motion 23', title: 'Présentation du rapport de recommandations de la VPA', plenary: 2 },
  { key: 'motion_24', label: 'Motion 24', title: "Présentation des rapports Post-Délégation de l’équipe RELEX", plenary: 2 },
  { key: 'motion_25', label: 'Motion 25', title: 'clôture de la deuxième plénière', plenary: 2 },

  { key: 'motion_26', label: 'Motion 26', title: 'Ouverture de la deuxième plénière', plenary: 3 },
  { key: 'proc_8', label: 'Motion de procédure 8', title: "Ajout d'une motion: liste des orateurs: recommandations pour LH2YC et LIAYC à propos l'état initiale pour la RH des deux clubs 15 min - 3 min par personne", plenary: 3 },
  { key: 'motion_28', label: 'Motion 28', title: 'Présentation des candidatures aux postes vacants du BEN 25-26', plenary: 3 },
  { key: 'motion_29', label: 'Motion 29', title: 'Présentation des candidatures aux postes vacants du SUPCO 25-27', plenary: 3 },
  { key: 'motion_30', label: 'Motion 30', title: 'Présentation des candidatures aux postes du BEN 26-27', plenary: 3 },
  { key: 'proc_9', label: 'Motion de procédure 9', title: 'ajout d’une motion liste des orateur discussion sur les candidature du postes de BEN 10 min / 3 min par personnes', plenary: 3 },
  { key: 'motion_32', label: 'Motion 32', title: 'Présentation des candidatures aux postes du SUPCO 27-29', plenary: 3 },
  { key: 'motion_33', label: 'Motion 33', title: "Présentation des candidatures aux postes de l'EPN de l'AGOFM 25-26", plenary: 3 },
  { key: 'motion_34', label: 'Motion 34', title: 'clôture de la troisième plénière', plenary: 3 },

  { key: 'motion_35', label: 'Motion 35', title: 'Ouverture de la quatrième plénière', plenary: 4 },
  { key: 'motion_36', label: 'Motion 36', title: "Adoption du PV de l’AGOMM 25-26", plenary: 4 },
  { key: 'motion_37', label: 'Motion 37', title: "Adoption du rapport de fin de mandat de l’EPN précédente", plenary: 4 },
  { key: 'motion_38', label: 'Motion 38', title: 'Vote sur les changements grammaticaux du document de la réglementation', plenary: 4 },
  { key: 'motion_39', label: 'Motion 39', title: 'Vote sur les amendements de Statut', plenary: 4 },
  { key: 'motion_40', label: 'Motion 40', title: "Vote sur les amendements du règlement intérieur de l’association", plenary: 4 },
  { key: 'motion_41', label: 'Motion 41', title: 'Vote sur les amendements du système de mise à jour', plenary: 4 },
  { key: 'motion_42', label: 'Motion 42', title: 'Vote sur les amendements des règlements intérieurs des clubs', plenary: 4 },
  { key: 'motion_43', label: 'Motion 43', title: 'Adoption du rapport de recommandations de la VPA', plenary: 4 },
  { key: 'motion_44', label: 'Motion 44', title: 'Vote sur les candidatures aux postes Vacants du BEN 25-26', plenary: 4 },
  { key: 'motion_45', label: 'Motion 45', title: 'Vote sur les candidatures aux postes vacants du SupCo 25-27', plenary: 4 },
  { key: 'motion_46', label: 'Motion 46', title: 'Vote sur les candidatures au poste du BEN 26-27', plenary: 4 },
  { key: 'motion_47', label: 'Motion 47', title: 'Vote sur les candidatures aux postes vacants du SupCo 27-29', plenary: 4 },
  { key: 'motion_48', label: 'Motion 48', title: "Vote sur les candidatures de l’EPN pour l’AGOFM 25-26", plenary: 4 },
  { key: 'motion_49', label: 'Motion 49', title: 'Adoption du rapport Post-délégation', plenary: 4 },
  { key: 'motion_50', label: 'Motion 50', title: 'Présentation du rapport final du CSCY', plenary: 4 },
  { key: 'motion_51', label: 'Motion 51', title: 'Adoption du rapport final du CSCY', plenary: 4 },
  { key: 'motion_52', label: 'Motion 52', title: "Clôture de l’assemblée générale extraordinaire", plenary: 4 },
];

const AG_PDF_CLUBS = [
  { name: 'Lycée el Hay Sfax YOUTH CLUB', representative: 'N/A', status: 'Club membre', presence: 'absent', vote: 'non_votant' },
  { name: 'Lycée Ennassr YOUTH CLUB', representative: 'N/A', status: 'Club membre', presence: 'absent', vote: 'non_votant' },
  { name: 'Lycée Khairedinne Ariana YOUTH CLUB', representative: 'N/A', status: 'Club membre', presence: 'absent', vote: 'non_votant' },
  { name: 'Lycée Menzah 9 YOUTH CLUB', representative: 'Mariem Khanteche', status: 'Club membre', presence: 'present', vote: 'votant' },
  { name: 'Lycée Mohamed Dachraoui El Menzah 9 YOUTH CLUB', representative: 'N/A', status: 'Club membre', presence: 'absent', vote: 'votant' },
  { name: 'Lycée Pilote Bourguiba de Tunis YOUTH CLUB', representative: 'Rayen Selmi', status: 'Club membre', presence: 'present', vote: 'votant' },
  { name: 'Lycée Pilote Manouba YOUTH CLUB', representative: 'Farah Derrouich', status: 'Club membre', presence: 'present', vote: 'votant' },
  { name: 'Lycée Pilote Sakiet Ezzit YOUTH CLUB', representative: 'Yassine Baklouti', status: 'Club membre', presence: 'present', vote: 'votant' },
  { name: 'Lycée Pilote Sfax YOUTH CLUB', representative: 'N/A', status: 'Club membre', presence: 'absent', vote: 'non_votant' },
  { name: 'Sadiki YOUTH CLUB', representative: 'N/A', status: 'Club membre', presence: 'absent', vote: 'non_votant' },
  { name: 'Lycée Abou Kacem Elchebbi YOUTH CLUB', representative: 'N/A', status: 'Nouveau Club', presence: 'absent', vote: 'non_votant' },
  { name: 'Lycée Chebbi Morneg YOUTH CLUB', representative: 'N/A', status: 'Nouveau Club', presence: 'absent', vote: 'non_votant' },
  { name: 'Lycée Habib Mazoun Sfax YOUTH CLUB', representative: 'N/A', status: 'Nouveau Club', presence: 'absent', vote: 'non_votant' },
  { name: 'Lycée Hrairia 2 YOUTH CLUB', representative: 'Brahim Dallegi', status: 'Nouveau Club', presence: 'present', vote: 'non_votant' },
  { name: 'Lycée ibn abi dhief Manouba YOUTH CLUB', representative: 'Zeineb Aissa', status: 'Nouveau Club', presence: 'present', vote: 'non_votant' },
  { name: 'Lycée Pilote Jendouba YOUTH CLUB', representative: 'N/A', status: 'Nouveau Club', presence: 'absent', vote: 'non_votant' },
  { name: 'Lycée Pilote Neuble YOUTH CLUB', representative: 'N/A', status: 'Nouveau Club', presence: 'absent', vote: 'non_votant' },
  { name: 'Lycée Pilote Ariana YOUTH CLUB', representative: 'N/A', status: 'Nouveau Club', presence: 'absent', vote: 'non_votant' },
  { name: 'Lycée Rue De Pacha YOUTH CLUB', representative: 'N/A', status: 'Nouveau Club', presence: 'absent', vote: 'non_votant' },
];

const AG_BEN_SUPCO = [
  { office: 'Président National', name: 'Mohamed Makni', presence: 'present' },
  { office: 'Secrétaire Générale National', name: 'Vacant', presence: 'vacant' },
  { office: 'Trésorier National', name: 'Mohammed Ayari', presence: 'present' },
  { office: 'VPA', name: 'Nour Barkaoui', presence: 'present' },
  { office: 'VPR', name: 'Vacant', presence: 'vacant' },
  { office: 'VPCOM', name: 'Alia Yamak', presence: 'present' },
  { office: 'SUPCO', name: 'Arwa Jemali', presence: 'absent' },
];

const AG_CONTEXTUALIZATION = {
  state: "Soumis à l’adoption",
  assemblyType: 'Assemblée Générale',
  startDate: '26/07/2025',
  endDate: '26/07/2025',
  location: 'Must University',
  redactors: [
    { name: 'Moemen Arfaoui', club: 'Membre au sein du Lycée Pilote Bourguiba de Tunis YOUTH CLUB' },
    { name: 'Salma Jdidi', club: 'Membre au sein du Lycée Pilote Bourguiba de Tunis YOUTH CLUB' },
    { name: 'Sadok Mehrzi', club: 'Membre au sein du Lycée Pilote Bourguiba de Tunis YOUTH CLUB' },
  ],
  organizers: "Bureau Exécutif National",
};

const AG_SUMMARY = {
  date: '26/07/2025',
  location: 'Must University',
  startTime: '10:35',
  endTime: '17:17',
  plenaryTeam: {
    president: 'Fekih Mariem',
    vicePresident: 'Assil Mhenni',
    secretaries: ['Salma Jdidi', 'Moemen Arfaoui', 'Sadok Mehrzii'],
    cscy: ['Elaa Amri'],
    financialCommittee: 'pas de CF',
  },
};

const AG_PIS = [
  { id: 'pi-1', name: 'Zeineb Aissa', role: 'Responsable LIAYC', note: "Elle se demandait si un membre de CNS a le droit de postuler au BEN ; Yassine Borchani (CNS) : Yassine Borchani a précisé qu’un membre du CNS ne pouvait pas exercer simultanément un mandat au sein du CNS et une fonction au sein du BEN. Il a expliqué que le membre concerné devait d’abord terminer son mandat au sein du CNS avant de commencer un nouveau mandat en tant que membre du BEN", source: 'Responsable LIAYC' },
  { id: 'pi-2', name: 'Kenza Hamzaoui', role: 'Entité des membres nationaux', note: "Elle voulait rappeler en cas de faute dans l’ordre de présentation des motions il faut prendre un accord oral pour clôturer la motion actuelle et passer à la motion procédurale ou la motion raté", source: 'Entité des membres nationaux' },
];

const AG_GROUND_RULES = {
  introduction: '',
  rules: [],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildPlenaries() {
  return [1, 2, 3, 4].map(plenary => ({
    number: plenary,
    title: `Plénière ${plenary}`,
    date: plenary === 1 ? '26/07/2026' : '',
    location: plenary === 1 ? 'Must University' : '',
    startTime: plenary === 1 ? '10:35' : '',
    endTime: plenary === 1 ? '11:46' : '',
    team: plenary === 1 ? {
      president: 'Mariem Fekih',
      vicePresident: 'Assil Mhenni',
      secretaries: ['Moemen Arfaoui', 'Salma Jdidi', 'Sadok Mehrzii'],
      cscy: ['Elaa Amri'],
      financialCommittee: 'pas de CF',
    } : { president: '', vicePresident: '', secretaries: [], cscy: [], financialCommittee: '' },
    agenda: AG_MOTION_CATALOG.filter(m => m.plenary === plenary).map(m => ({
      motionKey: m.key,
      label: m.label,
      title: m.title,
      motionPosition: AG_MOTION_CATALOG.findIndex(x => x.key === m.key),
    })),
  }));
}

function buildMotionDetails() {
  const motions = AG_MOTION_CATALOG.map((motion, index) => ({
    key: motion.key,
    position: index,
    label: motion.label,
    title: motion.title,
    plenary: motion.plenary,
  }));
  Object.assign(motions[0], {
    proposer: 'Bureau Exécutif National',
    seconder: 'LPSEYC',
    amendment: 'Non',
    directNegative: 'Non',
    majority: 'Simple',
    result: 'La motion passe',
    consequence: "L'assemblée générale est ouverte",
    discussion: 'Aucune',
    startsAt: '10:35',
    closesAt: '10:35',
    duration: 'Quelques secondes',
  });
  Object.assign(motions[1], {
    proposer: 'Bureau Exécutif National',
    seconder: 'LPManoubaYC',
    amendment: 'Non',
    directNegative: 'Non',
    majority: 'Simple',
    result: 'La motion passe',
    consequence: "Le point 2.4 du 2eme article du 2eme titre du règlement intérieur de l’association YOUTH CLUBs est suspendu donc Salma Jdidi est valide au poste du secrétaire de l'AG",
    discussion: 'Aucune',
    startsAt: '10:36',
    closesAt: '10:36',
    duration: 'Quelques secondes',
  });
  return motions;
}

function buildAgWorkspace() {
  return {
    contextualization: clone(AG_CONTEXTUALIZATION),
    summary: clone(AG_SUMMARY),
    plenaries: buildPlenaries(),
    clubs: clone(AG_PDF_CLUBS),
    benSupco: clone(AG_BEN_SUPCO),
    seniors: [{ name: 'Yassine Borchani', presence: 'present', voting: 'votant' }],
    trainers: [{ name: 'Eya Hammemi', presence: 'present' }],
    nationalMembers: [{ name: 'Kenza Hamzaoui', presence: 'present', voting: 'votant' }],
    pis: clone(AG_PIS),
    groundRules: clone(AG_GROUND_RULES),
    movements: [],
    representativeChanges: [],
    motionCatalog: buildMotionDetails(),
  };
}

module.exports = {
  AG_MOTION_CATALOG,
  AG_PDF_CLUBS,
  AG_BEN_SUPCO,
  AG_CONTEXTUALIZATION,
  AG_SUMMARY,
  AG_PIS,
  buildAgWorkspace,
};
