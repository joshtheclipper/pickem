const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');
const { fetchCurrentWeek } = require('../services/espn');

const router = express.Router();

// ESPN's "what week is it" answer barely changes within a day, but
// /current-week is hit on every Picks/Admin page load, so cache it per
// league for a while rather than calling ESPN each time. A failed fetch is
// cached too (as null) but only briefly, so a flaky ESPN doesn't get
// hammered while still recovering within a few minutes.
const espnWeekCache = new Map(); // league -> { at, week }
const ESPN_WEEK_TTL_OK = 30 * 60 * 1000;
const ESPN_WEEK_TTL_ERR = 3 * 60 * 1000;

async function getEspnCurrentWeek(league) {
  const hit = espnWeekCache.get(league);
  if (hit) {
    const ttl = hit.week == null ? ESPN_WEEK_TTL_ERR : ESPN_WEEK_TTL_OK;
    if (Date.now() - hit.at < ttl) return hit.week;
  }
  let week = null;
  try {
    const cur = await fetchCurrentWeek(league);
    week = cur && cur.week ? cur.week : null;
  } catch (err) {
    console.error(`current-week: ESPN lookup failed for ${league}:`, err.message);
  }
  espnWeekCache.set(league, { at: Date.now(), week });
  return week;
}

// GET /api/games?league=NFL&week=1&year=2026
// Returns games for the week, plus the current user's pick on each (if any).
router.get('/', requireAuth, (req, res) => {
  // Live in-progress games change every couple minutes server-side; don't
  // let a proxy or the browser serve a stale cached copy of this poll.
  res.set('Cache-Control', 'no-store');
  const { league, week, year } = req.query;
  if (!league || !week || !year) {
    return res.status(400).json({ error: 'league, week, and year are required' });
  }

  const games = db
    .prepare(
      `SELECT * FROM games WHERE league = ? AND week = ? AND season_year = ? AND included = 1 ORDER BY start_time ASC`
    )
    .all(league, week, year);

  const picks = db
    .prepare(
      `SELECT game_id, pick, is_correct, locked_in, admin_overridden FROM picks WHERE user_id = ? AND game_id IN (${games.map(() => '?').join(',') || 'NULL'})`
    )
    .all(req.user.id, ...games.map((g) => g.id));

  const pickMap = Object.fromEntries(picks.map((p) => [p.game_id, p]));

  const now = new Date();
  const enriched = games.map((g) => ({
    ...g,
    locked: new Date(g.start_time) <= now || g.status !== 'scheduled',
    my_pick: pickMap[g.id] ? pickMap[g.id].pick : null,
    my_pick_correct: pickMap[g.id] ? pickMap[g.id].is_correct : null,
    my_pick_locked: pickMap[g.id] ? !!pickMap[g.id].locked_in : false,
    my_pick_admin_overridden: pickMap[g.id] ? !!pickMap[g.id].admin_overridden : false,
  }));

  res.json({ games: enriched });
});

// GET /api/games/:id/picks - everyone's pick on a single game.
//
// "Pick-to-see": before a game starts, a player can only view everyone
// else's pick on it once they've locked in their own pick for that game.
// Once the game itself has started (or finished), it's visible to everyone
// regardless — same as the old kickoff-based reveal, just no longer the
// only way in.
router.get('/:id/picks', requireAuth, (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const gameLocked = game.status !== 'scheduled' || new Date(game.start_time) <= new Date();

  if (!gameLocked) {
    const myPick = db
      .prepare('SELECT locked_in FROM picks WHERE user_id = ? AND game_id = ?')
      .get(req.user.id, req.params.id);
    const myPickLocked = myPick ? !!myPick.locked_in : false;
    if (!myPickLocked) {
      return res.status(403).json({
        error: 'Lock in your pick on this game to see everyone else\u2019s picks',
        pick_to_see: true,
      });
    }
  }

  const picks = db
    .prepare(
      `SELECT u.username, p.pick, p.is_correct, p.admin_overridden
       FROM picks p JOIN users u ON u.id = p.user_id
       WHERE p.game_id = ?
       ORDER BY u.username ASC`
    )
    .all(req.params.id);

  res.json({ picks });
});

// GET /api/games/current-week?year=2026
// Best guess at the "active" week for each league. The primary source is
// ESPN's own live schedule (services/espn.fetchCurrentWeek) — the real
// slate, not whatever games our admin happens to have entered — so the
// Picks page lands on the right week even before the admin has built it.
// If ESPN can't be reached (or it's the off-/pre-season), we fall back to
// deriving the week from the games the admin *has* entered, and finally the
// client falls back to its own date estimate.
//
// Two answers, because players and the admin want different things once a
// week wraps up:
//   weeks       - for the Picks page. The current week per ESPN; on the
//                 fallback path, the earliest entered week whose last
//                 kickoff is still ahead of us (plus a ~6h grace so a week
//                 in progress doesn't jump forward mid-slate).
//   admin_weeks - for the admin panel. Same current week, but once every
//                 entered week is already over it rolls to the week *after*
//                 the last one — the next slate to build — instead of
//                 parking on a finished week.
// Both null for a league we can't place at all; the client then falls back
// to its date estimate.
router.get('/current-week', requireAuth, async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const GRACE_MS = 6 * 60 * 60 * 1000;
  const now = Date.now();
  const weeks = {};
  const admin_weeks = {};

  const leagues = ['NFL', 'NCAAF'];
  // Both ESPN lookups (cached, but the first hit after a restart is a real
  // request) run up front in parallel — this endpoint is on the Picks-page
  // render path.
  const espnWeeks = Object.fromEntries(
    await Promise.all(leagues.map(async (lg) => [lg, await getEspnCurrentWeek(lg)]))
  );

  for (const league of leagues) {
    const rows = db
      .prepare(
        `SELECT week, MAX(start_time) AS last_start
         FROM games
         WHERE league = ? AND season_year = ? AND included = 1
         GROUP BY week ORDER BY week ASC`
      )
      .all(league, year);

    const lastStart = (r) => new Date(r.last_start).getTime();
    const espnWeek = espnWeeks[league];

    if (espnWeek) {
      weeks[league] = espnWeek;
      // Admin panel: if the whole entered slate is already in the past and
      // ESPN hasn't moved past it yet, point at the next week to build.
      const lastEntered = rows.length ? rows[rows.length - 1].week : 0;
      const allEnteredDone =
        rows.length > 0 && rows.every((r) => lastStart(r) + GRACE_MS <= now);
      admin_weeks[league] =
        allEnteredDone && espnWeek <= lastEntered ? lastEntered + 1 : espnWeek;
      continue;
    }

    // ---- Fallback: derive from the slate the admin has entered ----
    if (rows.length === 0) {
      weeks[league] = null;
      admin_weeks[league] = null;
      continue;
    }

    const active = rows.find((r) => lastStart(r) + GRACE_MS > now);
    weeks[league] = active ? active.week : rows[rows.length - 1].week;
    admin_weeks[league] = active ? active.week : rows[rows.length - 1].week + 1;
  }

  res.json({ weeks, admin_weeks });
});

// GET /api/games/weeks - distinct league/week/year combos available, for nav
router.get('/weeks', requireAuth, (req, res) => {
  const weeks = db
    .prepare(
      `SELECT DISTINCT league, week, season_year FROM games WHERE included = 1 ORDER BY season_year DESC, week ASC`
    )
    .all();
  res.json({ weeks });
});

module.exports = router;
