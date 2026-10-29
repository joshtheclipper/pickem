const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// A streak only counts (and gets a flame/snowflake) once it's this long.
const STREAK_MIN = 3;

// Timestamps come in two shapes: ESPN ISO strings ("2026-09-24T17:00Z") and
// SQLite datetime('now') text ("2026-09-24 17:00:00", UTC with no zone).
function toMs(t) {
  if (!t) return 0;
  const s = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(t) ? `${t.replace(' ', 'T')}Z` : t;
  const ms = new Date(s).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

// Standings order: most correct first, then fewest graded picks (a better
// hit rate), then name — the same order as the SQL below (binary name
// compare, like SQLite's default collation).
function rankUsers(users, stats) {
  const s = (id) => stats.get(id) || { correct: 0, graded: 0 };
  return [...users].sort(
    (a, b) =>
      s(b.user_id).correct - s(a.user_id).correct ||
      s(a.user_id).graded - s(b.user_id).graded ||
      (a.username < b.username ? -1 : a.username > b.username ? 1 : 0)
  );
}

function tally(items) {
  const stats = new Map();
  for (const it of items) {
    const st = stats.get(it.user_id) || { correct: 0, graded: 0 };
    st.graded += 1;
    if (it.is_correct === 1) st.correct += 1;
    stats.set(it.user_id, st);
  }
  return stats;
}

// GET /api/leaderboard - overall totals across everything graded so far
// GET /api/leaderboard?league=NFL - filter to one league
// GET /api/leaderboard?league=NFL&week=3&year=2026 - a single week
// Combines regular game picks and yes/no prop picks into one point total
// (1 point per correct answer, same as game picks). Each row also carries:
//   avatar_v  - profile photo version (null = no photo)
//   streak    - { type: 'hot'|'cold', count } for 3+ straight right/wrong
//   movement  - places gained (+) or lost (-) since before the latest
//               graded week in each league; null when there's no prior week
// plus a top-level weekly_winner for the most recently completed week.
router.get('/', requireAuth, (req, res) => {
  const { league, week, year } = req.query;

  const gameConditions = [];
  const gameParams = [];
  if (league) { gameConditions.push('g.league = ?'); gameParams.push(league); }
  if (week) { gameConditions.push('g.week = ?'); gameParams.push(week); }
  if (year) { gameConditions.push('g.season_year = ?'); gameParams.push(year); }
  const gameWhere = gameConditions.length ? `WHERE ${gameConditions.join(' AND ')}` : '';

  const propConditions = [];
  const propParams = [];
  if (league) { propConditions.push('pr.league = ?'); propParams.push(league); }
  if (week) { propConditions.push('pr.week = ?'); propParams.push(week); }
  if (year) { propConditions.push('pr.season_year = ?'); propParams.push(year); }
  const propWhere = propConditions.length ? `WHERE ${propConditions.join(' AND ')}` : '';

  const query = `
    SELECT
      u.id AS user_id,
      u.username,
      a.updated_at AS avatar_v,
      COALESCE(gp.total, 0) + COALESCE(pp.total, 0) AS total_picks,
      COALESCE(gp.correct, 0) + COALESCE(pp.correct, 0) AS correct_picks,
      COALESCE(gp.graded, 0) + COALESCE(pp.graded, 0) AS graded_picks
    FROM users u
    LEFT JOIN user_avatars a ON a.user_id = u.id
    LEFT JOIN (
      SELECT p.user_id,
        COUNT(*) AS total,
        SUM(CASE WHEN p.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
        SUM(CASE WHEN p.is_correct IS NOT NULL THEN 1 ELSE 0 END) AS graded
      FROM picks p JOIN games g ON g.id = p.game_id
      ${gameWhere}
      GROUP BY p.user_id
    ) gp ON gp.user_id = u.id
    LEFT JOIN (
      SELECT pp.user_id,
        COUNT(*) AS total,
        SUM(CASE WHEN pp.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
        SUM(CASE WHEN pp.is_correct IS NOT NULL THEN 1 ELSE 0 END) AS graded
      FROM prop_picks pp JOIN props pr ON pr.id = pp.prop_id
      ${propWhere}
      GROUP BY pp.user_id
    ) pp ON pp.user_id = u.id
    ORDER BY correct_picks DESC, graded_picks ASC, u.username ASC
  `;

  const rows = db.prepare(query).all(...gameParams, ...propParams);

  // Every graded pick in scope, with the time it was decided: kickoff for a
  // game, lock time for a prop (or when it was written, if it never locked).
  const andGame = gameConditions.length ? `AND ${gameConditions.join(' AND ')}` : '';
  const andProp = propConditions.length ? `AND ${propConditions.join(' AND ')}` : '';
  const items = db
    .prepare(
      `SELECT p.user_id, p.is_correct, g.league, g.season_year, g.week, g.start_time AS t
       FROM picks p JOIN games g ON g.id = p.game_id
       WHERE p.is_correct IS NOT NULL ${andGame}
       UNION ALL
       SELECT pp.user_id, pp.is_correct, pr.league, pr.season_year, pr.week, COALESCE(pr.locks_at, pr.created_at) AS t
       FROM prop_picks pp JOIN props pr ON pr.id = pp.prop_id
       WHERE pp.is_correct IS NOT NULL ${andProp}`
    )
    .all(...gameParams, ...propParams)
    .map((it) => ({ ...it, ms: toMs(it.t) }))
    .sort((a, b) => a.ms - b.ms);

  // --- Streaks: walk each player's graded picks from the newest back ---
  const byUser = new Map();
  for (const it of items) {
    if (!byUser.has(it.user_id)) byUser.set(it.user_id, []);
    byUser.get(it.user_id).push(it.is_correct);
  }
  const streakFor = (userId) => {
    const results = byUser.get(userId);
    if (!results || results.length === 0) return null;
    const last = results[results.length - 1];
    let count = 0;
    for (let i = results.length - 1; i >= 0 && results[i] === last; i -= 1) count += 1;
    if (count < STREAK_MIN) return null;
    return { type: last === 1 ? 'hot' : 'cold', count };
  };

  // --- Movement: standings now vs. before each league's latest graded week ---
  const weekKey = (it) => `${it.league}|${it.season_year}|${it.week}`;
  const latestByLeague = new Map();
  for (const it of items) {
    const cur = latestByLeague.get(it.league);
    if (!cur || it.season_year > cur.season_year || (it.season_year === cur.season_year && it.week > cur.week)) {
      latestByLeague.set(it.league, { season_year: it.season_year, week: it.week });
    }
  }
  const latestKeys = new Set(
    [...latestByLeague.entries()].map(([lg, w]) => `${lg}|${w.season_year}|${w.week}`)
  );
  const priorItems = items.filter((it) => !latestKeys.has(weekKey(it)));
  const movement = new Map();
  if (priorItems.length > 0) {
    // rows is already in standings order, so its index is the current rank.
    const nowRank = rows;
    const prevRank = rankUsers(rows, tally(priorItems));
    const prevPos = new Map(prevRank.map((u, i) => [u.user_id, i]));
    nowRank.forEach((u, i) => {
      if (u.graded_picks > 0) movement.set(u.user_id, prevPos.get(u.user_id) - i);
    });
  }

  const leaderboard = rows.map((r) => ({
    ...r,
    streak: streakFor(r.user_id),
    movement: movement.has(r.user_id) ? movement.get(r.user_id) : null,
  }));

  res.json({ leaderboard, weekly_winner: weeklyWinner({ league, year }) });
});

// The most recently completed week (every included game final) in scope,
// and whoever got the most right in it — games plus props, ties share it.
function weeklyWinner({ league, year }) {
  const cond = ['included = 1'];
  const params = [];
  if (league) { cond.push('league = ?'); params.push(league); }
  if (year) { cond.push('season_year = ?'); params.push(year); }
  const done = db
    .prepare(
      `SELECT league, season_year, week, MAX(start_time) AS last_start
       FROM games WHERE ${cond.join(' AND ')}
       GROUP BY league, season_year, week
       HAVING SUM(CASE WHEN status = 'final' THEN 0 ELSE 1 END) = 0`
    )
    .all(...params)
    .sort((a, b) => toMs(b.last_start) - toMs(a.last_start))[0];
  if (!done) return null;

  const scores = db
    .prepare(
      `SELECT u.id AS user_id, u.username, a.updated_at AS avatar_v,
         SUM(x.is_correct) AS correct, COUNT(*) AS graded
       FROM (
         SELECT p.user_id, p.is_correct FROM picks p JOIN games g ON g.id = p.game_id
         WHERE g.league = ? AND g.season_year = ? AND g.week = ? AND g.included = 1 AND p.is_correct IS NOT NULL
         UNION ALL
         SELECT pp.user_id, pp.is_correct FROM prop_picks pp JOIN props pr ON pr.id = pp.prop_id
         WHERE pr.league = ? AND pr.season_year = ? AND pr.week = ? AND pr.included = 1 AND pp.is_correct IS NOT NULL
       ) x
       JOIN users u ON u.id = x.user_id
       LEFT JOIN user_avatars a ON a.user_id = u.id
       GROUP BY u.id
       ORDER BY correct DESC, u.username ASC`
    )
    .all(done.league, done.season_year, done.week, done.league, done.season_year, done.week);
  if (scores.length === 0 || !scores[0].correct) return null;

  const best = scores[0].correct;
  const winners = scores.filter((s) => s.correct === best);
  return {
    league: done.league,
    season_year: done.season_year,
    week: done.week,
    correct: best,
    graded: winners[0].graded,
    winners: winners.map(({ user_id, username, avatar_v }) => ({ user_id, username, avatar_v })),
  };
}

module.exports = router;
