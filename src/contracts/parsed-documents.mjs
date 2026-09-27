import { assertPageType } from './source.mjs';
import { GAME_CONTEXTS, GAME_STATUSES, assertSourceValue } from './value-state.mjs';

// Frozen parsed-document shapes, one per page type (#76). Parsers produce these;
// discovery, normalization and persistence consume them. See PARSED_DOCUMENTS.md.

export const CORE_STAT_FIELDS = Object.freeze([
  'minutes', 'fg', 'fga', 'fg3', 'fg3a', 'ft', 'fta', 'orb', 'drb', 'trb', 'ast', 'stl', 'blk', 'tov', 'pf', 'pts',
]);
export const GAME_RESULTS = Object.freeze(['W', 'L']);
export const BOX_SCORE_SIDES = Object.freeze(['away', 'home']);

class DocumentShapeError extends Error {
  constructor(path, expected) {
    super(`${path}: expected ${expected}`);
    this.name = 'DocumentShapeError';
  }
}

function fail(path, expected) { throw new DocumentShapeError(path, expected); }

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function object(value, path, required, optional = []) {
  if (!isObject(value)) fail(path, 'an object');
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, `no such field; allowed fields are ${[...allowed].join(', ')}`);
  for (const key of required) if (!(key in value)) fail(`${path}.${key}`, 'a required field');
  return value;
}

function array(value, path, item) {
  if (!Array.isArray(value)) fail(path, 'an array');
  value.forEach((entry, index) => item(entry, `${path}[${index}]`));
}

function string(value, path) { if (typeof value !== 'string' || !value.trim()) fail(path, 'a non-empty string'); }
function nullableString(value, path) { if (value !== null) string(value, path); }
function nullableBoolean(value, path) { if (value !== null && typeof value !== 'boolean') fail(path, 'true, false, or null'); }

function integer(value, path, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) fail(path, `an integer >= ${min}`);
}
function nullableInteger(value, path, options) { if (value !== null) integer(value, path, options); }

function nullableDate(value, path) {
  if (value === null) return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    fail(path, 'an ISO date (YYYY-MM-DD) or null');
  }
}

function oneOf(value, path, choices, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!choices.includes(value)) fail(path, `one of ${choices.join(', ')}${nullable ? ', or null' : ''}`);
}

// A statistic is a source value: blank, unavailable, explicit null, or present(value).
function sourceValue(value, path, check = (present) => {
  if (typeof present !== 'number' || !Number.isFinite(present)) fail(`${path}.value`, 'a finite number');
}) {
  try { assertSourceValue(value); } catch { fail(path, 'a source value: blank, unavailable, null, or present(value)'); }
  if (value.state === 'present') check(value.value);
}

function countValue(value, path) {
  sourceValue(value, path, (present) => integer(present, `${path}.value`));
}

function numberValue(value, path) { sourceValue(value, path); }

function extraValues(value, path) {
  if (!isObject(value)) fail(path, 'an object of source values');
  for (const [key, entry] of Object.entries(value)) {
    sourceValue(entry, `${path}.${key}`, (present) => {
      if (!(typeof present === 'number' && Number.isFinite(present)) && typeof present !== 'string') {
        fail(`${path}.${key}.value`, 'a finite number or a string');
      }
    });
  }
}

function extraObject(value, path) { if (!isObject(value)) fail(path, 'an object'); }

// The sixteen core counting stats. Minutes are decimal minutes (32:30 -> 32.5);
// everything else is a whole-number count. Printed percentages and other
// derivable or source-specific figures go in `extra`, as fractions (33% -> 0.33).
function statLine(value, path) {
  object(value, path, CORE_STAT_FIELDS, ['extra']);
  sourceValue(value.minutes, `${path}.minutes`, (present) => {
    if (typeof present !== 'number' || !Number.isFinite(present) || present < 0) fail(`${path}.minutes.value`, 'decimal minutes >= 0');
  });
  for (const field of CORE_STAT_FIELDS.slice(1)) countValue(value[field], `${path}.${field}`);
  if ('extra' in value) extraValues(value.extra, `${path}.extra`);
}

function nullableStatLine(value, path) { if (value !== null) statLine(value, path); }

// A link to another school carries the school's page path (its identity), never
// only a display name. schoolPath is null when the source does not link the team.
function teamRef(value, path) {
  object(value, path, ['name', 'schoolPath']);
  nullableString(value.name, `${path}.name`);
  nullableString(value.schoolPath, `${path}.schoolPath`);
}

function namedLink(value, path) {
  if (value === null) return;
  object(value, path, ['name', 'path']);
  string(value.name, `${path}.name`);
  nullableString(value.path, `${path}.path`);
}

