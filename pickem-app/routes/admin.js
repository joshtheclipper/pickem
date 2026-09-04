const express = require('express');
const db = require('../db/db');
const { requireAdmin } = require('../middleware/auth');
const { fetchScoreboard } = require('../services/espn');
const { syncAndGrade } = require('../services/grading');

const router = express.Router();

// GET /api/admin/fetch-games?league=NFL&week=1&year=2026
// Pulls the full slate from ESPN so the admin can pick which ones to include.
router.get('/fetch-games', requireAdmin, async (req, res) => {
  const { league, week, year } = req.query;
  if (!league || !week || !year) {
    return res.status(400).json({ error: 'league, week, and year are required' });
  }
  try {
    const events = await fetchScoreboard(league, Number(week), Number(year));
    // Mark which ones are already saved/included in our DB.
    const existing = db
      .prepare('SELECT espn_event_id, included FROM games WHERE league = ? AND week = ? AND season_year = ?')
      .all(league, week, year);
    const existingMap = Object.fromEntries(existing.map((e) => [e.espn_event_id, e.included]));

    const result = events.map((ev) => ({
      ...ev,
      already_saved: ev.espn_event_id in existingMap,
      included: existingMap[ev.espn_event_id] !== undefined ? !!existingMap[ev.espn_event_id] : false,
    }));
    res.json({ games: result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/admin/select-games  { games: [ {espn_event_id, league, ...}, ... ] }
// Saves the admin's chosen subset (10-15 games) as the official challenge slate for that week.
router.post('/select-games', requireAdmin, (req, res) => {
  const { games } = req.body || {};
  if (!Array.isArray(games) || games.length === 0) {
    return res.status(400).json({ error: 'games array is required' });
  }

  const upsert = db.prepare(`
    INSERT INTO games (
      espn_event_id, league, season_year, week, start_time,
      home_team, home_team_abbr, home_team_logo,
      away_team, away_team_abbr, away_team_logo,
      home_score, away_score, status, winner,
      home_rank, away_rank, odds_summary, included
    ) VALUES (@espn_event_id, @league, @season_year, @week, @start_time,
      @home_team, @home_team_abbr, @home_team_logo,
      @away_team, @away_team_abbr, @away_team_logo,
      @home_score, @away_score, @status, @winner,
      @home_rank, @away_rank, @odds_summary, 1)
    ON CONFLICT(espn_event_id) DO UPDATE SET
      start_time = excluded.start_time,
      home_score = excluded.home_score,
      away_score = excluded.away_score,
      status = excluded.status,
      winner = excluded.winner,
      home_rank = excluded.home_rank,
      away_rank = excluded.away_rank,
      odds_summary = excluded.odds_summary,
      included = 1
  `);

  const tx = db.transaction((list) => {
    for (const g of list) {
      upsert.run({
        espn_event_id: g.espn_event_id,
        league: g.league,
        season_year: g.season_year,
        week: g.week,
        start_time: g.start_time,
        home_team: g.home_team,
        home_team_abbr: g.home_team_abbr,
        home_team_logo: g.home_team_logo || null,
        away_team: g.away_team,
        away_team_abbr: g.away_team_abbr,
        away_team_logo: g.away_team_logo || null,
        home_score: g.home_score !== undefined ? g.home_score : null,
        away_score: g.away_score !== undefined ? g.away_score : null,
        status: g.status || 'scheduled',
        winner: g.winner || null,
        home_rank: g.home_rank || null,
        away_rank: g.away_rank || null,
        odds_summary: g.odds_summary || null,
      });
    }
  });
  tx(games);

  res.json({ ok: true, saved: games.length });
});

// POST /api/admin/remove-game { id }
router.post('/remove-game', requireAdmin, (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  db.prepare('UPDATE games SET included = 0 WHERE id = ?').run(id);
  res.json({ ok: true });
});

// POST /api/admin/sync - manually trigger a score sync + grading pass
router.post('/sync', requireAdmin, async (req, res) => {
  try {
    const result = await syncAndGrade();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/games/:id/picks - every player's pick on a single game
// (or null if they haven't picked), regardless of lock status. Used by the
// admin "Manage picks" panel so picks can be corrected at any time.
router.get('/games/:id/picks', requireAdmin, (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const rows = db
    .prepare(
      `SELECT u.id AS user_id, u.username, p.pick, p.is_correct, p.admin_overridden
       FROM users u
       LEFT JOIN picks p ON p.user_id = u.id AND p.game_id = ?
       ORDER BY u.username ASC`
    )
    .all(req.params.id);

  res.json({ game, picks: rows });
});

// POST /api/admin/picks/edit  { game_id, user_id, pick: 'home'|'away' }
// Admin override: sets or changes a player's pick on a game regardless of
// whether picks are locked. If the game is already final, the pick is
// re-graded immediately rather than waiting for the next sync (the sync job
// only grades picks where is_correct IS NULL, so a correction here would
// otherwise be silently skipped).
router.post('/picks/edit', requireAdmin, (req, res) => {
  const { game_id, user_id, pick } = req.body || {};
  if (!game_id || !user_id || !['home', 'away'].includes(pick)) {
    return res.status(400).json({ error: "game_id, user_id, and pick ('home'|'away') are required" });
  }

  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(game_id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let isCorrect = null;
  if (game.status === 'final' && game.winner) {
    isCorrect = game.winner === 'tie' ? 0 : pick === game.winner ? 1 : 0;
  }

  const existing = db.prepare('SELECT id FROM picks WHERE user_id = ? AND game_id = ?').get(user_id, game_id);
  if (existing) {
    db.prepare("UPDATE picks SET pick = ?, is_correct = ?, admin_overridden = 1, updated_at = datetime('now') WHERE id = ?").run(
      pick,
      isCorrect,
      existing.id
    );
  } else {
    db.prepare('INSERT INTO picks (user_id, game_id, pick, is_correct, admin_overridden) VALUES (?, ?, ?, ?, 1)').run(
      user_id,
      game_id,
      pick,
      isCorrect
    );
  }

  res.json({ ok: true, is_correct: isCorrect });
});

// POST /api/admin/props  { league, week, season_year, question, locks_at? }
// Create a free-text yes/no prop question for a given league/week.
router.post('/props', requireAdmin, (req, res) => {
  const { league, week, season_year, question, locks_at } = req.body || {};
  if (!league || !week || !season_year || !question || !String(question).trim()) {
    return res.status(400).json({ error: 'league, week, season_year, and question are required' });
  }
  const info = db
    .prepare(
      'INSERT INTO props (league, season_year, week, question, locks_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(league, season_year, week, String(question).trim(), locks_at || null);
  res.json({ ok: true, id: info.lastInsertRowid });
});

// GET /api/admin/props?league=&week=&year= - list props for a week (admin view, includes closed ones)
router.get('/props', requireAdmin, (req, res) => {
  const { league, week, year } = req.query;
  if (!league || !week || !year) {
    return res.status(400).json({ error: 'league, week, and year are required' });
  }
  const props = db
    .prepare(
      'SELECT * FROM props WHERE league = ? AND week = ? AND season_year = ? AND included = 1 ORDER BY created_at ASC'
    )
    .all(league, week, year);
  res.json({ props });
});

// POST /api/admin/props/grade  { id, correct_answer: 'yes'|'no' }
// Grades every pick submitted on this prop and closes it.
router.post('/props/grade', requireAdmin, (req, res) => {
  const { id, correct_answer } = req.body || {};
  if (!id || !['yes', 'no'].includes(correct_answer)) {
    return res.status(400).json({ error: "id and correct_answer ('yes'|'no') are required" });
  }
  const prop = db.prepare('SELECT * FROM props WHERE id = ?').get(id);
  if (!prop) return res.status(404).json({ error: 'Prop not found' });

  const tx = db.transaction(() => {
    db.prepare("UPDATE props SET status = 'closed', correct_answer = ? WHERE id = ?").run(correct_answer, id);
    const picks = db.prepare('SELECT id, answer FROM prop_picks WHERE prop_id = ?').all(id);
    for (const p of picks) {
      const isCorrect = p.answer === correct_answer ? 1 : 0;
      db.prepare("UPDATE prop_picks SET is_correct = ?, updated_at = datetime('now') WHERE id = ?").run(isCorrect, p.id);
    }
  });
  tx();

  res.json({ ok: true });
});

// POST /api/admin/props/remove { id } - hide a prop (only if no one has picked it yet)
router.post('/props/remove', requireAdmin, (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  const pickCount = db.prepare('SELECT COUNT(*) AS c FROM prop_picks WHERE prop_id = ?').get(id).c;
  if (pickCount > 0) {
    return res.status(400).json({ error: 'Cannot remove a prop that already has picks on it — grade it instead' });
  }
  db.prepare('UPDATE props SET included = 0 WHERE id = ?').run(id);
  res.json({ ok: true });
});

// GET /api/admin/users - list all players
router.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY username').all();
  res.json({ users });
});

// POST /api/admin/users/remove { id }
// Permanently deletes a player's account. Their picks and prop picks cascade
// with it (ON DELETE CASCADE), so this also erases their leaderboard history
// — the client confirms this with the admin before calling it.
router.post('/users/remove', requireAdmin, (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  if (Number(id) === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own account" });
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
