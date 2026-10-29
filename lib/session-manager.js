// lib/session-manager.js
// Handles WiFi session creation, activation, and expiry.
//
// CONCURRENCY PROTECTION:
// Node.js is single-threaded so true parallel execution is impossible,
// but rapid async requests (two coin pulses within the same event loop tick)
// can still cause race conditions. We use a per-MAC in-memory lock (_locks)
// to queue concurrent requests for the same device.

const db   = require('./db');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require('child_process');

const IS_LINUX = process.platform === 'linux';

// ── Per-MAC mutex lock ────────────────────────────────────────────────────────
// Prevents double-session creation when two coin pulses arrive simultaneously
// for the same MAC address.

const _locks = new Map(); // mac → Promise chain

function withLock(mac, fn) {
  const prev = _locks.get(mac) || Promise.resolve();
  const next = prev.then(() => fn()).catch(err => {
    console.error(`[session-lock] Error for ${mac}:`, err.message);
    throw err;
  });
  _locks.set(mac, next.catch(() => {})); // keep chain alive even on error
  // Clean up after 10 seconds to avoid memory leak
  setTimeout(() => {
    if (_locks.get(mac) === next.catch(() => {})) _locks.delete(mac);
  }, 10000);
  return next;
}

// ── iptables helpers (only run on Linux / Armbian) ────────────────────────────

function ruleExists(table, chain, mac) {
  try {
    execSync(`iptables -t ${table} -C ${chain} -m mac --mac-source ${mac} -j ACCEPT 2>/dev/null`);
    return true;
  } catch { return false; }
}

function allowMac(mac) {
  if (!IS_LINUX) return;
  try {
    if (!ruleExists('nat', 'PREROUTING', mac))
      execSync(`iptables -t nat -I PREROUTING 1 -m mac --mac-source ${mac} -j ACCEPT`);
    if (!ruleExists('filter', 'FORWARD', mac))
      execSync(`iptables -I FORWARD 1 -m mac --mac-source ${mac} -j ACCEPT`);
  } catch (e) { console.error('iptables allow error:', e.message); }
}

function blockMac(mac) {
  if (!IS_LINUX) return;
  try {
    execSync(`iptables -t nat -D PREROUTING -m mac --mac-source ${mac} -j ACCEPT 2>/dev/null || true`);
    execSync(`iptables -D FORWARD -m mac --mac-source ${mac} -j ACCEPT 2>/dev/null || true`);
  } catch { /* already removed */ }
}

// ── Session creation ──────────────────────────────────────────────────────────

function _createSession(mac, ip, coinsPaid) {
  // Double-check no active session exists (safety net inside the lock)
  const existing = getActiveSession(mac);
  if (existing) {
    // Race condition caught — add time instead
    return _addTime(mac, coinsPaid, existing);
  }

  const rate    = db.prepare(
    'SELECT * FROM rates WHERE coins = ? AND active = 1 ORDER BY minutes DESC LIMIT 1'
  ).get(coinsPaid);
  const minutes = rate ? rate.minutes : coinsPaid * 8; // fallback: 8 min / peso
  const now     = Math.floor(Date.now() / 1000);
  const expires = now + minutes * 60;
  const id      = uuidv4();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO sessions (id, mac_address, ip_address, coins_paid, minutes, started_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(id, mac, ip, coinsPaid, minutes, now, expires);

    db.prepare(`
      INSERT INTO transactions (session_id, mac_address, coins_paid, minutes)
      VALUES (?, ?, ?, ?)
    `).run(id, mac, coinsPaid, minutes);
  });

  allowMac(mac);
  console.log(`✅ Session created for ${mac} — ${minutes} min (₱${coinsPaid})`);
  return { id, minutes, expires };
}

// ── Add time to existing session ──────────────────────────────────────────────

function _addTime(mac, coinsPaid, existing) {
  const rate    = db.prepare(
    'SELECT * FROM rates WHERE coins = ? AND active = 1 ORDER BY minutes DESC LIMIT 1'
  ).get(coinsPaid);
  const addMins = rate ? rate.minutes : coinsPaid * 8;
  const newExp  = existing.expires_at + addMins * 60;

  db.transaction(() => {
    db.prepare("UPDATE sessions SET expires_at = ?, minutes = minutes + ? WHERE id = ?")
      .run(newExp, addMins, existing.id);

    db.prepare(`
      INSERT INTO transactions (session_id, mac_address, coins_paid, minutes)
      VALUES (?, ?, ?, ?)
    `).run(existing.id, mac, coinsPaid, addMins);
  });

  console.log(`➕ Time added for ${mac} — +${addMins} min (₱${coinsPaid})`);
  return { id: existing.id, minutes: addMins, expires: newExp };
}

// ── Public API — all go through the per-MAC lock ──────────────────────────────

function createSession(mac, ip, coinsPaid) {
  return withLock(mac, () => _createSession(mac, ip, coinsPaid));
}

function addTime(mac, coinsPaid) {
  return withLock(mac, () => {
    const existing = getActiveSession(mac);
    if (!existing) return _createSession(mac, null, coinsPaid);
    return _addTime(mac, coinsPaid, existing);
  });
}

// ── Check if a MAC has an active session ─────────────────────────────────────

function getActiveSession(mac) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(`
    SELECT *, (expires_at - ?) as remaining_seconds
    FROM sessions
    WHERE mac_address = ? AND status = 'active' AND expires_at > ?
    ORDER BY expires_at DESC LIMIT 1
  `).get(now, mac, now);
}

// ── Expire sessions (called by cron every minute) ────────────────────────────

function expireOldSessions() {
  const now = Math.floor(Date.now() / 1000);
  const expired = db.prepare(`
    SELECT * FROM sessions WHERE status = 'active' AND expires_at <= ?
  `).all(now);

  const stmt = db.prepare("UPDATE sessions SET status = 'expired' WHERE id = ?");
  for (const s of expired) {
    stmt.run(s.id);
    blockMac(s.mac_address);
    console.log(`⏰ Session expired for MAC: ${s.mac_address}`);
  }
}

module.exports = { createSession, getActiveSession, expireOldSessions, addTime, blockMac };
