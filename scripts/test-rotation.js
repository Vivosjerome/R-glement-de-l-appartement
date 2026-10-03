// Verifie que la rotation part bien de la derniere realisation :
// Jerome fait la litiere -> elle revient a Laurine 2 jours plus tard, etc.
import { db, saveNow } from "../server/store.js";
import { tick, completeInstance, nextOccurrence } from "../server/engine.js";
import { TASKS_BY_ID } from "../server/tasks.js";

Object.assign(db, {
  instances: [],
  history: [],
  subscriptions: [],
  lastSpawn: {},
  nextDue: {},
  lastDoneBy: {},
  lastReminder: {},
});

const MINUTE = 60000;
const litiere = TASKS_BY_ID.litiere;
let now = new Date(2026, 9, 3, 19, 0); // samedi 3 octobre, 19 h

const fr = (d) => d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "short" });

for (let cycle = 1; cycle <= 5; cycle++) {
  await tick(now);

  const inst = db.instances.find((i) => i.defId === "litiere");
  if (!inst) {
    console.log(`  ${fr(now)} : rien a faire`);
    now = new Date(now.getTime() + 864e5);
    cycle--;
    continue;
  }

  console.log(`  ${fr(now)} -> pour ${inst.assignee.padEnd(8)} (${inst.kind})`);
  completeInstance(inst.id, inst.assignee, now);

  const next = nextOccurrence(litiere, now);
  console.log(`     fait, prochaine fois le ${fr(next)}\n`);
  now = new Date(next.getTime() + MINUTE);
}

console.log("Rythme hebdomadaire du menage (jour fixe) :");
db.settings.menageDay = 6;
console.log(`  prochaine occurrence : ${fr(nextOccurrence(TASKS_BY_ID.menage, new Date(2026, 9, 3, 12)))}`);

Object.assign(db, { instances: [], history: [], lastSpawn: {}, nextDue: {}, lastDoneBy: {} });
saveNow();
