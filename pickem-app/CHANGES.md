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
