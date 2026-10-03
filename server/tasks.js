// Traduction du reglement en taches.
//
// Toutes les regles ne donnent pas une tache : celles qui se font dans la
// foulee (la vaisselle juste apres avoir cuisine, ranger ses affaires) n'ont
// pas besoin d'etre suivies, elles restent affichees dans l'onglet Regles.
//
// schedule :
//   { type: "interval", days: N }   -> revient N jours apres la derniere fois
//   { type: "weekday", setting: X } -> un jour fixe de la semaine
//   { type: "trigger" }             -> cree par un bouton dans l'app
//   { type: "chained" }             -> cree par l'achevement d'une autre tache
//
// assign :
//   rotation -> passe a l'autre a chaque fois
//   together -> les deux, n'importe qui peut valider
//   actor    -> celui qui a appuye sur le bouton
//   other    -> l'autre que celui qui a appuye

export const REGLEMENT = [
  "Celui qui cuisine nettoie ses ustensiles. L'autre nettoie la vaisselle.",
  "Des que le linge est sec il doit etre rentre et range immediatement.",
  "L'aspirateur doit etre passe deux fois par semaine puis vide. La poussiere doit etre faite au moins une fois par semaine.",
  "Chaque semaine un jour sera choisi pour le menage complet.",
  "La litiere doit etre verifiee et nettoyee tous les deux jours.",
  "La poubelle doit etre descendue a chaque fois qu'elle est devant la porte.",
  "Une fois par semaine activites ensemble (payante ou non payante).",
  "Pas d'accumulation de linge dans la paniere.",
  "Lorsque la machine est lancee et finie le linge doit etre etendu en suivant.",
  "Lors du menage complet verification du frigo et nettoyage si necessaire.",
  "Ne pas laisser trainer ses affaires.",
];

export const DEVISE = "Aucune excuse ne sera valable.";

// Heure du rappel groupe du soir pour ce qui reste a faire.
export const RAPPEL_SOIR = 20;

export const TASKS = [
  {
    id: "litiere",
    label: "Litiere",
    emoji: "\u{1F408}",
    detail: "Verifier et nettoyer",
    rule: REGLEMENT[4],
    schedule: { type: "interval", days: 2 },
    assign: "rotation",
    remindAt: 19,
    // Declarable a tout moment : faire la litiere a 14 h relance aussitot
    // le compte a rebours de 2 jours au nom de l'autre.
    declare: "J'ai fait la litiere",
  },
  {
    id: "aspirateur",
    label: "Aspirateur + vider",
    emoji: "\u{1F9F9}",
    detail: "Passer l'aspirateur puis vider le bac",
    rule: REGLEMENT[2],
    schedule: { type: "interval", days: 3 },
    assign: "rotation",
    remindAt: 11,
    declare: "J'ai passe l'aspirateur",
  },
  {
    id: "menage",
    label: "Menage complet + frigo",
    emoji: "\u{1F9FD}",
    detail: "Le grand menage, frigo compris",
    rule: `${REGLEMENT[3]} ${REGLEMENT[9]}`,
    schedule: { type: "weekday", setting: "menageDay" },
    assign: "together",
    remindAt: 10,
  },
  {
    id: "activite",
    label: "Activite ensemble",
    emoji: "\u{2764}",
    detail: "Payante ou non payante",
    rule: REGLEMENT[6],
    schedule: { type: "interval", days: 7 },
    assign: "together",
    remindAt: 12,
  },

  // --------------------------------------------------------------- boutons
  {
    id: "etendre",
    label: "Etendre le linge",
    emoji: "\u{1F455}",
    rule: REGLEMENT[8],
    schedule: { type: "trigger", delaySetting: "machineMinutes" },
    trigger: { label: "Machine lancee", emoji: "\u{1F300}" },
    assign: "actor",
    chainsTo: "rentrer",
  },
  {
    id: "rentrer",
    label: "Rentrer et ranger le linge",
    emoji: "\u{1F9FA}",
    rule: REGLEMENT[1],
    schedule: { type: "chained", delaySettingHours: "lingeSecHours" },
    assign: "actor",
  },
  {
    id: "poubelle",
    label: "Descendre la poubelle",
    emoji: "\u{1F5D1}",
    rule: REGLEMENT[5],
    schedule: { type: "trigger", delayMinutes: 90 },
    trigger: { label: "Poubelle devant la porte", emoji: "\u{1F6AA}" },
    // Signaler la poubelle ne la refile a personne : c'est juste a faire,
    // par l'un ou par l'autre.
    assign: "together",
  },
];

export const TASKS_BY_ID = Object.fromEntries(TASKS.map((t) => [t.id, t]));
export const TRIGGERS = TASKS.filter((t) => t.schedule.type === "trigger");
export const DECLARABLE = TASKS.filter((t) => t.declare);
export const PLANNED = TASKS.filter(
  (t) => t.schedule.type === "interval" || t.schedule.type === "weekday",
);
