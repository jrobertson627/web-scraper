import { CORE_STAT_FIELDS } from '../contracts/parsed-documents.mjs';
import { present, unavailable } from '../contracts/value-state.mjs';

// Builders for synthetic parsed documents that satisfy the frozen contracts in
// src/contracts/parsed-documents.mjs. Fixture-only; real parsers build these
// from source HTML.

export function statLine(values = {}, extra) {
  const line = Object.fromEntries(CORE_STAT_FIELDS.map((field) => {
    const value = values[field];
    return [field, value && typeof value === 'object' ? value : present(value ?? 0)];
  }));
  return extra ? { ...line, extra } : line;
}

export function sumStatLines(lines) {
  return statLine(Object.fromEntries(CORE_STAT_FIELDS.map((field) => [field,
    lines.reduce((total, line) => total + (line[field].state === 'present' ? line[field].value : 0), 0)])));
}

export function schoolRow({ name, path, historyUrl = null, to = null, from = null, city = null, state = null }) {
  return { name, path, historyUrl, city, state, from, to };
}

export function schoolIndexDocument(schools) { return { schools: schools.map(schoolRow) }; }

export function schoolHistoryDocument(seasons) { return { seasons: seasons.map(({ endingYear, url }) => ({ endingYear, url })) }; }

function score(value) { return typeof value === 'number' ? present(value) : unavailable('not_played'); }

// games: [{ location, opponent: { name, schoolPath }, status, teamScore, opponentScore,
//   teamStats, opponentStats, boxScoreUrl, date, overtimes, gameType }]
export function gameLogDocument(endingYear, games) {
  let played = 0;
  return {
    endingYear,
    games: games.map((game) => {
      const final = game.status === 'final';
      if (final) played += 1;
      return {
        gameNumber: final ? played : null,
        date: game.date ?? null,
        location: game.location ?? null,
        opponent: { name: game.opponent?.name ?? null, schoolPath: game.opponent?.schoolPath ?? null },
        gameType: game.gameType ?? null,
        result: final ? (game.teamScore > game.opponentScore ? 'W' : 'L') : null,
        status: game.status,
        overtimes: final ? (game.overtimes ?? 0) : null,
        teamScore: score(final ? game.teamScore : undefined),
        opponentScore: score(final ? game.opponentScore : undefined),
        teamStats: final ? game.teamStats : null,
        opponentStats: final ? game.opponentStats : null,
        boxScoreUrl: game.boxScoreUrl ?? null,
      };
    }),
  };
}

// sides: { away: { name, schoolPath, score, stats, players }, home: { ... } }
export function boxScoreDocument({ date = null, status, overtimes = null, away, home, venue = null }) {
  const team = (side, value) => ({
    side,
    name: value.name,
    schoolPath: value.schoolPath ?? null,
    finalScore: score(status === 'final' ? value.score : undefined),
    lineScore: [],
    stats: status === 'final' ? value.stats : null,
    advanced: {},
    players: (value.players ?? []).map((player) => ({
      name: player.name, playerPath: player.playerPath ?? null, starter: player.starter ?? null,
      stats: player.stats, advanced: player.advanced ?? {},
    })),
  });
  return {
    date, status, gameType: null, description: null, venue,
    attendance: unavailable('not_published'),
    overtimes: status === 'final' ? (overtimes ?? 0) : null,
    teams: [team('away', away), team('home', home)],
  };
}

// games: game-log rows (as passed to gameLogDocument) for this school and season.
// players: [{ name, playerPath, lines: [statLine per final game] }]
export function seasonDocument({ school, endingYear, gameLogUrl, games = [], players = [] }) {
  const finals = games.filter((game) => game.status === 'final');
  const wins = finals.filter((game) => game.teamScore > game.opponentScore).length;
  return {
    school,
    endingYear,
    gameLogUrl,
    summary: {
      wins: present(wins), losses: present(finals.length - wins),
      confWins: unavailable('not_in_fixture'), confLosses: unavailable('not_in_fixture'),
      srs: unavailable('not_in_fixture'), sos: unavailable('not_in_fixture'),
      offRtg: unavailable('not_in_fixture'), defRtg: unavailable('not_in_fixture'),
      conference: null, coach: null, ncaaTournament: null,
    },
    roster: players.map((player) => ({
      name: player.name, playerPath: player.playerPath ?? null, number: null, class: null, position: null,
      heightIn: unavailable('not_in_fixture'), weight: unavailable('not_in_fixture'),
    })),
    teamTotals: {
      team: { games: present(finals.length), stats: sumStatLines(finals.map((game) => game.teamStats)) },
      opponent: { games: present(finals.length), stats: sumStatLines(finals.map((game) => game.opponentStats)) },
    },
    players: players.map((player) => ({
      name: player.name, playerPath: player.playerPath ?? null,
      games: present(player.lines.length), gamesStarted: present(player.lines.length),
      stats: sumStatLines(player.lines), advanced: {},
    })),
  };
}
