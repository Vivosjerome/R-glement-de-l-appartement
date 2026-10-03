import { config } from "./config.js";

/**
 * Devine la plateforme a partir des en-tetes de la requete.
 * On croise le User-Agent et les Client Hints : Chrome envoie
 * Sec-CH-UA-Platform par defaut, Safari non, d'ou les deux sources.
 */
export function detectPlatform(req) {
  const hint = (req.get("sec-ch-ua-platform") || "").replace(/"/g, "").toLowerCase();
  if (hint === "android") return "android";
  if (hint === "ios") return "ios";

  const ua = req.get("user-agent") || "";
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";

  // iPadOS 13+ se fait passer pour un Mac de bureau : seul le tactile le trahit,
  // et ca ne se voit que cote navigateur. On laisse le client completer.
  if (/macintosh/i.test(ua)) return "mac-or-ipad";
  if (/windows/i.test(ua)) return "windows";
  return "unknown";
}

/**
 * Renvoie l'utilisateur correspondant a la plateforme, uniquement si
 * la correspondance est sans ambiguite (un seul occupant sur cet OS).
 */
export function suggestUser(platform) {
  const matches = config.users.filter((u) => u.platform === platform);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Vrai uniquement si la requete vient de la machine qui heberge le serveur.
 *
 * On lit l'adresse de la socket et non req.ip : derriere "trust proxy",
 * req.ip provient de X-Forwarded-For, que n'importe qui peut falsifier.
 * Le tunnel tourne lui aussi en local, mais il ajoute toujours les en-tetes
 * de transfert : leur absence est donc ce qui signe un acces vraiment local.
 */
export function isLocalRequest(req) {
  const addr = (req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  const loopback = addr === "127.0.0.1" || addr === "::1";
  const forwarded = req.get("x-forwarded-for") || req.get("cf-connecting-ip");
  return loopback && !forwarded;
}
