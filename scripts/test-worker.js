// Parcours complets contre le Worker lance par `npx wrangler dev --port 8788`.
// Verifie la connexion, la rotation, le passage de main, l'enchainement
// machine -> etendre -> rentrer, les photos et le declencheur cron.

const BASE = process.env.BASE || "http://127.0.0.1:8788";
const UA = {
  android: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
  ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile Safari/604.1",
};

let echecs = 0;
function verifie(nom, condition, detail = "") {
  const marque = condition ? "  ok  " : " ECHEC";
  console.log(`${marque}  ${nom}${detail ? `  -> ${detail}` : ""}`);
  if (!condition) echecs++;
}

async function appel(chemin, { token, method = "GET", body, ua = UA.android, raw } = {}) {
  const headers = { "user-agent": ua };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined && !raw) headers["content-type"] = "application/json";
  const res = await fetch(BASE + chemin, {
    method,
    headers,
    body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, data: type.includes("json") ? await res.json() : res, res };
}

async function connecte(user, ua) {
  const { data } = await appel("/api/login", { method: "POST", body: { pin: "1234", user }, ua });
  if (!data.token) throw new Error(`connexion impossible : ${JSON.stringify(data)}`);
  return data.token;
}

// --------------------------------------------------------------------------
console.log("\n--- Detection et connexion ---");
const pub = await appel("/api/public", { ua: UA.android });
verifie("Android reconnu", pub.data.platform === "android", pub.data.platform);
verifie("Jerome propose", pub.data.suggested?.id === "jerome", pub.data.suggested?.name);

const pubIos = await appel("/api/public", { ua: UA.ios });
verifie("iPhone reconnu", pubIos.data.platform === "ios", pubIos.data.platform);
verifie("Laurine proposee", pubIos.data.suggested?.id === "laurine", pubIos.data.suggested?.name);
verifie("Push pret", pub.data.pushReady === true);

const mauvais = await appel("/api/login", { method: "POST", body: { pin: "0000", user: "jerome" } });
verifie("Mauvais code refuse", mauvais.status === 401, `HTTP ${mauvais.status}`);

const jerome = await connecte("jerome", UA.android);
const laurine = await connecte("laurine", UA.ios);
verifie("Deux sessions ouvertes", Boolean(jerome && laurine));

const sansJeton = await appel("/api/state");
verifie("Etat protege sans jeton", sansJeton.status === 401, `HTTP ${sansJeton.status}`);

// --------------------------------------------------------------------------
console.log("\n--- Rotation de la litiere ---");
const avant = await appel("/api/state", { token: jerome });
const litiereAvant = avant.data.declarable.find((d) => d.id === "litiere");
verifie("Litiere declarable au depart", Boolean(litiereAvant), `tour : ${litiereAvant?.turn}`);

const fait1 = await appel("/api/declare-done", {
  token: jerome,
  method: "POST",
  body: { defId: "litiere" },
});
verifie("Jerome fait la litiere", fait1.status === 200, fait1.data.instance?.label);

const rejets = [];
for (let i = 0; i < 3; i++) {
  const r = await appel("/api/declare-done", {
    token: jerome,
    method: "POST",
    body: { defId: "litiere" },
  });
  rejets.push(r.status);
}
verifie(
  "Clics en boucle bloques",
  rejets.every((s) => s === 409),
  rejets.join(", "),
);

const vueLaurine = await appel("/api/state", { token: laurine });
const litiereL = vueLaurine.data.declarable.find((d) => d.id === "litiere");
verifie("La main passe a Laurine", litiereL?.turn === "laurine", litiereL?.turn);

const ecart = (new Date(litiereL.date) - Date.now()) / 864e5;
verifie("Echeance a deux jours", ecart > 1.2 && ecart < 2.9, `${ecart.toFixed(2)} jour(s)`);

const heureLocale = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Paris",
  hour: "2-digit",
  hourCycle: "h23",
}).format(new Date(litiereL.date));
verifie("Echeance a 19 h heure de Paris", Number(heureLocale) === 19, `${heureLocale} h`);

const fait2 = await appel("/api/declare-done", {
  token: laurine,
  method: "POST",
  body: { defId: "litiere" },
});
verifie("Laurine peut la faire", fait2.status === 200);

const apres = await appel("/api/state", { token: jerome });
verifie(
  "La main revient a Jerome",
  apres.data.declarable.find((d) => d.id === "litiere")?.turn === "jerome",
);
verifie("Historique rempli", apres.data.history.length >= 2, `${apres.data.history.length} entrees`);
verifie(
  "Compteurs par personne",
  apres.data.stats.jerome.week >= 1 && apres.data.stats.laurine.week >= 1,
  `jerome ${apres.data.stats.jerome.week} / laurine ${apres.data.stats.laurine.week}`,
);

// --------------------------------------------------------------------------
console.log("\n--- Machine : etendre puis rentrer ---");
const machine = await appel("/api/trigger", {
  token: jerome,
  method: "POST",
  body: { defId: "etendre" },
});
verifie("Machine lancee", machine.status === 200, machine.data.instance?.label);
verifie(
  "Etendre revient a celui qui lance",
  machine.data.instance?.assignee === "jerome",
  machine.data.instance?.assignee,
);

const doublon = await appel("/api/trigger", {
  token: laurine,
  method: "POST",
  body: { defId: "etendre" },
});
verifie("Pas de doublon de machine", doublon.status === 409, `HTTP ${doublon.status}`);

