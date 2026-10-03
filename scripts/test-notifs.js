// Apercu du texte envoye a l'autre occupant quand une tache est validee,
// et verification que la main passe bien.
import { db, saveNow } from "../server/store.js";
import { declareDone, nextAssignee } from "../server/engine.js";
import { TASKS_BY_ID } from "../shared/tasks.js";

Object.assign(db, {
  instances: [],
  history: [],
  subscriptions: [],
  lastSpawn: {},
  nextDue: {},
  lastDoneBy: {},
  lastReminder: {},
});

// Meme calcul que dans engine.js, reproduit ici pour inspecter le rendu.
const relativeDay = (date, from) => {
  const d = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()) -
      new Date(from.getFullYear(), from.getMonth(), from.getDate())) / 864e5,
  );
  if (d <= 0) return "aujourd'hui";
  if (d === 1) return "demain";
  if (d < 7) return date.toLocaleDateString("fr-FR", { weekday: "long" });
  const court = date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  return `le ${court.replace(/\.$/, "")}`;
};

console.log("Formulation selon l'echeance :");
const from = new Date(2026, 9, 3, 14, 40);
for (const offset of [0, 1, 2, 3, 6, 9]) {
  const cible = new Date(2026, 9, 3 + offset, 19, 0);
  console.log(`  "Jerome a fait : Litiere. A toi ${relativeDay(cible, from)}."`);
}

console.log("\nEnchainement reel des tours :");
let now = from;
for (let i = 0; i < 4; i++) {
  const qui = nextAssignee(TASKS_BY_ID.litiere);
  const res = declareDone("litiere", qui, now);
  if (res.error) {
    console.log(`  refus : ${res.error}`);
    break;
  }
  const next = new Date(db.nextDue.litiere);
  console.log(
    `  ${qui.padEnd(8)} valide -> notification a l'autre : "A toi ${relativeDay(next, now)}."`,
  );
  now = next;
}

console.log("\nTentative de double validation par le meme :");
const qui = nextAssignee(TASKS_BY_ID.litiere);
const intrus = qui === "jerome" ? "laurine" : "jerome";
console.log(`  ${intrus} essaie alors que c'est au tour de ${qui} :`);
console.log(`    -> ${declareDone("litiere", intrus, now).error}`);

Object.assign(db, { instances: [], history: [], lastSpawn: {}, nextDue: {}, lastDoneBy: {} });
saveNow();
