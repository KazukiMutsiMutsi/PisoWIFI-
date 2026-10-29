// server.js — Main entry point for Piso WiFi

const express    = require('express');
const bodyParser = require('body-parser');
const session    = require('express-session');
const path       = require('path');
const cron       = require('node-cron');
const db         = require('./lib/db');

const PORT = process.env.PORT || 3000;
const GATEWAY_IP = process.env.GATEWAY_IP || '192.168.10.1';

async function main() {
  // ── Init DB first ───────────────────────────────────────────────────────────
  await db.init();
  console.log('✅ Database ready');

  // Load routes AFTER db is initialized (they require db at module level)
  const portalRouter = require('./routes/portal');
  const adminRouter  = require('./routes/admin');
  const apiRouter    = require('./routes/api');
  const eloadRouter  = require('./routes/eload');
  const sessionMgr   = require('./lib/session-manager');

  const app = express();

  // ── View engine & middleware ────────────────────────────────────────────────
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(bodyParser.json());
  app.use(session({
    secret: process.env.SESSION_SECRET || 'pisowifi-secret-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 60 * 1000 },
  }));

  // ── Captive portal redirect ─────────────────────────────────────────────────
  const captiveChecks = [
    '/generate_204', '/hotspot-detect.html', '/ncsi.txt',
    '/connecttest.txt', '/redirect',
  ];
  app.use((req, res, next) => {
    if (req.path.startsWith('/admin') || req.path.startsWith('/api')) return next();
    if (captiveChecks.some(p => req.path.startsWith(p))) {
      return res.redirect(`http://${GATEWAY_IP}:${PORT}/portal`);
    }
    next();
  });

  // ── Routes ──────────────────────────────────────────────────────────────────
  app.use('/portal', portalRouter);
  app.use('/admin',  adminRouter);
  app.use('/api',    apiRouter);
  app.use('/eload',  eloadRouter);
  app.get('/', (req, res) => res.redirect('/portal'));

  // ── Cron: expire sessions every minute ─────────────────────────────────────
  cron.schedule('* * * * *', () => sessionMgr.expireOldSessions());

  // ── Start ───────────────────────────────────────────────────────────────────
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Piso WiFi running on port ${PORT}`);
    console.log(`   Portal  → http://localhost:${PORT}/portal`);
    console.log(`   Admin   → http://localhost:${PORT}/admin`);
    console.log(`   Gateway → http://${GATEWAY_IP}:${PORT}\n`);
  });
}

main().catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});
