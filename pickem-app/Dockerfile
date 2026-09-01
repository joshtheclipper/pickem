FROM node:20-slim

# better-sqlite3 needs build tools to compile its native binding on install
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# SQLite data lives here - mount a named volume at this path so it
# survives image rebuilds and container restarts.
VOLUME /app/db

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
