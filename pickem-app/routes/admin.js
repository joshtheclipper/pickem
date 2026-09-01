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
      home_score, away_score, status, winner, included
    ) VALUES (@espn_event_id, @league, @season_year, @week, @start_time,
      @home_team, @home_team_abbr, @home_team_logo,
      @away_team, @away_team_abbr, @away_team_logo,
      @home_score, @away_score, @status, @winner, 1)
    ON CONFLICT(espn_event_id) DO UPDATE SET
      start_time = excluded.start_time,
      home_score = excluded.home_score,
      away_score = excluded.away_score,
      status = excluded.status,
      winner = excluded.winner,
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

// GET /api/admin/users - list all players
router.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY username').all();
  res.json({ users });
});

module.exports = router;
