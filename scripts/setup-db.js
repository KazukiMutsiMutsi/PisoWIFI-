// scripts/setup-db.js — Initialize the SQLite database
// Run once: node scripts/setup-db.js

const db     = require('../lib/db');
const bcrypt = require('bcryptjs');

async function setup() {
  await db.init();
  console.log('Database opened.');

  // ── Tables ────────────────────────────────────────────────────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rates (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      coins   INTEGER NOT NULL,
      minutes INTEGER NOT NULL,
      label   TEXT NOT NULL,
      active  INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      mac_address TEXT NOT NULL,
      ip_address  TEXT,
      coins_paid  INTEGER NOT NULL DEFAULT 0,
      minutes     INTEGER NOT NULL DEFAULT 0,
      started_at  INTEGER,
      expires_at  INTEGER,
      status      TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT,
      mac_address TEXT,
      coins_paid  INTEGER NOT NULL,
      minutes     INTEGER NOT NULL,
      created_at  INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS eload_balance (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      balance_php REAL NOT NULL DEFAULT 0,
      updated_at  INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS eload_transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,
      amount_php  REAL NOT NULL,
      note        TEXT,
      created_at  INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS eload_products (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      network        TEXT NOT NULL,
      name           TEXT NOT NULL,
      description    TEXT DEFAULT '',
      face_value     REAL NOT NULL,
      dealer_price   REAL NOT NULL,
      selling_price  REAL NOT NULL,
      active         INTEGER DEFAULT 1,
      created_at     INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS eload_orders (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id   INTEGER,
      product_name TEXT,
      phone        TEXT NOT NULL,
      network      TEXT NOT NULL,
      amount       REAL NOT NULL,
      dealer_price REAL NOT NULL DEFAULT 0,
      profit       REAL NOT NULL DEFAULT 0,
      status       TEXT DEFAULT 'pending',
      created_at   INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  // ── Default settings ────────────────────────────────────────────────────────

  const defaults = {
    wifi_name:        'TechPiso WiFi',
    currency:         'PHP',
    machine_name:     'Piso WiFi Machine 1',
    idle_timeout_min: '5',
  };
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) ins.run(k, v);

  // ── Default rates ────────────────────────────────────────────────────────────

  const rateCount = db.prepare('SELECT COUNT(*) as c FROM rates').get();
  if (!rateCount || rateCount.c === 0) {
    const rates = [
      [1,   8,    '₱1 = 8 mins'],
      [5,   60,   '₱5 = 1 hr'],
      [10,  180,  '₱10 = 3 hrs'],
      [20,  360,  '₱20 = 6 hrs'],
      [50,  1440, '₱50 = 24 hrs'],
    ];
    const ri = db.prepare('INSERT INTO rates (coins, minutes, label) VALUES (?, ?, ?)');
    for (const r of rates) ri.run(...r);
  }

  // ── Eload balance row ────────────────────────────────────────────────────────

  db.prepare('INSERT OR IGNORE INTO eload_balance (id, balance_php) VALUES (1, 0)').run();

  // ── Admin account ────────────────────────────────────────────────────────────

  const adminExists = db.prepare("SELECT id FROM admin_users WHERE username = 'admin'").get();
  if (!adminExists) {
    const hashed = bcrypt.hashSync('admin1234', 10);
    db.prepare('INSERT INTO admin_users (username, password) VALUES (?, ?)').run('admin', hashed);
    console.log('\n✅ Admin account created');
    console.log('   Username: admin');
    console.log('   Password: admin1234');
    console.log('   ⚠️  Change the password after first login!\n');
  } else {
    console.log('Admin account already exists.');
  }

  console.log('✅ Database setup complete → data/pisowifi.db');
  process.exit(0);
}

setup().catch(err => { console.error(err); process.exit(1); });
