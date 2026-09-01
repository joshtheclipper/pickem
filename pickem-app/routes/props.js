const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/props?league=NFL&week=1&year=2026
router.get('/', requireAuth, (req, res) => {
  const { league, week, year } = req.query;
  if (!league || !week || !year) {
    return res.status(400).json({ error: 'league, week, and year are required' });
  }

  const props = db
    .prepare(
      `SELECT * FROM props WHERE league = ? AND week = ? AND season_year = ? AND included = 1 ORDER BY created_at ASC`
    )
    .all(league, week, year);

  const picks = db
    .prepare(
      `SELECT prop_id, answer, is_correct FROM prop_picks WHERE user_id = ? AND prop_id IN (${props.map(() => '?').join(',') || 'NULL'})`
    )
    .all(req.user.id, ...props.map((p) => p.id));

  const pickMap = Object.fromEntries(picks.map((p) => [p.prop_id, p]));

  const now = new Date();
  const enriched = props.map((p) => ({
    ...p,
    locked: p.status === 'closed' || (p.locks_at && new Date(p.locks_at) <= now),
    my_answer: pickMap[p.id] ? pickMap[p.id].answer : null,
    my_answer_correct: pickMap[p.id] ? pickMap[p.id].is_correct : null,
  }));

  res.json({ props: enriched });
});

// POST /api/props/pick  { prop_id, answer: 'yes'|'no' }
router.post('/pick', requireAuth, (req, res) => {
  const { prop_id, answer } = req.body || {};
  if (!prop_id || !['yes', 'no'].includes(answer)) {
    return res.status(400).json({ error: "prop_id and answer ('yes'|'no') are required" });
  }

  const prop = db.prepare('SELECT * FROM props WHERE id = ?').get(prop_id);
  if (!prop) return res.status(404).json({ error: 'Prop not found' });

  if (prop.status === 'closed' || (prop.locks_at && new Date(prop.locks_at) <= new Date())) {
    return res.status(400).json({ error: 'This prop is locked' });
  }

  const existing = db
    .prepare('SELECT id FROM prop_picks WHERE user_id = ? AND prop_id = ?')
    .get(req.user.id, prop_id);

  if (existing) {
    db.prepare("UPDATE prop_picks SET answer = ?, updated_at = datetime('now') WHERE id = ?").run(answer, existing.id);
  } else {
    db.prepare('INSERT INTO prop_picks (user_id, prop_id, answer) VALUES (?, ?, ?)').run(req.user.id, prop_id, answer);
  }

  res.json({ ok: true });
});

module.exports = router;
