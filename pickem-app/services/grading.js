const db = require('../db/db');
const { fetchScoreboard } = require('./espn');

/**
 * Re-fetches scores for all non-final games currently in the DB and grades
 * any picks attached to games that just went final. Safe to call repeatedly
 * (e.g. from a cron job or a manual "Sync Now" button).
 */
async function syncAndGrade() {
  const pendingGames = db
    .prepare("SELECT DISTINCT league, season_year, week FROM games WHERE status != 'final'")
    .all();

  let updatedGames = 0;
  let gradedPicks = 0;

  for (const { league, season_year, week } of pendingGames) {
    let events;
    try {
      events = await fetchScoreboard(league, week, season_year);
    } catch (err) {
      console.error(`Failed to sync ${league} week ${week}:`, err.message);
      continue;
    }

    const updateStmt = db.prepare(`
      UPDATE games SET home_score = ?, away_score = ?, status = ?, winner = ?,
        home_rank = ?, away_rank = ?, odds_summary = ?
      WHERE espn_event_id = ? AND league = ? AND season_year = ?
    `);

    for (const ev of events) {
      const result = updateStmt.run(
        ev.home_score,
        ev.away_score,
        ev.status,
        ev.winner,
        ev.home_rank,
        ev.away_rank,
        ev.odds_summary,
        ev.espn_event_id,
        league,
        season_year
      );
      if (result.changes > 0) updatedGames += result.changes;
    }
  }

  // Grade any picks tied to games that are final but not yet graded.
  const finalGames = db
    .prepare("SELECT id, winner FROM games WHERE status = 'final' AND winner IS NOT NULL")
    .all();

  const gradeStmt = db.prepare(
    "UPDATE picks SET is_correct = ?, updated_at = datetime('now') WHERE game_id = ? AND is_correct IS NULL"
  );

  const tx = db.transaction((games) => {
    for (const g of games) {
      if (g.winner === 'tie') {
        // Ties count as no one correct (pushes). Mark as 0 either way.
        const r = gradeStmt.run(0, g.id);
        gradedPicks += r.changes;
        continue;
      }
      const correctPicks = db.prepare('SELECT id, pick FROM picks WHERE game_id = ? AND is_correct IS NULL').all(g.id);
      for (const p of correctPicks) {
        const isCorrect = p.pick === g.winner ? 1 : 0;
        db.prepare("UPDATE picks SET is_correct = ?, updated_at = datetime('now') WHERE id = ?").run(isCorrect, p.id);
        gradedPicks += 1;
      }
    }
  });
  tx(finalGames);

  return { updatedGames, gradedPicks, checkedGroups: pendingGames.length };
}

module.exports = { syncAndGrade };
