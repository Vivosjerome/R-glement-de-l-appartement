// Le declencheur d'une minute est la seule partie qui tourne sans que
// personne ne regarde : s'il se trompe, rien ne le signale. Ces verifications
// l'exercent a des heures precises, avec un magasin en memoire.

import { tick } from "../worker/engine.js";
import { buildConfig } from "../worker/config.js";

class FauxMagasin {
  constructor(valeurs = {}) {
    this.values = valeurs;
    this.rows = [];
  }
  get(k, f) {
    return this.values[k] ?? f;
  }
  set(k, v) {
    this.values[k] = v;
  }
  setIn(k, champ, v) {
    this.values[k] = { ...(this.values[k] || {}), [champ]: v };
  }
  async openFor(id) {
    return this.rows.find((r) => r.defId === id) || null;
  }
  async addInstance(i) {
    this.rows.push(i);
  }
  async instances() {
    return this.rows;
  }
  async subscriptions() {
    return [];
  }
  async removeSubscriptions() {}
}

const config = buildConfig({});
const contexte = (valeurs) => ({ config, store: new FauxMagasin(valeurs), env: {} });

let echecs = 0;
function verifie(nom, condition, detail = "") {
  console.log(`${condition ? "  ok  " : " ECHEC"}  ${nom}${detail ? `  -> ${detail}` : ""}`);
  if (!condition) echecs++;
}

const creees = (ctx) => ctx.store.rows.map((r) => r.defId).sort().join(", ") || "aucune";

// Samedi 3 octobre 2026, 15 h 30 a Paris. Le menage est cale sur samedi (10 h),
// l'aspirateur rappelle a 11 h, l'activite a 12 h : les trois sont dues.
console.log("\n--- Samedi apres-midi, rien n'a jamais ete fait ---");
const apresMidi = new Date("2026-10-03T13:30:00Z");
const c1 = contexte({});
await tick(c1, apresMidi);
verifie("Menage du samedi cree", c1.store.rows.some((r) => r.defId === "menage"), creees(c1));
verifie("Aspirateur cree", c1.store.rows.some((r) => r.defId === "aspirateur"));
verifie("Activite creee", c1.store.rows.some((r) => r.defId === "activite"));
verifie("Litiere pas encore (19 h)", !c1.store.rows.some((r) => r.defId === "litiere"));

console.log("\n--- Le tick suivant ne doit rien dupliquer ---");
await tick(c1, new Date("2026-10-03T13:31:00Z"));
verifie("Toujours trois taches", c1.store.rows.length === 3, `${c1.store.rows.length}`);

console.log("\n--- Tot le matin, rien n'est encore du ---");
const c2 = contexte({});
await tick(c2, new Date("2026-10-03T05:00:00Z")); // 7 h a Paris
verifie("Aucune tache a 7 h", c2.store.rows.length === 0, creees(c2));

console.log("\n--- Le soir, la litiere apparait ---");
const c3 = contexte({});
await tick(c3, new Date("2026-10-03T17:30:00Z")); // 19 h 30 a Paris
verifie("Litiere creee a 19 h 30", c3.store.rows.some((r) => r.defId === "litiere"), creees(c3));

console.log("\n--- Une echeance future retient la tache ---");
const c4 = contexte({ nextDue: { aspirateur: "2026-10-06T09:00:00.000Z" } });
await tick(c4, apresMidi);
verifie("Aspirateur attend son tour", !c4.store.rows.some((r) => r.defId === "aspirateur"), creees(c4));

console.log("\n--- Le menage ne revient pas deux fois le meme jour ---");
const c5 = contexte({ lastSpawn: { menage: "2026-10-03T08:00:00.000Z" } });
await tick(c5, apresMidi);
verifie("Menage deja sorti aujourd'hui", !c5.store.rows.some((r) => r.defId === "menage"), creees(c5));

console.log("\n--- Mais il revient le samedi suivant ---");
const c6 = contexte({ lastSpawn: { menage: "2026-09-26T08:00:00.000Z" } });
await tick(c6, apresMidi);
verifie("Menage de la nouvelle semaine", c6.store.rows.some((r) => r.defId === "menage"), creees(c6));

console.log("\n--- A qui revient chaque tache ---");
const menage = c1.store.rows.find((r) => r.defId === "menage");
verifie("Le menage est pour les deux", menage?.assignee === "both", menage?.assignee);
const aspi = c1.store.rows.find((r) => r.defId === "aspirateur");
verifie("L'aspirateur revient a quelqu'un", ["jerome", "laurine"].includes(aspi?.assignee), aspi?.assignee);
const c7 = contexte({ lastDoneBy: { aspirateur: "jerome" } });
await tick(c7, apresMidi);
verifie(
  "Apres Jerome, c'est a Laurine",
  c7.store.rows.find((r) => r.defId === "aspirateur")?.assignee === "laurine",
  c7.store.rows.find((r) => r.defId === "aspirateur")?.assignee,
);

console.log(echecs === 0 ? "\nDECLENCHEUR : CONFORME\n" : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
