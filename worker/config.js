// Les reglages viennent des variables du Worker (wrangler.toml et secrets).

function parseUsers(raw) {
  const fallback = [
    { id: "jerome", name: "Jerome", platform: "android" },
    { id: "laurine", name: "Laurine", platform: "ios" },
  ];
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [id, name, platform] = chunk.split(":").map((s) => s && s.trim());
      return id && name ? { id, name, platform: platform || null } : null;
    })
    .filter(Boolean);
  return parsed.length === 2 ? parsed : fallback;
}

export function buildConfig(env) {
  const users = parseUsers(env.USERS);
  return {
    users,
    userIds: users.map((u) => u.id),
    pin: String(env.APP_PIN || "").trim(),
    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY || "",
      privateKey: env.VAPID_PRIVATE_KEY || "",
      subject: env.VAPID_SUBJECT || "mailto:admin@example.com",
    },
    defaults: {
      menageDay: Number(env.MENAGE_DAY ?? 6),
      machineMinutes: Number(env.MACHINE_MINUTES ?? 120),
      lingeSecHours: Number(env.LINGE_SEC_HOURS ?? 6),
    },
    // Les Workers tournent en UTC. Tout raisonnement sur les heures doit
    // donc passer par ce fuseau, sinon "19 h" tombe a 20 h en France l'ete.
    timeZone: env.TIMEZONE || "Europe/Paris",
  };
}

export function userName(config, id) {
  if (id === "both") return "vous deux";
  return config.users.find((u) => u.id === id)?.name || id;
}

export function otherUser(config, id) {
  return config.userIds.find((u) => u !== id) || id;
}
