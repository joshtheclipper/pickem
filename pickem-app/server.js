require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const cron = require('node-cron');

const authRoutes = require('./routes/auth');
const gamesRoutes = require('./routes/games');
const picksRoutes = require('./routes/picks');
const propsRoutes = require('./routes/props');
const leaderboardRoutes = require('./routes/leaderboard');
const adminRoutes = require('./routes/admin');
const { syncAndGrade } = require('./services/grading');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/games', gamesRoutes);
app.use('/api/picks', picksRoutes);
app.use('/api/props', propsRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/admin', adminRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Pick'em app running at http://localhost:${PORT}`);
});

// Auto-sync scores every 15 minutes so games get graded without anyone
// needing to click "Sync Now". Disable by setting DISABLE_CRON=true.
if (process.env.DISABLE_CRON !== 'true') {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const result = await syncAndGrade();
      if (result.gradedPicks > 0 || result.updatedGames > 0) {
        console.log(
          `[cron] Synced: ${result.updatedGames} games updated, ${result.gradedPicks} picks graded`
        );
      }
    } catch (err) {
      console.error('[cron] Sync failed:', err.message);
    }
  });
  console.log('Auto-sync cron scheduled (every 15 min)');
}
