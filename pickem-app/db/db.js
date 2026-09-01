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

module.exports = db;