function schoolIndex(document, path) {
  object(document, path, ['schools'], ['extra']);
  array(document.schools, `${path}.schools`, (school, at) => {
    object(school, at, ['name', 'path', 'historyUrl', 'city', 'state', 'from', 'to'], ['aliases', 'aggregateFields']);
    string(school.name, `${at}.name`);
    nullableString(school.path, `${at}.path`);
    nullableString(school.historyUrl, `${at}.historyUrl`);
    nullableString(school.city, `${at}.city`);
    nullableString(school.state, `${at}.state`);
    nullableInteger(school.from, `${at}.from`, { min: 1800 });
    nullableInteger(school.to, `${at}.to`, { min: 1800 });
    if ('aliases' in school) array(school.aliases, `${at}.aliases`, string);
    if ('aggregateFields' in school) extraValues(school.aggregateFields, `${at}.aggregateFields`);
  });
  if ('extra' in document) extraObject(document.extra, `${path}.extra`);
}

function schoolHistory(document, path) {
  object(document, path, ['seasons'], ['extra']);
  array(document.seasons, `${path}.seasons`, (season, at) => {
    object(season, at, ['endingYear', 'url'], ['extra']);
    integer(season.endingYear, `${at}.endingYear`, { min: 1800 });
    nullableString(season.url, `${at}.url`);
    if ('extra' in season) extraValues(season.extra, `${at}.extra`);
  });
  if ('extra' in document) extraObject(document.extra, `${path}.extra`);
}

function tournament(value, path) {
  if (value === null) return;
  object(value, path, ['seed', 'region', 'games']);
  countValue(value.seed, `${path}.seed`);
  nullableString(value.region, `${path}.region`);
  array(value.games, `${path}.games`, (game, at) => {
    object(game, at, ['round', 'result', 'teamScore', 'opponentScore', 'opponent']);
    string(game.round, `${at}.round`);
    oneOf(game.result, `${at}.result`, GAME_RESULTS);
    integer(game.teamScore, `${at}.teamScore`);
    integer(game.opponentScore, `${at}.opponentScore`);
    object(game.opponent, `${at}.opponent`, ['name', 'seed']);
    string(game.opponent.name, `${at}.opponent.name`);
    nullableInteger(game.opponent.seed, `${at}.opponent.seed`, { min: 1 });
  });
}

function season(document, path) {
  object(document, path, ['school', 'endingYear', 'gameLogUrl', 'summary', 'roster', 'teamTotals', 'players'], ['extra']);
  string(document.school, `${path}.school`);
  integer(document.endingYear, `${path}.endingYear`, { min: 1800 });
  nullableString(document.gameLogUrl, `${path}.gameLogUrl`);

  const summary = object(document.summary, `${path}.summary`,
    ['wins', 'losses', 'confWins', 'confLosses', 'srs', 'sos', 'offRtg', 'defRtg', 'conference', 'coach', 'ncaaTournament'], ['extra']);
  for (const field of ['wins', 'losses', 'confWins', 'confLosses']) countValue(summary[field], `${path}.summary.${field}`);
  for (const field of ['srs', 'sos', 'offRtg', 'defRtg']) numberValue(summary[field], `${path}.summary.${field}`);
  namedLink(summary.conference, `${path}.summary.conference`);
  namedLink(summary.coach, `${path}.summary.coach`);
  tournament(summary.ncaaTournament, `${path}.summary.ncaaTournament`);
  if ('extra' in summary) extraValues(summary.extra, `${path}.summary.extra`);

  array(document.roster, `${path}.roster`, (player, at) => {
    object(player, at, ['name', 'playerPath', 'number', 'class', 'position', 'heightIn', 'weight'], ['extra']);
    string(player.name, `${at}.name`);
    nullableString(player.playerPath, `${at}.playerPath`);
    nullableString(player.number, `${at}.number`);
    nullableString(player.class, `${at}.class`);
    nullableString(player.position, `${at}.position`);
    countValue(player.heightIn, `${at}.heightIn`);
    countValue(player.weight, `${at}.weight`);
    if ('extra' in player) extraValues(player.extra, `${at}.extra`);
  });

  if (document.teamTotals !== null) {
    object(document.teamTotals, `${path}.teamTotals`, ['team', 'opponent'], ['extra']);
    for (const side of ['team', 'opponent']) {
      const at = `${path}.teamTotals.${side}`;
      object(document.teamTotals[side], at, ['games', 'stats']);
      countValue(document.teamTotals[side].games, `${at}.games`);
      statLine(document.teamTotals[side].stats, `${at}.stats`);
    }
    if ('extra' in document.teamTotals) extraValues(document.teamTotals.extra, `${path}.teamTotals.extra`);
  }

  array(document.players, `${path}.players`, (player, at) => {
    object(player, at, ['name', 'playerPath', 'games', 'gamesStarted', 'stats', 'advanced']);
    string(player.name, `${at}.name`);
    nullableString(player.playerPath, `${at}.playerPath`);
    countValue(player.games, `${at}.games`);
    countValue(player.gamesStarted, `${at}.gamesStarted`);
    statLine(player.stats, `${at}.stats`);
    extraValues(player.advanced, `${at}.advanced`);
  });
  if ('extra' in document) extraObject(document.extra, `${path}.extra`);
}

