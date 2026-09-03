const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// The actual .db file lives in a separate "data" directory from the source
// code (db.js, schema.sql). This matters for Docker: if the data directory
// were the same one schema.sql/db.js live in, mounting a volume there would
// permanently mask any future code updates to those files. Keeping data in
// its own directory means `docker compose up -d --build` always picks up
// code changes, while the volume only ever holds the .db file itself.
const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DEFAULT_DATA_DIR, 'pickem.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const isNew = !fs.existsSync(DB_PATH);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

if (isNew) {
  console.log(`Created new database at ${DB_PATH}`);
}

// Lightweight migrations for columns added after initial release. Safe to
// run every startup — each one only fires if the column doesn't exist yet,
// so it never touches existing data. CREATE TABLE IF NOT EXISTS (above)
// only helps brand-new tables; altering an *existing* table needs this.
const migrations = [
  { table: 'games', column: 'home_rank', ddl: 'ALTER TABLE games ADD COLUMN home_rank INTEGER' },
  { table: 'games', column: 'away_rank', ddl: 'ALTER TABLE games ADD COLUMN away_rank INTEGER' },
  { table: 'games', column: 'odds_summary', ddl: 'ALTER TABLE games ADD COLUMN odds_summary TEXT' },
  { table: 'picks', column: 'locked_in', ddl: 'ALTER TABLE picks ADD COLUMN locked_in INTEGER NOT NULL DEFAULT 0' },
];
for (const m of migrations) {
  const cols = db.prepare(`PRAGMA table_info(${m.table})`).all();
  if (!cols.some((c) => c.name === m.column)) {
    db.exec(m.ddl);
    console.log(`Migrated: added ${m.table}.${m.column}`);
  }
}

module.exports = db;
