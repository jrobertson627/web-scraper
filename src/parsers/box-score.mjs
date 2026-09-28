import { decimalMinutes } from '../contracts/parsed-documents.mjs';
import { blank, present, unavailable } from '../contracts/value-state.mjs';
import {
  assertTableLayout,
  loadSportsReferenceHtml,
  numericSourceValue,
  requiredCell,
  sportsReferenceParse,
  sportsReferenceTable,
  sportsReferenceTableIds,
  tableDataRows,
} from './sports-reference-html.mjs';

// Sports Reference box score (#42). The scorebox lists the away team first and
// the home team second; a neutral-site game still has nominal sides, and its
// neutral context comes from the game-log rows that link the box score.

const COUNT_STATS = Object.freeze(['fg', 'fga', 'fg3', 'fg3a', 'ft', 'fta', 'orb', 'drb', 'trb', 'ast', 'stl', 'blk', 'tov', 'pf', 'pts']);
const BASIC_STATS = Object.freeze(['player', 'mp', ...COUNT_STATS]);
const ADVANCED_STATS = Object.freeze(['player', 'mp', 'ts_pct', 'efg_pct']);
const FOUR_FACTOR_STATS = Object.freeze(['school_name', 'pace', 'efg_pct', 'tov_pct', 'orb_pct', 'ft_rate']);
// Printed on a 0-100 scale; documents store fractions (35.7 -> 0.357).
const PERCENT_POINTS = new Set(['orb_pct', 'drb_pct', 'trb_pct', 'ast_pct', 'stl_pct', 'blk_pct', 'tov_pct', 'usg_pct']);
const MONTHS = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
const NOT_PUBLISHED = 'not_published';

function text(node) { return node.text().replace(/\s+/g, ' ').trim(); }

function isoDate(value) {
  const match = new RegExp(`\\b(${MONTHS.join('|')}) (\\d{1,2}), (\\d{4})\\b`).exec(value);
  if (!match) throw new Error(`scorebox date is unexpected: ${value || 'blank'}`);
  const date = `${match[3]}-${String(MONTHS.indexOf(match[1]) + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error(`scorebox date is not a calendar date: ${value}`);
  return date;
}

function minutesValue(value, label) {
  if (!value) return blank();
  if (/^\d+$/.test(value)) return present(Number(value));
  if (/^\d+:\d{2}$/.test(value)) return present(decimalMinutes(value));
  throw new Error(`${label} is not minutes`);
}

function percentPoints(value, label) {
  const parsed = numericSourceValue(value, label);
  if (parsed.state !== 'present') return parsed;
  const decimals = value.split('.')[1]?.length ?? 0;
  return present(Number((parsed.value / 100).toFixed(decimals + 2)));
}

function statValue($, row, stat, tableId, label) {
  const value = text(requiredCell($, row, stat, tableId));
  if (stat === 'mp') return minutesValue(value, `${label} mp`);
  if (PERCENT_POINTS.has(stat)) return percentPoints(value, `${label} ${stat}`);
  return numericSourceValue(value, `${label} ${stat}`, { integer: COUNT_STATS.includes(stat) });
}

function headerStats($, table) { return table.find('thead tr').last().children('[data-stat]').map((_, cell) => $(cell).attr('data-stat')).get(); }

// A row with no stat cells, only one note spanning the row ("Did Not Play"):
// every statistic is unavailable for that reason, never zero.
function noStatsReason($, row) {
  const cells = $(row).children('td');
  if (cells.length !== 1 || !(cells.attr('data-stat') === 'reason' || cells.attr('colspan'))) return null;
  return text(cells).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'no_statistics';
}

function rowValues($, row, stats, tableId, label, reason) {
  return Object.fromEntries(stats.map((stat) => [stat, reason ? unavailable(reason) : statValue($, row, stat, tableId, label)]));
}

function statLine(values) {
  const { mp, ...rest } = values;
  const line = { minutes: mp, ...Object.fromEntries(COUNT_STATS.map((stat) => [stat, rest[stat]])) };
  const extra = Object.fromEntries(Object.entries(rest).filter(([stat]) => !COUNT_STATS.includes(stat)));
  return Object.keys(extra).length ? { ...line, extra } : line;
}

function sectionOf(label) { return label === 'Starters' ? true : label === 'Reserves' ? false : null; }

function playerIdentity($, row, tableId, snapshot) {
  const cell = requiredCell($, row, 'player', tableId);
  const name = text(cell);
  if (!name) throw new Error(`table #${tableId} has a player row with no name`);
  const href = cell.find('a').attr('href');
  if (!href) return { name, playerPath: null };
  const source = snapshot.sourceUrlFrom(href);
  if (!/^\/cbb\/players\/[^/]+\.html$/.test(source.path)) throw new Error(`player ${name} has an unexpected link: ${source.path}`);
  return { name, playerPath: source.path };
}

