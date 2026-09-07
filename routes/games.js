const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

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
// Best guess at the "active" week for each league, derived from the real
// slate rather than a calendar formula (NFL and NCAAF start on different
// dates and don't line up week-for-week).
//
// Two answers, because players and the admin want different things once a
// week wraps up:
//   weeks       - for the Picks page. Earliest week whose last kickoff is
//                 still ahead of us (plus a ~6h grace so a week in progress
//                 doesn't jump forward mid-slate); if every entered week is
//                 over, stays on the most recent one (never an empty week).
//   admin_weeks - for the admin panel. Same "current" week as above, but
//                 once every entered week is over it rolls to the week
//                 *after* the last one — the next slate to build — instead
//                 of parking on a finished week.
// Both null for a league with nothing scheduled yet; the client then falls
// back to its date estimate.
router.get('/current-week', requireAuth, (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const GRACE_MS = 6 * 60 * 60 * 1000;
  const now = Date.now();
  const weeks = {};
  const admin_weeks = {};

  for (const league of ['NFL', 'NCAAF']) {
    const rows = db
      .prepare(
        `SELECT week, MAX(start_time) AS last_start
         FROM games
         WHERE league = ? AND season_year = ? AND included = 1
         GROUP BY week ORDER BY week ASC`
      )
      .all(league, year);

    if (rows.length === 0) {
      weeks[league] = null;
      admin_weeks[league] = null;
      continue;
    }

    const lastStart = (r) => new Date(r.last_start).getTime();
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
