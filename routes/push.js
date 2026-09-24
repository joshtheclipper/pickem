const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');
const push = require('../services/push');

const router = express.Router();

// Only the flags actually present in the body are touched, so one toggle
// never flips the other.
function applyFlags(userId, body) {
  for (const flag of ['notify_slate', 'notify_kickoff']) {
    if (body[flag] !== undefined) {
      db.prepare(`UPDATE users SET ${flag} = ? WHERE id = ?`).run(body[flag] ? 1 : 0, userId);
    }
  }
  const row = db.prepare('SELECT notify_slate, notify_kickoff FROM users WHERE id = ?').get(userId);
  return { notify_slate: !!row.notify_slate, notify_kickoff: !!row.notify_kickoff };
}

// GET /api/push/config
// What the client needs to decide whether to offer the toggles: is push
// wired up server-side, and the VAPID public key to build a subscription
// with. Also echoes the caller's current opt-in flags so the Account page
// can render the switches in the right position.
router.get('/config', requireAuth, (req, res) => {
  const row = db.prepare('SELECT notify_slate, notify_kickoff FROM users WHERE id = ?').get(req.user.id);
  res.json({
    enabled: push.enabled,
    public_key: push.enabled ? push.publicKey : null,
    notify_slate: row ? !!row.notify_slate : false,
    notify_kickoff: row ? !!row.notify_kickoff : false,
  });
});

// POST /api/push/subscribe  { subscription, notify_slate?, notify_kickoff? }
// Stores the browser's PushSubscription and sets whichever opt-in flags
// were sent.
router.post('/subscribe', requireAuth, (req, res) => {
  if (!push.enabled) return res.status(503).json({ error: 'Push notifications are not configured' });
  const body = req.body || {};
  try {
    push.saveSubscription(req.user.id, body.subscription);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ ok: true, ...applyFlags(req.user.id, body) });
});

// POST /api/push/prefs  { notify_slate?, notify_kickoff? }
// Flips opt-in flags without touching subscriptions — used when one toggle
// is turned off while the other still needs this device subscribed.
router.post('/prefs', requireAuth, (req, res) => {
  res.json({ ok: true, ...applyFlags(req.user.id, req.body || {}) });
});

// POST /api/push/unsubscribe  { endpoint? }
// Turns every opt-in off and forgets this browser's subscription. The
// endpoint is optional — without it we just clear the flags (the client
// couldn't produce a subscription object, e.g. permission already revoked).
router.post('/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body || {};
  push.removeSubscription(req.user.id, endpoint);
  db.prepare('UPDATE users SET notify_slate = 0, notify_kickoff = 0 WHERE id = ?').run(req.user.id);
  res.json({ ok: true, notify_slate: false, notify_kickoff: false });
});

module.exports = router;
