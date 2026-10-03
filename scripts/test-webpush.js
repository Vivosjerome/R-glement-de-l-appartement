// Verifie l'implementation Web Push en rejouant le role du navigateur :
// on fabrique un abonnement, on chiffre comme le serveur, puis on dechiffre
// avec la cle privee du "navigateur". Si le texte revient intact, la
// derivation de cles et le chiffrement sont conformes a la RFC 8291.
import {
  encryptPayload,
  b64urlToBytes,
  bytesToB64url,
} from "../worker/webpush.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8),
  );
}

const labelInfo = (l) => concat(enc.encode(l), new Uint8Array([0]));

// ------------------------------- cote "navigateur" : creation de l'abonnement
const uaKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
  "deriveBits",
]);
const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", uaKeys.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));

const subscription = {
  endpoint: "https://web.push.apple.com/exemple",
  p256dh: bytesToB64url(uaPublic),
  auth: bytesToB64url(authSecret),
};

// ------------------------------------------------ cote serveur : chiffrement
const message = JSON.stringify({
  title: "\u{1F408} Litiere",
  body: "Jerome a fait : Litiere. A toi lundi.",
});
const body = await encryptPayload(message, subscription);
console.log(`  message clair    : ${message.length} octets`);
console.log(`  corps chiffre    : ${body.length} octets`);

// ---------------------------- cote navigateur : dechiffrement du corps recu
const salt = body.slice(0, 16);
const idlen = body[20];
const asPublic = body.slice(21, 21 + idlen);
const ciphertext = body.slice(21 + idlen);
console.log(`  taille du keyid  : ${idlen} (65 attendu pour un point P-256)`);

const asKey = await crypto.subtle.importKey(
  "raw",
  asPublic,
  { name: "ECDH", namedCurve: "P-256" },
  false,
  [],
);
const shared = new Uint8Array(
  await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaKeys.privateKey, 256),
);

const ikm = await hkdf(
  authSecret,
  shared,
  concat(labelInfo("WebPush: info"), uaPublic, asPublic),
  32,
);
const cek = await hkdf(salt, ikm, labelInfo("Content-Encoding: aes128gcm"), 16);
const nonce = await hkdf(salt, ikm, labelInfo("Content-Encoding: nonce"), 12);

const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
const plain = new Uint8Array(
  await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ciphertext),
);

const recovered = dec.decode(plain.slice(0, -1)); // on retire le delimiteur 0x02
console.log(`  delimiteur final : 0x0${plain[plain.length - 1]} (0x02 attendu)`);
console.log(`\n  dechiffre -> ${recovered}`);
console.log(`\n  CHIFFREMENT : ${recovered === message ? "CONFORME" : "ECHEC"}`);

// -------------------------------------------- verification de la signature VAPID
const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", vapidPair.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);

const { sendPush } = await import("../worker/webpush.js");
let capturedAuth = null;
globalThis.fetch = async (url, init) => {
  capturedAuth = init.headers.Authorization;
  return new Response(null, { status: 201 });
};

const res = await sendPush(subscription, message, {
  publicKey: bytesToB64url(rawPub),
  privateKey: jwk.d,
  subject: "mailto:test@example.com",
});

const [h, p, s] = capturedAuth.match(/t=([^.]+)\.([^.]+)\.([^,]+)/).slice(1);
const valide = await crypto.subtle.verify(
  { name: "ECDSA", hash: "SHA-256" },
  vapidPair.publicKey,
  b64urlToBytes(s),
  enc.encode(`${h}.${p}`),
);
const claims = JSON.parse(dec.decode(b64urlToBytes(p)));

console.log(`\n  JWT audience     : ${claims.aud} (origine de l'endpoint)`);
console.log(`  JWT expiration   : dans ${Math.round((claims.exp - Date.now() / 1000) / 3600)} h`);
console.log(`  requete envoyee  : HTTP ${res.status}`);
console.log(`\n  SIGNATURE VAPID : ${valide ? "VALIDE" : "INVALIDE"}`);
