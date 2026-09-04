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
