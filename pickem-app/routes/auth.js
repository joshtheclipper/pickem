const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
  // secure: true, // enable this once you're running behind HTTPS
};

// Register a new player. The very first user created becomes admin automatically.
router.post('/register', (req, res) => {
  const { username, pin } = req.body || {};
  if (!username || !pin) {
    return res.status(400).json({ error: 'Username and PIN are required' });
  }
  if (String(pin).length < 4) {
    return res.status(400).json({ error: 'PIN must be at least 4 characters' });
  }
  const cleanUsername = String(username).trim();
  if (cleanUsername.length < 2 || cleanUsername.length > 30) {
    return res.status(400).json({ error: 'Username must be 2-30 characters' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername);
  if (existing) {
    return res.status(409).json({ error: 'That username is taken' });
  }

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const isFirstUser = userCount === 0;

  const pinHash = bcrypt.hashSync(String(pin), 10);
  const info = db
    .prepare('INSERT INTO users (username, pin_hash, is_admin) VALUES (?, ?, ?)')
    .run(cleanUsername, pinHash, isFirstUser ? 1 : 0);

  const user = { id: info.lastInsertRowid, username: cleanUsername, is_admin: isFirstUser ? 1 : 0 };
  const token = signToken(user);
  res.cookie('token', token, COOKIE_OPTS);
  res.json({ user });
});

router.post('/login', (req, res) => {
  const { username, pin } = req.body || {};
  if (!username || !pin) {
    return res.status(400).json({ error: 'Username and PIN are required' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  if (!user || !bcrypt.compareSync(String(pin), user.pin_hash)) {
    return res.status(401).json({ error: 'Incorrect username or PIN' });
  }
  const token = signToken(user);
  res.cookie('token', token, COOKIE_OPTS);
  res.json({ user: { id: user.id, username: user.username, is_admin: !!user.is_admin } });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