// Player rows in source order with their starter designation, and the School
// Totals footer row (null when the table has none).
function teamRows($, table, tableId, snapshot) {
  let starter = sectionOf(text(table.find('thead tr').last().children('[data-stat="player"]')));
  const players = [];
  for (const row of table.find('tbody > tr').toArray()) {
    if ($(row).hasClass('thead')) {
      starter = sectionOf(text($(row).children('[data-stat="player"]')));
      continue;
    }
    players.push({ row, starter, ...playerIdentity($, row, tableId, snapshot) });
  }
  const totals = table.find('tfoot > tr').filter((_, row) => text($(row).children('[data-stat="player"]')) === 'School Totals').toArray();
  if (totals.length > 1) throw new Error(`table #${tableId} has ${totals.length} School Totals rows`);
  return { players, totals: totals[0] ?? null };
}

function teamTables($, index, team, snapshot) {
  const [basicIds, advancedIds] = ['box-score-basic-', 'box-score-advanced-'].map((prefix) => {
    const ids = sportsReferenceTableIds($, prefix);
    if (ids.length !== 2) throw new Error(`expected two ${prefix}<team> tables, found ${ids.length}`);
    return ids;
  });
  const basicId = basicIds[index];
  const advancedId = advancedIds[index];
  const slug = basicId.slice('box-score-basic-'.length);
  if (advancedId !== `box-score-advanced-${slug}`) throw new Error(`table #${advancedId} does not follow #${basicId}`);
  const linkedSlug = /^\/cbb\/schools\/([^/]+)\/men\/$/.exec(team.schoolPath ?? '')?.[1];
  if (linkedSlug && linkedSlug !== slug) throw new Error(`${team.side} team ${team.name} has table #${basicId}, expected box-score-basic-${linkedSlug}`);

  const basic = sportsReferenceTable($, basicId);
  assertTableLayout($, basic, basicId, BASIC_STATS);
  const advanced = sportsReferenceTable($, advancedId);
  assertTableLayout($, advanced, advancedId, ADVANCED_STATS);
  const basicStats = headerStats($, basic).filter((stat) => stat !== 'player');
  const advancedStats = headerStats($, advanced).filter((stat) => stat !== 'player' && stat !== 'mp');

  const basicRows = teamRows($, basic, basicId, snapshot);
  const advancedRows = teamRows($, advanced, advancedId, snapshot);
  if (advancedRows.players.length !== basicRows.players.length) {
    throw new Error(`table #${advancedId} has ${advancedRows.players.length} player rows, #${basicId} has ${basicRows.players.length}`);
  }
  const players = basicRows.players.map((player, row) => {
    const other = advancedRows.players[row];
    if (other.name !== player.name || other.playerPath !== player.playerPath) {
      throw new Error(`table #${advancedId} row ${row} is ${other.name}, expected ${player.name}`);
    }
    const label = `${team.name} ${player.name}`;
    return {
      name: player.name,
      playerPath: player.playerPath,
      starter: player.starter,
      stats: statLine(rowValues($, player.row, basicStats, basicId, label, noStatsReason($, player.row))),
      advanced: rowValues($, other.row, advancedStats, advancedId, label, noStatsReason($, other.row)),
    };
  });
  const label = `${team.name} School Totals`;
  return {
    stats: basicRows.totals ? statLine(rowValues($, basicRows.totals, basicStats, basicId, label)) : null,
    advanced: advancedRows.totals ? rowValues($, advancedRows.totals, advancedStats, advancedId, label) : {},
    players,
  };
}

function schoolPathOf(href, snapshot, name) {
  if (!href) return null;
  const source = snapshot.sourceUrlFrom(href);
  // Team links point at the season page; the school page (identity) drops `<year>.html`.
  const match = /^\/cbb\/schools\/([^/]+)\/men\/\d{4}\.html$/.exec(source.path);
  if (!match) throw new Error(`team ${name} has an unexpected link: ${source.path}`);
  return `/cbb/schools/${match[1]}/men/`;
}

function scoreboxTeam($, scorebox, index, snapshot) {
  const block = scorebox.find(`#sb_team_${index}`);
  if (block.length !== 1) throw new Error(`scorebox team ${index} is missing`);
  const strong = block.find('strong').first();
  const name = text(strong);
  if (!name) throw new Error(`scorebox team ${index} has no name`);
  const score = block.find('.scores .score');
  if (score.length > 1) throw new Error(`scorebox team ${name} has ${score.length} scores`);
  return {
    side: index === 0 ? 'away' : 'home',
    name,
    schoolPath: schoolPathOf(strong.find('a').attr('href'), snapshot, name),
    finalScore: score.length ? numericSourceValue(text(score), `${name} final score`, { integer: true }) : unavailable(NOT_PUBLISHED),
  };
}

