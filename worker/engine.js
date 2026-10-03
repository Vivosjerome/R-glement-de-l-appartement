import { TASKS_BY_ID, PLANNED, RAPPEL_SOIR } from "../shared/tasks.js";
import { userName, otherUser } from "./config.js";
import { notify } from "./push.js";
import { local, atLocalHour, addDaysAtHour, nextWeekday } from "./time.js";

const MINUTE = 60 * 1000;

// ------------------------------------------------------------- attribution
/** A qui revient la tache. La rotation part de la derniere realisation. */
export function nextAssignee(ctx, def, actor = null) {
  switch (def.assign) {
    case "together":
      return "both";
    case "actor":
      return actor || ctx.config.userIds[0];
    case "other":
      return actor ? otherUser(ctx.config, actor) : ctx.config.userIds[0];
    case "rotation": {
      const last = ctx.store.get("lastDoneBy", {})[def.id];
      return last ? otherUser(ctx.config, last) : ctx.config.userIds[0];
    }
    default:
      return ctx.config.userIds[0];
  }
}

function delayMinutes(ctx, def) {
  const settings = ctx.store.get("settings", ctx.config.defaults);
  const { delaySetting, delaySettingHours, delayMinutes: fixed } = def.schedule;
  if (delaySetting) return settings[delaySetting] ?? 0;
  if (delaySettingHours) return (settings[delaySettingHours] ?? 0) * 60;
  return fixed ?? 0;
}

export async function createInstance(ctx, def, { actor = null, now = new Date() } = {}) {
  const timed = def.schedule.type === "trigger" || def.schedule.type === "chained";
  const instance = {
    id: crypto.randomUUID(),
    defId: def.id,
    label: def.label,
    emoji: def.emoji,
    assignee: nextAssignee(ctx, def, actor),
    kind: timed ? "timed" : "day",
    createdAt: now.toISOString(),
    dueAt: new Date(now.getTime() + delayMinutes(ctx, def) * MINUTE).toISOString(),
  };

  await ctx.store.addInstance(instance);
  ctx.store.setIn("lastSpawn", def.id, now.toISOString());
  return instance;
}

export async function completeInstance(ctx, id, actor, now = new Date()) {
  const instance = await ctx.store.instance(id);
  if (!instance) return null;

  await ctx.store.removeInstance(id);
  await ctx.store.addHistory({
    id: instance.id,
    defId: instance.defId,
    label: instance.label,
    emoji: instance.emoji,
    doneBy: actor,
    doneAt: now.toISOString(),
  });

  const def = TASKS_BY_ID[instance.defId];
  if (def) {
    // C'est la realisation qui fait tourner le tour, pas le calendrier.
    if (def.assign === "rotation") ctx.store.setIn("lastDoneBy", def.id, actor);

    if (def.schedule.type === "interval") {
      const next = addDaysAtHour(now, def.schedule.days, def.remindAt, ctx.config.timeZone);
      ctx.store.setIn("nextDue", def.id, next.toISOString());
    }

    if (def.chainsTo && TASKS_BY_ID[def.chainsTo] && !(await ctx.store.openFor(def.chainsTo))) {
      await createInstance(ctx, TASKS_BY_ID[def.chainsTo], { actor, now });
    }
  }

  // L'autre est prevenu systematiquement, et sait quand ce sera son tour.
  const due = def?.assign === "rotation" ? ctx.store.get("nextDue", {})[def.id] : null;
  await notify(ctx, otherUser(ctx.config, actor), {
    title: `${instance.emoji} ${instance.label}`,
    body:
      `${userName(ctx.config, actor)} a fait : ${instance.label}.` +
      (due ? ` A toi ${relativeDay(ctx, new Date(due), now)}.` : ""),
    tag: `done-${instance.defId}`,
    renotify: false,
  });

  return instance;
}

export async function declareDone(ctx, defId, actor, now = new Date()) {
  const def = TASKS_BY_ID[defId];
  if (!def || !def.declare) return { error: "Tache inconnue" };

  // Celui qui vient de la faire ne peut pas la redeclarer : la main est
  // passee a l'autre. C'est ce qui empeche d'appuyer en boucle.
  const turn = nextAssignee(ctx, def);
  if (turn !== "both" && turn !== actor) {
    return { error: `C'est au tour de ${userName(ctx.config, turn)}.` };
  }

  const open = await ctx.store.openFor(defId);
  if (open) return { instance: await completeInstance(ctx, open.id, actor, now) };

  const instance = await createInstance(ctx, def, { actor, now });
  return { instance: await completeInstance(ctx, instance.id, actor, now) };
}

