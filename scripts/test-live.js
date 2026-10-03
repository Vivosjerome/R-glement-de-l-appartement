// Verification de l'app reellement en ligne. Volontairement en lecture seule :
// rien ici ne valide de tache ni n'ecrit d'historique dans la vraie base.

const BASE = process.env.BASE || "https://regles-appartement.vivosjerome.workers.dev";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile Safari/604.1";

let echecs = 0;
function verifie(nom, condition, detail = "") {
  console.log(`${condition ? "  ok  " : " ECHEC"}  ${nom}${detail ? `  -> ${detail}` : ""}`);
  if (!condition) echecs++;
}

console.log(`\n${BASE}\n`);
console.log("--- Fichiers de l'app ---");
for (const chemin of [
  "/",
  "/app.js",
  "/styles.css",
  "/sw.js",
  "/manifest.webmanifest",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
]) {
  const r = await fetch(BASE + chemin);
  const taille = (await r.arrayBuffer()).byteLength;
  verifie(chemin, r.ok && taille > 0, `HTTP ${r.status}, ${taille} octets`);
}

console.log("\n--- Reconnaissance des telephones ---");
const pub = await (await fetch(`${BASE}/api/public`, { headers: { "user-agent": ANDROID } })).json();
verifie("Android reconnu comme Jerome", pub.suggested?.id === "jerome", pub.suggested?.name);
verifie("Notifications configurees", pub.pushReady === true);

const pubIos = await (
  await fetch(`${BASE}/api/public`, { headers: { "user-agent": IPHONE } })
).json();
verifie("iPhone reconnu comme Laurine", pubIos.suggested?.id === "laurine", pubIos.suggested?.name);

console.log("\n--- Base de donnees et session ---");
const refus = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ pin: "0000", user: "jerome" }),
});
verifie("Mauvais code refuse", refus.status === 401, `HTTP ${refus.status}`);

const code = process.env.APP_PIN;
if (!code) {
  console.log("\n  (APP_PIN absent de l'environnement : lecture de l'etat non testee)");
} else {
  const connexion = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": ANDROID },
    body: JSON.stringify({ pin: code, user: "jerome" }),
  });
  const session = await connexion.json();
  verifie("Connexion acceptee", Boolean(session.token), session.name);

  if (session.token) {
    const etat = await (
      await fetch(`${BASE}/api/state`, { headers: { authorization: `Bearer ${session.token}` } })
    ).json();
    verifie("Les tables D1 repondent", Array.isArray(etat.history), `${etat.history?.length} entrees`);
    verifie("Reglement charge", etat.reglement?.length === 11, `${etat.reglement?.length} regles`);
    verifie("Taches a declarer", etat.declarable?.length > 0, etat.declarable?.map((d) => d.id).join(", "));
    verifie("Cle publique de notification servie", (etat.vapidPublicKey || "").length > 80);

    const invite = await (
      await fetch(`${BASE}/api/invite`, { headers: { authorization: `Bearer ${session.token}` } })
    ).json();
    verifie("Lien d'invitation", invite.url?.startsWith(BASE), invite.url);
  }
}

console.log(echecs === 0 ? "\nL'APP EST EN LIGNE ET FONCTIONNELLE\n" : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
