// lib/db.js — SQLite via sql.js (pure WASM, no native build needed)
// Initialized once at startup; exports synchronous-style methods after init.

const initSqlJs = require('sql.js');
const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'pisowifi.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db          = null;
let ready        = false;
let _inTx        = false;   // suppress mid-transaction persist() calls

// ── Persist to disk after writes ──────────────────────────────────────────────

function persist() {
  if (!_db || _inTx) return;   // skip during transactions — flush at COMMIT
  const buf = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(buf));
}

// ── Public interface ──────────────────────────────────────────────────────────

const db = {
  /** Call once at app startup */
  async init() {
    if (ready) return;
    const SQL  = await initSqlJs();
    const data = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : undefined;
    _db = data ? new SQL.Database(data) : new SQL.Database();
    _db.run('PRAGMA foreign_keys=ON;');
    _db.run('PRAGMA synchronous=NORMAL;');
    ready = true;
  },

  /** Run DDL or multi-statement SQL (no return) */
  exec(sql) {
    _db.exec(sql);
    persist();
  },

  /**
   * Run fn() inside a BEGIN/COMMIT transaction.
   * persist() is suppressed during the transaction and called once on COMMIT.
   * Automatically rolls back if fn() throws.
   */
  transaction(fn) {
    _db.run('BEGIN');
    _inTx = true;
    try {
      fn();
      _inTx = false;
      _db.run('COMMIT');
      // Flush to disk once after the whole transaction
      const buf = _db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(buf));
    } catch (err) {
      _inTx = false;
      try { _db.run('ROLLBACK'); } catch (_) {}
      throw err;
    }
  },

  /** Returns a statement-like object with .run() / .get() / .all() */
  prepare(sql) {
    return {
      /** Insert / Update / Delete */
      run(...params) {
        _db.run(sql, params.length ? params : []);
        persist();
      },
      /** Returns first matching row or undefined */
      get(...params) {
        const stmt  = _db.prepare(sql);
        const bound = params.length ? params : [];
        if (bound.length) stmt.bind(bound);
        const ok  = stmt.step();
        const row = ok ? stmt.getAsObject() : undefined;
        stmt.free();
        return row;
      },
      /** Returns all matching rows */
      all(...params) {
        const rows  = [];
        const stmt  = _db.prepare(sql);
        const bound = params.length ? params : [];
        if (bound.length) stmt.bind(bound);
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      },
    };
  },
};

module.exports = db;
