// routes/portal.js — Customer-facing captive portal

const express    = require('express');
const router     = express.Router();
const db         = require('../lib/db');
const sessionMgr = require('../lib/session-manager');

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMacFromArp(ip) {
  if (process.platform !== 'linux') return null;
  try {
    const { execSync } = require('child_process');
    const arp   = execSync(`arp -n ${ip} 2>/dev/null`).toString();
    const match = arp.match(/([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})/i);
    return match ? match[1].toUpperCase() : null;
  } catch { return null; }
}

function getClientMac(req) {
  if (req.query.mac)              return req.query.mac.toUpperCase();
  if (req.headers['x-client-mac']) return req.headers['x-client-mac'].toUpperCase();
  const ip  = getClientIp(req);
  const mac = getMacFromArp(ip);
  if (mac) return mac;
  return 'DEV-' + (ip || '127.0.0.1').replace(/[:.]/g, '-');
}

function getClientIp(req) {
  return req.socket.remoteAddress;
}

// ── GET /portal ───────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const mac     = getClientMac(req);
  const active  = sessionMgr.getActiveSession(mac);
  const rates   = db.prepare('SELECT * FROM rates WHERE active=1 ORDER BY coins ASC').all();
  const setting = key => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  const now     = Math.floor(Date.now() / 1000);

  res.render('portal', {
    wifiName:    setting('wifi_name') || 'TechPiso WiFi',
    macAddress:  mac,
    active,
    rates,
    // Pass exact server timestamp so JS can compute accurate countdown
    serverNow:   now,
    message:     req.query.message || null,
    error:       req.query.error   || null,
  });
});

// ── GET /portal/status — JSON (polled by portal) ──────────────────────────────

router.get('/status', (req, res) => {
  const mac    = getClientMac(req);
  const active = sessionMgr.getActiveSession(mac);
  if (!active) return res.json({ connected: false });

  res.json({
    connected:         true,
    remaining_seconds: active.remaining_seconds,
    expires_at:        active.expires_at,
    minutes_total:     active.minutes,
    coins_paid:        active.coins_paid,
  });
});

// ── GET /portal/waiting — page shown while waiting for coin ──────────────────
// Uses meta-refresh to auto-reload every 3 seconds and check if coin inserted

router.get('/waiting', (req, res) => {
  const mac    = getClientMac(req);
  const active = sessionMgr.getActiveSession(mac);

  // If coin was inserted — redirect to portal (session now active)
  if (active && active.coins_paid > 0) {
    return res.redirect('/portal');
  }

  const rates   = db.prepare('SELECT * FROM rates WHERE active=1 ORDER BY coins ASC').all();
  const setting = key => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;

  res.render('portal-waiting', {
    wifiName:   setting('wifi_name') || 'TechPiso WiFi',
    macAddress: mac,
    rates,
  });
});

module.exports = router;
