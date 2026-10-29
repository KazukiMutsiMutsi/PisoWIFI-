// routes/api.js
// REST API used by coin slot hardware (Arduino / NodeMCU)
// The hardware POSTs to /api/coin with the coin value and MAC address

const express    = require('express');
const router     = express.Router();
const sessionMgr = require('../lib/session-manager');
const db         = require('../lib/db');

// Simple API key auth (set in settings or env)
const API_KEY = process.env.API_KEY || 'piso-api-key-2024';

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── POST /api/coin — called by coin slot hardware ─────────────────────────────
// Body: { mac: "AA:BB:CC:DD:EE:FF", coins: 1, ip: "192.168.10.x" }

router.post('/coin', requireApiKey, async (req, res) => {
  const { mac, coins, ip } = req.body;
  if (!mac || !coins) return res.status(400).json({ error: 'mac and coins required' });

  try {
    // addTime() handles both new sessions and adding to existing ones,
    // and is protected by a per-MAC lock to prevent race conditions.
    const result = await sessionMgr.addTime(mac, parseInt(coins));
    res.json({ success: true, session_id: result.id, minutes_added: result.minutes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /api/session?mac=xx:xx:xx:xx:xx:xx ───────────────────────────────────

router.get('/session', requireApiKey, (req, res) => {
  const mac    = req.query.mac;
  if (!mac) return res.status(400).json({ error: 'mac required' });
  const active = sessionMgr.getActiveSession(mac);
  res.json(active || { connected: false });
});

// ── GET /api/rates ────────────────────────────────────────────────────────────

router.get('/rates', (req, res) => {
  const rates = db.prepare('SELECT * FROM rates WHERE active=1 ORDER BY coins ASC').all();
  res.json(rates);
});

// ── GET /api/stats ─────────────────────────────────────────────────────────────

router.get('/stats', requireApiKey, (req, res) => {
  const now        = Math.floor(Date.now() / 1000);
  const todayStart = Math.floor(new Date().setHours(0,0,0,0) / 1000);
  const active     = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE status='active' AND expires_at > ?").get(now);
  const today      = db.prepare("SELECT SUM(coins_paid) as t FROM transactions WHERE created_at >= ?").get(todayStart);
  const total      = db.prepare("SELECT SUM(coins_paid) as t FROM transactions").get();
  const eload      = db.prepare("SELECT balance_php FROM eload_balance WHERE id=1").get();

  res.json({
    active_sessions: active.c,
    today_php:       today.t || 0,
    total_php:       total.t || 0,
    eload_balance:   eload ? eload.balance_php : 0,
  });
});

module.exports = router;
