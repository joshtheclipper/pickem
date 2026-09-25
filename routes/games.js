const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');
const { fetchCurrentWeek, fetchScoreboard, fetchTeamSchedule } = require('../services/espn');

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
      `SELECT u.id AS user_id, u.username, a.updated_at AS avatar_v, p.pick, p.is_correct, p.admin_overridden
       FROM picks p JOIN users u ON u.id = p.user_id
       LEFT JOIN user_avatars a ON a.user_id = u.id
       WHERE p.game_id = ?
       ORDER BY u.username ASC`
    )
    .all(req.params.id);

  res.json({ picks });
});

// Team schedules for the "View matchup" panel, cached per team the same
// way as espnWeekCache above. Scores only change on game days, so a few
// minutes of staleness is fine, and it keeps a whole league of players
// opening panels from turning into a whole league of ESPN requests.
const teamScheduleCache = new Map(); // `${league}:${teamId}:${year}` -> { at, data }
const TEAM_SCHEDULE_TTL_OK = 10 * 60 * 1000;
const TEAM_SCHEDULE_TTL_ERR = 3 * 60 * 1000;

async function getTeamSchedule(league, teamId, year) {
  const key = `${league}:${teamId}:${year}`;
  const hit = teamScheduleCache.get(key);
  if (hit) {
    const ttl = hit.data == null ? TEAM_SCHEDULE_TTL_ERR : TEAM_SCHEDULE_TTL_OK;
    if (Date.now() - hit.at < ttl) return hit.data;
  }
  let data = null;
  try {
    data = await fetchTeamSchedule(league, teamId, year);
  } catch (err) {
    console.error(`matchup: ESPN schedule lookup failed for ${key}:`, err.message);
  }
  teamScheduleCache.set(key, { at: Date.now(), data });
  return data;
}

// Games saved before home_team_id/away_team_id existed have neither. Look
// the event back up on its week's scoreboard once and store them.
async function ensureTeamIds(game) {
  if (game.home_team_id && game.away_team_id) return game;
  const events = await fetchScoreboard(game.league, game.week, game.season_year);
  const ev = events.find((e) => e.espn_event_id === game.espn_event_id);
  if (!ev || !ev.home_team_id || !ev.away_team_id) return game;
  db.prepare('UPDATE games SET home_team_id = ?, away_team_id = ? WHERE id = ?').run(
    ev.home_team_id,
    ev.away_team_id,
    game.id
  );
  return { ...game, home_team_id: ev.home_team_id, away_team_id: ev.away_team_id };
}

// Only games played before this one kicked off count, so an old week's
// panel shows each team as it stood going into that game. The record is
// rebuilt from that list; ESPN's standing text is "as of today", so it's
// only passed along when nothing later has been cut off.
function teamAsOf(schedule, kickoff) {
  if (!schedule) return null;
  const games = schedule.games.filter((g) => new Date(g.date) < kickoff);
  const w = games.filter((g) => g.result === 'W').length;
  const l = games.filter((g) => g.result === 'L').length;
  const t = games.filter((g) => g.result === 'T').length;
  return {
    record: t ? `${w}-${l}-${t}` : `${w}-${l}`,
    standing: games.length === schedule.games.length ? schedule.standing : null,
    games,
  };
}

// GET /api/games/:id/matchup - both teams' records and completed games so
// far this season, for the "View matchup" panel on each game card.
router.get('/:id/matchup', requireAuth, async (req, res) => {
  let game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  try {
    game = await ensureTeamIds(game);
  } catch (err) {
    console.error(`matchup: team id backfill failed for game ${game.id}:`, err.message);
  }
  if (!game.home_team_id || !game.away_team_id) {
    return res.status(502).json({ error: 'Couldn’t load team records from ESPN. Try again in a few minutes.' });
  }

  const [awaySched, homeSched] = await Promise.all([
    getTeamSchedule(game.league, game.away_team_id, game.season_year),
    getTeamSchedule(game.league, game.home_team_id, game.season_year),
  ]);
  if (!awaySched || !homeSched) {
    return res.status(502).json({ error: 'Couldn’t load team records from ESPN. Try again in a few minutes.' });
  }

  const kickoff = new Date(game.start_time);
  res.json({ away: teamAsOf(awaySched, kickoff), home: teamAsOf(homeSched, kickoff) });
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