export async function triggerEvent(ctx, defId, actor) {
  const def = TASKS_BY_ID[defId];
  if (!def || def.schedule.type !== "trigger") return null;
  if (await ctx.store.openFor(def.id)) return null;

  const instance = await createInstance(ctx, def, { actor });
  await notify(ctx, instance.assignee, {
    title: `${def.emoji} ${def.label}`,
    body: def.rule,
    tag: `task-${def.id}`,
    urgent: true,
  });
  return instance;
}

// ------------------------------------------------------------ planification
function relativeDay(ctx, date, from) {
  const a = local(from, ctx.config.timeZone);
  const b = local(date, ctx.config.timeZone);
  const days = Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 864e5,
  );
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return "demain";
  const fmt = (opts) =>
    new Intl.DateTimeFormat("fr-FR", { timeZone: ctx.config.timeZone, ...opts }).format(date);
  if (days < 7) return fmt({ weekday: "long" });
  return `le ${fmt({ day: "numeric", month: "short" }).replace(/\.$/, "")}`;
}

export function nextOccurrence(ctx, def, now = new Date()) {
  if (def.schedule.type === "interval") {
    const saved = ctx.store.get("nextDue", {})[def.id];
    if (saved) return new Date(saved);
    // Jamais faite : elle apparaitra a l'heure de rappel du jour, ou demain
    // si cette heure est deja passee.
    const p = local(now, ctx.config.timeZone);
    const today = atLocalHour(p, def.remindAt, ctx.config.timeZone);
    return today > now ? today : addDaysAtHour(now, 1, def.remindAt, ctx.config.timeZone);
  }
  if (def.schedule.type === "weekday") {
    const settings = ctx.store.get("settings", ctx.config.defaults);
    const day = settings[def.schedule.setting] ?? ctx.config.defaults.menageDay;
    return nextWeekday(now, day, def.remindAt, ctx.config.timeZone);
  }
  return null;
}

async function dueNow(ctx, def, now) {
  if (await ctx.store.openFor(def.id)) return false;
  const p = local(now, ctx.config.timeZone);

  if (def.schedule.type === "interval") {
    const saved = ctx.store.get("nextDue", {})[def.id];
    if (!saved) return p.hour >= def.remindAt;
    return now >= new Date(saved);
  }

  if (def.schedule.type === "weekday") {
    const settings = ctx.store.get("settings", ctx.config.defaults);
    if (p.weekday !== (settings[def.schedule.setting] ?? ctx.config.defaults.menageDay)) return false;
    if (p.hour < def.remindAt) return false;
    const last = ctx.store.get("lastSpawn", {})[def.id];
    return !last || local(new Date(last), ctx.config.timeZone).dayKey !== p.dayKey;
  }

  return false;
}

// -------------------------------------------------------------------- rappels
async function dailyReminders(ctx, now) {
  const p = local(now, ctx.config.timeZone);
  if (p.hour < RAPPEL_SOIR) return;

  const dejaFait = ctx.store.get("lastReminder", {});
  const instances = await ctx.store.instances();

  for (const user of ctx.config.userIds) {
    if (dejaFait[user] === p.dayKey) continue;
    ctx.store.setIn("lastReminder", user, p.dayKey);

    const todo = instances.filter((i) => i.assignee === user || i.assignee === "both");
    if (!todo.length) continue;

    // Un seul rappel groupe plutot qu'une notification par tache.
    await notify(ctx, user, {
      title:
        todo.length === 1
          ? `${todo[0].emoji} Il reste une chose a faire`
          : `\u{1F4CB} Il reste ${todo.length} choses a faire`,
      body: todo.map((t) => t.label).join(", "),
      tag: "rappel-soir",
      urgent: true,
    });
  }
}

/** Appele chaque minute par le declencheur cron. */
export async function tick(ctx, now = new Date()) {
  for (const def of PLANNED) {
    if (!(await dueNow(ctx, def, now))) continue;
    const instance = await createInstance(ctx, def, { now });
    await notify(ctx, instance.assignee, {
      title: `${def.emoji} ${def.label}`,
      body: def.detail ? `${def.detail}. C'est pour aujourd'hui.` : "C'est pour aujourd'hui.",
      tag: `task-${def.id}`,
      urgent: true,
    });
  }
  await dailyReminders(ctx, now);
}
