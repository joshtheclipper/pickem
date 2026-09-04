# Pick'em Challenge

A self-hosted weekly pick'em app for NFL and NCAAF. Pick winners on a set of admin-chosen games
each week, get auto-graded from live scores, and track everyone on a leaderboard — plus prop
questions, AP Top 25 badges, and betting lines for context.

Built for a group of friends running their own private challenge, with no third-party service or
account required beyond a place to host it.

## Features

- **Weekly picks for NFL and NCAAF.** An admin selects ~10–15 games per league per week; everyone
  picks a winner for each. Picks lock automatically at kickoff.
- **Auto-grading.** Scores sync from ESPN's public scoreboard feed every 15 minutes and correct
  picks are graded automatically — no manual score entry. A "Sync now" button is also available
  for on-demand refreshes.
- **Leaderboard.** Totals overall, or filtered to a single league.
- **Prop questions.** Admins can add free-text yes/no questions (e.g. "Will there be a pick-six
  this week?") that score alongside regular picks. Grading is manual since there's no live data
  source for arbitrary questions.
- **AP Top 25 badges & betting lines.** When ESPN reports a team as ranked or provides a spread /
  over-under, it's shown next to the matchup for context. Grading is always straight-up by winner,
  never against the spread.
- **Simple auth.** Username + PIN, no email required. The first account created becomes admin.
  Players can change their own username/PIN later from the Account tab.
- **Zero external dependencies for game data.** Schedules, team logos, and live scores come from
  ESPN's public scoreboard API — the same feed espn.com's own site uses. No API key or account
  needed.

## Tech stack

- **Backend:** Node.js + Express
- **Database:** SQLite (via `better-sqlite3`), a single file, no separate DB server to run
- **Frontend:** Plain HTML/CSS/vanilla JS — no build step, no framework
- **Auth:** JWT in an HTTP-only cookie, PINs hashed with bcrypt

## Requirements

- Node.js 18+ (uses the built-in `fetch`)
- Outbound internet access from wherever it's hosted (to reach ESPN's public API)

## Quick start (local development)

```bash
git clone <this-repo-url>
cd pickem
npm install
cp samples/.env.example .env
```

Open `.env` and set `JWT_SECRET` to a long random string — this signs login sessions. Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Start it:

```bash
npm start
```

Visit `http://localhost:3000`. **The first account registered automatically becomes admin.**

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Required | Default | Description |
|---|---|---|---|
| `JWT_SECRET` | Yes | — | Signs login session tokens. Use a long random string. |
| `PORT` | No | `3000` | Port the server listens on. |
| `DB_PATH` | No | `data/pickem.db` | Path to the SQLite file. |
| `DISABLE_CRON` | No | `false` | Set `true` to disable the automatic 15-minute score sync. |

## Deploying

### Option 1 — plain Node + a process manager

```bash
npm install -g pm2
pm2 start server.js --name pickem
pm2 save
pm2 startup   # follow the printed instructions to run on boot
```

Put it behind a reverse proxy for HTTPS and a real domain — e.g. with Caddy:

```
pickem.yourdomain.com {
  reverse_proxy localhost:3000
}
```

or nginx with `proxy_pass http://localhost:3000;` plus Let's Encrypt via certbot.

Once you're serving over HTTPS, uncomment `secure: true` in `routes/auth.js`'s `COOKIE_OPTS` so
login cookies are only ever sent over an encrypted connection.

### Option 2 — standalone Docker

A `Dockerfile` and `.dockerignore` are included.

```bash
docker build -t pickem .
docker run -d --name pickem \
  -p 3000:3000 \
  -e JWT_SECRET=$(openssl rand -hex 48) \
  -v pickem_data:/app/data \
  pickem
```

The `-v pickem_data:/app/data` mount is what makes your data survive container restarts and
rebuilds. **Important:** the database lives in `/app/data` specifically, separate from `/app/db`
(where the application source code lives). Don't mount a volume at `/app/db` — doing so would mask
future code updates to the files that live there.

### Option 3 — alongside an existing docker-compose stack

`samples/docker-compose.example.yml` is set up for exactly this: dropping the service into a
compose file you already run, rather than standing up a separate stack.

1. **Place this project's folder next to your existing compose file:**
   ```
   your-docker-dir/
     docker-compose.yml       ← your existing stack
     pickem/                   ← this repo
   ```
2. **Add a JWT secret** to the `.env` next to your `docker-compose.yml` (compose reads `${VARS}`
   from it automatically):
   ```
   PICKEM_JWT_SECRET=<output of: openssl rand -hex 48>
   ```
3. **Copy the `pickem:` service block** from `docker-compose.example.yml` into your existing
   compose file's `services:` section. It builds from the local folder — no image to publish.
