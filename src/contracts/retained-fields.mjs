// The data contract's retained fields (#89). A data contract lists retained
// fields by name (`retainedFields` in config/*.data-contract.json), such as
// `box_scores.venue`. The specs below map every field of the frozen parsed
// documents (PARSED_DOCUMENTS.md), the normalized pages and the API models to
// one of those names. The normalizer and the query service keep only fields
// whose name the contract lists. A field with no mapping here is never kept,
// so a new field needs a mapping and a contract entry.
//
// A spec is a retained-field name (the whole value, with everything under it,
// belongs to that field), an object spec (each listed key has its own spec;
// unlisted keys are dropped), or list(spec) for an array of such values.
// Generic `extra` objects are unmapped unless a spec names them, so their
// contents are dropped; a stat line's `extra` belongs to its stat line.

const ITEMS = Symbol('items');
const list = (item) => Object.freeze({ [ITEMS]: item });
const OMIT = Symbol('omit');

const PROVENANCE = 'source_provenance.url_fetch_time_parser_version';

const SCHOOL_ROW = Object.freeze({
  name: 'schools.display_name', aliases: 'schools.display_name', path: 'schools.source_path', historyUrl: 'schools.source_path',
  city: 'schools.city', state: 'schools.state', from: 'schools.from_year', to: 'schools.to_year',
  aggregateFields: 'schools.aggregate_fields',
});

const SEASON = Object.freeze({
  school: 'schools.display_name',
  endingYear: 'school_seasons.ending_year',
  gameLogUrl: 'game_logs.source_link',
  summary: Object.freeze({
    wins: 'seasons.team_record', losses: 'seasons.team_record', confWins: 'seasons.team_record', confLosses: 'seasons.team_record',
    srs: 'seasons.srs', sos: 'seasons.sos', offRtg: 'seasons.ratings', defRtg: 'seasons.ratings',
    conference: 'seasons.conference', coach: 'seasons.coach', ncaaTournament: 'seasons.ncaa_tournament_seed_region_and_results',
    // Only the listed extra figures are kept.
    extra: Object.freeze({ conf_finish: 'seasons.conference', ap_final_rank: 'seasons.ap_final_rank' }),
  }),
  roster: list(Object.freeze({
    name: 'seasons.roster_names_and_source_links', playerPath: 'seasons.roster_names_and_source_links',
    number: 'seasons.roster_bio_fields', class: 'seasons.roster_bio_fields', position: 'seasons.roster_bio_fields',
    heightIn: 'seasons.roster_bio_fields', weight: 'seasons.roster_bio_fields', extra: 'seasons.roster_bio_fields',
  })),
  teamTotals: Object.freeze({
    team: 'seasons.team_aggregate_statistics', opponent: 'seasons.opponent_aggregate_statistics', extra: 'seasons.team_aggregate_statistics',
  }),
  players: list(Object.freeze({
    name: 'seasons.roster_names_and_source_links', playerPath: 'seasons.roster_names_and_source_links',
    games: 'seasons.player_totals_and_advanced_statistics', gamesStarted: 'seasons.player_totals_and_advanced_statistics',
    stats: 'seasons.player_totals_and_advanced_statistics', advanced: 'seasons.player_totals_and_advanced_statistics',
  })),
});

const GAME_LOG = Object.freeze({
  endingYear: 'school_seasons.ending_year',
  games: list(Object.freeze({
    gameNumber: 'game_logs.game_number', date: 'game_logs.date', location: 'game_logs.home_away_neutral',
    opponent: 'game_logs.opponent_name_and_source_link', gameType: 'game_logs.game_type',
    result: 'game_logs.result_and_status', status: 'game_logs.result_and_status', overtimes: 'game_logs.overtime',
    teamScore: 'game_logs.scores_and_team_totals', opponentScore: 'game_logs.scores_and_team_totals',
    teamStats: 'game_logs.scores_and_team_totals', opponentStats: 'game_logs.scores_and_team_totals',
    boxScoreUrl: 'game_logs.box_score_source_link',
  })),
});

const BOX_SCORE = Object.freeze({
  date: 'box_scores.date', status: 'box_scores.status', gameType: 'box_scores.game_type', description: 'box_scores.description',
  venue: 'box_scores.venue', attendance: 'box_scores.attendance', overtimes: 'box_scores.overtime', context: 'box_scores.home_away_neutral',
  teams: list(Object.freeze({
    side: 'box_scores.teams_and_final_scores', name: 'box_scores.teams_and_final_scores', schoolPath: 'box_scores.teams_and_final_scores',
    finalScore: 'box_scores.teams_and_final_scores', lineScore: 'box_scores.line_scores',
    stats: 'box_scores.team_basic_and_advanced_statistics', advanced: 'box_scores.team_basic_and_advanced_statistics',
    players: list(Object.freeze({
      name: 'box_scores.player_names_and_source_links', playerPath: 'box_scores.player_names_and_source_links',
      starter: 'box_scores.player_starter_status',
      stats: 'box_scores.player_basic_and_advanced_statistics', advanced: 'box_scores.player_basic_and_advanced_statistics',
    })),
  })),
});

