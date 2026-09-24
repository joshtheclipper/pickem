// Web Push notifications: "a new slate has been posted" and
// "kickoff in an hour and you haven't picked" reminders.
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

  return sendToSubs(subs, buildPayload({ league, week, kind }));
}

// Sends one payload to a list of push_subscriptions rows ({ id, endpoint,
// p256dh, auth }). Dead subscriptions (404 gone / 410 expired) are deleted;
// other failures are just logged. Resolves to { sent }.
async function sendToSubs(subs, payloadObj) {
  if (subs.length === 0) return { sent: 0 };

  const payload = JSON.stringify(payloadObj);
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
      if (code === 404 || code === 410) del.run(subs[i].id);
      else console.error('Push send failed:', code || (r.reason && r.reason.message));
    }
  });

  return { sent };
}

const REMINDER_WINDOW_MS = 60 * 60 * 1000;

// Run on a timer (see server.js). Finds included games kicking off — and
// open props locking — within the next hour, and sends each opted-in player
// one grouped push listing the ones they haven't picked yet. Each
// (player, game/prop) is reminded at most once via kickoff_reminders.
async function sendKickoffReminders() {
  if (!enabled) return { users: 0, sent: 0, skipped: 'disabled' };

  // Timestamps are stored as ESPN ISO strings (or whatever the admin
  // entered for locks_at), so compare them as Dates rather than in SQL.
  const now = Date.now();
  const due = (iso) => {
    const t = new Date(iso).getTime();
    return t > now && t <= now + REMINDER_WINDOW_MS;
  };

  const games = db
    .prepare(
      `SELECT id, start_time, home_team_abbr, away_team_abbr
       FROM games WHERE included = 1 AND status = 'scheduled'`
    )
    .all()
    .filter((g) => due(g.start_time));
  const props = db
    .prepare(
      `SELECT id, locks_at FROM props
       WHERE included = 1 AND status = 'open' AND locks_at IS NOT NULL`
    )
    .all()
    .filter((p) => due(p.locks_at));

  if (games.length === 0 && props.length === 0) return { users: 0, sent: 0 };

  const users = db
    .prepare(
      `SELECT DISTINCT u.id FROM users u
       JOIN push_subscriptions ps ON ps.user_id = u.id
       WHERE u.notify_kickoff = 1`
    )
    .all();

  const hasPick = db.prepare('SELECT 1 FROM picks WHERE user_id = ? AND game_id = ?');
  const hasPropPick = db.prepare('SELECT 1 FROM prop_picks WHERE user_id = ? AND prop_id = ?');
  const reminded = db.prepare(
    'SELECT 1 FROM kickoff_reminders WHERE user_id = ? AND kind = ? AND item_id = ?'
  );
  const markReminded = db.prepare(
    'INSERT OR IGNORE INTO kickoff_reminders (user_id, kind, item_id) VALUES (?, ?, ?)'
  );
  const subsFor = db.prepare(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?'
  );

  let userCount = 0;
  let sent = 0;
  for (const u of users) {
    const openGames = games.filter(
      (g) => !hasPick.get(u.id, g.id) && !reminded.get(u.id, 'game', g.id)
    );
    const openProps = props.filter(
      (p) => !hasPropPick.get(u.id, p.id) && !reminded.get(u.id, 'prop', p.id)
    );
    if (openGames.length === 0 && openProps.length === 0) continue;

    // Record before sending so a slow or failed send never causes a repeat.
    db.transaction(() => {
      openGames.forEach((g) => markReminded.run(u.id, 'game', g.id));
      openProps.forEach((p) => markReminded.run(u.id, 'prop', p.id));
    })();

    const r = await sendToSubs(subsFor.all(u.id), buildReminderPayload(openGames, openProps));
    userCount += 1;
    sent += r.sent;
  }

  return { users: userCount, sent };
}

function buildReminderPayload(games, props) {
  const base = { url: '/index.html', tag: 'pickem-kickoff' };
  const label = (g) => `${g.away_team_abbr} @ ${g.home_team_abbr}`;

  if (games.length === 1 && props.length === 0) {
    return { ...base, title: `${label(games[0])} kicks off in under an hour`, body: "You haven't made a pick yet." };
  }
  if (games.length === 0 && props.length === 1) {
    return { ...base, title: 'A prop locks in under an hour', body: "You haven't answered it yet." };
  }

  const parts = games.slice(0, 3).map(label);
  if (games.length > 3) parts.push(`+${games.length - 3} more`);
  if (props.length) parts.push(`${props.length} prop${props.length === 1 ? '' : 's'}`);
  return {
    ...base,
    title: `${games.length + props.length} picks still open`,
    body: `Locking within the hour: ${parts.join(', ')}.`,
  };
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
  sendKickoffReminders,
};
