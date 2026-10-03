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

/**
 * `interactif` rend la main au terminal : indispensable pour `deploy`, qui
 * propose de creer le sous-domaine workers.dev et renonce sans rien demander
 * si sa sortie est capturee.
 */
function wrangler(args, { input, silencieux, interactif } = {}) {
  if (interactif) {
    const res = spawnSync("npx", ["wrangler", ...args], { shell: true, stdio: "inherit" });
    return { code: res.status, sortie: "" };
  }
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

/** Les commandes `--json` entourent parfois le JSON de lignes de journal. */
function tableauJson(sortie) {
  const debut = sortie.indexOf("[");
  const fin = sortie.lastIndexOf("]");
  if (debut === -1 || fin < debut) return [];
  try {
    return JSON.parse(sortie.slice(debut, fin + 1));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- connexion
etape("Verification de la connexion a Cloudflare");
const qui = wrangler(["whoami"], { silencieux: true });
if (qui.code !== 0 || /not authenticated|You are not logged in/i.test(qui.sortie)) {
  console.error("\nTu n'es pas connecte. Lance d'abord :\n\n    npx wrangler login\n");
  process.exit(1);
}
const compte = qui.sortie.match(/associated with the email (\S+@[\w.-]+\.\w+)/i);
console.log(`   Connecte${compte ? ` (${compte[1]})` : ""}.`);

let toml = readFileSync(TOML, "utf8");

// On interroge toujours le compte plutot que de se fier a ce que contient
// wrangler.toml : `wrangler dev` peut y avoir ecrit des identifiants locaux,
// qui n'existent pas chez Cloudflare et feraient echouer la mise en ligne.

// ---------------------------------------------------------- base de donnees
etape("Base de donnees D1");
let idBase = tableauJson(wrangler(["d1", "list", "--json"], { silencieux: true }).sortie).find(
  (b) => b.name === BASE_D1,
)?.uuid;

if (idBase) {
  console.log(`   Base "${BASE_D1}" deja presente.`);
} else {
  const creation = wrangler(["d1", "create", BASE_D1]);
  idBase =
    creation.sortie.match(/database_id\s*=\s*"([^"]+)"/)?.[1] ||
    creation.sortie.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  if (!idBase) throw new Error("identifiant de base introuvable dans la reponse de Cloudflare");
  console.log(`   Base "${BASE_D1}" creee.`);
}
toml = toml.replace(/^database_id\s*=\s*"[^"]*"/m, `database_id = "${idBase}"`);
writeFileSync(TOML, toml);

// -------------------------------------------------------- stockage des photos
etape("Stockage des photos (KV)");
// Cloudflare prefixe le titre du nom du Worker : "regles-appartement-PHOTOS".
let idKv = tableauJson(wrangler(["kv", "namespace", "list"], { silencieux: true }).sortie).find(
  (n) => n.title?.endsWith(KV_BINDING) && !/preview/i.test(n.title),
)?.id;

if (idKv) {
  console.log("   Espace deja present.");
} else {
  const creation = wrangler(["kv", "namespace", "create", KV_BINDING]);
  idKv =
    creation.sortie.match(/\bid\s*=\s*"([0-9a-f]{32})"/i)?.[1] ||
    creation.sortie.match(/"id"\s*:\s*"([0-9a-f]{32})"/i)?.[1];
  if (!idKv) throw new Error("identifiant KV introuvable dans la reponse de Cloudflare");
  console.log("   Espace cree.");
}
toml = toml.replace(/^id\s*=\s*"[^"]*"/m, `id = "${idKv}"`);
writeFileSync(TOML, toml);

// ------------------------------------------------------------------ schema
etape("Creation des tables");
wrangler(["d1", "execute", BASE_D1, "--remote", "--file=schema.sql", "--yes"]);
console.log("   Tables en place.");

// ------------------------------------------------------------------ secrets
// Cloudflare ne laisse jamais relire un secret. C'est donc .dev.vars, le
// fichier de secrets locaux deja ignore par git, qui fait foi : sans cette
// reference une relance regenererait des cles, et il faudrait reactiver les
// notifications sur les deux telephones.
const DEV_VARS = ".dev.vars";

function lire(fichier, cle) {
  if (!existsSync(fichier)) return null;
  return readFileSync(fichier, "utf8").match(new RegExp(`^${cle}=(.+)$`, "m"))?.[1]?.trim() || null;
}

function memorise(cle, valeur) {
  const avant = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, "utf8") : "";
  const ligne = `${cle}=${valeur}`;
  const motif = new RegExp(`^${cle}=.*$`, "m");
  writeFileSync(
    DEV_VARS,
    motif.test(avant)
      ? avant.replace(motif, ligne)
      : `${avant}${!avant || avant.endsWith("\n") ? "" : "\n"}${ligne}\n`,
  );
}

/**
 * Valeur connue localement, sinon celle qu'on vient de fabriquer. On ne
 * regarde pas .env ici : c'est la configuration du serveur Node local, et son
 * code d'acces par defaut n'a rien a faire en production.
 */
function secret(cle, valeur) {
  const retenue = process.env[cle] || lire(DEV_VARS, cle) || valeur;
  wrangler(["secret", "put", cle], { input: `${retenue}\n` });
  memorise(cle, retenue);
  return retenue;
}

/**
 * Les cles VAPID, elles, sont partagees avec le serveur local : les memes des
 * deux cotes, les telephones restent abonnes sans rien reactiver. Les deux
 * moities doivent venir du meme fichier, car associer une cle publique a une
 * privee depareillee rendrait tout envoi invalide sans message comprehensible.
 */
function clesVapid() {
  for (const fichier of [".env", DEV_VARS]) {
    const publicKey = lire(fichier, "VAPID_PUBLIC_KEY");
    const privateKey = lire(fichier, "VAPID_PRIVATE_KEY");
    if (publicKey && privateKey) return { paire: { publicKey, privateKey }, source: fichier };
  }
  return { paire: webpush.generateVAPIDKeys(), source: null };
}

etape("Cles de notification et code d'acces");
const { paire, source } = clesVapid();
for (const [cle, valeur] of Object.entries({
  VAPID_PUBLIC_KEY: paire.publicKey,
  VAPID_PRIVATE_KEY: paire.privateKey,
})) {
  wrangler(["secret", "put", cle], { input: `${valeur}\n` });
  memorise(cle, valeur);
}
secret("VAPID_SUBJECT", "mailto:regles@appartement.local");
console.log(`   Cles ${source ? `reprises de ${source}` : "generees"}.`);

const code = secret("APP_PIN", String(Math.floor(1000 + Math.random() * 9000)));
console.log(`   Code d'acces : ${code}`);

// -------------------------------------------------------------- mise en ligne
// Les icones sont generees, donc absentes du depot : sans elles l'app ne
// s'installe pas sur l'ecran d'accueil, et c'est tout l'interet d'une PWA.
if (!existsSync("public/icons/icon-512.png")) {
  etape("Generation des icones");
  spawnSync("node", ["scripts/make-icons.js"], { shell: true, stdio: "inherit" });
}

etape("Mise en ligne");
console.log(`   Si Cloudflare propose d'enregistrer un sous-domaine workers.dev,
   reponds oui : c'est l'adresse publique de l'app. N'importe quel nom
   libre convient, il n'apparait que dans l'URL.
`);

// En mode interactif : sans terminal, wrangler refuse la question du
// sous-domaine et echoue au lieu de le creer.
const deploiement = wrangler(["deploy"], { interactif: true });

if (deploiement.code !== 0) {
  console.error(`
${"\u2500".repeat(60)}
  La mise en ligne a echoue, mais tout le reste est en place : la base,
  le stockage, les cles et les fichiers sont deja chez Cloudflare.

  Si le message parle de "workers.dev subdomain", c'est qu'il manque
  l'adresse publique du compte. Ouvre le lien affiche ci-dessus, choisis
  un nom, puis relance :

      npm run deploy

  Le script reprendra sans rien recreer.
${"\u2500".repeat(60)}
`);
  process.exit(1);
}

console.log("\n" + "\u2500".repeat(60));
console.log("  C'est en ligne. L'adresse est celle affichee juste au-dessus.");
if (code) console.log(`\n  Code d'acces : ${code}`);
console.log(`
  Sur ton Android : ouvre l'adresse dans Chrome, menu > Ajouter a
  l'ecran d'accueil, puis active les notifications dans l'app.

  Pour Laurine : depuis l'app, bouton "Inviter" ; envoie-lui le lien.
  Elle doit l'ouvrir dans Safari, Partager > Sur l'ecran d'accueil,
  et lancer l'app DEPUIS l'icone (iOS ne donne les notifications
  qu'aux applications installees).
`);
console.log("\u2500".repeat(60) + "\n");
