// Web Push ("a new slate has been posted") notifications.
//
// Entirely optional: with no VAPID keys in the environment, `enabled` is
// false, every function here is a no-op, and the Account page hides its
// notification toggle. Push also only works over HTTPS (or localhost) —
// that's a browser rule, nothing we enforce here.

const webpush = require('web-push');
const db = require('./../db/db');

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

const enabled = Boolean(PUBLIC_KEY && PRIVATE_KEY);
if (enabled) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
} else {
  console.log('Web Push disabled (set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to enable)');
}

// Store / refresh a browser's subscription. Keyed by endpoint, so re-calling
// with the same subscription just re-points it at the current user (e.g. a
// shared device where someone else logged in).
function saveSubscription(userId, sub) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw new Error('Invalid push subscription');
  }
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth`
  ).run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
}

function removeSubscription(userId, endpoint) {
  if (!endpoint) return;
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}

// Fire-and-forget: notify every opted-in player that a slate is up for a
// league/week. `kind` is 'games' or 'props'. Deduped via slate_notifications
// so a re-save doesn't double-send. Callers should not await this (or should
// swallow errors) — a push failure must never break the admin's save.
async function notifySlatePosted({ league, season_year, week, kind }) {
  if (!enabled) return { sent: 0, skipped: 'disabled' };

  // Claim the (league, year, week, kind) slot; if the row already exists
  // this throws on the UNIQUE constraint and we bail — already notified.
  try {
    db.prepare(
      'INSERT INTO slate_notifications (league, season_year, week, kind) VALUES (?, ?, ?, ?)'
    ).run(league, season_year, week, kind);
  } catch (err) {
    return { sent: 0, skipped: 'already-notified' };
  }

  const subs = db
    .prepare(
      `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
       FROM push_subscriptions ps
       JOIN users u ON u.id = ps.user_id
       WHERE u.notify_slate = 1`
    )
    .all();

  if (subs.length === 0) return { sent: 0 };

  const payload = JSON.stringify(buildPayload({ league, week, kind }));
  const del = db.prepare('DELETE FROM push_subscriptions WHERE id = ?');

  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
      )
    )
  );

  let sent = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      sent += 1;
    } else {
      const code = r.reason && r.reason.statusCode;
      // 404 gone / 410 expired — the subscription is dead, drop it.
      if (code === 404 || code === 410) del.run(subs[i].id);
      else console.error('Push send failed:', code || (r.reason && r.reason.message));
    }
  });

  return { sent };
}

function buildPayload({ league, week, kind }) {
  const where = `${league} Week ${week}`;
  if (kind === 'props') {
    return {
      title: `New prop — ${where}`,
      body: `A prop question is up for ${where}. Get your pick in.`,
      url: '/index.html',
    };
  }
  return {
    title: `${where} is up`,
    body: `The ${where} slate has been posted — make your picks.`,
    url: '/index.html',
  };
}

module.exports = {
  enabled,
  publicKey: PUBLIC_KEY,
  saveSubscription,
  removeSubscription,
  notifySlatePosted,
};
