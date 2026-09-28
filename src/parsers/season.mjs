import { load } from 'cheerio';
import { createParseResult } from '../contracts/boundaries.mjs';
import { CORE_STAT_FIELDS } from '../contracts/parsed-documents.mjs';
import { blank, present, unavailable } from '../contracts/value-state.mjs';
import {
  assertTableLayout,
  hasSportsReferenceTable,
  loadSportsReferenceHtml,
  numericSourceValue,
  requiredCell,
  sportsReferenceParse,
  sportsReferenceTable,
  tableDataRows,
  tableHeaderStats,
} from './sports-reference-html.mjs';

const NOT_PUBLISHED = unavailable('not_published');
const ROSTER = 'roster';
const TEAM_TOTALS = 'season-total_totals';
const PLAYER_TOTALS = 'players_totals';
const PLAYER_ADVANCED = 'players_advanced';

// Source columns for the sixteen core stats. Team-total opponent rows prefix
// each stat with `opp_`, except games and minutes.
const STAT_COLUMNS = Object.freeze({ minutes: 'mp', ...Object.fromEntries(CORE_STAT_FIELDS.slice(1).map((field) => [field, field])) });
const STAT_EXTRAS = Object.freeze(['fg_pct', 'fg2', 'fg2a', 'fg2_pct', 'fg3_pct', 'efg_pct', 'ft_pct']);
const INTEGER_EXTRAS = new Set(['fg2', 'fg2a']);
const ROSTER_STATS = Object.freeze(['player', 'number', 'class', 'pos', 'height', 'weight']);
const ROSTER_EXTRAS = Object.freeze(['hometown', 'high_school', 'rsci']);
const TOTALS_STATS = Object.freeze(['entity', 'games', ...Object.values(STAT_COLUMNS)]);
const PLAYER_STATS = Object.freeze(['name_display', 'games', 'games_started', ...Object.values(STAT_COLUMNS)]);
const ADVANCED_STATS = Object.freeze(['name_display', 'per', 'ws', 'bpm']);
// Identity and totals columns repeated in the advanced table, plus award text.
const ADVANCED_SKIPPED = new Set(['ranker', 'name_display', 'pos', 'games', 'games_started', 'mp', 'awards']);
// Advanced columns printed as percentages (20.7 means 20.7%); stored as fractions.
const PERCENT_POINTS = new Set(['orb_pct', 'drb_pct', 'trb_pct', 'ast_pct', 'stl_pct', 'blk_pct', 'tov_pct', 'usg_pct']);

function seasonSource(snapshot) {
  const match = /^\/cbb\/schools\/([^/]+)\/men\/(\d{4})\.html$/.exec(snapshot?.sourceUrl?.path ?? '');
  if (!match) throw new Error(`season source path is unexpected: ${snapshot?.sourceUrl?.path ?? 'missing'}`);
  return { slug: match[1], endingYear: Number(match[2]) };
}

function squash(text) { return String(text).replace(/\s+/g, ' ').trim(); }

function ordinal(text, label) {
  const match = /^(\d+)(?:st|nd|rd|th)$/.exec(text);
  if (!match) throw new Error(`${label} is not an ordinal: ${text}`);
  return Number(match[1]);
}

// A link on the same site, kept as its path (the linked entity's identity).
function sitePath(snapshot, href, pattern, label) {
  if (!href) return null;
  const source = snapshot.sourceUrlFrom(href);
  if (source.host !== snapshot.sourceUrl.host || !pattern.test(source.path)) throw new Error(`${label} links to an unexpected page: ${source.absoluteUrl}`);
  return source.path;
}

function heading($, endingYear) {
  const spans = $('#info h1 span').map((_, span) => squash($(span).text())).get();
  if (spans.length < 2) throw new Error('season heading is missing its season and team');
  const expected = `${endingYear - 1}-${String(endingYear % 100).padStart(2, '0')}`;
  if (spans[0] !== expected) throw new Error(`season heading ${spans[0]} does not match ${expected}`);
  const school = spans[1].replace(/\s+(?:Men's|Women's)$/, '');
  if (!school) throw new Error('season heading has no team name');
  return school;
}

// `#info` paragraphs keyed by their bold label ("Record", "Coach", "SRS", ...).
function infoLines($) {
  const lines = new Map();
  $('#info p').each((_, p) => {
    const label = squash($(p).children('strong').first().text()).replace(/:$/, '');
    if (!label) return;
    if (lines.has(label)) throw new Error(`season summary repeats its ${label} line`);
    lines.set(label, $(p));
  });
  return lines;
}