// The normalized game adds fields derived from the box score.
const GAME = Object.freeze({
  ...BOX_SCORE,
  gameDate: 'box_scores.date', neutralSite: 'box_scores.home_away_neutral',
  home: 'box_scores.teams_and_final_scores', away: 'box_scores.teams_and_final_scores',
  homeScore: 'box_scores.teams_and_final_scores', awayScore: 'box_scores.teams_and_final_scores',
});

// Parsed documents, by page type.
export const DOCUMENT_FIELDS = Object.freeze({
  school_index: Object.freeze({ schools: list(SCHOOL_ROW) }),
  school_history: Object.freeze({ seasons: list(Object.freeze({ endingYear: 'school_seasons.ending_year', url: 'school_seasons.source_link' })) }),
  season: SEASON,
  game_log: GAME_LOG,
  box_score: BOX_SCORE,
});

// Normalized page data (what is stored as revision `data`), by page kind.
export const NORMALIZED_FIELDS = Object.freeze({
  school_index: DOCUMENT_FIELDS.school_index,
  school_history: DOCUMENT_FIELDS.school_history,
  season: SEASON,
  game_log: GAME_LOG,
  game: GAME,
});

// API models, by route. Both persistence adapters' read models are covered.
// /health is left out: it returns only job, fetch and parse counts, not source data.
export const API_FIELDS = Object.freeze({
  school: Object.freeze({ ...SCHOOL_ROW, eligible: 'schools.eligibility', provenance: PROVENANCE }),
  season: Object.freeze({ ...SEASON, schoolSourcePath: 'schools.source_path', coverageStatus: 'school_seasons.coverage_status', provenance: PROVENANCE }),
  game: Object.freeze({ ...GAME, gameKey: 'game_logs.box_score_source_link', provenance: PROVENANCE }),
});

function* categories(spec) {
  if (typeof spec === 'string') yield spec;
  else if (spec[ITEMS]) yield* categories(spec[ITEMS]);
  else for (const child of Object.values(spec)) yield* categories(child);
}

// Every retained-field name some spec uses.
export const MAPPED_RETAINED_FIELDS = Object.freeze([...new Set(
  [DOCUMENT_FIELDS, NORMALIZED_FIELDS, API_FIELDS].flatMap((specs) => Object.values(specs).flatMap((spec) => [...categories(spec)])),
)].sort());

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function project(spec, value, retained, path, dropped) {
  if (typeof spec === 'string') {
    if (retained.has(spec)) return value;
    dropped.push({ path, field: spec });
    return OMIT;
  }
  // A group with no retained field at all is dropped whole, not kept empty.
  const fields = [...new Set(categories(spec))];
  if (!fields.some((field) => retained.has(field))) {
    dropped.push({ path, field: fields.join(', ') });
    return OMIT;
  }
  if (value === null || value === undefined) return value;
  if (spec[ITEMS]) {
    if (!Array.isArray(value)) { dropped.push({ path, field: null }); return OMIT; }
    return value.map((item, index) => {
      const kept = project(spec[ITEMS], item, retained, `${path}[${index}]`, dropped);
      return kept === OMIT ? null : kept;
    });
  }
  if (!isPlainObject(value)) { dropped.push({ path, field: null }); return OMIT; }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(spec, key)) { dropped.push({ path: at, field: null }); continue; }
    const kept = project(spec[key], child, retained, at, dropped);
    if (kept !== OMIT) result[key] = kept;
  }
  return result;
}

function retainedSet(retainedFields) {
  if (!Array.isArray(retainedFields) && !(retainedFields instanceof Set)) throw new Error('retainedFields must list the data contract\'s retained fields');
  return new Set(retainedFields);
}

// A copy of value with only the fields the retained list covers. `dropped`
// lists each removed field's path and its retained-field name (null when the
// field has no mapping at all).
export function retainFields(spec, value, retainedFields) {
  const dropped = [];
  const kept = project(spec, value, retainedSet(retainedFields), '', dropped);
  return { value: kept === OMIT ? undefined : kept, dropped };
}

// Paths in value that the retained list does not cover, as "path (field)".
export function unretainedFields(spec, value, retainedFields) {
  return retainFields(spec, value, retainedFields).dropped
    .map(({ path, field }) => `${path} (${field ?? 'not mapped to any retained field'})`);
}

// Every field path in value with the retained-field name it maps to (null when
// unmapped). Paths stop at a mapped field; array indexes are written as [].
export function fieldCategories(spec, value, path = '') {
  if (typeof spec === 'string') return [{ path, field: spec }];
  if (value === null || value === undefined) return [];
  if (spec[ITEMS]) return Array.isArray(value) ? value.flatMap((item) => fieldCategories(spec[ITEMS], item, `${path}[]`)) : [{ path, field: null }];
  if (!isPlainObject(value)) return [{ path, field: null }];
  return Object.entries(value).flatMap(([key, child]) => {
    const at = path ? `${path}.${key}` : key;
    return Object.hasOwn(spec, key) ? fieldCategories(spec[key], child, at) : [{ path: at, field: null }];
  });
}
