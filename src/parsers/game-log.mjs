import { CORE_STAT_FIELDS, GAME_RESULTS } from '../contracts/parsed-documents.mjs';
import { blank, present, unavailable } from '../contracts/value-state.mjs';
import {
  assertTableLayout,
  integerText,
  loadSportsReferenceHtml,
  numericSourceValue,
  requiredCell,
  sportsReferenceParse,
  sportsReferenceTable,
  tableDataRows,
} from './sports-reference-html.mjs';

const TABLE_ID = 'team_game_log';
// Core stats other than minutes and points, which the game log prints per side
// (`fg` for the team, `opp_fg` for the opponent). Points come from the score cells.
const COUNT_STATS = Object.freeze(CORE_STAT_FIELDS.filter((field) => field !== 'minutes' && field !== 'pts'));
// Printed fractions and derivable counts, kept in the stat line's `extra`.
const EXTRA_STATS = Object.freeze(['fg_pct', 'fg3_pct', 'fg2', 'fg2a', 'fg2_pct', 'efg_pct', 'ft_pct']);
const INTEGER_EXTRAS = new Set(['fg2', 'fg2a']);
const SIDE_STATS = Object.freeze([...COUNT_STATS, ...EXTRA_STATS]);
const REQUIRED_STATS = Object.freeze([
  'team_game_num_season', 'date', 'game_location', 'opp_name_abbr', 'game_type', 'team_game_result',
  'team_game_score', 'opp_team_game_score', 'overtimes',
  ...SIDE_STATS, ...SIDE_STATS.map((stat) => `opp_${stat}`),
]);
const LOCATIONS = Object.freeze({ '': 'home', '@': 'away', N: 'neutral' });
// The game log has no minutes column; team minutes come from the box score.
const MINUTES = unavailable('not_published');

function endingYearOf(snapshot) {
  const match = /^\/cbb\/schools\/[^/]+\/men\/(\d{4})-gamelogs\.html$/.exec(snapshot?.sourceUrl?.path ?? '');
  if (!match) throw new Error(`game log source path is unexpected: ${snapshot?.sourceUrl?.path ?? 'missing'}`);
  return Number(match[1]);
}

function text($, row, stat) { return requiredCell($, row, stat, TABLE_ID).text().trim(); }

function linkOf($, row, stat) { return requiredCell($, row, stat, TABLE_ID).find('a').attr('href') ?? null; }

// Opponent links point at the opponent's season page; its school page (identity)
// drops `<year>.html`. Unlinked (non-D-I) opponents have no identity.
function opponentOf($, row, snapshot, label) {
  const name = text($, row, 'opp_name_abbr') || null;
  const href = linkOf($, row, 'opp_name_abbr');
  if (!href) return { name, schoolPath: null };
  const { path } = snapshot.sourceUrlFrom(href);
  const match = /^(\/cbb\/schools\/[^/]+\/men\/)\d{4}\.html$/.exec(path);
  if (!match) throw new Error(`${label} opponent links to an unexpected page: ${path}`);
  return { name, schoolPath: match[1] };
}

function boxScoreUrlOf($, row, snapshot, label) {
  const href = linkOf($, row, 'date');
  if (!href) return null;
  const source = snapshot.sourceUrlFrom(href);
  if (!/^\/cbb\/boxscores\/[^/]+\.html$/.test(source.path)) throw new Error(`${label} date links to an unexpected page: ${source.path}`);
  return source.absoluteUrl;
}

function dateOf(value, label) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(`${label} date is not YYYY-MM-DD: ${value}`);
  return value;
}

function locationOf(value, label) {
  if (!(value in LOCATIONS)) throw new Error(`${label} location marker is unexpected: ${value}`);
  return LOCATIONS[value];
}

// '' -> 0, 'OT' -> 1, '2OT' -> 2 on a played game; unknown when it was not played.
function overtimesOf(value, final, label) {
  if (!final) {
    if (value) throw new Error(`${label} has an overtime marker but no result`);
    return null;
  }
  if (!value) return 0;
  const match = /^(\d*)OT$/.exec(value);
  const count = match && (match[1] ? Number(match[1]) : 1);
  if (!count) throw new Error(`${label} overtime marker is unexpected: ${value}`);
  return count;
}

function statLine($, row, prefix, points, label) {
  const value = (stat, integer) => numericSourceValue(text($, row, `${prefix}${stat}`), `${label} ${prefix}${stat}`, { integer });
  const line = { minutes: MINUTES };
  for (const field of COUNT_STATS) {
    line[field] = value(field, true);
    if (line[field].state === 'present' && line[field].value < 0) throw new Error(`${label} ${prefix}${field} is negative`);
  }
  line.pts = points;
  line.extra = Object.fromEntries(EXTRA_STATS.map((stat) => [stat, value(stat, INTEGER_EXTRAS.has(stat))]));
  return line;
}

function scoreOf(value, label) { return value ? present(integerText(value, label)) : blank(); }

function gameRow($, row, snapshot, index) {
  const label = `row ${index + 1}`;
  const result = text($, row, 'team_game_result');
  if (result && !GAME_RESULTS.includes(result)) throw new Error(`${label} result is unexpected: ${result}`);
  const final = Boolean(result);
  const teamScore = scoreOf(text($, row, 'team_game_score'), `${label} team score`);
  const opponentScore = scoreOf(text($, row, 'opp_team_game_score'), `${label} opponent score`);
  // A result needs both scores; scores without a result have no known status.
  if ([teamScore, opponentScore].some((score) => (score.state === 'present') !== final)) {
    throw new Error(`${label} result and scores disagree about whether the game was played`);
  }
  const gameNumber = text($, row, 'team_game_num_season');
  return {
    gameNumber: gameNumber ? integerText(gameNumber, `${label} game number`, { min: 1 }) : null,
    date: dateOf(text($, row, 'date'), label),
    location: locationOf(text($, row, 'game_location'), label),
    opponent: opponentOf($, row, snapshot, label),
    gameType: text($, row, 'game_type') || null,
    result: final ? result : null,
    status: final ? 'final' : 'incomplete',
    overtimes: overtimesOf(text($, row, 'overtimes'), final, label),
    teamScore,
    opponentScore,
    teamStats: statLine($, row, '', teamScore, label),
    opponentStats: statLine($, row, 'opp_', opponentScore, label),
    boxScoreUrl: boxScoreUrlOf($, row, snapshot, label),
  };
}

export class GameLogParser {
  pageType() { return 'game_log'; }
  version() { return '1'; }
  parse(snapshot) {
    return sportsReferenceParse(this.pageType(), () => {
      const endingYear = endingYearOf(snapshot);
      const $ = loadSportsReferenceHtml(snapshot);
      const table = sportsReferenceTable($, TABLE_ID);
      assertTableLayout($, table, TABLE_ID, REQUIRED_STATS);
      const rows = tableDataRows($, table);
      if (!rows.length) throw new Error(`table #${TABLE_ID} has no game rows`);
      return { endingYear, games: rows.map((row, index) => gameRow($, row, snapshot, index)) };
    });
  }
}
