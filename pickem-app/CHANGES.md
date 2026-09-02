# Changes in this update

- Fixed: making a pick no longer reloads/flickers the whole list — it updates just that one
  game or prop in place.
- Added: admin can write free-text yes/no "prop" questions per league/week (e.g. "Will there be
  a pick-six this week?"). Players answer Yes/No from the Picks tab, alongside the regular games.
  Admin grades them manually from the Admin tab once the answer is known, and correct answers
  count 1 point each toward the leaderboard, same as game picks.
- New tables: `props`, `prop_picks`. These are added via `CREATE TABLE IF NOT EXISTS`, so
  restarting with the updated `db/schema.sql` will not touch your existing `games`, `picks`, or
  `users` data — it only adds the two new tables alongside what's already there.

## Follow-up update

- **Fixed a Docker volume bug**: the database file now lives in its own `data/` directory,
  separate from `db/` (source code). Previously the volume was mounted at `/app/db`, which is
  also where `schema.sql` and `db.js` live — this permanently masked any future code updates to
  those two files after the volume's first creation. If you hit this, see the fix instructions
  you were walked through; your `docker-compose.yml` needs its volume mount changed from
  `pickem_data:/app/db` to `pickem_data:/app/data`.
- **AP Top 25 rankings**: when ESPN reports a team as ranked (NCAAF only, in practice), the pick
  page now shows a `#N` badge next to that team's name.
- **Betting lines**: the point spread and over/under, when ESPN provides them, show under the
  kickoff time on each game — for reference only, picks are still graded straight-up by winner,
  not against the spread.
- **Account settings**: players can now change their own username and/or PIN from the new
  "Account" tab, confirmed with their current PIN.
- **Schema migration added**: `db/db.js` now runs small, additive `ALTER TABLE` migrations for
  columns added after initial release (currently: `games.home_rank`, `games.away_rank`,
  `games.odds_summary`). These run automatically on startup and only add a column if it's
  missing — existing data is never touched. This mechanism will be reused for any future
  column additions, so future updates like this one will apply automatically without you needing
  to do anything beyond the normal `docker compose up -d --build pickem`.
