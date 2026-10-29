// routes/eload.js — Customer-facing eload vending portal
// Customers MUST have an active WiFi session (inserted coins) to buy eload.

const express    = require('express');
const router     = express.Router();
const db         = require('../lib/db');
const sessionMgr = require('../lib/session-manager');

function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
}

// ── Helper: get client MAC (same logic as portal.js) ─────────────────────────

function getClientMac(req) {
  if (req.query.mac) return req.query.mac.toUpperCase();
  if (req.headers['x-client-mac']) return req.headers['x-client-mac'].toUpperCase();
  // ARP lookup on Linux
  if (process.platform === 'linux') {
    try {
      const { execSync } = require('child_process');
      const ip  = req.socket.remoteAddress;
      const arp = execSync(`arp -n ${ip} 2>/dev/null`).toString();
      const m   = arp.match(/([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})/i);
      if (m) return m[1].toUpperCase();
    } catch {}
  }
  // Dev fallback
  return 'DEV-' + (req.socket.remoteAddress || '127.0.0.1').replace(/[:.]/g, '-');
}

// ── GET /eload — product listing ──────────────────────────────────────────────

router.get('/', (req, res) => {
  const mac     = getClientMac(req);
  const session = sessionMgr.getActiveSession(mac);

  const products = db.prepare(
    'SELECT * FROM eload_products WHERE active=1 ORDER BY network, selling_price ASC'
  ).all();
  const networks = [...new Set(products.map(p => p.network))];

  res.render('eload-portal', {
    wifiName:   getSetting('wifi_name') || 'TechPiso WiFi',
    products,
    networks,
    hasSession: !!session,   // <-- tells the view whether coins were inserted
    mac,
    message:    req.query.message || null,
    error:      req.query.error   || null,
  });
});

// ── POST /eload/order — customer places an eload order ───────────────────────

router.post('/order', (req, res) => {
  const { product_id, phone, network, amount } = req.body;

  // ── Must have an active WiFi session to buy eload ─────────────────────────
  const mac     = getClientMac(req);
  const session = sessionMgr.getActiveSession(mac);
  if (!session) {
    return res.redirect('/eload?error=Please+insert+a+coin+first+to+buy+eload.');
  }

  // Validate phone
  if (!phone || !phone.match(/^09[0-9]{9}$/)) {
    return res.redirect('/eload?error=Invalid+phone+number');
  }

  // Get product
  const product = db.prepare('SELECT * FROM eload_products WHERE id=? AND active=1').get(product_id);
  if (!product) {
    return res.redirect('/eload?error=Product+not+available');
  }

  // Check balance
  const bal = db.prepare('SELECT balance_php FROM eload_balance WHERE id=1').get();
  if (!bal || bal.balance_php < product.dealer_price) {
    return res.redirect('/eload?error=Sorry,+eload+not+available+right+now.+Please+try+later.');
  }

  const now    = Math.floor(Date.now() / 1000);
  const profit = product.selling_price - product.dealer_price;

  let orderId;
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO eload_orders (product_id, product_name, phone, network, amount, dealer_price, profit, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(product.id, product.name, phone, product.network, product.selling_price,
             product.dealer_price, profit, now);

      const row = db.prepare('SELECT last_insert_rowid() AS id').get();
      orderId = row.id;

      db.prepare('UPDATE eload_balance SET balance_php = balance_php - ?, updated_at=? WHERE id=1')
        .run(product.dealer_price, now);

      db.prepare("INSERT INTO eload_transactions (type, amount_php, note, created_at) VALUES ('deduct',?,?,?)")
        .run(product.dealer_price, `Order #${orderId}: ${product.network} ₱${product.selling_price} → ${phone}`, now);
    });
  } catch (err) {
    console.error('Eload order error:', err);
    return res.redirect('/eload?error=Order+failed.+Please+try+again.');
  }

  const order = db.prepare('SELECT * FROM eload_orders WHERE id=?').get(orderId);
  res.render('eload-receipt', {
    wifiName: getSetting('wifi_name') || 'TechPiso WiFi',
    order,
  });
});

module.exports = router;