function valueText($, line) {
  const clone = line.clone();
  clone.children('strong').first().remove();
  return squash(clone.text());
}

function rating($, lines, label) {
  const line = lines.get(label);
  if (!line) return NOT_PUBLISHED;
  const text = valueText($, line);
  const match = /^(\S*)(?:\s+\(\d+(?:st|nd|rd|th) of \d+\))?$/.exec(text);
  if (!match) throw new Error(`season ${label} line is unexpected: ${text}`);
  return numericSourceValue(match[1], `season ${label}`);
}

function record($, lines, snapshot) {
  const line = lines.get('Record');
  if (!line) throw new Error('season summary has no Record line');
  const text = valueText($, line);
  const match = /^(\d+)-(\d+)(?: \((\d+)-(\d+), (\d+(?:st|nd|rd|th)) in (.+)\))?$/.exec(text);
  if (!match) throw new Error(`season record is unexpected: ${text}`);
  const links = line.find('a');
  if (links.length > 1) throw new Error('season record links more than one conference');
  const conferenceName = match[6] ? squash(links.first().text() || match[6]) : null;
  return {
    wins: present(Number(match[1])),
    losses: present(Number(match[2])),
    confWins: match[3] ? present(Number(match[3])) : NOT_PUBLISHED,
    confLosses: match[4] ? present(Number(match[4])) : NOT_PUBLISHED,
    conference: conferenceName ? {
      name: conferenceName,
      path: sitePath(snapshot, links.first().attr('href'), /^\/cbb\/conferences\/[^/]+\/men\/\d{4}\.html$/, 'conference'),
    } : null,
    confFinish: match[5] ? present(ordinal(match[5], 'conference finish')) : NOT_PUBLISHED,
  };
}

function coach($, lines, snapshot, warnings) {
  const line = lines.get('Coach');
  if (!line) return null;
  const links = line.find('a');
  if (links.length > 1) {
    warnings.push(`season lists ${links.length} coaches; summary.coach holds one, so it is null`);
    return null;
  }
  const name = links.length ? squash(links.first().text()) : valueText($, line).replace(/\s*\(\d+-\d+\)$/, '');
  if (!name) throw new Error('season Coach line is blank');
  return { name, path: sitePath(snapshot, links.first().attr('href'), /^\/cbb\/coaches\/[^/]+\.html$/, `coach ${name}`) };
}

function apFinalRank($, lines) {
  const line = lines.get('Rank');
  if (!line) return NOT_PUBLISHED;
  const text = valueText($, line);
  const match = /^(\d+(?:st|nd|rd|th)) in the (.+)$/.exec(text);
  if (!match) throw new Error(`season Rank line is unexpected: ${text}`);
  return match[2] === 'Final AP Poll' ? present(ordinal(match[1], 'AP rank')) : NOT_PUBLISHED;
}

