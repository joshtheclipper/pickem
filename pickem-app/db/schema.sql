-- Pick'em Challenge schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pin_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  winner TEXT, -- 'home' | 'away' | 'tie' | NULL
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, prop_id)
);

CREATE INDEX IF NOT EXISTS idx_props_week ON props(league, season_year, week);
CREATE INDEX IF NOT EXISTS idx_prop_picks_user ON prop_picks(user_id);
