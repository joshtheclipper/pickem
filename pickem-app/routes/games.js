const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/games?league=NFL&week=1&year=2026
// Returns games for the week, plus the current user's pick on each (if any).
router.get('/', requireAuth, (req, res) => {
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
      `SELECT game_id, pick, is_correct FROM picks WHERE user_id = ? AND game_id IN (${games.map(() => '?').join(',') || 'NULL'})`
    )
    .all(req.user.id, ...games.map((g) => g.id));

  const pickMap = Object.fromEntries(picks.map((p) => [p.game_id, p]));

  const now = new Date();
  const enriched = games.map((g) => ({
    ...g,
    locked: new Date(g.start_time) <= now || g.status !== 'scheduled',
    my_pick: pickMap[g.id] ? pickMap[g.id].pick : null,
    my_pick_correct: pickMap[g.id] ? pickMap[g.id].is_correct : null,
  }));

  res.json({ games: enriched });
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
