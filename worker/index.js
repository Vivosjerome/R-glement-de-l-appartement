import { Hono } from "hono";

import { REGLEMENT, DEVISE, TRIGGERS, PLANNED, DECLARABLE } from "../shared/tasks.js";
import { buildConfig, userName, otherUser } from "./config.js";
import { Store } from "./store.js";
import { notify } from "./push.js";
import {
  tick,
  completeInstance,
  declareDone,
  triggerEvent,
  nextOccurrence,
  nextAssignee,
} from "./engine.js";

const app = new Hono();

/** Contexte partage : configuration lue dans l'environnement + acces D1. */
async function buildContext(env) {
  const config = buildConfig(env);
  const store = await new Store(env.DB).load();
  if (!store.get("settings")) store.set("settings", config.defaults);
  if (!store.get("appKey")) store.set("appKey", crypto.randomUUID().replace(/-/g, ""));
  return { config, store, env };
}

app.use("/api/*", async (c, next) => {
  c.set("ctx", await buildContext(c.env));
  await next();
  await c.get("ctx").store.flush();
});

// ------------------------------------------------------------- detection
function detectPlatform(c) {
  const hint = (c.req.header("sec-ch-ua-platform") || "").replace(/"/g, "").toLowerCase();
  if (hint === "android") return "android";
  if (hint === "ios") return "ios";
  const ua = c.req.header("user-agent") || "";
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/macintosh/i.test(ua)) return "mac-or-ipad";
  if (/windows/i.test(ua)) return "windows";
  return "unknown";
}

// ----------------------------------------------------------------- session
app.get("/api/public", (c) => {
  const { config } = c.get("ctx");
  const platform = detectPlatform(c);
  const matches = config.users.filter((u) => u.platform === platform);
  return c.json({
    users: config.users,
    pushReady: Boolean(config.vapid.publicKey && config.vapid.privateKey),
    platform,
    suggested: matches.length === 1 ? { id: matches[0].id, name: matches[0].name } : null,
    fallback: config.users[0],
    // Pas d'equivalent a l'acces local ici : le Worker est toujours distant.
    local: false,
    pinAvailable: config.pin !== "",
  });
});

app.post("/api/login", async (c) => {
  const { config, store } = c.get("ctx");
  const { pin, key, user } = await c.req.json().catch(() => ({}));

  const byKey = typeof key === "string" && key.length > 20 && key === store.get("appKey");
  const byPin = config.pin !== "" && String(pin) === config.pin;
  if (!byKey && !byPin) {
    return c.json({ error: key ? "Lien invalide ou perime" : "Code incorrect" }, 401);
  }
  if (!config.userIds.includes(user)) return c.json({ error: "Utilisateur inconnu" }, 400);

  const token = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO sessions (token, user, platform, created_at) VALUES (?,?,?,?)",
  )
    .bind(token, user, detectPlatform(c), new Date().toISOString())
    .run();

  return c.json({ token, user, name: userName(config, user) });
});

async function requireSession(c) {
  const token = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  return c.env.DB.prepare("SELECT * FROM sessions WHERE token = ?").bind(token).first();
}

const auth = async (c, next) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: "Session expiree" }, 401);
  c.set("session", session);
  c.set("me", session.user);
  await next();
};

// ------------------------------------------------------------------ etat
async function stats(store, userIds) {
  const [week, month] = await Promise.all([
    store.counts(userIds, 7),
    store.counts(userIds, 30),
  ]);
  return Object.fromEntries(userIds.map((u) => [u, { week: week[u], month: month[u] }]));
}

