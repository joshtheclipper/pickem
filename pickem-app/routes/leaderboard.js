const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/leaderboard - overall totals across everything graded so far
// GET /api/leaderboard?league=NFL - filter to one league
// GET /api/leaderboard?league=NFL&week=3&year=2026 - a single week
router.get('/', requireAuth, (req, res) => {
  const { league, week, year } = req.query;

  let query = `
    SELECT u.id AS user_id, u.username,
      COUNT(p.id) AS total_picks,
      SUM(CASE WHEN p.is_correct = 1 THEN 1 ELSE 0 END) AS correct_picks,
      SUM(CASE WHEN p.is_correct IS NOT NULL THEN 1 ELSE 0 END) AS graded_picks
    FROM users u
    LEFT JOIN picks p ON p.user_id = u.id
    LEFT JOIN games g ON g.id = p.game_id
  `;
  const conditions = [];
  const params = [];
  if (league) {
    conditions.push('g.league = ?');
    params.push(league);
  }
  if (week) {
    conditions.push('g.week = ?');
    params.push(week);
  }
  if (year) {
    conditions.push('g.season_year = ?');
    params.push(year);
  }
  if (conditions.length) {
    query += ' WHERE (g.id IS NULL OR (' + conditions.join(' AND ') + '))';
  }
  query += ' GROUP BY u.id, u.username ORDER BY correct_picks DESC, total_picks ASC, u.username ASC';

  const rows = db.prepare(query).all(...params);
  const leaderboard = rows.map((r) => ({
    ...r,
    correct_picks: r.correct_picks || 0,
    total_picks: r.total_picks || 0,
    graded_picks: r.graded_picks || 0,
  }));

  res.json({ leaderboard });
});

module.exports = router;
