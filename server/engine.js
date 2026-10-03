import { randomUUID } from "node:crypto";
import { USER_IDS, userName, otherUser } from "./config.js";
import { db, save } from "./store.js";
import { TASKS_BY_ID, PLANNED, RAPPEL_SOIR } from "../shared/tasks.js";
import { notify } from "./push.js";

const MINUTE = 60 * 1000;

const dayKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function isOpen(defId) {
  return db.instances.some((i) => i.defId === defId);
}

/** A qui revient la tache maintenant. La rotation part de la derniere fois. */
export function nextAssignee(def, actor = null) {
  switch (def.assign) {
    case "together":
      return "both";
    case "actor":
      return actor || USER_IDS[0];
    case "other":
      return actor ? otherUser(actor) : USER_IDS[0];
    case "rotation": {
      const last = db.lastDoneBy[def.id];
      return last ? otherUser(last) : USER_IDS[0];
    }
    default:
      return USER_IDS[0];
  }
}

function delayMinutes(def) {
  const { delaySetting, delaySettingHours, delayMinutes: fixed } = def.schedule;
  if (delaySetting) return db.settings[delaySetting] ?? 0;
  if (delaySettingHours) return (db.settings[delaySettingHours] ?? 0) * 60;
  return fixed ?? 0;
}

export function createInstance(def, { actor = null, now = new Date() } = {}) {
  const timed = def.schedule.type === "trigger" || def.schedule.type === "chained";

  const instance = {
    id: randomUUID(),
    defId: def.id,
    label: def.label,
    emoji: def.emoji,
    detail: def.detail || null,
    assignee: nextAssignee(def, actor),
    kind: timed ? "timed" : "day",
    createdAt: now.toISOString(),
    dueAt: new Date(now.getTime() + delayMinutes(def) * MINUTE).toISOString(),
  };

  db.instances.push(instance);
  db.lastSpawn[def.id] = now.toISOString();
  save();
  return instance;
}

export function completeInstance(id, actor, now = new Date()) {
  const instance = db.instances.find((i) => i.id === id);
  if (!instance) return null;

  instance.doneBy = actor;
  instance.doneAt = now.toISOString();
  db.instances = db.instances.filter((i) => i.id !== id);
  db.history.unshift(instance);
  db.history = db.history.slice(0, 500);

  const def = TASKS_BY_ID[instance.defId];
  if (def) {
    // C'est la realisation qui fait tourner le tour, pas le calendrier :
    // celui qui vient de faire passe la main a l'autre.
    if (def.assign === "rotation") db.lastDoneBy[def.id] = actor;

    if (def.schedule.type === "interval") {
      const next = new Date(now);
      next.setDate(next.getDate() + def.schedule.days);
      next.setHours(def.remindAt, 0, 0, 0);
      db.nextDue[def.id] = next.toISOString();
    }

    if (def.chainsTo && TASKS_BY_ID[def.chainsTo] && !isOpen(def.chainsTo)) {
      createInstance(TASKS_BY_ID[def.chainsTo], { actor, now });
    }
  }

  save();

  // L'autre est prevenu systematiquement, et sait quand ce sera son tour.
  const next = def?.assign === "rotation" ? db.nextDue[def.id] : null;
  notify(otherUser(actor), {
    title: `${instance.emoji} ${instance.label}`,
    body:
      `${userName(actor)} a fait : ${instance.label}.` +
      (next ? ` A toi ${relativeDay(new Date(next), now)}.` : ""),
    tag: `done-${instance.defId}`,
    renotify: false,
  });

  return instance;
}

/** "aujourd'hui", "demain", "lundi" ou "le 12 oct." selon l'echeance. */
function relativeDay(date, from = new Date()) {
  const days = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()) -
      new Date(from.getFullYear(), from.getMonth(), from.getDate())) /
      864e5,
  );
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return "demain";
  if (days < 7) return date.toLocaleDateString("fr-FR", { weekday: "long" });
  // "12 oct." finit deja par un point : on l'enleve pour ne pas doubler
  // celui de la phrase.
  const court = date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  return `le ${court.replace(/\.$/, "")}`;
}

/**
 * "Je viens de le faire", sans attendre que la tache apparaisse.
 * Si elle est deja dans la liste du jour on la valide normalement, sinon on
 * l'inscrit directement a l'historique. Dans les deux cas le compte a rebours
 * repart et la main passe a l'autre.
 */
