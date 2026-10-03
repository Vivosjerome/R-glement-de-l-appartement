import "dotenv/config";

// Format attendu : "id:Prenom:plateforme" ou "id:Prenom".
// La plateforme (android | ios) sert a deviner qui ouvre l'app.
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

export const config = {
  port: Number(process.env.PORT) || 3000,
  // Code de secours, saisi a la main. Laisser vide pour s'en passer
  // completement : le lien d'invitation suffit alors a se connecter.
  pin: String(process.env.APP_PIN || "").trim(),
  users: parseUsers(process.env.USERS),
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || "",
    privateKey: process.env.VAPID_PRIVATE_KEY || "",
    subject: process.env.VAPID_SUBJECT || "mailto:admin@example.com",
  },
  defaults: {
    menageDay: Number(process.env.MENAGE_DAY ?? 6),
    machineMinutes: Number(process.env.MACHINE_MINUTES ?? 120),
    lingeSecHours: Number(process.env.LINGE_SEC_HOURS ?? 6),
  },
  timezone: process.env.TZ || "Europe/Paris",
};

export const USER_IDS = config.users.map((u) => u.id);

export function userName(id) {
  if (id === "both") return "vous deux";
  return config.users.find((u) => u.id === id)?.name || id;
}

export function otherUser(id) {
  return USER_IDS.find((u) => u !== id) || id;
}
