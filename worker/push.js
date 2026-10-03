import { sendPush } from "./webpush.js";

/**
 * Envoie une notification a un occupant, aux deux ("both" / "all"), et
 * purge au passage les abonnements que le navigateur a revoques.
 */
export async function notify(ctx, target, payload) {
  const { config, store } = ctx;
  if (!config.vapid.publicKey || !config.vapid.privateKey) return;

  const wanted = target === "both" || target === "all" ? config.userIds : [target];
  const subs = await store.subscriptions(wanted);
  if (!subs.length) return;

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    image: payload.image || null,
    tag: payload.tag || "regles",
    url: payload.url || "/",
    renotify: payload.renotify ?? true,
    requireInteraction: payload.requireInteraction ?? false,
  });

  const perimes = [];
  await Promise.all(
    subs.map(async (sub) => {
      try {
        const res = await sendPush(
          { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
          body,
          config.vapid,
          { urgency: payload.urgent ? "high" : "normal", ttl: payload.ttl ?? 3600 },
        );
        if (res.gone) perimes.push(sub.endpoint);
        else if (!res.ok) console.error("[push]", res.status, sub.endpoint.slice(0, 48));
      } catch (err) {
        console.error("[push] echec", err?.message);
      }
    }),
  );

  await store.removeSubscriptions(perimes);
}
