// Installation complete sur Cloudflare : base de donnees, stockage des
// photos, cles de notification, mise en ligne. A lancer apres
// `npx wrangler login`. Le script est rejouable : il ne recree pas ce qui
// existe deja.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import webpush from "web-push";

const TOML = "wrangler.toml";
const BASE_D1 = "regles";
const KV_BINDING = "PHOTOS";

function wrangler(args, { input, silencieux } = {}) {
  const res = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    shell: true,
    input,
  });
  const sortie = `${res.stdout || ""}${res.stderr || ""}`;
  if (!silencieux && res.status !== 0) {
    console.error(sortie.trim());
    throw new Error(`echec de : wrangler ${args.join(" ")}`);
  }
  return { code: res.status, sortie };
}

function etape(titre) {
  console.log(`\n\u2500\u2500 ${titre}`);
}

// ---------------------------------------------------------------- connexion
etape("Verification de la connexion a Cloudflare");
const qui = wrangler(["whoami"], { silencieux: true });
if (qui.code !== 0 || /not authenticated|You are not logged in/i.test(qui.sortie)) {
  console.error("\nTu n'es pas connecte. Lance d'abord :\n\n    npx wrangler login\n");
  process.exit(1);
}
const compte = qui.sortie.match(/associated with the email ([^\s.]+@[^\s.]+\.\S+)/i);
console.log(`   Connecte${compte ? ` (${compte[1]})` : ""}.`);

let toml = readFileSync(TOML, "utf8");

// ---------------------------------------------------------- base de donnees
etape("Base de donnees D1");
let idBase = toml.match(/database_id\s*=\s*"([^"]+)"/)?.[1];
if (idBase?.startsWith("a-remplacer")) {
  // Peut-etre creee lors d'une tentative precedente.
  const liste = wrangler(["d1", "list", "--json"], { silencieux: true });
  const existante = JSON.parse(liste.sortie.slice(liste.sortie.indexOf("[")) || "[]").find(
    (b) => b.name === BASE_D1,
  );
  if (existante) {
    idBase = existante.uuid;
    console.log(`   Base "${BASE_D1}" deja presente.`);
  } else {
    const creation = wrangler(["d1", "create", BASE_D1]);
    idBase = creation.sortie.match(/database_id\s*=\s*"([^"]+)"/)?.[1]
      || creation.sortie.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    if (!idBase) throw new Error("identifiant de base introuvable dans la reponse de Cloudflare");
    console.log(`   Base "${BASE_D1}" creee.`);
  }
  toml = toml.replace(/database_id\s*=\s*"[^"]+"/, `database_id = "${idBase}"`);
  writeFileSync(TOML, toml);
} else {
  console.log(`   Deja configuree.`);
}

// -------------------------------------------------------- stockage des photos
etape("Stockage des photos (KV)");
let idKv = toml.match(/\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([^"]+)"/)?.[1];
if (idKv?.startsWith("a-remplacer")) {
  const liste = wrangler(["kv", "namespace", "list"], { silencieux: true });
  const attendu = new RegExp(`"title"\\s*:\\s*"[^"]*${KV_BINDING}[^"]*"`, "i");
  const existant = liste.sortie
    .split(/\},\s*\{/)
    .find((bloc) => attendu.test(`{${bloc}}`))
    ?.match(/"id"\s*:\s*"([0-9a-f]{32})"/i)?.[1];
  if (existant) {
    idKv = existant;
    console.log("   Espace deja present.");
  } else {
    const creation = wrangler(["kv", "namespace", "create", KV_BINDING]);
    idKv = creation.sortie.match(/id\s*=\s*"([0-9a-f]{32})"/i)?.[1]
      || creation.sortie.match(/"id"\s*:\s*"([0-9a-f]{32})"/i)?.[1];
    if (!idKv) throw new Error("identifiant KV introuvable dans la reponse de Cloudflare");
    console.log("   Espace cree.");
  }
  toml = toml.replace(
    /(\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*)"[^"]+"/,
    `$1"${idKv}"`,
  );
  writeFileSync(TOML, toml);
} else {
  console.log("   Deja configure.");
}

// ------------------------------------------------------------------ schema
etape("Creation des tables");
wrangler(["d1", "execute", BASE_D1, "--remote", "--file=schema.sql", "--yes"]);
console.log("   Tables en place.");

// ------------------------------------------------------------------ secrets
etape("Cles de notification et code d'acces");
const dejaPosees = wrangler(["secret", "list"], { silencieux: true }).sortie;
const manque = (nom) => !new RegExp(`"name"\\s*:\\s*"${nom}"`).test(dejaPosees);

if (manque("VAPID_PUBLIC_KEY") || manque("VAPID_PRIVATE_KEY")) {
  // Des cles neuves obligeraient a reactiver les notifications sur les deux
  // telephones : on reutilise celles du .env si elles existent.
  let cles = null;
  if (existsSync(".env")) {
    const env = readFileSync(".env", "utf8");
    const pub = env.match(/^VAPID_PUBLIC_KEY=(.+)$/m)?.[1]?.trim();
    const priv = env.match(/^VAPID_PRIVATE_KEY=(.+)$/m)?.[1]?.trim();
    if (pub && priv) {
      cles = { publicKey: pub, privateKey: priv };
      console.log("   Cles reprises du fichier .env.");
    }
  }
  if (!cles) {
    cles = webpush.generateVAPIDKeys();
    console.log("   Nouvelles cles generees.");
  }
  wrangler(["secret", "put", "VAPID_PUBLIC_KEY"], { input: `${cles.publicKey}\n` });
  wrangler(["secret", "put", "VAPID_PRIVATE_KEY"], { input: `${cles.privateKey}\n` });
  wrangler(["secret", "put", "VAPID_SUBJECT"], { input: "mailto:regles@appartement.local\n" });
} else {
  console.log("   Cles deja en place.");
}

let code = process.env.APP_PIN;
if (manque("APP_PIN")) {
  if (!code) code = String(Math.floor(1000 + Math.random() * 9000));
  wrangler(["secret", "put", "APP_PIN"], { input: `${code}\n` });
  console.log(`   Code d'acces : ${code}`);
} else {
  console.log("   Code d'acces deja defini.");
}

// -------------------------------------------------------------- mise en ligne
etape("Mise en ligne");
const deploiement = wrangler(["deploy"]);
const url = deploiement.sortie.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];

console.log("\n" + "\u2500".repeat(60));
console.log("  C'est en ligne.");
if (url) console.log(`\n  Adresse : ${url}`);
if (code) console.log(`  Code    : ${code}`);
console.log(`
  Sur ton Android : ouvre l'adresse dans Chrome, menu > Ajouter a
  l'ecran d'accueil, puis active les notifications dans l'app.

  Pour Laurine : depuis l'app, bouton "Inviter" ; envoie-lui le lien.
  Elle doit l'ouvrir dans Safari, Partager > Sur l'ecran d'accueil,
  et lancer l'app DEPUIS l'icone (iOS ne donne les notifications
  qu'aux applications installees).
`);
console.log("\u2500".repeat(60) + "\n");
