const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/picks  { game_id, pick: 'home'|'away' }
router.post('/', requireAuth, (req, res) => {
  const { game_id, pick } = req.body || {};
  if (!game_id || !['home', 'away'].includes(pick)) {
    return res.status(400).json({ error: "game_id and pick ('home'|'away') are required" });
  }

  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(game_id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  if (game.status !== 'scheduled' || new Date(game.start_time) <= new Date()) {
    return res.status(400).json({ error: 'Picks are locked for this game (it has started or finished)' });
  }

  const existing = db
    .prepare('SELECT id FROM picks WHERE user_id = ? AND game_id = ?')
    .get(req.user.id, game_id);

  if (existing) {
    db.prepare("UPDATE picks SET pick = ?, updated_at = datetime('now') WHERE id = ?").run(pick, existing.id);
  } else {
    db.prepare('INSERT INTO picks (user_id, game_id, pick) VALUES (?, ?, ?)').run(req.user.id, game_id, pick);
  }

  res.json({ ok: true });
});

// GET /api/picks/mine?league=&week=&year= - all of my picks for a week, with correctness
router.get('/mine', requireAuth, (req, res) => {
  const { league, week, year } = req.query;
  const rows = db
    .prepare(
      `SELECT p.pick, p.is_correct, g.* FROM picks p
       JOIN games g ON g.id = p.game_id
       WHERE p.user_id = ? AND g.league = ? AND g.week = ? AND g.season_year = ?
       ORDER BY g.start_time ASC`
    )
    .all(req.user.id, league, week, year);
  res.json({ picks: rows });
});

module.exports = router;