export function declareDone(defId, actor, now = new Date()) {
  const def = TASKS_BY_ID[defId];
  if (!def || !def.declare) return { error: "Tache inconnue" };

  // Celui qui vient de la faire ne peut pas la redeclarer : la main est
  // passee a l'autre. C'est ce qui empeche d'appuyer en boucle.
  const turn = nextAssignee(def);
  if (turn !== "both" && turn !== actor) {
    return { error: `C'est au tour de ${userName(turn)}.` };
  }

  const open = db.instances.find((i) => i.defId === defId);
  if (open) return { instance: completeInstance(open.id, actor, now) };

  const instance = createInstance(def, { actor, now });
  instance.assignee = actor; // c'est bien lui qui l'a faite, pas le tour en cours
  return { instance: completeInstance(instance.id, actor, now) };
}

export function triggerEvent(defId, actor) {
  const def = TASKS_BY_ID[defId];
  if (!def || def.schedule.type !== "trigger" || isOpen(def.id)) return null;

  const instance = createInstance(def, { actor });
  notify(instance.assignee, {
    title: `${def.emoji} ${def.label}`,
    body: def.rule,
    tag: `task-${def.id}`,
    urgent: true,
  });
  return instance;
}

// ------------------------------------------------------------- planification
function dueNow(def, now) {
  if (isOpen(def.id)) return false;

  if (def.schedule.type === "interval") {
    const next = db.nextDue[def.id];
    if (!next) return now.getHours() >= def.remindAt;
    return now >= new Date(next);
  }

  if (def.schedule.type === "weekday") {
    const day = db.settings[def.schedule.setting];
    if (now.getDay() !== day || now.getHours() < def.remindAt) return false;
    const last = db.lastSpawn[def.id];
    return !last || dayKey(new Date(last)) !== dayKey(now);
  }

  return false;
}

/** Prochaine echeance prevue, pour l'apercu "A venir" dans l'app. */
export function nextOccurrence(def, now = new Date()) {
  if (def.schedule.type === "interval") {
    if (db.nextDue[def.id]) return new Date(db.nextDue[def.id]);
    // Jamais faite encore : elle apparaitra a l'heure de rappel du jour,
    // ou demain si cette heure est deja passee.
    const date = new Date(now);
    date.setHours(def.remindAt, 0, 0, 0);
    if (date <= now) date.setDate(date.getDate() + 1);
    return date;
  }
  if (def.schedule.type === "weekday") {
    const target = db.settings[def.schedule.setting];
    const date = new Date(now);
    date.setHours(def.remindAt, 0, 0, 0);
    const delta = (target - date.getDay() + 7) % 7;
    date.setDate(date.getDate() + (delta === 0 && date <= now ? 7 : delta));
    return date;
  }
  return null;
}

// ----------------------------------------------------------------- rappels
async function dailyReminders(now) {
  if (now.getHours() < RAPPEL_SOIR) return;
  const today = dayKey(now);

  for (const user of USER_IDS) {
    if (db.lastReminder[user] === today) continue;

    const todo = db.instances.filter((i) => i.assignee === user || i.assignee === "both");
    db.lastReminder[user] = today;
    save();
    if (!todo.length) continue;

    // Un seul rappel groupe plutot qu'une notification par tache.
    const body =
      todo.length === 1
        ? todo[0].label
        : todo.map((t) => t.label).join(", ");

    await notify(user, {
      title:
        todo.length === 1
          ? `${todo[0].emoji} Il reste une chose a faire`
          : `\u{1F4CB} Il reste ${todo.length} choses a faire`,
      body,
      tag: "rappel-soir",
      urgent: true,
    });
  }
}

/** Appele chaque minute. */
export async function tick(now = new Date()) {
  for (const def of PLANNED) {
    if (!dueNow(def, now)) continue;
    const instance = createInstance(def, { now });
    await notify(instance.assignee, {
      title: `${def.emoji} ${def.label}`,
      body: def.detail ? `${def.detail}. C'est pour aujourd'hui.` : "C'est pour aujourd'hui.",
      tag: `task-${def.id}`,
      urgent: true,
    });
  }

  await dailyReminders(now);
}
