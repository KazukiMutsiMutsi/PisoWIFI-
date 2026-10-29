// routes/admin.js — Admin dashboard

const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const db       = require('../lib/db');
const sessionMgr = require('../lib/session-manager');

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireLogin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  res.redirect('/admin/login');
}

// ── Login ─────────────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  res.render('admin/login', { error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.render('admin/login', { error: 'Invalid username or password.' });
  }

  req.session.adminId       = user.id;
  req.session.adminUsername = user.username;
  res.redirect('/admin');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

router.get('/', requireLogin, (req, res) => {
  const now         = Math.floor(Date.now() / 1000);
  const todayStart  = Math.floor(new Date().setHours(0,0,0,0) / 1000);

  const activeSess  = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE status='active' AND expires_at > ?").get(now);
  const todayEarned = db.prepare("SELECT SUM(coins_paid) as total FROM transactions WHERE created_at >= ?").get(todayStart);
  const totalEarned = db.prepare("SELECT SUM(coins_paid) as total FROM transactions").get();
  const eload       = db.prepare("SELECT balance_php FROM eload_balance WHERE id=1").get();
  const recentTx    = db.prepare("SELECT * FROM transactions ORDER BY created_at DESC LIMIT 10").all();

  // Eload stats
  const eloadTodaySold  = db.prepare("SELECT SUM(amount) as t FROM eload_orders WHERE status='completed' AND created_at>=?").get(todayStart);
  const eloadTotalSold  = db.prepare("SELECT SUM(amount) as t FROM eload_orders WHERE status='completed'").get();
  const pendingEload    = db.prepare("SELECT COUNT(*) as c FROM eload_orders WHERE status='pending'").get();
  const recentEload     = db.prepare("SELECT * FROM eload_orders ORDER BY created_at DESC LIMIT 8").all();

  res.render('admin/dashboard', {
    admin:          req.session.adminUsername,
    activeSess:     activeSess.c,
    todayEarned:    todayEarned.total || 0,
    totalEarned:    totalEarned.total || 0,
    eloadBalance:   eload ? eload.balance_php : 0,
    recentTx,
    eloadTodaySold: eloadTodaySold?.t || 0,
    eloadTotalSold: eloadTotalSold?.t || 0,
    pendingEload:   pendingEload?.c   || 0,
    recentEload,
  });
});

// ── Active Sessions ───────────────────────────────────────────────────────────

router.get('/sessions', requireLogin, (req, res) => {
  const now      = Math.floor(Date.now() / 1000);
  const sessions = db.prepare(`
    SELECT *, (expires_at - ?) as remaining_seconds
    FROM sessions WHERE status = 'active' AND expires_at > ?
    ORDER BY started_at DESC
  `).all(now, now);

  res.render('admin/sessions', { sessions, admin: req.session.adminUsername });
});

router.post('/sessions/kick', requireLogin, (req, res) => {
  const { session_id } = req.body;
  const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session_id);
  if (sess) {
    db.prepare("UPDATE sessions SET status='expired' WHERE id=?").run(session_id);
    sessionMgr.blockMac(sess.mac_address);
  }
  res.redirect('/admin/sessions');
});

// ── Rates Management ──────────────────────────────────────────────────────────

router.get('/rates', requireLogin, (req, res) => {
  const rates = db.prepare('SELECT * FROM rates ORDER BY coins ASC').all();
  res.render('admin/rates', { rates, admin: req.session.adminUsername, message: req.query.message || null });
});

router.post('/rates/add', requireLogin, (req, res) => {
  const { coins, minutes, label } = req.body;
  db.prepare('INSERT INTO rates (coins, minutes, label) VALUES (?, ?, ?)').run(
    parseInt(coins), parseInt(minutes), label
  );
  res.redirect('/admin/rates?message=Rate+added');
});

router.post('/rates/update', requireLogin, (req, res) => {
  const { id, coins, minutes, label, active } = req.body;
  db.prepare('UPDATE rates SET coins=?, minutes=?, label=?, active=? WHERE id=?').run(
    parseInt(coins), parseInt(minutes), label, active ? 1 : 0, id
  );
  res.redirect('/admin/rates?message=Rate+updated');
});

