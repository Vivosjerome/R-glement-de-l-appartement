// Genere les icones PNG de la PWA sans aucune dependance :
// on encode le PNG a la main (chunks + zlib natif de Node).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // profondeur 8 bits
  ihdr[9] = 6; // RGBA
  // Chaque scanline est prefixee par son octet de filtre (0 = aucun).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smoothstep = (edge, width, x) => clamp01(0.5 - (x - edge) / width);

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.22; // rayon des coins arrondis
  const stroke = size * 0.085;

  // Trace de la coche, en coordonnees relatives a la taille.
  const seg = [
    [0.27, 0.52, 0.43, 0.68],
    [0.43, 0.68, 0.74, 0.33],
  ].map((s) => s.map((v) => v * size));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // Masque du carre aux coins arrondis.
      const qx = Math.max(Math.abs(x + 0.5 - size / 2) - (size / 2 - r), 0);
      const qy = Math.max(Math.abs(y + 0.5 - size / 2) - (size / 2 - r), 0);
      const alpha = smoothstep(r, 1.5, Math.hypot(qx, qy));

      // Degrade diagonal violet.
      const t = (x / size + y / size) / 2;
      let cr = Math.round(124 + (91 - 124) * t);
      let cg = Math.round(108 + (74 - 108) * t);
      let cb = Math.round(255 + (209 - 255) * t);

      const d = Math.min(...seg.map((s) => distToSegment(x + 0.5, y + 0.5, ...s)));
      const mark = smoothstep(stroke / 2, 1.5, d);
      cr = Math.round(cr + (255 - cr) * mark);
      cg = Math.round(cg + (255 - cg) * mark);
      cb = Math.round(cb + (255 - cb) * mark);

      buf[i] = cr;
      buf[i + 1] = cg;
      buf[i + 2] = cb;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return buf;
}

function drawOpaque(size, bg = [17, 19, 26]) {
  // iOS n'aime pas la transparence sur l'apple-touch-icon : on aplatit.
  const buf = draw(size);
  for (let i = 0; i < buf.length; i += 4) {
    const a = buf[i + 3] / 255;
    for (let c = 0; c < 3; c++) buf[i + c] = Math.round(buf[i + c] * a + bg[c] * (1 - a));
    buf[i + 3] = 255;
  }
  return buf;
}

fs.mkdirSync(OUT, { recursive: true });

for (const [name, size, opaque] of [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["apple-touch-icon.png", 180, true],
]) {
  const pixels = opaque ? drawOpaque(size) : draw(size);
  fs.writeFileSync(path.join(OUT, name), encodePNG(size, pixels));
  console.log(`  ecrit public/icons/${name}`);
}
