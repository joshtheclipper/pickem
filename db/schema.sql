-- Pick'em Challenge schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pin_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  -- Opt-in: send this player a Web Push notification when the admin posts a
  -- new slate (games or the first prop) for a league/week. Off by default;
  -- toggled from the Account page, which also registers the push
  -- subscription rows below.
  notify_slate INTEGER NOT NULL DEFAULT 0,
  -- Opt-in: push a reminder ~1 hour before a game kicks off (or a prop
  -- locks) if this player still hasn't picked it. Separate from
  -- notify_slate; both share the push_subscriptions rows below.
  notify_kickoff INTEGER NOT NULL DEFAULT 0,
  -- UI color mode chosen on the Account page: 'dark' | 'light' | 'system'.
  -- Stored on the account so it follows the player to every device.
  theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark','light','system')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per browser/device a player has granted notification permission
-- on. A player can have several (phone + laptop). Rows are pruned lazily:
-- when a push send comes back 404/410 the endpoint is dead and we delete it.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

-- Profile photos. The browser crops/shrinks the image to a small square
-- JPEG before upload (see public/account.html), so rows stay tiny; the
-- server still caps the upload size in routes/avatars.js. updated_at (ms)
-- doubles as the cache-busting version in avatar URLs.
CREATE TABLE IF NOT EXISTS user_avatars (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Dedup guard so re-saving a slate (or adding a second prop) doesn't fire a
-- second round of notifications for the same league/week/kind.
CREATE TABLE IF NOT EXISTS slate_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league TEXT NOT NULL,
  season_year INTEGER NOT NULL,
  week INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('games','props')),
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(league, season_year, week, kind)
);

-- Dedup guard for kickoff reminders: one row per player per game/prop
-- they've already been reminded about, so the job never repeats itself.
CREATE TABLE IF NOT EXISTS kickoff_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('game','prop')),
  item_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, kind, item_id)
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  espn_event_id TEXT NOT NULL,
  league TEXT NOT NULL CHECK (league IN ('NFL','NCAAF')),
  season_year INTEGER NOT NULL,
  week INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  home_team TEXT NOT NULL,
  home_team_abbr TEXT NOT NULL,
  home_team_logo TEXT,
  away_team TEXT NOT NULL,
  away_team_abbr TEXT NOT NULL,
  away_team_logo TEXT,
  home_score INTEGER,
  away_score INTEGER,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | in_progress | final
  status_detail TEXT, -- live quarter/clock text from ESPN, e.g. "8:23 - 3rd Quarter"; only meaningful while in_progress
  winner TEXT, -- 'home' | 'away' | 'tie' | NULL
  home_rank INTEGER, -- AP Top 25 rank (1-25), NULL if unranked
  away_rank INTEGER,
  odds_summary TEXT, -- e.g. "BUF -3.5, O/U 47.5" for display only, not used in grading
  -- ESPN team ids, used to pull each team's season schedule for the
  -- "View matchup" panel. NULL on rows saved before these existed; the
  -- score sync (and the matchup route itself) fills them in.
  home_team_id TEXT,
  away_team_id TEXT,
  included INTEGER NOT NULL DEFAULT 1, -- admin-selected for the challenge
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(espn_event_id)
);

CREATE TABLE IF NOT EXISTS picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  pick TEXT NOT NULL CHECK (pick IN ('home','away')),
  is_correct INTEGER, -- NULL until graded, then 0 or 1
  -- Player-initiated "lock in" — separate from the game's own kickoff lock.
  -- A pick becomes visible to other players (pick-to-see) once either this
  -- is set, or the game itself has started. See routes/games.js.
  locked_in INTEGER NOT NULL DEFAULT 0,
  -- Set when an admin uses the "Manage picks" override to set/change this
  -- pick on the player's behalf. Cleared again if the player changes the
  -- pick themselves afterward (only possible if it's still unlocked and
  -- the game hasn't started) — at that point it's genuinely their own
  -- choice again. See routes/picks.js and routes/admin.js.
  admin_overridden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_games_week ON games(league, season_year, week);
CREATE INDEX IF NOT EXISTS idx_picks_user ON picks(user_id);
CREATE INDEX IF NOT EXISTS idx_picks_game ON picks(game_id);

-- Free-text yes/no prop questions the admin writes in, e.g.
-- "Will there be a 50+ yard field goal this week?"
CREATE TABLE IF NOT EXISTS props (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league TEXT NOT NULL CHECK (league IN ('NFL','NCAAF')),
  season_year INTEGER NOT NULL,
  week INTEGER NOT NULL,
  question TEXT NOT NULL,
  locks_at TEXT, -- optional; NULL means it stays open until the admin grades it
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  correct_answer TEXT CHECK (correct_answer IN ('yes','no')), -- set when graded
  included INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prop_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prop_id INTEGER NOT NULL REFERENCES props(id) ON DELETE CASCADE,
  answer TEXT NOT NULL CHECK (answer IN ('yes','no')),
  is_correct INTEGER, -- NULL until graded
  -- Player-initiated "lock in", same pick-to-see mechanic as picks.locked_in
  -- (see routes/games.js) — a player can't view everyone else's answer on a
  -- prop until they've committed their own, or the prop itself has locked.
  locked_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, prop_id)
);

CREATE INDEX IF NOT EXISTS idx_props_week ON props(league, season_year, week);
CREATE INDEX IF NOT EXISTS idx_prop_picks_user ON prop_picks(user_id);