// Date first, then venue and description by position; blank lines stay null.
function scoreboxMeta($, scorebox) {
  const lines = scorebox.find('.scorebox_meta').children('div').map((_, div) => text($(div))).get()
    .filter((line) => !/^Logos via Sports Logos\.net/.test(line));
  const attendance = lines.filter((line) => /^Attendance:/.test(line));
  if (attendance.length > 1) throw new Error('scorebox has more than one attendance line');
  const [date, venue, description] = lines.filter((line) => !/^Attendance:/.test(line));
  return {
    date: isoDate(date ?? ''),
    venue: venue || null,
    description: description || null,
    attendance: attendance.length
      ? numericSourceValue(attendance[0].replace(/^Attendance:/, ''), 'attendance', { integer: true })
      : unavailable(NOT_PUBLISHED),
  };
}

// Rows of a two-team summary table, matched to the scorebox teams by position
// and checked against their links.
function teamRowsByPosition($, tableId, requiredStats, teams, snapshot) {
  const table = sportsReferenceTable($, tableId);
  assertTableLayout($, table, tableId, requiredStats);
  const nameStat = requiredStats[0];
  const rows = tableDataRows($, table);
  if (rows.length !== 2) throw new Error(`table #${tableId} has ${rows.length} team rows; expected two`);
  rows.forEach((row, index) => {
    const cell = requiredCell($, row, nameStat, tableId);
    const path = schoolPathOf(cell.find('a').attr('href'), snapshot, text(cell));
    if (path !== teams[index].schoolPath) throw new Error(`table #${tableId} row ${index} is ${text(cell)}, expected ${teams[index].name}`);
  });
  return { table, rows };
}

function lineScores($, teams, snapshot) {
  const { table, rows } = teamRowsByPosition($, 'line-score', ['team', 'T'], teams, snapshot);
  const periods = headerStats($, table).filter((stat) => stat !== 'team' && stat !== 'T');
  for (const period of periods) if (!/^(\d+|\d*OT)$/.test(period)) throw new Error(`line score period is unexpected: ${period}`);
  if (!periods.length) throw new Error('line score has no periods');
  const lines = rows.map((row, index) => {
    const label = `${teams[index].name} line score`;
    const lineScore = periods.map((period) => numericSourceValue(text(requiredCell($, row, period, 'line-score')), `${label} ${period}`, { integer: true }));
    const total = numericSourceValue(text(requiredCell($, row, 'T', 'line-score')), `${label} total`, { integer: true });
    const finalScore = teams[index].finalScore;
    if (total.state === 'present' && finalScore.state === 'present' && total.value !== finalScore.value) {
      throw new Error(`${label} total ${total.value} differs from the final score ${finalScore.value}`);
    }
    if (total.state === 'present' && lineScore.every((entry) => entry.state === 'present')
      && lineScore.reduce((sum, entry) => sum + entry.value, 0) !== total.value) {
      throw new Error(`${label} periods do not add up to ${total.value}`);
    }
    return lineScore;
  });
  return { lines, overtimes: periods.filter((period) => period.endsWith('OT')).length };
}

// Four-factor figures join the team's advanced totals. Where both tables print
// the same statistic they must agree, which also confirms the row matching.
function withFourFactors($, teams, snapshot) {
  const { table, rows } = teamRowsByPosition($, 'four-factors', FOUR_FACTOR_STATS, teams, snapshot);
  const stats = headerStats($, table).filter((stat) => stat !== 'school_name');
  return teams.map((team, index) => {
    const advanced = { ...team.advanced };
    for (const [stat, value] of Object.entries(rowValues($, rows[index], stats, 'four-factors', `${team.name} four factors`))) {
      const printed = advanced[stat];
      if (printed?.state === 'present' && value.state === 'present' && printed.value !== value.value) {
        throw new Error(`${team.name} four-factor ${stat} ${value.value} differs from its advanced total ${printed.value}`);
      }
      if (printed?.state !== 'present') advanced[stat] = value;
    }
    return { ...team, advanced };
  });
}

export class BoxScoreParser {
  pageType() { return 'box_score'; }
  version() { return '1'; }
  parse(snapshot) {
    return sportsReferenceParse(this.pageType(), () => {
      const $ = loadSportsReferenceHtml(snapshot);
      const scorebox = $('.scorebox');
      if (scorebox.length !== 1) throw new Error(`expected one scorebox, found ${scorebox.length}`);
      const sides = [0, 1].map((index) => scoreboxTeam($, scorebox, index, snapshot));
      const meta = scoreboxMeta($, scorebox);
      const { lines, overtimes } = lineScores($, sides, snapshot);
      const teams = withFourFactors($, sides.map((team, index) => ({
        ...team, lineScore: lines[index], ...teamTables($, index, team, snapshot),
      })), snapshot);
      return {
        date: meta.date,
        status: teams.every((team) => team.finalScore.state === 'present') ? 'final' : 'incomplete',
        // Not printed on the box score; the game-log row that links it states the game type.
        gameType: null,
        description: meta.description,
        venue: meta.venue,
        attendance: meta.attendance,
        overtimes,
        teams: teams.map(({ side, name, schoolPath, finalScore, lineScore, stats, advanced, players }) => ({
          side, name, schoolPath, finalScore, lineScore, stats, advanced, players,
        })),
      };
    });
  }
}
