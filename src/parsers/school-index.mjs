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

const TABLE_ID = 'NCAAM_schools';
const REQUIRED_STATS = Object.freeze([
  'school_name', 'location', 'year_min', 'year_max', 'years', 'g', 'wins', 'losses', 'win_loss_pct',
  'srs', 'sos', 'poll_final', 'conf_champ_count', 'conf_champ_post_count', 'ncaa_count',
  'ncaa_final_four_count', 'ncaa_champ_count',
]);
const INTEGER_AGGREGATES = new Set([
  'years', 'g', 'wins', 'losses', 'poll_final', 'conf_champ_count', 'conf_champ_post_count',
  'ncaa_count', 'ncaa_final_four_count', 'ncaa_champ_count',
]);
const AGGREGATE_STATS = REQUIRED_STATS.slice(4);

function locationParts(value) {
  const location = value.trim();
  const split = location.lastIndexOf(',');
  if (split < 1 || !location.slice(split + 1).trim()) throw new Error(`school location is not "City, State": ${location}`);
  return { city: location.slice(0, split).trim(), state: location.slice(split + 1).trim() };
}

function schoolRow($, row, snapshot) {
  const school = requiredCell($, row, 'school_name', TABLE_ID);
  const name = school.text().trim();
  const href = school.find('a').attr('href');
  if (!name) throw new Error('school name is blank');
  if (!href) throw new Error(`school ${name} has no history link`);
  const source = snapshot.sourceUrlFrom(href);
  if (!/^\/cbb\/schools\/[^/]+\/men\/$/.test(source.path)) throw new Error(`school ${name} has an unexpected history path: ${source.path}`);
  const { city, state } = locationParts(requiredCell($, row, 'location', TABLE_ID).text());
  const aggregateFields = Object.fromEntries(AGGREGATE_STATS.map((stat) => [
    stat,
    numericSourceValue(requiredCell($, row, stat, TABLE_ID).text(), `${name} ${stat}`, { integer: INTEGER_AGGREGATES.has(stat) }),
  ]));
  return {
    name,
    path: source.path,
    historyUrl: source.absoluteUrl,
    city,
    state,
    from: integerText(requiredCell($, row, 'year_min', TABLE_ID).text(), `${name} From`, { min: 1800 }),
    to: integerText(requiredCell($, row, 'year_max', TABLE_ID).text(), `${name} To`, { min: 1800 }),
    aggregateFields,
  };
}

export class SchoolIndexParser {
  pageType() { return 'school_index'; }
  version() { return '1'; }
  parse(snapshot) {
    return sportsReferenceParse(this.pageType(), () => {
      const $ = loadSportsReferenceHtml(snapshot);
      const table = sportsReferenceTable($, TABLE_ID);
      assertTableLayout($, table, TABLE_ID, REQUIRED_STATS);
      const rows = tableDataRows($, table);
      if (!rows.length) throw new Error(`table #${TABLE_ID} has no school rows`);
      return { schools: rows.map((row) => schoolRow($, row, snapshot)) };
    });
  }
}