app.get("/api/state", auth, async (c) => {
  const ctx = c.get("ctx");
  const { config, store } = ctx;
  const me = c.get("me");
  const now = new Date();

  const instances = await store.instances();
  const openIds = new Set(instances.map((i) => i.defId));
  const settings = store.get("settings", config.defaults);

  return c.json({
    me,
    users: config.users,
    settings,
    reglement: REGLEMENT,
    devise: DEVISE,
    pushReady: Boolean(config.vapid.publicKey && config.vapid.privateKey),
    vapidPublicKey: config.vapid.publicKey,
    instances,
    triggers: TRIGGERS.map((t) => ({
      id: t.id,
      label: t.trigger.label,
      emoji: t.trigger.emoji,
      taskLabel: t.label,
      assign: t.assign,
      delayMinutes: t.schedule.delaySetting
        ? settings[t.schedule.delaySetting]
        : (t.schedule.delayMinutes ?? 0),
      open: openIds.has(t.id),
    })),
    declarable: DECLARABLE.filter((t) => !openIds.has(t.id)).map((t) => ({
      id: t.id,
      taskLabel: t.label,
      label: t.declare,
      emoji: t.emoji,
      days: t.schedule.days,
      turn: nextAssignee(ctx, t),
      date: nextOccurrence(ctx, t, now)?.toISOString() || null,
    })),
    upcoming: PLANNED.filter((def) => !def.declare && !openIds.has(def.id))
      .map((def) => ({
        defId: def.id,
        label: def.label,
        emoji: def.emoji,
        assignee: nextAssignee(ctx, def),
        date: nextOccurrence(ctx, def, now)?.toISOString() || null,
      }))
      .filter((u) => u.date)
      .sort((a, b) => new Date(a.date) - new Date(b.date)),
    photos: (
      await c.env.DB.prepare("SELECT * FROM photos ORDER BY created_at DESC LIMIT 12").all()
    ).results.map((p) => ({
      id: p.id,
      from: p.from_user,
      note: p.note,
      createdAt: p.created_at,
    })),
    history: await store.history(40),
    stats: await stats(store, config.userIds),
    subscribed: await store.hasSubscription(me),
    device: { platform: c.get("session").platform, since: c.get("session").created_at },
  });
});

// --------------------------------------------------------------- actions
app.post("/api/trigger", auth, async (c) => {
  const { defId } = await c.req.json().catch(() => ({}));
  const instance = await triggerEvent(c.get("ctx"), defId, c.get("me"));
  if (!instance) return c.json({ error: "Deja en cours ou inconnu" }, 409);
  return c.json({ instance });
});

app.post("/api/declare-done", auth, async (c) => {
  const { defId } = await c.req.json().catch(() => ({}));
  const result = await declareDone(c.get("ctx"), defId, c.get("me"));
  if (result.error) return c.json(result, 409);
  return c.json(result);
});

app.post("/api/complete", auth, async (c) => {
  const { id } = await c.req.json().catch(() => ({}));
  const instance = await completeInstance(c.get("ctx"), id, c.get("me"));
  if (!instance) return c.json({ error: "Tache introuvable" }, 404);
  return c.json({ instance });
});

app.post("/api/switch-user", auth, async (c) => {
  const { config } = c.get("ctx");
  const { user } = await c.req.json().catch(() => ({}));
  if (!config.userIds.includes(user)) return c.json({ error: "Utilisateur inconnu" }, 400);
  await c.env.DB.prepare("UPDATE sessions SET user = ? WHERE token = ?")
    .bind(user, c.get("session").token)
    .run();
  return c.json({ user, name: userName(config, user) });
});

app.post("/api/settings", auth, async (c) => {
  const { config, store } = c.get("ctx");
  const body = await c.req.json().catch(() => ({}));
  const settings = { ...store.get("settings", config.defaults) };
  if (body.menageDay !== undefined) {
    settings.menageDay = Math.min(Math.max(Number(body.menageDay), 0), 6);
  }
  if (body.machineMinutes !== undefined) {
    settings.machineMinutes = Math.max(Number(body.machineMinutes), 10);
  }
  if (body.lingeSecHours !== undefined) {
    settings.lingeSecHours = Math.max(Number(body.lingeSecHours), 1);
  }
  store.set("settings", settings);
  return c.json({ settings });
});

app.get("/api/invite", auth, (c) => {
  const url = new URL(c.req.url);
  return c.json({ url: `${url.origin}/?k=${c.get("ctx").store.get("appKey")}` });
});

