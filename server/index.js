import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cron from "node-cron";

import { config, USER_IDS, userName, otherUser } from "./config.js";
import { db, save } from "./store.js";
import { REGLEMENT, DEVISE, TRIGGERS, PLANNED, DECLARABLE, TASKS_BY_ID } from "../shared/tasks.js";
import { addSubscription, removeSubscription, notify, pushReady } from "./push.js";
import {
  completeInstance,
  triggerEvent,
  declareDone,
  tick,
  nextOccurrence,
  nextAssignee,
} from "./engine.js";
import { detectPlatform, suggestUser, isLocalRequest } from "./detect.js";
import { savePhoto, photoPath, deletePhoto } from "./photos.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = express();

// On tourne derriere un tunnel (Cloudflare, ngrok...) qui s'execute sur la
// meme machine : on ne fait confiance qu'aux en-tetes X-Forwarded-* venant
// de la loopback, sinon n'importe qui pourrait se declarer local.
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(ROOT, "public"), { maxAge: "1h" }));

// ------------------------------------------------------------------ auth
// Secret du lien d'invitation : genere une fois, puis stable.
if (!db.appKey) {
  db.appKey = randomUUID().replace(/-/g, "");
  save();
}

app.post("/api/login", (req, res) => {
  const { pin, key, user } = req.body || {};

  // Trois voies : depuis la machine hote (rien a prouver), via le lien
  // d'invitation, ou avec le code de secours.
  const byLocal = isLocalRequest(req);
  const byKey = typeof key === "string" && key.length > 20 && key === db.appKey;
  const byPin = config.pin !== "" && String(pin) === config.pin;

  if (!byLocal && !byKey && !byPin) {
    return res.status(401).json({ error: key ? "Lien invalide ou perime" : "Code incorrect" });
  }
  if (!USER_IDS.includes(user)) return res.status(400).json({ error: "Utilisateur inconnu" });

  const platform = detectPlatform(req);
  const token = randomUUID();
  db.tokens.push({
    token,
    user,
    platform,
    userAgent: (req.get("user-agent") || "").slice(0, 200),
    createdAt: new Date().toISOString(),
  });
  save();
  res.json({ token, user, name: userName(user) });
});

app.get("/api/public", (req, res) => {
  const platform = detectPlatform(req);
  const guess = suggestUser(platform);
  res.json({
    users: config.users,
    pushReady,
    platform,
    suggested: guess ? { id: guess.id, name: guess.name } : null,
    // Faute de mieux on retient le premier occupant declare : mieux vaut
    // entrer avec une identite corrigeable que rester bloque sur un choix.
    fallback: config.users[0],
    local: isLocalRequest(req),
    pinAvailable: config.pin !== "",
  });
});

function auth(req, res, next) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const session = db.tokens.find((t) => t.token === token);
  if (!session) return res.status(401).json({ error: "Session expiree" });
  req.user = session.user;
  req.session = session;
  next();
}

// ------------------------------------------------------------------ state
function buildStats() {
  const now = Date.now();
  const windows = { week: 7 * 864e5, month: 30 * 864e5 };
  const stats = {};
  for (const u of USER_IDS) {
    stats[u] = { week: 0, month: 0 };
    for (const h of db.history) {
      if (h.doneBy !== u) continue;
      const age = now - new Date(h.doneAt).getTime();
      if (age <= windows.week) stats[u].week++;
      if (age <= windows.month) stats[u].month++;
    }
  }
  return stats;
}