router.post('/rates/delete', requireLogin, (req, res) => {
  db.prepare('DELETE FROM rates WHERE id=?').run(req.body.id);
  res.redirect('/admin/rates?message=Rate+deleted');
});

// ── Eload Management ──────────────────────────────────────────────────────────

router.get('/eload', requireLogin, (req, res) => {
  const now        = Math.floor(Date.now() / 1000);
  const todayStart = Math.floor(new Date().setHours(0,0,0,0) / 1000);

  const balance      = db.prepare('SELECT balance_php FROM eload_balance WHERE id=1').get();
  const products     = db.prepare('SELECT * FROM eload_products ORDER BY network, selling_price ASC').all();
  const orders       = db.prepare('SELECT * FROM eload_orders ORDER BY created_at DESC LIMIT 30').all();
  const ledger       = db.prepare('SELECT * FROM eload_transactions ORDER BY created_at DESC LIMIT 50').all();
  const todaySold    = db.prepare("SELECT SUM(amount) as t FROM eload_orders WHERE status='completed' AND created_at>=?").get(todayStart);
  const totalSold    = db.prepare("SELECT SUM(amount) as t FROM eload_orders WHERE status='completed'").get();
  const pendingCount = db.prepare("SELECT COUNT(*) as c FROM eload_orders WHERE status='pending'").get();

  res.render('admin/eload', {
    admin:        req.session.adminUsername,
    balance:      balance ? balance.balance_php : 0,
    products,
    orders,
    ledger,
    todaySold:    todaySold?.t || 0,
    totalSold:    totalSold?.t || 0,
    pendingCount: pendingCount?.c || 0,
    message:      req.query.message || null,
  });
});

// Restock — add load to balance
router.post('/eload/add', requireLogin, (req, res) => {
  const amount = parseFloat(req.body.amount);
  const note   = req.body.note || 'Restock';
  if (!amount || amount <= 0) return res.redirect('/admin/eload?message=Invalid+amount');

  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE eload_balance SET balance_php = balance_php + ?, updated_at=? WHERE id=1').run(amount, now);
  db.prepare("INSERT INTO eload_transactions (type, amount_php, note, created_at) VALUES ('load',?,?,?)").run(amount, note, now);
  res.redirect('/admin/eload?message=₱' + amount + '+added+to+eload+stock');
});

// Manual sell — operator sells eload directly
router.post('/eload/sell', requireLogin, (req, res) => {
  const { network, amount, phone } = req.body;
  const amt = parseFloat(amount);
  if (!amt || !phone || !network) return res.redirect('/admin/eload?message=Missing+fields');

  // Look up dealer price from products, fallback to 95% of face value
  const product = db.prepare(
    'SELECT * FROM eload_products WHERE network=? AND selling_price=? AND active=1 LIMIT 1'
  ).get(network, amt);

  const dealerPrice = product ? product.dealer_price : amt * 0.95;
  const profit      = amt - dealerPrice;
  const now         = Math.floor(Date.now() / 1000);

  // Check balance
  const bal = db.prepare('SELECT balance_php FROM eload_balance WHERE id=1').get();
  if (!bal || bal.balance_php < dealerPrice) {
    return res.redirect('/admin/eload?message=Error:+Insufficient+eload+balance');
  }

  db.prepare(`
    INSERT INTO eload_orders (product_id, product_name, phone, network, amount, dealer_price, profit, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?)
  `).run(product?.id || null, network + ' ₱' + amt, phone, network, amt, dealerPrice, profit, now);

  db.prepare('UPDATE eload_balance SET balance_php = balance_php - ?, updated_at=? WHERE id=1').run(dealerPrice, now);
  db.prepare("INSERT INTO eload_transactions (type, amount_php, note, created_at) VALUES ('deduct',?,?,?)")
    .run(dealerPrice, `Sold: ${network} ₱${amt} → ${phone}`, now);

  res.redirect('/admin/eload?message=Eload+sent:+' + network + '+₱' + amt + '+to+' + phone);
});

// ── Eload Products CRUD ───────────────────────────────────────────────────────

