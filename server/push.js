import webpush from "web-push";
import { config, USER_IDS } from "./config.js";
import { db, save } from "./store.js";

export const pushReady = Boolean(config.vapid.publicKey && config.vapid.privateKey);

if (pushReady) {
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
} else {
  console.warn("[push] Cles VAPID absentes : lance `npm run keys` et colle-les dans .env");
}

export function addSubscription(user, subscription) {
  if (!subscription?.endpoint) return false;
  const existing = db.subscriptions.find((s) => s.endpoint === subscription.endpoint);
  if (existing) {
    existing.user = user;
    existing.keys = subscription.keys;
  } else {
    db.subscriptions.push({
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      user,
      createdAt: new Date().toISOString(),
    });
  }
  save();
  return true;
}

export function removeSubscription(endpoint) {
  const before = db.subscriptions.length;
  db.subscriptions = db.subscriptions.filter((s) => s.endpoint !== endpoint);
  if (db.subscriptions.length !== before) save();
}

/**
 * @param {string} target id d'utilisateur, "both" ou "all"
 */
export async function notify(target, payload) {
  if (!pushReady) return;

  const wanted = target === "both" || target === "all" ? USER_IDS : [target];
  const targets = db.subscriptions.filter((s) => wanted.includes(s.user));
  if (!targets.length) return;

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    image: payload.image || null,
    tag: payload.tag || "regles",
    url: payload.url || "/",
    renotify: payload.renotify ?? true,
    requireInteraction: payload.requireInteraction ?? false,
  });

  const dead = [];
  await Promise.all(
    targets.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body,
          { urgency: payload.urgent ? "high" : "normal", TTL: payload.ttl ?? 3600 },
        );
      } catch (err) {
        // 404/410 = l'abonnement n'existe plus cote navigateur, on le purge.
        if (err?.statusCode === 404 || err?.statusCode === 410) dead.push(sub.endpoint);
        else console.error("[push] echec envoi:", err?.statusCode, err?.body || err?.message);
      }
    }),
  );

  if (dead.length) {
    db.subscriptions = db.subscriptions.filter((s) => !dead.includes(s.endpoint));
    save();
  }
}
