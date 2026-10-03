// Web Push sans dependance Node : la librairie `web-push` s'appuie sur le
// module crypto de Node, absent des Workers. On reimplemente donc les deux
// specifications concernees avec l'API WebCrypto standard.
//
//   RFC 8292 (VAPID)  : un JWT signe en ES256 identifie l'expediteur.
//   RFC 8291 + 8188   : le contenu est chiffre en aes128gcm pour que le
//                       service de push d'Apple ou Google ne puisse pas le lire.

const enc = new TextEncoder();

// ------------------------------------------------------------------ base64url
export function b64urlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export function bytesToB64url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// -------------------------------------------------------------------- VAPID
/**
 * La cle privee VAPID est un scalaire de 32 octets. WebCrypto veut un JWK,
 * et la cle publique (point non compresse de 65 octets) fournit x et y.
 */
async function importVapidKey(publicKey, privateKey) {
  const pub = b64urlToBytes(publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("Cle VAPID publique invalide (point non compresse attendu)");
  }
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      d: bytesToB64url(b64urlToBytes(privateKey)),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function vapidHeader(endpoint, { publicKey, privateKey, subject }) {
  const audience = new URL(endpoint).origin;
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64url(
    enc.encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: subject,
      }),
    ),
  );

  const key = await importVapidKey(publicKey, privateKey);
  // WebCrypto rend la signature ECDSA au format brut r||s, exactement ce
  // qu'attend JOSE. Pas de conversion DER a faire.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    enc.encode(`${header}.${payload}`),
  );

  return `vapid t=${header}.${payload}.${bytesToB64url(signature)}, k=${publicKey}`;
}

// --------------------------------------------------------------- chiffrement
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

const labelInfo = (label) => concat(enc.encode(label), new Uint8Array([0]));

/**
 * Chiffre le contenu pour un abonnement donne, selon RFC 8291.
 * Renvoie le corps complet : en-tete aes128gcm suivi du texte chiffre.
 */
export async function encryptPayload(plaintext, { p256dh, auth }) {
  const uaPublic = b64urlToBytes(p256dh); // cle publique du navigateur
  const authSecret = b64urlToBytes(auth);

  // Paire ephemere : une nouvelle a chaque envoi.
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256),
  );

  // Le secret d'authentification de l'abonnement sert de sel pour lier
  // la cle derivee a ce navigateur precis.
  const keyInfo = concat(labelInfo("WebPush: info"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, labelInfo("Content-Encoding: aes128gcm"), 16);
  const nonce = await hkdf(salt, ikm, labelInfo("Content-Encoding: nonce"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 marque la fin du dernier (et unique) enregistrement.
  const padded = concat(enc.encode(plaintext), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded),
  );

  // En-tete RFC 8188 : sel, taille d'enregistrement, longueur et valeur du keyid.
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  const header = concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic);

  return concat(header, ciphertext);
}

// ------------------------------------------------------------------- envoi
/**
 * @returns {Promise<{ok: boolean, status: number, gone: boolean}>}
 */
export async function sendPush(subscription, payload, vapid, options = {}) {
  const body = await encryptPayload(payload, subscription);
  const auth = await vapidHeader(subscription.endpoint, vapid);

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(options.ttl ?? 3600),
      Urgency: options.urgency || "normal",
    },
    body,
  });

  return {
    ok: res.ok,
    status: res.status,
    // 404/410 : l'abonnement n'existe plus cote navigateur, a purger.
    gone: res.status === 404 || res.status === 410,
  };
}
