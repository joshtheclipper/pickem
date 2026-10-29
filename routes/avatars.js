const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// The Account page crops and shrinks photos to a ~256px JPEG in the browser
// before uploading (a few dozen KB), so this cap only exists to stop a
// hand-crafted request from pushing a huge blob into memory or the DB.
const MAX_BYTES = 512 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Checks the file's magic bytes rather than trusting Content-Type.
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// GET /api/avatars/:userId  - the raw image. Callers add ?v=<avatar_v> to
// the URL, so the response can be cached for good; a new upload changes v.
router.get('/:userId', requireAuth, (req, res) => {
  const row = db.prepare('SELECT mime, data FROM user_avatars WHERE user_id = ?').get(req.params.userId);
  if (!row) return res.status(404).json({ error: 'No profile photo' });
  res.set('Content-Type', row.mime);
  res.set('Cache-Control', req.query.v ? 'private, max-age=31536000, immutable' : 'private, no-cache');
  res.send(row.data);
});

// PUT /api/avatars  (raw image body) - set or replace your own photo.
router.put(
  '/',
  requireAuth,
  express.raw({ type: TYPES, limit: MAX_BYTES }),
  (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ error: 'Send a JPEG, PNG or WebP image' });
    }
    const mime = sniff(buf);
    if (!mime) return res.status(400).json({ error: 'That file isn’t a supported image' });
    const now = Date.now();
    db.prepare(
      `INSERT INTO user_avatars (user_id, mime, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`
    ).run(req.user.id, mime, buf, now);
    res.json({ ok: true, avatar_v: now });
  }
);

// DELETE /api/avatars - remove your own photo (back to initials).
router.delete('/', requireAuth, (req, res) => {
  db.prepare('DELETE FROM user_avatars WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true, avatar_v: null });
});

// Oversized uploads come out of express.raw as a 413; answer in JSON so the
// client's api helper can show the message.
router.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That photo is too large' });
  }
  next(err);
});

module.exports = router;
