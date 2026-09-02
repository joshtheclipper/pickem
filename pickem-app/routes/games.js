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

// GET /api/games/:id/picks - everyone's pick on a single game, once it's locked
// Server-side enforced: even a direct API call can't see picks before kickoff.
router.get('/:id/picks', requireAuth, (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const locked = game.status !== 'scheduled' || new Date(game.start_time) <= new Date();
  if (!locked) {
    return res.status(403).json({ error: 'Picks are hidden until this game starts' });
  }

  const picks = db
    .prepare(
      `SELECT u.username, p.pick, p.is_correct
       FROM picks p JOIN users u ON u.id = p.user_id
       WHERE p.game_id = ?
       ORDER BY u.username ASC`
    )
    .all(req.params.id);

  res.json({ picks });
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
