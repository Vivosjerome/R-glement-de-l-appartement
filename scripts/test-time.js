// Le Worker tourne en UTC. Ces verifications s'assurent que "19 h" veut bien
// dire 19 h a l'appartement, y compris de part et d'autre du changement
// d'heure de fin octobre.

import { local, atLocalHour, addDaysAtHour, nextWeekday } from "../worker/time.js";

const TZ = "Europe/Paris";
let echecs = 0;

const heureParis = (date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    dateStyle: "short",
    timeStyle: "short",
    hourCycle: "h23",
  }).format(date);

function verifie(nom, condition, detail = "") {
  console.log(`${condition ? "  ok  " : " ECHEC"}  ${nom}${detail ? `  -> ${detail}` : ""}`);
  if (!condition) echecs++;
}

console.log("\n--- Lecture de l'heure locale ---");
// 2026-07-15 23:30 UTC = 2026-07-16 01:30 a Paris : jour different d'UTC.
const nuitEte = new Date("2026-07-15T23:30:00Z");
const p1 = local(nuitEte, TZ);
verifie("Jour local correct la nuit", p1.dayKey === "2026-07-16", p1.dayKey);
verifie("Heure locale correcte", p1.hour === 1, `${p1.hour} h`);
verifie("Jour de la semaine", p1.weekday === 4, `${p1.weekday} (jeudi attendu)`);

// Minuit pile : certains environnements rendent "24" au lieu de "00".
const minuit = new Date("2026-07-15T22:00:00Z");
verifie("Minuit vaut 0 et non 24", local(minuit, TZ).hour === 0, `${local(minuit, TZ).hour}`);

console.log("\n--- Heure d'ete ---");
const ete = atLocalHour({ year: 2026, month: 7, day: 10 }, 19, TZ);
verifie("19 h en juillet", heureParis(ete).endsWith("19:00"), heureParis(ete));
verifie("Soit 17 h UTC", ete.toISOString() === "2026-07-10T17:00:00.000Z", ete.toISOString());

console.log("\n--- Heure d'hiver ---");
const hiver = atLocalHour({ year: 2026, month: 12, day: 10 }, 19, TZ);
verifie("19 h en decembre", heureParis(hiver).endsWith("19:00"), heureParis(hiver));
verifie("Soit 18 h UTC", hiver.toISOString() === "2026-12-10T18:00:00.000Z", hiver.toISOString());

console.log("\n--- Passage a l'heure d'hiver (25 octobre 2026) ---");
// Litiere faite le 24 au soir : l'echeance a deux jours tombe apres le
// changement d'heure. Elle doit rester a 19 h locales, pas glisser a 18 h.
const avant = new Date("2026-10-24T17:00:00Z"); // 19 h a Paris
const deuxJours = addDaysAtHour(avant, 2, 19, TZ);
verifie("Toujours 19 h apres le changement", heureParis(deuxJours).endsWith("19:00"), heureParis(deuxJours));
verifie("Date du 26 octobre", heureParis(deuxJours).startsWith("26/10/2026"), heureParis(deuxJours));
const ecart = (deuxJours - avant) / 3600e3;
verifie("L'ecart reel fait 49 h, pas 48", Math.round(ecart) === 49, `${ecart} h`);

console.log("\n--- Prochain jour de la semaine ---");
// Jeudi 1er octobre 2026, 10 h locales. Le menage est cale sur samedi (6).
const jeudi = new Date("2026-10-01T08:00:00Z");
const samedi = nextWeekday(jeudi, 6, 10, TZ);
verifie("Samedi suivant trouve", heureParis(samedi).startsWith("03/10/2026"), heureParis(samedi));
verifie("A 10 h locales", heureParis(samedi).endsWith("10:00"), heureParis(samedi));

// Samedi 10 h 30 : l'heure du menage est passee, on vise samedi prochain.
const samediTard = new Date("2026-10-03T08:30:00Z");
const suivant = nextWeekday(samediTard, 6, 10, TZ);
verifie("Si l'heure est passee, on saute d'une semaine", heureParis(suivant).startsWith("10/10/2026"), heureParis(suivant));

// Samedi 9 h : c'est encore pour aujourd'hui.
const samediTot = new Date("2026-10-03T07:00:00Z");
const aujourdhui = nextWeekday(samediTot, 6, 10, TZ);
verifie("Si l'heure n'est pas passee, c'est aujourd'hui", heureParis(aujourdhui).startsWith("03/10/2026"), heureParis(aujourdhui));

console.log("\n--- Changement de mois et d'annee ---");
const saintSylvestre = new Date("2026-12-30T18:00:00Z"); // 19 h a Paris
const apresNouvelAn = addDaysAtHour(saintSylvestre, 3, 19, TZ);
verifie("On passe bien en 2027", heureParis(apresNouvelAn).startsWith("02/01/2027"), heureParis(apresNouvelAn));

console.log(echecs === 0 ? "\nFUSEAU HORAIRE : CONFORME\n" : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
