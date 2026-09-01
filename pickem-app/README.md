# Pick'em Challenge

A self-hosted weekly pick'em app for NFL and NCAAF, built for a group of friends. Pick winners on a
set of admin-chosen games each week, get auto-graded from live scores, and track everyone on a
leaderboard.

## How it works

- **Admin picks the slate.** Each week, an admin pulls the schedule from ESPN and selects the
  10–15 marquee/close matchups for NFL and for NCAAF that the group will pick on.
- **Everyone makes picks.** Players log in with a username + PIN and pick a winner for each game.
  Picks lock automatically once a game kicks off.
- **Auto-grading.** The server checks ESPN every 15 minutes for final scores and awards 1 point per
  correct pick — no one has to enter results by hand. There's also a "Sync now" button in the admin
  panel for on-demand syncing.
- **Leaderboard.** Totals overall, or filtered to just NFL or just NCAAF.

Game data (schedules, team names/logos, live scores) comes from ESPN's public scoreboard API. It's
the same free JSON feed espn.com's website uses and needs no API key or account.

## Requirements

- Node.js 18 or newer (uses the built-in `fetch`)
- A server/VM with outbound internet access (to reach ESPN's API)

## Setup

```bash
npm install
cp .env.example .env
```

Open `.env` and set `JWT_SECRET` to a long random string — this is what signs login sessions.
Generate one quickly with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Then start the app:

```bash
npm start
```

Visit `http://localhost:3000` (or whatever `PORT` you set). The **first account you register
automatically becomes the admin** — register yourself first, then have your friends create their
own accounts.

## Running it long-term (self-hosting)

The app is a single Node process with a SQLite file for storage — nothing else to install (no
separate database server, no build step).

**Simple option — a process manager:**

```bash
npm install -g pm2
pm2 start server.js --name pickem
pm2 save
pm2 startup   # follow the printed instructions to run on boot
```

**Put it behind a reverse proxy** (recommended) so you get HTTPS and a normal domain/subdomain,
e.g. with Caddy:

```
pickem.yourdomain.com {
  reverse_proxy localhost:3000
}
```

or nginx with a standard `proxy_pass http://localhost:3000;` config plus Let's Encrypt via certbot.

Once you're serving over HTTPS, open `middleware/auth.js` — well, actually just uncomment `secure:
true` in `routes/auth.js`'s `COOKIE_OPTS` so login cookies are only sent over HTTPS.

**Docker.** See "Running alongside your existing Docker services" below — a `Dockerfile`,
`.dockerignore`, and an example `docker-compose.example.yml` are included in this project.

## Running alongside your existing Docker services

The project includes a `Dockerfile`, `.dockerignore`, and `docker-compose.example.yml` so you can
drop it into a compose stack you already run, rather than standing up a separate one.

**1. Place the project folder next to your existing compose file.**

```
docker/
  docker-compose.yml       ← your existing stack
  pickem-app/               ← this project, unzipped here
```

**2. Add a JWT secret to your top-level `.env`** (the one next to your `docker-compose.yml` —
compose reads `${VARS}` from it automatically). Generate a random value once:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# or, without Node installed on the host:
openssl rand -hex 48
```

Add it as a line in that `.env` file:

```
PICKEM_JWT_SECRET=<paste the generated value here>
```

**3. Merge the service into your compose file.** Open `docker-compose.example.yml` in this project
and copy the `pickem:` block into the `services:` section of your existing `docker-compose.yml`.
It builds from the `./pickem-app` folder, so as long as that path is correct relative to your
compose file, `build: ./pickem-app` just works — no separate image to publish anywhere.

**4. Pick how it's reached** — the example file has three variants, pick one and delete the other
two:

- **Variant A — direct port mapping.** Simplest option if you don't run a reverse proxy: exposes
  `3000:3000` and you hit it at `http://your-server-ip:3000`.
- **Variant B — Traefik.** If your other services already use Traefik with labels, use this
  variant and drop the `ports:` mapping — Traefik reaches the container over the internal Docker
  network instead. Swap `pickem.yourdomain.com` for your actual domain.
- **Variant C — nginx-proxy + acme-companion.** Same idea via `VIRTUAL_HOST`/`LETSENCRYPT_HOST`
  environment variables instead of labels.

For B or C, `pickem` needs to be attached to the same external Docker network your proxy
container listens on (commonly named something like `proxy` or `web`) — check what your proxy's
`networks:` section is already called and match it. If your existing compose file doesn't already
declare that network as `external: true`, uncomment the `networks:` block at the bottom of the
example file.

**5. Add the named volume.** Copy the `pickem_data:` line into your existing top-level `volumes:`
block, so the SQLite database persists across rebuilds — it's mounted at `/app/db` inside the
container, matching where `db/pickem.db` lives in the app.

**6. Bring it up:**

```bash
docker compose up -d --build pickem
docker compose logs -f pickem
```

You should see `Created new database at /app/db/pickem.db` and `Pick'em app running at
http://localhost:3000` in the logs. Register your first account (it becomes the admin) at
whichever URL you configured in step 4.

**Updating later:** since it builds from the local folder rather than a published image, pulling
future changes is just replacing the `pickem-app` folder's contents and re-running
`docker compose up -d --build pickem`. Your data isn't affected — it lives in the `pickem_data`
volume, separate from the image.

## Making changes safely once it's live

The safest workflow is: **put the project under git, back up the database before any change,
apply changes on top of your running folder, rebuild, and keep the old image around until you've
confirmed the new one works.**

**1. Put it under version control (one-time setup).** From inside the `pickem-app` folder on your
server:

```bash
git init
git add .
git commit -m "Working baseline"
```

Now every future change is a diff you can review or revert — `git diff` shows exactly what
changed before you rebuild, and `git checkout -- .` throws away changes you don't want.

**2. Back up the database before any update** (schema changes especially):

```bash
docker compose exec pickem sh -c "cp /app/db/pickem.db /app/db/pickem-backup-$(date +%F).db"
```

That backup lives inside the volume, so also copy it out to the host occasionally:

```bash
docker cp pickem:/app/db/pickem-backup-YYYY-MM-DD.db ./backups/
```

**3. Apply the update.** Copy new/changed files into the `pickem-app` folder (overwriting what's
there), or `git apply` a diff, or pull from wherever you're tracking it.

**4. Know whether the change is "safe" before rebuilding:**
- **New files, new routes, new tables in `schema.sql` (using `CREATE TABLE IF NOT EXISTS`)** —
  safe. Existing tables and data are untouched; the app just gains new capability on next start.
- **Changing an *existing* table's columns** — not automatically safe. SQLite's
  `CREATE TABLE IF NOT EXISTS` won't alter a table that already exists, so a schema edit like
  "add a column to `games`" silently does nothing on restart. That needs an explicit one-time
  migration (an `ALTER TABLE ... ADD COLUMN ...` you run yourself against the live DB) — ask me
  when you're ready to make that kind of change and I'll write the migration for you rather than
  just editing `schema.sql`.
- **Editing routes, frontend files (`public/`), `server.js`** — safe; these don't touch stored
  data at all.

**5. Rebuild and restart just this service** (your other containers keep running untouched):

```bash
docker compose up -d --build pickem
docker compose logs -f pickem
```

Watch the logs for the startup lines (`Pick'em app running at ...`) and check the app in the
browser before moving on.

**6. If something's wrong, roll back fast:**

```bash
git log --oneline          # find the last known-good commit
git checkout <commit-hash> -- .
docker compose up -d --build pickem
```

Your data is untouched by any of this — it lives in the `pickem_data` volume, completely separate
from the code/image, so rebuilding or rolling back the app never risks the picks or leaderboard
history. The only thing that risks data is manually altering the schema, which is why step 4 flags
that case specifically.

**Optional but worth it:** keep a second copy of the folder (e.g. `pickem-app-dev`) running on a
different port with its own throwaway database, so you can try a change there first before
touching the version your friends are actually using.

## Weekly workflow for the admin

1. Go to **Admin** in the nav.
2. Pick the league (NFL/NCAAF) and week number, then **Fetch games from ESPN**.
3. Check the box next to the 10–15 games you want in the challenge that week.
4. **Save selected games.** They'll immediately show up for everyone on the Picks tab.
5. That's it — scores sync and picks get graded automatically. Use **Sync now** if you want to
   force a refresh (e.g. right after a game you're watching ends).

You can revisit a week anytime to add more games (fetch again, check more boxes, save) — already
saved games aren't duplicated.

## Notes & things worth knowing

- **Season year / week numbers** follow ESPN's own numbering — NFL and NCAAF each start at Week 1
  for their regular season. Postseason/bowl games aren't wired up (only `seasontype=2`, regular
  season) — let me know if you want that added.
- **Ties**: if ESPN marks a completed game as a tie, every pick on it is scored as incorrect
  (a "push") rather than crediting anyone.
- **PINs** are hashed (bcrypt) before storage — not stored in plain text. That said, this is a
  friend-group app, not a bank; keep the PINs simple but don't reuse a sensitive password.
- **Data lives in `db/pickem.db`** (SQLite). Back it up by just copying that file.
- If you want to reset everything, stop the server and delete `db/pickem.db*`.

## Project layout

```
server.js              Entry point, wires up routes + the 15-min cron sync
db/schema.sql           Table definitions
db/db.js                SQLite connection
routes/                 auth, games, picks, leaderboard, admin API endpoints
middleware/auth.js      JWT session handling
services/espn.js        ESPN scoreboard fetch + normalization
services/grading.js     Score sync + pick grading logic
public/                 Frontend (plain HTML/CSS/JS, no build step)
```
