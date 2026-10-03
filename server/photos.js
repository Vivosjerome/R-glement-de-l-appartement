import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { db, save } from "./store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PHOTO_DIR = path.join(ROOT, "data", "photos");

const MAX = 60; // au-dela, les plus anciennes sont effacees du disque

export function savePhoto(buffer, { from, note }) {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });

  const id = randomUUID();
  fs.writeFileSync(path.join(PHOTO_DIR, `${id}.jpg`), buffer);

  const photo = {
    id,
    from,
    note: (note || "").slice(0, 140),
    createdAt: new Date().toISOString(),
  };
  db.photos.unshift(photo);

  for (const vieille of db.photos.slice(MAX)) {
    fs.rm(path.join(PHOTO_DIR, `${vieille.id}.jpg`), { force: true }, () => {});
  }
  db.photos = db.photos.slice(0, MAX);

  save();
  return photo;
}

/** Le nom de fichier est un UUID : il sert de cle d'acces a l'image. */
export function photoPath(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const file = path.join(PHOTO_DIR, `${id}.jpg`);
  return fs.existsSync(file) ? file : null;
}

export function deletePhoto(id) {
  const before = db.photos.length;
  db.photos = db.photos.filter((p) => p.id !== id);
  if (db.photos.length === before) return false;

  const file = photoPath(id);
  if (file) fs.rmSync(file, { force: true });
  save();
  return true;
}
