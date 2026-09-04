FROM node:20-slim

# better-sqlite3 needs build tools to compile its native binding on install
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# The SQLite data file lives in its own directory, separate from the source
# code in db/ (see db/db.js) - this is the directory to mount a volume at,
# NOT /app/db, or you'll mask future code updates with stale volume content.
RUN mkdir -p /app/data
VOLUME /app/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
