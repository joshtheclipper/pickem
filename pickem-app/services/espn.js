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

  let winner = null;
  if (status === 'final') {
    const homeScore = Number(home.score);
    const awayScore = Number(away.score);
    if (homeScore > awayScore) winner = 'home';
    else if (awayScore > homeScore) winner = 'away';
    else winner = 'tie';
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
    winner,
    short_name: ev.shortName,
    name: ev.name,
  };
}

module.exports = { fetchScoreboard };
