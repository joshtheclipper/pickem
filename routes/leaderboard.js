const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/leaderboard - overall totals across everything graded so far
// GET /api/leaderboard?league=NFL - filter to one league
// GET /api/leaderboard?league=NFL&week=3&year=2026 - a single week
// Combines regular game picks and yes/no prop picks into one point total
// (1 point per correct answer, same as game picks).
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
      COALESCE(gp.total, 0) + COALESCE(pp.total, 0) AS total_picks,
      COALESCE(gp.correct, 0) + COALESCE(pp.correct, 0) AS correct_picks,
      COALESCE(gp.graded, 0) + COALESCE(pp.graded, 0) AS graded_picks
    FROM users u
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
    ORDER BY correct_picks DESC, total_picks ASC, u.username ASC
  `;

  const rows = db.prepare(query).all(...gameParams, ...propParams);
  res.json({ leaderboard: rows });
});

module.exports = router;
