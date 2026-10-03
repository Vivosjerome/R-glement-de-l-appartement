import { TASKS_BY_ID } from "../shared/tasks.js";

/**
 * Acces aux donnees D1. Les valeurs simples (reglages, echeances, rotation)
 * sont chargees d'un bloc au debut de chaque requete puis reecrites en une
 * seule operation groupee : avec deux utilisateurs, cela evite une dizaine
 * d'allers-retours pour rien.
 */
export class Store {
  constructor(db) {
    this.db = db;
    this.values = {};
    this.dirty = new Set();
  }

  async load() {
    const { results } = await this.db.prepare("SELECT k, v FROM state").all();
    this.values = Object.fromEntries(results.map((r) => [r.k, JSON.parse(r.v)]));
    this.dirty.clear();
    return this;
  }

  get(key, fallback) {
    return this.values[key] ?? fallback;
  }

  set(key, value) {
    this.values[key] = value;
    this.dirty.add(key);
  }

  /** Modifie un dictionnaire indexe par identifiant de tache. */
  setIn(key, field, value) {
    const map = { ...this.get(key, {}) };
    map[field] = value;
    this.set(key, map);
  }

  async flush() {
    if (!this.dirty.size) return;
    const stmt = this.db.prepare(
      "INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    );
    await this.db.batch(
      [...this.dirty].map((k) => stmt.bind(k, JSON.stringify(this.values[k]))),
    );
    this.dirty.clear();
  }

  // ------------------------------------------------------------ instances
  /** Les libelles viennent du reglement, pas de la base. */
  static hydrate(row) {
    const def = TASKS_BY_ID[row.def_id];
    return {
      id: row.id,
      defId: row.def_id,
      label: def?.label || row.def_id,
      emoji: def?.emoji || "\u{2753}",
      detail: def?.detail || null,
      assign: def?.assign || null,
      days: def?.schedule?.days || null,
      assignee: row.assignee,
      kind: row.kind,
      createdAt: row.created_at,
      dueAt: row.due_at,
    };
  }

  async instances() {
    const { results } = await this.db
      .prepare("SELECT * FROM instances ORDER BY due_at")
      .all();
    return results.map(Store.hydrate);
  }

  async instance(id) {
    const row = await this.db.prepare("SELECT * FROM instances WHERE id = ?").bind(id).first();
    return row ? Store.hydrate(row) : null;
  }

  async openFor(defId) {
    const row = await this.db
      .prepare("SELECT * FROM instances WHERE def_id = ?")
      .bind(defId)
      .first();
    return row ? Store.hydrate(row) : null;
  }

  async addInstance(instance) {
    await this.db
      .prepare(
        "INSERT INTO instances (id, def_id, assignee, kind, created_at, due_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(
        instance.id,
        instance.defId,
        instance.assignee,
        instance.kind,
        instance.createdAt,
        instance.dueAt,
      )
      .run();
  }

  async removeInstance(id) {
    await this.db.prepare("DELETE FROM instances WHERE id = ?").bind(id).run();
  }

  // -------------------------------------------------------------- historique
  async addHistory(entry) {
    await this.db
      .prepare("INSERT INTO history (id, def_id, label, emoji, done_by, done_at) VALUES (?,?,?,?,?,?)")
      .bind(entry.id, entry.defId, entry.label, entry.emoji, entry.doneBy, entry.doneAt)
      .run();
  }

  async history(limit = 40) {
    const { results } = await this.db
      .prepare("SELECT * FROM history ORDER BY done_at DESC LIMIT ?")
      .bind(limit)
      .all();
    return results.map((r) => ({
      id: r.id,
      defId: r.def_id,
      label: r.label,
      emoji: r.emoji,
      doneBy: r.done_by,
      doneAt: r.done_at,
    }));
  }

  /** Nombre de taches terminees par personne sur les N derniers jours. */
  async counts(users, days) {
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const { results } = await this.db
      .prepare("SELECT done_by, COUNT(*) AS n FROM history WHERE done_at >= ? GROUP BY done_by")
      .bind(since)
      .all();
    const byUser = Object.fromEntries(results.map((r) => [r.done_by, r.n]));
    return Object.fromEntries(users.map((u) => [u, byUser[u] || 0]));
  }

  // ------------------------------------------------------------ abonnements
  async subscriptions(users) {
    const list = Array.isArray(users) ? users : [users];
    const { results } = await this.db
      .prepare(`SELECT * FROM subscriptions WHERE user IN (${list.map(() => "?").join(",")})`)
      .bind(...list)
      .all();
    return results;
  }

  async addSubscription(user, sub) {
    await this.db
      .prepare(
        `INSERT INTO subscriptions (endpoint, user, p256dh, auth, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(endpoint) DO UPDATE SET user = excluded.user, p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .bind(sub.endpoint, user, sub.keys.p256dh, sub.keys.auth, new Date().toISOString())
      .run();
  }

  async removeSubscriptions(endpoints) {
    if (!endpoints.length) return;
    await this.db
      .prepare(`DELETE FROM subscriptions WHERE endpoint IN (${endpoints.map(() => "?").join(",")})`)
      .bind(...endpoints)
      .run();
  }

  async hasSubscription(user) {
    const row = await this.db
      .prepare("SELECT 1 FROM subscriptions WHERE user = ? LIMIT 1")
      .bind(user)
      .first();
    return Boolean(row);
  }
}