await appel("/api/complete", {
  token: jerome,
  method: "POST",
  body: { id: machine.data.instance.id },
});
const apresEtendu = await appel("/api/state", { token: jerome });
verifie(
  "Rentrer le linge enchaine",
  apresEtendu.data.instances.some((i) => i.defId === "rentrer"),
  apresEtendu.data.instances.map((i) => i.defId).join(", ") || "aucune",
);

// --------------------------------------------------------------------------
console.log("\n--- Poubelle : pas de passage de main ---");
const poubelle = await appel("/api/trigger", {
  token: jerome,
  method: "POST",
  body: { defId: "poubelle" },
});
verifie(
  "Poubelle pour tous les deux",
  poubelle.data.instance?.assignee === "both",
  poubelle.data.instance?.assignee,
);

// --------------------------------------------------------------------------
console.log("\n--- Photos ---");
// Le plus petit JPEG valide possible, suffisant pour verifier le stockage.
const jpeg = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  ),
  (c) => c.charCodeAt(0),
);
const envoi = await appel("/api/photo?note=Des%20vetements%20trainent", {
  token: jerome,
  method: "POST",
  body: jpeg,
  raw: true,
});
verifie("Photo envoyee", envoi.status === 200, envoi.data.photo?.id?.slice(0, 8));

const image = await fetch(`${BASE}/photos/${envoi.data.photo.id}.jpg`);
const octets = (await image.arrayBuffer()).byteLength;
verifie("Photo relisible sans session", image.status === 200 && octets === jpeg.length, `${octets} octets`);
verifie(
  "Type d'image correct",
  image.headers.get("content-type") === "image/jpeg",
  image.headers.get("content-type"),
);

const bidon = await fetch(`${BASE}/photos/pas-un-uuid.jpg`);
verifie("Identifiant invalide rejete", bidon.status === 404, `HTTP ${bidon.status}`);

const avecPhoto = await appel("/api/state", { token: laurine });
verifie("Photo visible des deux cotes", avecPhoto.data.photos.length >= 1);

const suppr = await appel(`/api/photo/${envoi.data.photo.id}`, { token: laurine, method: "DELETE" });
verifie("Photo supprimable", suppr.status === 200);
const apresSuppr = await fetch(`${BASE}/photos/${envoi.data.photo.id}.jpg`);
verifie("Image effacee du stockage", apresSuppr.status === 404, `HTTP ${apresSuppr.status}`);

// --------------------------------------------------------------------------
console.log("\n--- Reglages, invitation, abonnements ---");
const reglages = await appel("/api/settings", {
  token: jerome,
  method: "POST",
  body: { menageDay: 3, machineMinutes: 90 },
});
verifie(
  "Reglages enregistres",
  reglages.data.settings.menageDay === 3 && reglages.data.settings.machineMinutes === 90,
  JSON.stringify(reglages.data.settings),
);
const relu = await appel("/api/state", { token: laurine });
verifie("Reglages persistes", relu.data.settings.menageDay === 3);

const borne = await appel("/api/settings", { token: jerome, method: "POST", body: { menageDay: 42 } });
verifie("Valeur aberrante bornee", borne.data.settings.menageDay === 6, `${borne.data.settings.menageDay}`);
await appel("/api/settings", { token: jerome, method: "POST", body: { menageDay: 6, machineMinutes: 120 } });

const invite = await appel("/api/invite", { token: jerome });
const cle = new URL(invite.data.url).searchParams.get("k");
verifie("Lien d'invitation genere", cle?.length > 20, invite.data.url);

const parLien = await appel("/api/login", { method: "POST", body: { key: cle, user: "laurine" } });
verifie("Connexion par lien sans code", parLien.status === 200 && Boolean(parLien.data.token));

const lienFaux = await appel("/api/login", {
  method: "POST",
  body: { key: "x".repeat(32), user: "laurine" },
});
verifie("Faux lien refuse", lienFaux.status === 401, `HTTP ${lienFaux.status}`);

const abo = await appel("/api/subscribe", {
  token: laurine,
  method: "POST",
  body: {
    subscription: {
      endpoint: "https://example.invalid/push/abc",
      keys: { p256dh: "BObc", auth: "abcd" },
    },
  },
});
verifie("Abonnement enregistre", abo.status === 200);
const avecAbo = await appel("/api/state", { token: laurine });
verifie("Abonnement visible dans l'etat", avecAbo.data.subscribed === true);
await appel("/api/unsubscribe", {
  token: laurine,
  method: "POST",
  body: { endpoint: "https://example.invalid/push/abc" },
});

// --------------------------------------------------------------------------
console.log("\n--- Declencheur cron ---");
const cron = await fetch(`${BASE}/__scheduled?cron=*+*+*+*+*`);
verifie("Cron execute sans erreur", cron.status === 200, `HTTP ${cron.status}`);

// --------------------------------------------------------------------------
console.log("\n--- Fichiers statiques ---");
for (const fichier of ["/", "/app.js", "/styles.css", "/sw.js", "/manifest.webmanifest"]) {
  const r = await fetch(BASE + fichier);
  verifie(`Servi : ${fichier}`, r.status === 200, `HTTP ${r.status}`);
}

console.log(
  echecs === 0 ? "\nTOUS LES PARCOURS PASSENT\n" : `\n${echecs} VERIFICATION(S) EN ECHEC\n`,
);
process.exit(echecs === 0 ? 0 : 1);
