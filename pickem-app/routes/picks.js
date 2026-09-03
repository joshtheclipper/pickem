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
    .prepare('SELECT id, locked_in FROM picks WHERE user_id = ? AND game_id = ?')
    .get(req.user.id, game_id);

  if (existing && existing.locked_in) {
    return res.status(400).json({ error: 'This pick is locked in and can no longer be changed' });
  }

  if (existing) {
    db.prepare("UPDATE picks SET pick = ?, updated_at = datetime('now') WHERE id = ?").run(pick, existing.id);
  } else {
    db.prepare('INSERT INTO picks (user_id, game_id, pick) VALUES (?, ?, ?)').run(req.user.id, game_id, pick);
  }

  res.json({ ok: true });
});

// POST /api/picks/lock  { league, week, year }
// "Lock in" every pick the player has made in this league/week that isn't
// already locked. Locking a pick on a game is what unlocks pick-to-see for
// that specific game — a player can't view everyone else's pick until
// they've committed their own (or the game has started). This is a bulk
// action scoped to the currently-viewed week, mirroring how the admin's
// "Save selected games" is scoped to one league/week at a time.
router.post('/lock', requireAuth, (req, res) => {
  const { league, week, year } = req.body || {};
  if (!league || !week || !year) {
    return res.status(400).json({ error: 'league, week, and year are required' });
  }

  const result = db
    .prepare(
      `UPDATE picks
       SET locked_in = 1, updated_at = datetime('now')
       WHERE user_id = ? AND locked_in = 0 AND game_id IN (
         SELECT id FROM games WHERE league = ? AND week = ? AND season_year = ?
       )`
    )
    .run(req.user.id, league, week, year);

  res.json({ ok: true, locked: result.changes });
});

// GET /api/picks/mine?league=&week=&year= - all of my picks for a week, with correctness
router.get('/mine', requireAuth, (req, res) => {
  const { league, week, year } = req.query;
  const rows = db
    .prepare(
      `SELECT p.pick, p.is_correct, p.locked_in, g.* FROM picks p
       JOIN games g ON g.id = p.game_id
       WHERE p.user_id = ? AND g.league = ? AND g.week = ? AND g.season_year = ?
       ORDER BY g.start_time ASC`
    )
    .all(req.user.id, league, week, year);
  res.json({ picks: rows });
});

module.exports = router;
