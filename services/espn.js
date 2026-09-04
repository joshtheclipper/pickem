// Pulls schedule/score data from ESPN's public (unauthenticated) scoreboard API.
// This is the same JSON feed the espn.com site uses and requires no API key.

const LEAGUE_PATHS = {
  NFL: 'football/nfl',
  NCAAF: 'football/college-football',
};

/**
 * Fetch the scoreboard for a given league/week/year.
 * league: 'NFL' | 'NCAAF'
 * week: integer (regular season week number)
 * year: integer (season year, e.g. 2026)
 * seasontype: 1=preseason, 2=regular season, 3=postseason
 */
async function fetchScoreboard(league, week, year, seasontype = 2) {
  const path = LEAGUE_PATHS[league];
  if (!path) throw new Error(`Unknown league: ${league}`);

  const params = new URLSearchParams({
    week: String(week),
    seasontype: String(seasontype),
    year: String(year),
  });
  // groups=80 restricts college football to FBS (top division) so we don't
  // pull in hundreds of small-school games.
  if (league === 'NCAAF') params.set('groups', '80');

  const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN API error (${res.status}) for ${league} week ${week}`);
  }
  const data = await res.json();
  return (data.events || []).map((ev) => normalizeEvent(ev, league, year, week));
}

function normalizeEvent(ev, league, seasonYear, week) {
  const comp = ev.competitions && ev.competitions[0];
  const competitors = (comp && comp.competitors) || [];
  const home = competitors.find((c) => c.homeAway === 'home') || {};
  const away = competitors.find((c) => c.homeAway === 'away') || {};

  const statusType = comp && comp.status && comp.status.type;
  let status = 'scheduled';
  if (statusType) {
    if (statusType.completed) status = 'final';
    else if (statusType.state === 'in') status = 'in_progress';
  }

  // e.g. "8:23 - 3rd Quarter"; only used client-side while status is
  // in_progress, but harmless to store otherwise.
  const status_detail = statusType ? statusType.shortDetail : null;

  let winner = null;
  if (status === 'final') {
    const homeScore = Number(home.score);
    const awayScore = Number(away.score);
    if (homeScore > awayScore) winner = 'home';
    else if (awayScore > homeScore) winner = 'away';
    else winner = 'tie';
  }

  // AP Top 25 rank, when ESPN includes it. curatedRank.current is 1-25 for
  // ranked teams; anything else (commonly 99) means unranked.
  const homeRankRaw = home.curatedRank && home.curatedRank.current;
  const awayRankRaw = away.curatedRank && away.curatedRank.current;
  const home_rank = homeRankRaw && homeRankRaw <= 25 ? homeRankRaw : null;
  const away_rank = awayRankRaw && awayRankRaw <= 25 ? awayRankRaw : null;

  // Betting line, display-only — not used for grading (picks are graded
  // straight-up by winner, never against the spread).
  const odds = comp && comp.odds && comp.odds[0];
  let odds_summary = null;
  if (odds) {
    const parts = [];
    if (odds.details) parts.push(odds.details);
    if (odds.overUnder) parts.push(`O/U ${odds.overUnder}`);
    odds_summary = parts.length ? parts.join(' · ') : null;
  }

  return {
    espn_event_id: ev.id,
    league,
    season_year: seasonYear,
    week,
    start_time: ev.date,
    home_team: (home.team && home.team.displayName) || 'TBD',
    home_team_abbr: (home.team && home.team.abbreviation) || '',
    home_team_logo: home.team && home.team.logo,
    away_team: (away.team && away.team.displayName) || 'TBD',
    away_team_abbr: (away.team && away.team.abbreviation) || '',
    away_team_logo: away.team && away.team.logo,
    home_score: home.score !== undefined ? Number(home.score) : null,
    away_score: away.score !== undefined ? Number(away.score) : null,
    status,
    status_detail,
    winner,
    home_rank,
    away_rank,
    odds_summary,
    short_name: ev.shortName,
    name: ev.name,
  };
}

module.exports = { fetchScoreboard, normalizeEvent };