// "(#4 seed in South)" then one line per game:
// "Lost South Regional Final (76-64) versus #11 NC State". The printed score is
// winner first, so a loss swaps it into team/opponent order.
function ncaaTournament($, lines) {
  const line = lines.get('NCAA Tournament');
  if (!line) return null;
  const clone = line.clone();
  clone.children('strong').first().remove();
  const parts = clone.html().split(/<br\s*\/?>/i).map((part) => squash(load(part).text())).filter(Boolean);
  const header = /^\(#(\d+) seed in (.+)\)(.*)$/.exec(parts[0] ?? '');
  if (!header) throw new Error(`NCAA tournament seed line is unexpected: ${parts[0] ?? 'blank'}`);
  const region = header[2];
  const gameLines = [header[3].trim(), ...parts.slice(1)].filter(Boolean);
  const games = gameLines.map((text) => {
    const match = /^(Won|Lost) (.+?) \((\d+)-(\d+)\) versus (?:#(\d+) )?(.+)$/.exec(text);
    if (!match) throw new Error(`NCAA tournament game line is unexpected: ${text}`);
    const [winner, loser] = [Number(match[3]), Number(match[4])];
    if (winner <= loser) throw new Error(`NCAA tournament score is not winner first: ${text}`);
    const won = match[1] === 'Won';
    return {
      round: match[2].startsWith(`${region} `) ? match[2].slice(region.length + 1) : match[2],
      result: won ? 'W' : 'L',
      teamScore: won ? winner : loser,
      opponentScore: won ? loser : winner,
      opponent: { name: match[6], seed: match[5] ? Number(match[5]) : null },
    };
  });
  return { seed: present(Number(header[1])), region, games };
}

function gameLogUrl($, snapshot, slug, endingYear) {
  const expected = `/cbb/schools/${slug}/men/${endingYear}-gamelogs.html`;
  const urls = new Set($('a[href*="-gamelogs.html"]').map((_, link) => snapshot.sourceUrlFrom($(link).attr('href'))).get()
    .filter((source) => source.host === snapshot.sourceUrl.host && source.path === expected)
    .map((source) => source.absoluteUrl));
  if (urls.size > 1) throw new Error(`season links more than one game log: ${[...urls].join(', ')}`);
  return urls.size ? [...urls][0] : null;
}

function textValue(text) { return text ? present(text) : blank(); }

function heightInches(text, label) {
  if (!text) return blank();
  const match = /^(\d+)-(\d+)$/.exec(text);
  if (!match || Number(match[2]) > 11) throw new Error(`${label} height is not feet-inches: ${text}`);
  return present(Number(match[1]) * 12 + Number(match[2]));
}

function playerLink($, cell, snapshot, table) {
  const name = squash(cell.text());
  if (!name) throw new Error(`table #${table} has a player row with no name`);
  const links = cell.find('a');
  if (links.length > 1) throw new Error(`table #${table} player ${name} has ${links.length} links`);
  return { name, playerPath: sitePath(snapshot, links.first().attr('href'), /^\/cbb\/players\/[^/]+\.html$/, `player ${name}`) };
}

function rosterRow($, row, snapshot, headers) {
  const { name, playerPath } = playerLink($, requiredCell($, row, 'player', ROSTER), snapshot, ROSTER);
  const text = (stat) => squash(requiredCell($, row, stat, ROSTER).text());
  return {
    name, playerPath,
    number: text('number') || null,
    class: text('class') || null,
    position: text('pos') || null,
    heightIn: heightInches(text('height'), name),
    weight: numericSourceValue(text('weight'), `${name} weight`, { integer: true }),
    extra: Object.fromEntries(ROSTER_EXTRAS.map((stat) => [stat, headers.has(stat) ? textValue(text(stat)) : NOT_PUBLISHED])),
  };
}

function statLine($, row, table, headers, prefix = '') {
  const value = (stat, integer) => numericSourceValue(requiredCell($, row, `${prefix}${stat}`, table).text(), `table #${table} ${prefix}${stat}`, { integer });
  const line = Object.fromEntries(Object.entries(STAT_COLUMNS).map(([field, stat]) => (
    [field, field === 'minutes' ? numericSourceValue(requiredCell($, row, stat, table).text(), `table #${table} ${stat}`) : value(stat, true)]
  )));
  const extras = STAT_EXTRAS.filter((stat) => headers.has(stat));
  return extras.length ? { ...line, extra: Object.fromEntries(extras.map((stat) => [stat, value(stat, INTEGER_EXTRAS.has(stat))])) } : line;
}

function teamTotals($) {
  if (!hasSportsReferenceTable($, TEAM_TOTALS)) return null;
  const table = sportsReferenceTable($, TEAM_TOTALS);
  assertTableLayout($, table, TEAM_TOTALS, TOTALS_STATS);
  const headers = tableHeaderStats($, table);
  // Rank rows under each side rank the team nationally; they are not data rows.
  const rows = tableDataRows($, table).filter((row) => squash(requiredCell($, row, 'entity', TEAM_TOTALS).text()) !== 'Rank');
  const entities = rows.map((row) => squash(requiredCell($, row, 'entity', TEAM_TOTALS).text()));
  if (entities.join(',') !== 'Team,Opponent') throw new Error(`table #${TEAM_TOTALS} rows are ${entities.join(', ') || 'missing'}; expected Team, Opponent`);
  const side = (row, prefix) => ({
    games: numericSourceValue(requiredCell($, row, 'games', TEAM_TOTALS).text(), `table #${TEAM_TOTALS} games`, { integer: true }),
    stats: statLine($, row, TEAM_TOTALS, headers, prefix),
  });
  return { team: side(rows[0], ''), opponent: side(rows[1], 'opp_') };
}

function playerKey(player) { return player.playerPath ?? `name:${player.name}`; }

function advancedValue(stat, text) {
  const value = squash(text);
  if (!value || !PERCENT_POINTS.has(stat)) return numericSourceValue(value, `table #${PLAYER_ADVANCED} ${stat}`);
  // Shift the decimal point in text so 20.7 becomes exactly 0.207.
  if (!/^-?\d*\.?\d+$/.test(value)) throw new Error(`table #${PLAYER_ADVANCED} ${stat} is not a number`);
  return present(Number(`${value}e-2`));
}

function advancedByPlayer($, snapshot) {
  const table = sportsReferenceTable($, PLAYER_ADVANCED);
  assertTableLayout($, table, PLAYER_ADVANCED, ADVANCED_STATS);
  const stats = [...tableHeaderStats($, table)].filter((stat) => !ADVANCED_SKIPPED.has(stat));
  const players = new Map();
  for (const row of tableDataRows($, table)) {
    const player = playerLink($, requiredCell($, row, 'name_display', PLAYER_ADVANCED), snapshot, PLAYER_ADVANCED);
    if (players.has(playerKey(player))) throw new Error(`table #${PLAYER_ADVANCED} lists ${player.name} more than once`);
    players.set(playerKey(player), Object.fromEntries(stats.map((stat) => [stat, advancedValue(stat, requiredCell($, row, stat, PLAYER_ADVANCED).text())])));
  }
  return { stats, players };
}

function players($, snapshot) {
  const table = sportsReferenceTable($, PLAYER_TOTALS);
  assertTableLayout($, table, PLAYER_TOTALS, PLAYER_STATS);
  const headers = tableHeaderStats($, table);
  const advanced = advancedByPlayer($, snapshot);
  const seen = new Set();
  const list = tableDataRows($, table).map((row) => {
    const player = playerLink($, requiredCell($, row, 'name_display', PLAYER_TOTALS), snapshot, PLAYER_TOTALS);
    const key = playerKey(player);
    if (seen.has(key)) throw new Error(`table #${PLAYER_TOTALS} lists ${player.name} more than once`);
    seen.add(key);
    const count = (stat) => numericSourceValue(requiredCell($, row, stat, PLAYER_TOTALS).text(), `${player.name} ${stat}`, { integer: true });
    return {
      ...player,
      games: count('games'),
      gamesStarted: count('games_started'),
      stats: statLine($, row, PLAYER_TOTALS, headers),
      // A player the advanced table leaves out has no advanced figures, not zeros.
      advanced: advanced.players.get(key) ?? Object.fromEntries(advanced.stats.map((stat) => [stat, unavailable('not_listed')])),
    };
  });
  const extra = [...advanced.players.keys()].filter((key) => !seen.has(key));
  if (extra.length) throw new Error(`table #${PLAYER_ADVANCED} lists players missing from #${PLAYER_TOTALS}: ${extra.join(', ')}`);
  return list;
}

function roster($, snapshot) {
  const table = sportsReferenceTable($, ROSTER);
  assertTableLayout($, table, ROSTER, ROSTER_STATS);
  const headers = tableHeaderStats($, table);
  return tableDataRows($, table).map((row) => rosterRow($, row, snapshot, headers));
}

function seasonDocument(snapshot, warnings) {
  const { slug, endingYear } = seasonSource(snapshot);
  const $ = loadSportsReferenceHtml(snapshot);
  if ($('#info').length !== 1) throw new Error('season page has no single #info summary');
  const lines = infoLines($);
  const { confFinish, conference, ...wins } = record($, lines, snapshot);
  return {
    school: heading($, endingYear),
    endingYear,
    gameLogUrl: gameLogUrl($, snapshot, slug, endingYear),
    summary: {
      ...wins,
      srs: rating($, lines, 'SRS'),
      sos: rating($, lines, 'SOS'),
      offRtg: rating($, lines, 'ORtg'),
      defRtg: rating($, lines, 'DRtg'),
      conference,
      coach: coach($, lines, snapshot, warnings),
      ncaaTournament: ncaaTournament($, lines),
      extra: { conf_finish: confFinish, ap_final_rank: apFinalRank($, lines) },
    },
    roster: roster($, snapshot),
    teamTotals: teamTotals($),
    players: players($, snapshot),
  };
}

export class SeasonParser {
  pageType() { return 'season'; }
  version() { return '1'; }
  parse(snapshot) {
    const warnings = [];
    const parsed = sportsReferenceParse(this.pageType(), () => seasonDocument(snapshot, warnings));
    return parsed.kind === 'valid' && warnings.length ? createParseResult({ ...parsed, warnings }) : parsed;
  }
}