// Apercu du rythme : qui fera quoi, et quand. C'est ce qui rend la rotation
// comprehensible sans avoir a deviner.
function buildUpcoming() {
  const now = new Date();
  // Les taches declarables affichent deja leur etat sur leur bouton :
  // les reprendre ici ferait doublon.
  return PLANNED.filter((def) => !def.declare && !db.instances.some((i) => i.defId === def.id))
    .map((def) => ({
      defId: def.id,
      label: def.label,
      emoji: def.emoji,
      assignee: nextAssignee(def),
      date: nextOccurrence(def, now)?.toISOString() || null,
    }))
    .filter((u) => u.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

app.get("/api/state", auth, (req, res) => {
  res.json({
    me: req.user,
    users: config.users,
    settings: db.settings,
    reglement: REGLEMENT,
    devise: DEVISE,
    pushReady,
    vapidPublicKey: config.vapid.publicKey,
    triggers: TRIGGERS.map((t) => ({
      id: t.id,
      label: t.trigger.label,
      emoji: t.trigger.emoji,
      taskLabel: t.label,
      assign: t.assign,
      delayMinutes: t.schedule.delaySetting
        ? db.settings[t.schedule.delaySetting]
        : (t.schedule.delayMinutes ?? 0),
      open: db.instances.some((i) => i.defId === t.id),
    })),
    // Masquees si la tache est deja dans la liste du jour : son bouton de
    // validation suffit, inutile de proposer deux chemins pour la meme chose.
    declarable: DECLARABLE.filter((t) => !db.instances.some((i) => i.defId === t.id)).map((t) => ({
      id: t.id,
      taskLabel: t.label,
      label: t.declare,
      emoji: t.emoji,
      days: t.schedule.days,
      turn: nextAssignee(t),
      date: nextOccurrence(t)?.toISOString() || null,
    })),
    // On joint les infos de la definition pour que l'app puisse annoncer
    // ce qui se passera a la validation.
    instances: [...db.instances]
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
      .map((i) => ({
        ...i,
        assign: TASKS_BY_ID[i.defId]?.assign || null,
        days: TASKS_BY_ID[i.defId]?.schedule?.days || null,
      })),
    upcoming: buildUpcoming(),
    photos: db.photos.slice(0, 12),
    history: db.history.slice(0, 40),
    stats: buildStats(),
    subscribed: db.subscriptions.some((s) => s.user === req.user),
    device: {
      platform: req.session.platform || detectPlatform(req),
      since: req.session.createdAt,
    },
  });
});

app.get("/api/invite", auth, (req, res) => {
  // req.get("host") renvoie l'en-tete Host brut, qui vaut localhost derriere un
  // tunnel : c'est X-Forwarded-Host qui porte le vrai domaine public.
  const host = req.get("x-forwarded-host") || req.get("host");
  res.json({ url: `${req.protocol}://${host}/?k=${db.appKey}` });
});

// Permet de corriger l'appareil si la detection s'est trompee.
app.post("/api/switch-user", auth, (req, res) => {
  const { user } = req.body || {};
  if (!USER_IDS.includes(user)) return res.status(400).json({ error: "Utilisateur inconnu" });
  req.session.user = user;
  db.subscriptions
    .filter((s) => s.endpoint === req.body?.endpoint)
    .forEach((s) => (s.user = user));
  save();
  res.json({ user, name: userName(user) });
});

// ------------------------------------------------------------------ actions
app.post("/api/trigger", auth, (req, res) => {
  const instance = triggerEvent(req.body?.defId, req.user);
  if (!instance) return res.status(409).json({ error: "Deja en cours ou inconnu" });
  res.json({ instance });
});

app.post("/api/declare-done", auth, (req, res) => {
  const result = declareDone(req.body?.defId, req.user);
  if (result.error) return res.status(409).json(result);
  res.json(result);
});

app.post("/api/complete", auth, (req, res) => {
  const instance = completeInstance(req.body?.id, req.user);
  if (!instance) return res.status(404).json({ error: "Tache introuvable" });
  res.json({ instance });
});

// ---------------------------------------------------------------- photos
// L'image arrive deja redimensionnee par le navigateur, en binaire brut :
// pas de dependance multipart ni de surcout base64.
app.post(
  "/api/photo",
  auth,
  express.raw({ type: "image/jpeg", limit: "8mb" }),
  async (req, res) => {
    if (!req.body?.length) return res.status(400).json({ error: "Image vide" });

    const photo = savePhoto(req.body, { from: req.user, note: req.query.note });
    const host = req.get("x-forwarded-host") || req.get("host");
    const url = `${req.protocol}://${host}/photos/${photo.id}.jpg`;

    await notify(otherUser(req.user), {
      title: `\u{1F4F7} ${userName(req.user)} t'envoie une photo`,
      body: photo.note || "Appuie pour voir.",
      image: url,
      url: `/?photo=${photo.id}`,
      tag: `photo-${photo.id}`,
      urgent: true,
    });

    res.json({ photo });
  },
);

/**
 * Les photos ne durent que le temps d'etre vues : des que le destinataire
 * ferme la visionneuse, l'image part pour tous les deux. Celui qui l'a
 * envoyee peut la rouvrir sans la consommer, sinon il effacerait son propre
 * message en verifiant ce qu'il a envoye.
 */
app.post("/api/photo/:id/seen", auth, (req, res) => {
  const photo = db.photos.find((p) => p.id === req.params.id);
  if (!photo || photo.from === req.user) return res.json({ consumed: false });
  deletePhoto(photo.id);
  res.json({ consumed: true });
});

app.delete("/api/photo/:id", auth, (req, res) => {
  if (!deletePhoto(req.params.id)) return res.status(404).json({ error: "Photo introuvable" });
  res.json({ ok: true });
});

// Accessible sans session : une notification charge l'image sans nos en-tetes.
// Le nom de fichier est un UUID, c'est lui qui fait office de cle.
app.get("/photos/:file", (req, res) => {
  const file = photoPath(req.params.file.replace(/\.jpg$/i, ""));
  if (!file) return res.sendStatus(404);
  res.type("jpeg").set("Cache-Control", "public, max-age=31536000, immutable").sendFile(file);
});

// ------------------------------------------------------------------ push
app.post("/api/subscribe", auth, (req, res) => {
  if (!addSubscription(req.user, req.body?.subscription)) {
    return res.status(400).json({ error: "Abonnement invalide" });
  }
  res.json({ ok: true });
});

app.post("/api/unsubscribe", auth, (req, res) => {
  removeSubscription(req.body?.endpoint);
  res.json({ ok: true });
});

app.post("/api/test-notification", auth, async (req, res) => {
  await notify(req.user, {
    title: "\u{2705} Notifications actives",
    body: `Tout est pret, ${userName(req.user)}. ${DEVISE}`,
    tag: "test",
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ settings
app.post("/api/settings", auth, (req, res) => {
  const { menageDay, machineMinutes, lingeSecHours } = req.body || {};
  if (menageDay !== undefined) db.settings.menageDay = Math.min(Math.max(Number(menageDay), 0), 6);
  if (machineMinutes !== undefined) db.settings.machineMinutes = Math.max(Number(machineMinutes), 10);
  if (lingeSecHours !== undefined) db.settings.lingeSecHours = Math.max(Number(lingeSecHours), 1);
  save();
  res.json({ settings: db.settings });
});

// ------------------------------------------------------------------ boot
cron.schedule("* * * * *", () => {
  tick().catch((err) => console.error("[tick]", err));
});

app.listen(config.port, () => {
  console.log(`\n  Regles appartement -> http://localhost:${config.port}`);
  console.log(`  Occupants : ${config.users.map((u) => u.name).join(" & ")}`);
  console.log(`  Push      : ${pushReady ? "actif" : "INACTIF (npm run keys)"}`);
  console.log(`\n  Lien d'invitation (a ouvrir sur chaque telephone) :`);
  console.log(`  http://localhost:${config.port}/?k=${db.appKey}`);
  console.log(`  Remplace localhost par ton domaine HTTPS une fois le tunnel lance.\n`);
  tick().catch(() => {});
});
