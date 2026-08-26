// knowledge-base.js
// The association's reference material, given to the AI on every chat
// request so it can answer questions accurately. This is NOT "training" —
// the AI reads this text fresh each time, the same way a person would
// read a reference document before answering a question. Update this
// file any time the association's info changes; there's no retraining
// step, the very next chat message will reflect the edit.
//
// Source: "Association YOUTH CLUBs — Histoire, Structure, Statut,
// Règlements" (internal reference document).

const KNOWLEDGE_BASE = `
# Association YOUTH CLUBs (AYCs) — Document de référence

## Identité
- Nom officiel : Association YOUTH CLUBs. Abréviation officielle : AssoYCs (aussi écrit AYCs).
- Nom en arabe : جمعية نوادي الشبان.
- Organisation tunisienne à but non lucratif, reconnue par l'État.
- Regroupe des adhérents à des YOUTH CLUBs implantés dans des établissements éducatifs (collèges, lycées, universités).
- Siège officiel : Bureau 1.2, Immeuble Chebil, avenue Farhat Hached, Megrine, Ben Arous, 2033.
- Durée : illimitée.
- Langues de communication interne : arabe, français, anglais. Documentation officielle rédigée en français, traduite en arabe pour l'administration tunisienne, et en arabe/anglais pour l'externe.

## Historique (4 étapes fondatrices)
- 2013 — L'étincelle : un groupe d'élèves du collège Sadiki à Tunis organise une conférence TEDx, puis fonde le "Sadiki YOUTH CLUB", avec pour mission d'améliorer la vie quotidienne au sein du collège.
- 2014–2016 — La propagation : le Lycée Pilote Menzah 8 reproduit l'expérience ; une quinzaine d'autres YOUTH CLUBs voient le jour entre Tunis et Sfax, chacun organisé indépendamment.
- 2017–2019 — La structuration : l'Association YOUTH CLUBs (AYCs) est fondée pour coordonner les clubs, sur les principes de transparence et de démocratie, avec une vision axée sur l'éducation, la culture, le patriotisme et l'ouverture d'esprit.
- 2019–2020 — La stratégie : l'association rédige sa première stratégie annuelle (document bilingue de 97 pages) sur la place des activités extra-scolaires dans le système éducatif tunisien.
- Aujourd'hui — La charte : l'AYCs formalise son Statut et son Document de la Réglementation pour être pleinement opérationnelle à l'échelle nationale et locale.

## Vision
"Au terme de leur scolarité, tous les jeunes de la Tunisie seront outillés pour une vie d'adulte saine, responsable, moderne et équilibrée grâce à une éducation de qualité qui les implique activement."

Cette vision se décompose en 8 idées-clés (Article 5 du Statut) :
- Scolarité visée : secondaire et supérieure.
- Jeunes visés : qu'ils soient scolarisés ou pas.
- Périmètre géographique : Tunisiens et résidents en Tunisie qui s'identifient à cette dernière.
- Sain : bien-être physique, mental et social (définition de l'OMS).
- Responsable : sur les plans économique, social et environnemental (définition du PNUD).
- Moderne : en phase avec son époque.
- Équilibré : cognitivement, existentiellement et moralement enraciné dans son identité, ouvert aux principes universels, communiquant positivement avec son environnement, sans aucun extrémisme.
- Éducation qui implique activement : les jeunes façonnent leur propre éducation en étant orientés.

## Mission
- Bénéficiaires : tous les jeunes de Tunisie supposés inscrits au collège, lycée ou université, scolarisés ou non. Leur éducation implique plusieurs parties prenantes — enseignants, parents, cadres administratifs, société civile, médias — formant avec les jeunes la "communauté éducative".
- Prestations : dans chaque communauté éducative, un groupe de jeunes s'organise en YOUTH CLUB, outillé sur les plans cognitif et matériel, et suivi par l'association.
- Impact recherché (3 niveaux) :
  1. Rendre les apprenants conscients et actifs par rapport à ce qu'ils reçoivent de leurs enseignants (matières, volumes horaires, objectifs, évaluations, méthodes pédagogiques).
  2. Les rendre ouverts à toutes les acquisitions parascolaires structurées (sport, culture, art, santé sexuelle et reproductive, interscolaire, inter-régional).
  3. Les rendre responsables et actifs quant à leur santé (physique, mentale, sociale) et au développement durable (société, économie, environnement).

## Les 5 valeurs communes ("les 5H")
Toutes commencent par la lettre H, un moyen mnémotechnique voulu par l'association :
- Honneur — Gratifie les réussites et la conscience du potentiel propre. Fierté d'appartenir à l'association, fierté d'être tunisien, patriotisme.
- Honnêteté — Transparence et climat de confiance. Les coordinateurs partagent toutes les données non confidentielles au grand public.
- Harmonie — Implique toutes les personnes concernées sans distinction, démocratie dans toutes les actions, répartition équitable des tâches.
- Hardiesse — Travail complet et professionnel avec détermination ; les membres assument leurs responsabilités jusqu'au bout.
- Humilité — Connaître ses imperfections et vouloir toujours apprendre ; consultation d'experts pour être plus efficace, efficiente et pertinente.

## Les 5 axes stratégiques
La stratégie nationale de la Coalition Tunisienne pour l'Apprenant (portée par l'AYCs) se décline en 5 axes :
1. La Scolarité — Assurer l'accès à l'éducation sans discrimination ; réduire l'absentéisme, l'abandon et l'échec scolaire (sous-axes : Scolarisation, Régularité scolaire, Accessibilité scolaire).
2. L'Éducation Formelle — Participer à l'atteinte des objectifs éducatifs de l'établissement, sur le plan quantitatif (couverture des programmes) et qualitatif (méthodes pédagogiques).
3. La Santé (en 4D) — Veiller au bien-être physique, mental, social des apprenants et à leur santé sexuelle et reproductive (4e dimension ajoutée par l'UNFPA en 1994).
4. La Citoyenneté — Pousser les apprenants vers une citoyenneté responsable : économique (lutte contre la fraude, consommation locale), sociale (civisme, valeurs), environnementale (écologie).
5. La Vie Active — Préparer les apprenants à la vie professionnelle, à la vie pratique (autonomie) et aux spécificités communautaires (identité, ancrage local).

Principe clé : chaque projet local doit pouvoir se rattacher à l'un de ces 5 axes.

### Détail des sous-axes
Sous-axe 1.1 Scolarisation : scolariser/rescolariser les enfants en âge de l'être ; parties prenantes : parents, société civile, médias, administration.
Sous-axe 1.2 Régularité scolaire : diminuer l'absentéisme, l'abandon et l'échec ; parties prenantes : apprenants, parents, enseignants, administration.
Sous-axe 1.3 Accessibilité scolaire : accès libre et équitable sans discrimination ; harmoniser les types d'établissements.
Sous-axe 2.1 Aspect quantitatif : assurer que tout le contenu programmé soit délivré.
Sous-axe 2.2 Aspect qualitatif : favoriser l'épanouissement cognitif et culturel par des méthodes pédagogiques adaptées.

### L'axe Santé en 4 dimensions (4D)
Définition (OMS 1946, complétée par l'UNFPA en 1994) : la santé est un état de bien-être physique, mental et social — pas seulement l'absence de maladie — plus la santé sexuelle et reproductive.
3 niveaux de prévention :
- Primaire : éviter la survenue d'un problème avant qu'il ne devienne une menace (ex. vaccination).
- Secondaire : réduire l'importance d'un problème par le dépistage précoce et le traitement.
- Tertiaire : diminuer les complications d'un problème déjà installé (ex. réadaptation).
Bien-être physique : hygiène, nutrition, sommeil, vaccination.
Bien-être mental : stress, anxiété, burn-out, tendances suicidaires.
Bien-être social : fugues, conduite irresponsable, précarité, inégalité.

### La Citoyenneté (3 dimensions)
- Économique : lutter contre la fraude, la corruption, la surconsommation ; favoriser les produits et services locaux.
- Sociale : inculquer les valeurs universelles et nationales, lutter contre la haine et la violence, respecter les différences.
- Environnementale : habitudes écologiques (déchets, transports en commun, économie d'eau et d'électricité).

### La Vie Active (3 dimensions)
- Vie professionnelle : conscience des possibilités et opportunités, orientation vers les secteurs à forte employabilité.
- Vie pratique : autonomie et auto-suffisance (gestion du ménage, finances personnelles, démarches administratives).
- Spécificités communautaires : sens de l'identité et conscience des besoins de sa communauté locale.

## Lexique des sigles et acronymes

### Sigles institutionnels et organes
- AYCs / AssoYCs : Association YOUTH CLUBs.
- BEN : Bureau Exécutif National — pouvoir exécutif national (6 membres).
- BEL : Bureau Exécutif Local — pouvoir exécutif du club (6 membres).
- SupCo National : Conseil de Supervision National — pouvoir judiciaire national.
- SupCo Local / CSL : Conseil de Supervision Local — pouvoir judiciaire du club.
- CNS : Conseil National des Seniors — anciens responsables nationaux, rôle consultatif.
- CLS : Conseil Local des Seniors — anciens membres/responsables du club, rôle consultatif.
- CSCY : Conseil de Sauvegarde de la Constitution Youth — 3 conseillers juridiques garants du règlement pendant les assemblées.
- GDT : Groupe De Travail — équipe temporaire pour une tâche spécifique.
- RR : Responsable(s) Régional(aux) — relais du BEN à l'échelle régionale.

### Postes nationaux
- VPA : Vice-Président chargé des Adhérents — recrutement, formation, bien-être, TYT, RH.
- VPR : Vice-Président chargé des Relations Externes — partenariats, délégations, ministères, sponsoring.
- VPCom : Vice-Président chargé de la Communication — stratégie de communication, design, audiovisuel, réseaux sociaux, site web.

### Postes locaux
- VPI : Vice-Président chargé des affaires Internes — équivalent local du VPA.
- VPE : Vice-Président chargé des affaires Externes — équivalent local du VPR.
- VPC : Vice-Président chargé de la Communication — équivalent local du VPCom.

### Assemblées et processus
- AG : Assemblée Générale — pouvoir législatif suprême, échelle nationale.
- AL : Assemblée Locale — pouvoir législatif du club.
- AGOMM : Assemblée Générale Ordinaire de Mi-Mandat — vers mars ; élections du BEN et du SupCo National.
- AGOFM : Assemblée Générale Ordinaire de Fin de Mandat — vers septembre ; rapports de mise au point, tactique annuelle.
- ALOFM : Assemblée Locale Ordinaire de Fin de Mandat — suit l'AGOFM ; rapports locaux, plan d'action annuel du club.
- ALOE : Assemblée Locale Ordinaire Élective — élections locales, juin-juillet.
- ALE : Assemblée Locale Extraordinaire — convoquée en cas de besoin urgent.
- TYT : (Formation de formateurs) — programme certifiant les "Yathyouth Trainers", formateurs homologués.

### Autres termes
- ANVI : étude utilisée avant une délégation ou un partenariat pour analyser le besoin et l'opportunité.
- ODD : Objectifs de Développement Durable (agenda ONU 2015-2030).
- OSC / OG : Organisations de la Société Civile / Organisations Gouvernementales.
- SSR : Santé Sexuelle et Reproductive.
- ESI : Éducation Sexuelle Intégrée.
- PV : Procès-Verbal.

## Le Statut (loi suprême)
Le Statut est la loi suprême de l'AYCs. Le document de la réglementation a 4 parties, par ordre d'importance :
1. Le Statut (jamais suspendable dans ses 12 points fondateurs).
2. Le Règlement intérieur (gestion nationale).
3. Le Règlement des Clubs (gestion locale).
4. L'Annexe du système de mise à jour (procédures et deadlines).

Amendements : décidés par l'AG, proposés par le BEN, le SupCo, ou au moins deux clubs, votés à la majorité des 2/3. Les amendements du Statut nécessitent un avis d'avocat présenté à l'AG et un vote à main levée.

Nature de l'association : organisation à but non lucratif, reconnue par l'État tunisien, regroupant des adhérents à des YOUTH CLUBs implantés dans leurs établissements éducatifs.

### Les Clubs et leurs adhérents
Un club a le statut de "nouveau club" ou "club membre". Sa durée est illimitée tant qu'il n'est pas dissous. Tout club est soumis au règlement de son établissement, à la loi tunisienne et au document de la réglementation. Un club ne peut être créé que sous l'égide d'une institution apolitique et non religieuse.

Statuts possibles d'un adhérent :
- Nouveau Adhérent : n'a pas encore terminé sa période d'essai après recrutement.
- Adhérent (Membre) : a validé sa période d'essai, bénéficie du droit de vote au sein de son club.
- Responsable : élu à un poste national ou local, droit de vote aux assemblées sauf exceptions.
- Senior (CNS/CLS) : a occupé un poste, continue d'accompagner en conseil sans responsabilité opérationnelle.
- Membre National : n'appartient plus à un club (dissous) mais reste rattaché à l'association, sur demande adoptée par l'AG.
- Ancien : statut pris à la fin d'un mandat si l'adhérent quitte l'association sans démission ni exclusion.

Règles importantes : un responsable ne peut occuper deux responsabilités simultanément ; un adhérent ne peut pas cumuler deux statuts locaux (ou nationaux) à la fois ; tout membre d'un club doit obligatoirement appartenir à l'établissement dont le club porte le nom.

### Les trois pouvoirs de l'Association
- Législatif : les adhérents l'exercent indirectement via les clubs à l'AG, et directement à l'AL. L'AG est la première instance et le plus grand organe décisionnel.
- Exécutif : exercé par le BEN à l'échelle nationale, représenté par le BEL à l'échelle du club.
- Judiciaire (Supervision) : exercé par le Conseil de Supervision (national et local), pouvoir indépendant chargé de superviser, investiguer et garantir la justice interne.

### Finances
- Revenus : cotisations, contributions publiques, sponsoring, dons, usage du nom de l'association, biens/activités/projets, bailleurs de fonds.
- La cotisation nationale est fixée chaque mandat par le Trésorier National avec l'accord du BEN.
- Le Trésorier National présente un bilan de mise à jour national à chaque AGO, signé par tout le BEN.
- Le BEN est démis de sa responsabilité financière seulement si les finances respectent la loi tunisienne et que le bilan est adopté par l'AG.

### Dissolution de l'Association
Nécessite un vote à la majorité des 3/4 de tous les clubs membres (votants ou non), avec une proposition envoyée 6 mois avant l'AG concernée. Les biens restants sont distribués selon les objectifs de l'association à une institution de bénéfice général.

## Structure et pouvoirs

### Le Bureau Exécutif National (BEN)
Composé de 6 membres, élus par l'AG pour un mandat du 1er septembre au 31 août suivant. Une personne ne peut tenir le même poste plus de deux fois.
- Président National : stratégie, tactique annuelle, coordination du BEN, représentation officielle, coordination des Coordinateurs Stratégiques Régionaux.
- Secrétaire Général National : PV, archives, documents officiels, mise à jour du règlement, communication interne, base de données des adhérents.
- Trésorier National : administration financière, comptabilité, bilans, cotisations, budget, registre des dons/dettes/créances.
- VPA : recrutement des clubs, bien-être des adhérents, TYT, plan de formation annuel, cycle RH.
- VPR : représentation externe, délégations, partenariats, sponsoring, conventions ministérielles.
- VPCom : stratégie de communication, plateformes digitales, communication de masse, identité visuelle, création de contenu.

### Le Bureau Exécutif Local (BEL)
Composé de 6 membres, miroir local du BEN :
- Président Local : application du plan d'action annuel, planification des opérations locales, représentation du club envers le CLS et le Coordinateur Stratégique Régional.
- Secrétaire Général Local : PV, archives locales, documents officiels, coordination des rapports, liste des adhérents à jour.
- Trésorier Local : dépositaire des fonds du club, comptabilité, études budgétaires, justificatifs, bilans mensuels/annuels.
- VPI : recrutement, bien-être des adhérents, identification des besoins, communication avec les formateurs, relations inter-YOUTHs.
- VPE : représentation du club à l'externe, délégations locales, projets, partenariats, sponsoring.
- VPC : stratégie de communication du club, réseaux sociaux, création de contenu.

Chaque responsable local soumet un rapport de mise à jour à l'ALOFM. Si adopté, il est démis de toute responsabilité et reconnu comme ayant occupé le poste ; sinon, une investigation est ouverte par le SupCo Local.

### Le pouvoir Judiciaire : Conseil de Supervision
National : 6 membres (jamais moins de 3). Local : 3 membres. Pouvoir indépendant, tenu à la neutralité et à l'intégrité, s'exprime comme une seule entité.
Missions : suivi du BEN/BEL, investigation, suspension temporaire de membres en cas d'infraction, encadrement, mémoire institutionnelle. Toute décision de suspension doit être approuvée par l'Assemblée suivante à la majorité des 2/3.
Catégories de problèmes traités en investigation : manque de communication, problème personnel (conflit hors cadre), dépassement du règlement, dépassement de la loi tunisienne (traité strictement par le SupCo National).

### Le Conseil des Seniors (CNS/CLS)
Rôle consultatif, non contraignant : encadrer et conseiller le Bureau Exécutif. Les seniors n'ont pas le droit de vote au sein du club/BEN (l'ensemble du conseil des seniors ne dispose que d'un seul vote à l'AG). Un membre du CNS/CLS ne peut exercer une responsabilité que s'il renonce à son statut de senior.

## Règlement intérieur

### Les 7 domaines d'intervention
Coordination Stratégique ; Secrétariat ; Trésorerie ; Ressources Humaines ; Relations Externes ; Communication Médiatique ; Supervision.
Organisés sur deux échelles : nationale (BEN + Responsables Régionaux) et locale (BEL). La Supervision est représentée par le SupCo National et les SupCo Locaux.

### Formations requises par poste
- Président (local/national) : Coordination stratégique (COSTRA).
- VPI / VPA : Ressources humaines (RH).
- VPE / VPR : Relations externes (RELEX).
- VPC / VPCom : Communication médiatique (COM).
- Secrétaire (local/national) : Secrétariat.
- Trésorier (local/national) : Trésorerie.

### Critères pour les postes nationaux/régionaux
- Appartenir à un YOUTH CLUB ayant le statut de club membre.
- Avoir le statut de membre du CLS dans son club au début du mandat.
- Être résident en Tunisie.
- Avoir assisté à au moins une AG (pour le BEN ou le SupCo National).
- Être majeur pour les postes de Président National, Secrétaire Général National et Trésorier National.
- Pour le SupCo National : avoir fait partie du BEN ou occupé un poste régional.

### Réunions (types et fréquences)
- Réunion ordinaire du BEN/du club : selon le besoin (BEN) ou au moins 1x/mois (club/BEL) ; compte-rendu obligatoire ; tous les adhérents peuvent y assister.
- Réunion extraordinaire du BEN/BEL : à tout moment, mais annoncée au SupCo au moment de la décision.
- Réunion d'équipe (nationale) : un membre du BEN avec ses responsables régionaux, au moins 1x/mois.
- Réunion ordinaire du BEL (local) : au moins 1x/mois, annoncée 24h avant avec ordre du jour.

Interdiction stricte : consommer de l'alcool, du tabac ou toute substance illicite durant une réunion ou tout rassemblement officiel de l'association ou de ses clubs.

### Communication médiatique
Toute activité doit être médiatisée en 3 temps : pré-activité, durant l'activité, post-activité. Un plan médiatique est rédigé avant chaque activité, un bilan médiatique après. Le contenu doit être conforme à l'identité, aux travaux, aux objectifs et aux valeurs de l'association. Deux grands canaux : communication digitale (site web, réseaux sociaux) et communication de masse (TV, radio, papeterie).

## Le Club local

### Structure locale
Chaque YOUTH CLUB dispose d'un BEL (6 membres) et d'un SupCo Local (3 membres).

### Adhésion des nouveaux membres (3 voies)
- Recrutement : appel public ouvert à toute personne inscrite à l'établissement, en début de mandat. Passe par 3 Assemblées Locales : établissement des critères (ALOFM), validation du travail des recruteurs (Assemblée d'Adhésion), validation des nouveaux membres (Assemblée de Validation).
- Parrainage : cible des personnes spécifiques recommandées par des adhérents. Le parrain soumet une demande à l'AL ; si acceptée à la majorité des 3/4, une période d'essai commence.
- Transfert : un membre qui change d'établissement peut transférer vers le YOUTH CLUB de son nouvel établissement (ne peut pas être refusé par le club visé).

### Les 4 Assemblées Locales Ordinaires obligatoires
- ALOFM (Fin de Mandat) — suit l'AGOFM.
- AL Ordinaire d'Adhésion des Nouveaux adhérents — fin du 1er recrutement.
- AL Ordinaire de Validation des Nouveaux adhérents — fin de la période d'essai.
- ALOE (Élective) — juin-juillet, élections du BEL et du SupCo Local.
Quorum minimum requis pour toute AL : 1/3 des membres (point non suspendable).

### Dissolution d'un club
Un club peut être dissous : (1) sur sa propre décision, votée à 3/4 des adhérents votants lors d'une AL de dissolution en présence du VPA, du Coordinateur Stratégique Régional, d'un membre du SupCo National, d'au moins un autre membre du BEN et de 2 assistants régionaux ; (2) si en AG, 2/3 des clubs membres votants votent la dissolution suite à une investigation du SupCo National ; (3) si l'établissement en décide ainsi, suite à un dépassement de son propre règlement.
À la dissolution, les adhérents perdent tous leurs statuts (sauf les anciens, qui gardent le leur). Ils peuvent réintégrer l'association selon la procédure normale d'adhésion.

### Les Anciens et le Conseil Local des Seniors (CLS)
Le CLS regroupe les adhérents ayant eu le statut de membre/responsable pendant au moins un an, admis en ALOFM. Un "Ancien" est un titre attribué après au moins un mandat complet ; il ne bénéficie pas automatiquement des privilèges de l'association et est considéré comme un externe. Un adhérent exclu ou démissionnaire ne peut pas acquérir le statut d'ancien.

## Assemblées Générales et Locales

### Agenda minimal d'une Assemblée Générale
L'AG contient au minimum 3 plénières. Les 5 premières motions (d'une AL ou d'une AG) sont toujours, dans l'ordre : présentation du rapport préliminaire du CSCY, adoption du rapport préliminaire du CSCY, présentation de l'agenda, adoption de l'agenda, adoption du PV de la dernière Assemblée.
Les 3 dernières motions sont toujours : présentation du rapport final du CSCY, adoption du rapport final du CSCY, clôture de l'Assemblée.

### Les majorités
- Majorité simple : plus de votes pour que contre ; abstentions non comptées.
- Majorité absolue : plus de la moitié de tous les votes pour ; abstentions comptées.
- Majorité relative : la proposition avec le plus de votes pour l'emporte (utile s'il y a plusieurs propositions concurrentes).
- Majorité des 2/3 : le nombre de votes pour doit être au moins le double des votes contre.
Tous les postes officiels (national ou local) sont élus à la majorité absolue. En cas d'égalité au deuxième tour, un troisième round de discussion de 15 minutes précède un nouveau vote ; si l'égalité persiste, personne n'est élu.

### Motions, points d'ordre, points d'information
- Motion procédurale : a préséance sur les autres termes d'adresse (sauf le point d'ordre) ; votée à la majorité des 2/3 en cas de direct négatif.
- Point d'ordre : porte sur l'application du règlement, doit citer un document officiel crédible. Trois avertissements dans une même Assemblée = perte du droit pour le reste de l'Assemblée.
- Point d'information : bref fait pertinent, jamais un avis personnel. Même règle des 3 avertissements.

### Le rôle du CSCY (Conseil de Sauvegarde de la Constitution Youth)
Composé de 3 conseillers juridiques. Attribue les droits de vote, valide les rapports et candidatures, refuse les motions non conformes, tranche les désaccords d'interprétation, présente un rapport préliminaire (début) et un rapport final (fin) à chaque Assemblée.

## Le système de mise à jour
Le "Système de mise à jour" (annexe du règlement) définit, pour chaque type de rapport : son nom, qui le rédige, qui le reçoit, qui le valide, sa structure imposée, et sa deadline. Il garantit que l'information circule de façon fiable entre le BEL, les Responsables Régionaux, le BEN et le SupCo.

### Exemples de rapports clés pour un Président Local
- Rapport pré-projet local : 7 jours avant le premier engagement externe (invitation, communication, transaction). Rédigé par le Président avec tout le BEL.
- Rapport post-projet local : 10 jours après la fin du projet.
- Plan d'action annuel du club : 7 jours après l'élection du nouveau BEL ; validé par le BEN avant l'AGOFM.
- Rapport de mise à jour (avancement stratégique) : 15 jours avant la première plénière de chaque AG.
- Liste des adhérents du club : le 1er décembre (dernier délai pour l'Assemblée Locale d'adhésion : 30 novembre).
- Bilan financier de mise à jour local : 15 jours avant la première plénière de chaque AG.

### Perte du statut de "club membre"
Le VPA peut demander une investigation si un club ne respecte pas, pendant deux AG consécutives, l'une de ces obligations : rapport d'activité envoyé dans les délais, cotisations annuelles payées dans les délais, liste des membres envoyée dans les délais. Perdre ce statut expose le club à quitter l'association.

## La Stratégie de la Coalition Tunisienne pour l'Apprenant (Octobre 2024)

### Contexte et justificatifs
L'éducation tunisienne reste, dans les faits, un processus vertical où les apprenants reçoivent passivement l'enseignement, avec un taux d'abandon accepté, un corps enseignant confronté à des difficultés matérielles, et une infrastructure qui se détériore. Résultat : une employabilité faible qui pousse les familles vers des solutions à deux vitesses (écoles privées, soutien scolaire).

Indicateurs cités (2020-2021) : plus de 100 000 élèves quittent l'école chaque année en Tunisie (1 million depuis la révolution) ; environ 30% des décrocheurs ne bénéficient d'aucune "deuxième chance" ; la Tunisie se classe au 1er rang des pays arabes en matière de divorce ; le taux de licenciés sportifs jeunes est d'environ 3%, contre 25% en moyenne en Europe.

### Conclusion de la stratégie
"Il s'agit de rendre à l'ÉDUCATION le rôle qui est le sien de prodiguer à l'apprenant les Connaissances - Attitudes - et - Pratiques de manière tempestive et moderne, afin que le jeune adulte qu'il deviendra saura faire les bons choix pour sa vie, balisé par les valeurs humaines."
`.trim();

module.exports = { KNOWLEDGE_BASE };
