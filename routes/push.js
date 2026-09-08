const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');
const push = require('../services/push');

const router = express.Router();

// GET /api/push/config
// What the client needs to decide whether to offer the toggle: is push
// wired up server-side, and the VAPID public key to build a subscription
// with. Also echoes the caller's current opt-in flag so the Account page
// can render the switch in the right position.
router.get('/config', requireAuth, (req, res) => {
  const row = db.prepare('SELECT notify_slate FROM users WHERE id = ?').get(req.user.id);
  res.json({
    enabled: push.enabled,
    public_key: push.enabled ? push.publicKey : null,
    notify_slate: row ? !!row.notify_slate : false,
  });
});

// POST /api/push/subscribe  { subscription, notify_slate? }
// Stores the browser's PushSubscription and, unless told otherwise, flips
// the player's opt-in on (subscribing is the whole point of the toggle).
router.post('/subscribe', requireAuth, (req, res) => {
  if (!push.enabled) return res.status(503).json({ error: 'Push notifications are not configured' });
  const { subscription, notify_slate } = req.body || {};
  try {
    push.saveSubscription(req.user.id, subscription);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const optIn = notify_slate === undefined ? 1 : notify_slate ? 1 : 0;
  db.prepare('UPDATE users SET notify_slate = ? WHERE id = ?').run(optIn, req.user.id);
  res.json({ ok: true, notify_slate: !!optIn });
});

// POST /api/push/unsubscribe  { endpoint? }
// Turns the opt-in off and forgets this browser's subscription. The
// endpoint is optional — without it we just clear the flag (the client
// couldn't produce a subscription object, e.g. permission already revoked).
router.post('/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body || {};
  push.removeSubscription(req.user.id, endpoint);
  db.prepare('UPDATE users SET notify_slate = 0 WHERE id = ?').run(req.user.id);
  res.json({ ok: true, notify_slate: false });
});

module.exports = router;