function gameLog(document, path) {
  object(document, path, ['endingYear', 'games'], ['extra']);
  integer(document.endingYear, `${path}.endingYear`, { min: 1800 });
  array(document.games, `${path}.games`, (game, at) => {
    object(game, at, ['gameNumber', 'date', 'location', 'opponent', 'gameType', 'result', 'status', 'overtimes',
      'teamScore', 'opponentScore', 'teamStats', 'opponentStats', 'boxScoreUrl'], ['extra']);
    nullableInteger(game.gameNumber, `${at}.gameNumber`, { min: 1 });
    nullableDate(game.date, `${at}.date`);
    oneOf(game.location, `${at}.location`, GAME_CONTEXTS, { nullable: true });
    teamRef(game.opponent, `${at}.opponent`);
    nullableString(game.gameType, `${at}.gameType`);
    oneOf(game.result, `${at}.result`, GAME_RESULTS, { nullable: true });
    oneOf(game.status, `${at}.status`, GAME_STATUSES);
    nullableInteger(game.overtimes, `${at}.overtimes`);
    countValue(game.teamScore, `${at}.teamScore`);
    countValue(game.opponentScore, `${at}.opponentScore`);
    nullableStatLine(game.teamStats, `${at}.teamStats`);
    nullableStatLine(game.opponentStats, `${at}.opponentStats`);
    nullableString(game.boxScoreUrl, `${at}.boxScoreUrl`);
    if ('extra' in game) extraValues(game.extra, `${at}.extra`);
  });
  if ('extra' in document) extraObject(document.extra, `${path}.extra`);
}

function boxScore(document, path) {
  object(document, path, ['date', 'status', 'gameType', 'description', 'venue', 'attendance', 'overtimes', 'teams'], ['context', 'extra']);
  nullableDate(document.date, `${path}.date`);
  oneOf(document.status, `${path}.status`, GAME_STATUSES);
  nullableString(document.gameType, `${path}.gameType`);
  nullableString(document.description, `${path}.description`);
  nullableString(document.venue, `${path}.venue`);
  countValue(document.attendance, `${path}.attendance`);
  nullableInteger(document.overtimes, `${path}.overtimes`);
  // Only when the source states it. Sports Reference box scores do not, so
  // neutral-site context comes from the game-log rows that link the box score.
  if ('context' in document) oneOf(document.context, `${path}.context`, GAME_CONTEXTS);
  array(document.teams, `${path}.teams`, (team, at) => {
    object(team, at, ['side', 'name', 'schoolPath', 'finalScore', 'lineScore', 'stats', 'advanced', 'players']);
    oneOf(team.side, `${at}.side`, BOX_SCORE_SIDES);
    string(team.name, `${at}.name`);
    nullableString(team.schoolPath, `${at}.schoolPath`);
    countValue(team.finalScore, `${at}.finalScore`);
    array(team.lineScore, `${at}.lineScore`, countValue);
    nullableStatLine(team.stats, `${at}.stats`);
    extraValues(team.advanced, `${at}.advanced`);
    array(team.players, `${at}.players`, (player, playerAt) => {
      object(player, playerAt, ['name', 'playerPath', 'starter', 'stats', 'advanced']);
      string(player.name, `${playerAt}.name`);
      nullableString(player.playerPath, `${playerAt}.playerPath`);
      nullableBoolean(player.starter, `${playerAt}.starter`);
      statLine(player.stats, `${playerAt}.stats`);
      extraValues(player.advanced, `${playerAt}.advanced`);
    });
  });
  const sides = document.teams.map((team) => team.side).sort();
  if (sides.join(',') !== 'away,home') fail(`${path}.teams`, 'exactly one away team and one home team');
  if ('extra' in document) extraObject(document.extra, `${path}.extra`);
}

const VALIDATORS = Object.freeze({
  school_index: schoolIndex,
  school_history: schoolHistory,
  season,
  game_log: gameLog,
  box_score: boxScore,
});

// Throws a DocumentShapeError naming the first field that breaks the contract.
export function assertParsedDocument(pageType, document) {
  VALIDATORS[assertPageType(pageType)](document, pageType);
  return document;
}

export function parsedDocumentError(pageType, document) {
  try {
    assertParsedDocument(pageType, document);
    return null;
  } catch (error) {
    if (error instanceof DocumentShapeError) return error.message;
    throw error;
  }
}

// Decimal minutes from a source clock value: '32:30' -> 32.5.
export function decimalMinutes(clock) {
  const match = /^(\d+):([0-5]\d)$/.exec(String(clock).trim());
  if (!match) throw new Error(`invalid minutes clock: ${clock}. Expected MM:SS. Example: 32:30`);
  return Number(match[1]) + Number(match[2]) / 60;
}