4. **Pick how it's reached** — the example file has three variants (delete the two you don't use):
   - **A — direct port mapping**, if you don't run a reverse proxy.
   - **B — Traefik**, using labels; drop the `ports:` mapping if you use this.
   - **C — nginx-proxy + acme-companion**, using `VIRTUAL_HOST`/`LETSENCRYPT_HOST` env vars.

   For B or C, attach the service to whatever external network your reverse proxy already uses.
5. **Add the named volume** (`pickem_data:/app/data`) to your top-level `volumes:` block.
6. **Bring it up:**
   ```bash
   docker compose up -d --build pickem
   docker compose logs -f pickem
   ```

## Updating a running instance

Recommended workflow once this is live and tracked in git:

1. **Back up the database before any update:**
   ```bash
   docker compose exec pickem sh -c "cp /app/data/pickem.db /app/data/pickem-backup-$(date +%F).db"
   docker cp pickem:/app/data/pickem-backup-YYYY-MM-DD.db ./backups/
   ```
2. **Pull/apply the update**, review the diff (`git diff`), then commit.
3. **Rebuild:**
   ```bash
   docker compose up -d --build pickem
   docker compose logs -f pickem
   ```
4. **Roll back if needed:**
   ```bash
   git log --oneline
   git checkout <commit-hash> -- .
   docker compose up -d --build pickem
   ```

Your data lives in the named volume, entirely separate from the code/image — rebuilding or rolling
back the app never touches it.

### Database migrations

`db/schema.sql` uses `CREATE TABLE IF NOT EXISTS`, so **new tables** are always safe to add and
apply automatically on restart — existing data is untouched.

**Changing an existing table's columns is different.** SQLite's `CREATE TABLE IF NOT EXISTS` does
nothing to a table that already exists, so editing a column definition in `schema.sql` silently has
no effect on a live database. `db/db.js` includes a small migration runner for exactly this case:

```js
const migrations = [
  { table: 'games', column: 'home_rank', ddl: 'ALTER TABLE games ADD COLUMN home_rank INTEGER' },
  // add new entries here as the schema evolves
];
```

Each entry only runs its `ALTER TABLE` if the column doesn't already exist, so it's safe to leave
in place across every future startup. If you extend the schema, add a migration entry here rather
than only editing `schema.sql`.

## Admin: weekly workflow

1. Go to the **Admin** tab.
2. Pick a league (NFL/NCAAF) and week, then **Fetch games from ESPN**.
3. Check the box next to the games you want in the challenge that week (AP rank and spread, when
   available, are shown to help you pick close/notable matchups).
4. **Save selected games** — they show up immediately on everyone's Picks tab.
5. Optionally, add a **prop question** for the week from the same page.
6. Scores sync and picks grade automatically. Use **Sync now** for an on-demand refresh, and grade
   prop questions manually once the answer is known.

You can revisit a week anytime to add more games — already-saved games aren't duplicated.

## Notes & limitations

- **Season/week numbering** follows ESPN's own numbering for each league's regular season. Only
  `seasontype=2` (regular season) is wired up — postseason/bowl games aren't currently supported.
- **Ties**: if ESPN marks a completed game as a tie, every pick on it is scored as incorrect (a
  "push") rather than crediting anyone.
- **Prop questions** are graded manually by an admin — there's no automated data source for
  arbitrary yes/no questions.
- **Spreads/AP rankings** are shown for context only; grading is always straight-up by winner.
- **PINs** are hashed with bcrypt before storage, never stored in plain text. That said, this is a
  friend-group app, not a bank — keep PINs simple, but don't reuse a sensitive password as one.
- **Data** lives in a single SQLite file at `data/pickem.db` (or wherever `DB_PATH` points). Back
  it up by copying that file. To reset everything, stop the server and delete it.

## Project layout

```
server.js              Entry point — wires up routes + the 15-minute cron sync
db/schema.sql           Table definitions (new tables only — see Migrations above)
db/db.js                SQLite connection + migration runner
routes/                 auth, games, picks, props, leaderboard, admin API endpoints
middleware/auth.js      JWT session handling
services/espn.js        ESPN scoreboard fetch + normalization (scores, ranks, odds)
services/grading.js     Score sync + pick grading logic
public/                 Frontend — plain HTML/CSS/JS, no build step
Dockerfile, .dockerignore
                        Container build definition
samples/                Example configs to copy from: .env.example, docker-compose.example.yml
```

## Contributing

This started as a small project for a private friend-group challenge, so there's no formal
contribution process. Issues and pull requests are welcome if you find bugs or want to extend it
(postseason support and against-the-spread scoring are natural next steps).

## License

MIT — see [LICENSE](LICENSE).
