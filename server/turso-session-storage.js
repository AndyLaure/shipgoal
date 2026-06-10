// Session-Speicher für Shopify-OAuth-Sessions.
// Produktion: Turso (libsql). Fallback ohne ENV-Variablen: In-Memory (nur lokal sinnvoll,
// auf Render gehen In-Memory-Sessions bei jedem Deploy/Neustart verloren).
const { Session } = require('@shopify/shopify-api');

function reviveSession(payload) {
  const obj = JSON.parse(payload);
  if (obj.expires) obj.expires = new Date(obj.expires);
  if (obj.refreshTokenExpires) obj.refreshTokenExpires = new Date(obj.refreshTokenExpires);
  return new Session(obj);
}

class TursoSessionStorage {
  constructor(url, authToken) {
    const { createClient } = require('@libsql/client');
    this.client = createClient({ url, authToken });
    this.ready = this.client.execute(
      `CREATE TABLE IF NOT EXISTS shipgoal_sessions (
         id TEXT PRIMARY KEY,
         shop TEXT NOT NULL,
         payload TEXT NOT NULL
       )`
    );
  }

  async storeSession(session) {
    await this.ready;
    await this.client.execute({
      sql: `INSERT INTO shipgoal_sessions (id, shop, payload) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET shop = excluded.shop, payload = excluded.payload`,
      args: [session.id, session.shop, JSON.stringify(session.toObject())],
    });
    return true;
  }

  async loadSession(id) {
    await this.ready;
    const r = await this.client.execute({
      sql: `SELECT payload FROM shipgoal_sessions WHERE id = ?`,
      args: [id],
    });
    if (!r.rows.length) return undefined;
    return reviveSession(r.rows[0].payload);
  }

  async deleteSession(id) {
    await this.ready;
    await this.client.execute({
      sql: `DELETE FROM shipgoal_sessions WHERE id = ?`,
      args: [id],
    });
    return true;
  }

  async deleteSessions(ids) {
    for (const id of ids) await this.deleteSession(id);
    return true;
  }

  async findSessionsByShop(shop) {
    await this.ready;
    const r = await this.client.execute({
      sql: `SELECT payload FROM shipgoal_sessions WHERE shop = ?`,
      args: [shop],
    });
    return r.rows.map((row) => reviveSession(row.payload));
  }
}

class MemorySessionStorage {
  constructor() {
    this.map = new Map();
  }
  async storeSession(session) {
    this.map.set(session.id, session);
    return true;
  }
  async loadSession(id) {
    return this.map.get(id);
  }
  async deleteSession(id) {
    this.map.delete(id);
    return true;
  }
  async deleteSessions(ids) {
    ids.forEach((id) => this.map.delete(id));
    return true;
  }
  async findSessionsByShop(shop) {
    return [...this.map.values()].filter((s) => s.shop === shop);
  }
}

module.exports = { TursoSessionStorage, MemorySessionStorage };
