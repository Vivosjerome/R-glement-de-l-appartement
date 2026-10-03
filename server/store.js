import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const EMPTY = {
  appKey: null, // secret du lien d'invitation, genere au premier demarrage
  settings: { ...config.defaults },
  instances: [], // taches en cours
  history: [], // taches terminees (les 500 dernieres)
  photos: [], // photos partagees entre les deux telephones
  subscriptions: [], // abonnements Web Push
  tokens: [], // sessions des appareils
  lastSpawn: {}, // defId -> ISO date de la derniere creation
  nextDue: {}, // defId -> ISO date de la prochaine echeance
  lastDoneBy: {}, // defId -> qui l'a faite en dernier, pour la rotation
  lastReminder: {}, // userId -> jour du dernier rappel groupe
};

function load() {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    return { ...structuredClone(EMPTY), ...JSON.parse(raw) };
  } catch {
    return structuredClone(EMPTY);
  }
}

export const db = load();

let pending = null;

// Ecriture atomique : on passe par un fichier temporaire pour qu'une coupure
// de courant ne laisse jamais un db.json tronque.
function flush() {
  pending = null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export function save() {
  if (pending) return;
  pending = setTimeout(flush, 200);
}

export function saveNow() {
  if (pending) clearTimeout(pending);
  flush();
}

process.on("SIGINT", () => {
  saveNow();
  process.exit(0);
});
process.on("SIGTERM", () => {
  saveNow();
  process.exit(0);
});
