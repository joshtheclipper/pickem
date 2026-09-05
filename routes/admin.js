const express = require('express');
const bcrypt = require('bcryptjs');
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
      home_score, away_score, status, status_detail, winner,
      home_rank, away_rank, odds_summary, included
    ) VALUES (@espn_event_id, @league, @season_year, @week, @start_time,
      @home_team, @home_team_abbr, @home_team_logo,
      @away_team, @away_team_abbr, @away_team_logo,
      @home_score, @away_score, @status, @status_detail, @winner,
      @home_rank, @away_rank, @odds_summary, 1)
    ON CONFLICT(espn_event_id) DO UPDATE SET
      start_time = excluded.start_time,
      home_score = excluded.home_score,
      away_score = excluded.away_score,
      status = excluded.status,
      status_detail = excluded.status_detail,
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
        status_detail: g.status_detail || null,
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
      `SELECT p.*, (SELECT COUNT(*) FROM prop_picks pp WHERE pp.prop_id = p.id) AS pick_count
       FROM props p
       WHERE p.league = ? AND p.week = ? AND p.season_year = ? AND p.included = 1
       ORDER BY p.created_at ASC`
    )
    .all(league, week, year);
  res.json({ props });
});

// POST /api/admin/props/grade  { id, correct_answer: 'yes'|'no' }
// Grades every pick submitted on this prop and closes it. Safe to call again
// on an already-closed prop to change the grade — every pick is re-scored
// against the new answer, so the leaderboard corrects itself on the next load.
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

// POST /api/admin/props/ungrade  { id }
// Reverses a grade: reopens the prop and resets every pick's is_correct back
// to NULL, so it drops out of the leaderboard until it's graded again.
router.post('/props/ungrade', requireAdmin, (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  const prop = db.prepare('SELECT id FROM props WHERE id = ?').get(id);
  if (!prop) return res.status(404).json({ error: 'Prop not found' });

  const tx = db.transaction(() => {
    db.prepare("UPDATE props SET status = 'open', correct_answer = NULL WHERE id = ?").run(id);
    db.prepare("UPDATE prop_picks SET is_correct = NULL, updated_at = datetime('now') WHERE prop_id = ?").run(id);
  });
  tx();

  res.json({ ok: true });
});

// POST /api/admin/props/edit  { id, question?, locks_at? }
// Fix a prop's wording or lock time. Only the fields sent are touched, and
// grading is left untouched — changing the answer is /props/grade's job.
router.post('/props/edit', requireAdmin, (req, res) => {
  const { id, question, locks_at } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  const prop = db.prepare('SELECT id FROM props WHERE id = ?').get(id);
  if (!prop) return res.status(404).json({ error: 'Prop not found' });

  const fields = [];
  const params = [];
  if (question !== undefined) {
    if (!String(question).trim()) return res.status(400).json({ error: 'question cannot be empty' });
    fields.push('question = ?');
    params.push(String(question).trim());
  }
  if (locks_at !== undefined) {
    fields.push('locks_at = ?');
    params.push(locks_at || null);
  }
  if (fields.length === 0) return res.status(400).json({ error: 'nothing to update' });

  params.push(id);
  db.prepare(`UPDATE props SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// POST /api/admin/props/remove { id, force? }
// With no picks on it, the prop is just hidden (included = 0). Once picks
// exist, removing it also throws away those picks (which count toward the
// leaderboard), so that needs an explicit force flag — the client confirms
// it with the admin first. prop_picks cascades on delete.
router.post('/props/remove', requireAdmin, (req, res) => {
  const { id, force } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  const prop = db.prepare('SELECT id FROM props WHERE id = ?').get(id);
  if (!prop) return res.status(404).json({ error: 'Prop not found' });

  const pickCount = db.prepare('SELECT COUNT(*) AS c FROM prop_picks WHERE prop_id = ?').get(id).c;
  if (pickCount > 0 && !force) {
    return res.status(400).json({
      error: `This prop has ${pickCount} pick${pickCount === 1 ? '' : 's'} on it. Deleting it will also delete those picks.`,
      needs_force: true,
    });
  }

  if (pickCount > 0) {
    db.prepare('DELETE FROM props WHERE id = ?').run(id);
  } else {
    db.prepare('UPDATE props SET included = 0 WHERE id = ?').run(id);
  }
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

// POST /api/admin/users/set-pin  { id, new_pin }
// Resets a player's PIN on their behalf (e.g. they forgot it) — unlike the
// self-service Account page, this doesn't require knowing the current PIN.
router.post('/users/set-pin', requireAdmin, (req, res) => {
  const { id, new_pin } = req.body || {};
  if (!id || !new_pin) {
    return res.status(400).json({ error: 'id and new_pin are required' });
  }
  if (Number(id) === req.user.id) {
    return res.status(400).json({ error: 'Change your own PIN from the Account tab' });
  }
  if (String(new_pin).length < 4) {
    return res.status(400).json({ error: 'PIN must be at least 4 characters' });
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const pinHash = bcrypt.hashSync(String(new_pin), 10);
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(pinHash, id);
  res.json({ ok: true });
});

// POST /api/admin/users/make-admin  { id }
// Only one admin exists at a time, so this demotes whoever currently holds
// it and promotes the target user in the same transaction. Note this
// doesn't invalidate any already-issued JWTs — is_admin is baked into the
// token at login (see middleware/auth.js), so both the outgoing and
// incoming admin need to log out and back in for their session to reflect
// the change. The caller (the current admin) is logged out client-side
// immediately after this succeeds to avoid running on a stale token.
router.post('/users/make-admin', requireAdmin, (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  if (Number(id) === req.user.id) {
    return res.status(400).json({ error: "You're already the admin" });
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET is_admin = 0 WHERE is_admin = 1').run();
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id);
  });
  tx();

  res.json({ ok: true });
});

module.exports = router;