// ---------------------------------------------------------------- photos
app.post("/api/photo", auth, async (c) => {
  const ctx = c.get("ctx");
  const me = c.get("me");
  const data = await c.req.arrayBuffer();
  if (!data.byteLength) return c.json({ error: "Image vide" }, 400);

  const id = crypto.randomUUID();
  // L'image va dans le KV, seules les metadonnees restent en base.
  await c.env.PHOTOS.put(id, data);

  const note = (c.req.query("note") || "").slice(0, 140);
  const createdAt = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO photos (id, from_user, note, created_at) VALUES (?,?,?,?)",
  )
    .bind(id, me, note, createdAt)
    .run();

  // On ne garde que les 60 dernieres, images comprises.
  const { results: vieilles } = await c.env.DB.prepare(
    "SELECT id FROM photos ORDER BY created_at DESC LIMIT -1 OFFSET 60",
  ).all();
  for (const old of vieilles) {
    await c.env.PHOTOS.delete(old.id);
    await c.env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(old.id).run();
  }

  const url = new URL(c.req.url);
  await notify(ctx, otherUser(ctx.config, me), {
    title: `\u{1F4F7} ${userName(ctx.config, me)} t'envoie une photo`,
    body: note || "Appuie pour voir.",
    image: `${url.origin}/photos/${id}.jpg`,
    url: `/?photo=${id}`,
    tag: `photo-${id}`,
    urgent: true,
  });

  return c.json({ photo: { id, from: me, note, createdAt } });
});

/**
 * Les photos ne durent que le temps d'etre vues : des que le destinataire
 * ferme la visionneuse, l'image part pour tous les deux. Celui qui l'a
 * envoyee peut la rouvrir autant qu'il veut sans la consommer, sinon il
 * effacerait son propre message en verifiant ce qu'il a envoye.
 */
app.post("/api/photo/:id/seen", auth, async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT from_user FROM photos WHERE id = ?")
    .bind(id)
    .first();
  if (!row) return c.json({ consumed: false });
  if (row.from_user === c.get("me")) return c.json({ consumed: false });

  await c.env.PHOTOS.delete(id);
  await c.env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
  return c.json({ consumed: true });
});

app.delete("/api/photo/:id", auth, async (c) => {
  const id = c.req.param("id");
  const { meta } = await c.env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
  if (!meta.changes) return c.json({ error: "Photo introuvable" }, 404);
  await c.env.PHOTOS.delete(id);
  return c.json({ ok: true });
});

// Sans session : une notification charge l'image sans nos en-tetes.
// Le nom de fichier est un UUID, c'est lui qui fait office de cle.
app.get("/photos/:file", async (c) => {
  const id = c.req.param("file").replace(/\.jpg$/i, "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.notFound();
  const object = await c.env.PHOTOS.get(id, "arrayBuffer");
  if (!object) return c.notFound();
  return c.body(object, 200, {
    "Content-Type": "image/jpeg",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
});

// ------------------------------------------------------------------ push
app.post("/api/subscribe", auth, async (c) => {
  const { subscription } = await c.req.json().catch(() => ({}));
  if (!subscription?.endpoint || !subscription?.keys) {
    return c.json({ error: "Abonnement invalide" }, 400);
  }
  await c.get("ctx").store.addSubscription(c.get("me"), subscription);
  return c.json({ ok: true });
});

app.post("/api/unsubscribe", auth, async (c) => {
  const { endpoint } = await c.req.json().catch(() => ({}));
  if (endpoint) await c.get("ctx").store.removeSubscriptions([endpoint]);
  return c.json({ ok: true });
});

app.post("/api/test-notification", auth, async (c) => {
  const ctx = c.get("ctx");
  await notify(ctx, c.get("me"), {
    title: "\u{2705} Notifications actives",
    body: `Tout est pret, ${userName(ctx.config, c.get("me"))}. ${DEVISE}`,
    tag: "test",
  });
  return c.json({ ok: true });
});

export default {
  fetch: app.fetch,

  /** Declencheur cron, chaque minute. */
  async scheduled(event, env, executionCtx) {
    const ctx = await buildContext(env);
    executionCtx.waitUntil(
      (async () => {
        try {
          await tick(ctx, new Date(event.scheduledTime));
          await ctx.store.flush();
        } catch (err) {
          // Personne ne regarde quand le cron tourne : sans cette trace, une
          // panne resterait invisible et les taches cesseraient d'apparaitre
          // sans que rien ne le signale. Visible via `npx wrangler tail`.
          console.error("[cron] echec", err?.stack || err?.message || String(err));
        }
      })(),
    );
  },
};