router.get('/eload/products/add', requireLogin, (req, res) => {
  res.render('admin/eload-add-product', { admin: req.session.adminUsername, message: req.query.message || null });
});

router.post('/eload/products/add', requireLogin, (req, res) => {
  const { network, name, description, face_value, dealer_price, selling_price } = req.body;
  if (!network || !name || !face_value || !dealer_price || !selling_price) {
    return res.redirect('/admin/eload/products/add?message=All+fields+required');
  }
  db.prepare(`
    INSERT INTO eload_products (network, name, description, face_value, dealer_price, selling_price, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(network, name, description || '', parseFloat(face_value),
         parseFloat(dealer_price), parseFloat(selling_price));
  res.redirect('/admin/eload?message=Product+added');
});

router.post('/eload/products/toggle', requireLogin, (req, res) => {
  db.prepare('UPDATE eload_products SET active=? WHERE id=?').run(parseInt(req.body.active), req.body.id);
  res.redirect('/admin/eload');
});

router.post('/eload/products/delete', requireLogin, (req, res) => {
  db.prepare('DELETE FROM eload_products WHERE id=?').run(req.body.id);
  res.redirect('/admin/eload?message=Product+deleted');
});

// ── Eload Order Status Management ────────────────────────────────────────────

router.post('/eload/orders/complete', requireLogin, (req, res) => {
  const order = db.prepare('SELECT * FROM eload_orders WHERE id=?').get(req.body.id);
  if (order && order.status === 'pending') {
    db.prepare("UPDATE eload_orders SET status='completed' WHERE id=?").run(req.body.id);
  }
  res.redirect('/admin/eload');
});

router.post('/eload/orders/fail', requireLogin, (req, res) => {
  const order = db.prepare('SELECT * FROM eload_orders WHERE id=?').get(req.body.id);
  if (order && order.status === 'pending') {
    db.prepare("UPDATE eload_orders SET status='failed' WHERE id=?").run(req.body.id);
    // Refund balance
    const now = Math.floor(Date.now() / 1000);
    db.prepare('UPDATE eload_balance SET balance_php = balance_php + ?, updated_at=? WHERE id=1')
      .run(order.dealer_price, now);
    db.prepare("INSERT INTO eload_transactions (type, amount_php, note, created_at) VALUES ('load',?,?,?)")
      .run(order.dealer_price, `Refund: failed order #${order.id}`, now);
  }
  res.redirect('/admin/eload');
});

// ── Transactions ──────────────────────────────────────────────────────────────

router.get('/transactions', requireLogin, (req, res) => {
  const transactions = db.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 200').all();
  res.render('admin/transactions', { transactions, admin: req.session.adminUsername });
});

// ── Settings ──────────────────────────────────────────────────────────────────

router.get('/settings', requireLogin, (req, res) => {
  const rows     = db.prepare('SELECT * FROM settings').all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.render('admin/settings', { settings, admin: req.session.adminUsername, message: req.query.message || null });
});

router.post('/settings', requireLogin, (req, res) => {
  const { wifi_name, machine_name, idle_timeout_min } = req.body;
  const update = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  update.run('wifi_name', wifi_name);
  update.run('machine_name', machine_name);
  update.run('idle_timeout_min', idle_timeout_min);
  res.redirect('/admin/settings?message=Settings+saved');
});

// ── Change Password ───────────────────────────────────────────────────────────

router.post('/change-password', requireLogin, (req, res) => {
  const { current, newpass, confirm } = req.body;
  const user = db.prepare('SELECT * FROM admin_users WHERE id=?').get(req.session.adminId);

  if (!bcrypt.compareSync(current, user.password)) {
    return res.redirect('/admin/settings?message=Current+password+incorrect');
  }
  if (newpass !== confirm) {
    return res.redirect('/admin/settings?message=Passwords+do+not+match');
  }

  const hashed = bcrypt.hashSync(newpass, 10);
  db.prepare('UPDATE admin_users SET password=? WHERE id=?').run(hashed, user.id);
  res.redirect('/admin/settings?message=Password+changed+successfully');
});

module.exports = router;
