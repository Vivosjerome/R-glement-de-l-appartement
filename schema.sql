-- Base D1 (SQLite). A appliquer avec :
--   npx wrangler d1 execute regles --remote --file=schema.sql

-- Valeurs simples serialisees en JSON : reglages, prochaines echeances,
-- dernier a avoir fait chaque tache, secret du lien d'invitation.
CREATE TABLE IF NOT EXISTS state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user       TEXT NOT NULL,
  platform   TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user       TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user);

-- Taches en cours. Le libelle se retrouve depuis def_id, inutile de le stocker.
CREATE TABLE IF NOT EXISTS instances (
  id         TEXT PRIMARY KEY,
  def_id     TEXT NOT NULL,
  assignee   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  due_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inst_def ON instances(def_id);

-- Historique : on fige le libelle, pour qu'une tache retiree du reglement
-- reste lisible dans le passe.
CREATE TABLE IF NOT EXISTS history (
  id      TEXT PRIMARY KEY,
  def_id  TEXT NOT NULL,
  label   TEXT NOT NULL,
  emoji   TEXT NOT NULL,
  done_by TEXT NOT NULL,
  done_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hist_done ON history(done_at DESC);

-- Metadonnees des photos ; l'image elle-meme vit dans le KV.
CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  from_user  TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_date ON photos(created_at DESC);
