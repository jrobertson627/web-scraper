import {
  assertTableLayout,
  loadSportsReferenceHtml,
  requiredCell,
  sportsReferenceParse,
  sportsReferenceTable,
  tableDataRows,
} from './sports-reference-html.mjs';

// The oldest season a history row is kept for. The target seasons are the last
// five up to the current season (contracts/season.mjs, #115), which moves forward
// each year, so the parser keeps every linked season from here on and discovery
// applies the window. 2022 is the oldest a window can ever start at.
const FIRST_KEPT_ENDING_YEAR = 2022;

function historyTableId(snapshot) {
  const match = /^\/cbb\/schools\/([^/]+)\/men\/?$/.exec(snapshot?.sourceUrl?.path ?? '');
  if (!match) throw new Error(`history source path is unexpected: ${snapshot?.sourceUrl?.path ?? 'missing'}`);
  return match[1];
}

function endingYearOf(label) {
  const match = /^(\d{4})-(\d{2})$/.exec(label.trim());
  if (!match) throw new Error(`season label is unexpected: ${label.trim() || 'blank'}`);
  const endingYear = Number(match[1]) + 1;
  if (endingYear % 100 !== Number(match[2])) throw new Error(`season label crosses years inconsistently: ${label}`);
  return endingYear;
}

export class SchoolHistoryParser {
  pageType() { return 'school_history'; }
  version() { return '1'; }
  parse(snapshot) {
    return sportsReferenceParse(this.pageType(), () => {
      const id = historyTableId(snapshot);
      const $ = loadSportsReferenceHtml(snapshot);
      const table = sportsReferenceTable($, id);
      assertTableLayout($, table, id, ['season']);
      const rows = tableDataRows($, table);
      if (!rows.length) throw new Error(`table #${id} has no season rows`);
      const seasons = [];
      const seen = new Set();
      for (const row of rows) {
        const cell = requiredCell($, row, 'season', id);
        const endingYear = endingYearOf(cell.text());
        const href = cell.find('a').attr('href');
        if (!href || endingYear < FIRST_KEPT_ENDING_YEAR) continue;
        const source = snapshot.sourceUrlFrom(href);
        const expected = `/cbb/schools/${id}/men/${endingYear}.html`;
        if (source.path !== expected) throw new Error(`season ${endingYear} links to ${source.path}, expected ${expected}`);
        if (seen.has(endingYear)) throw new Error(`season ${endingYear} appears more than once`);
        seen.add(endingYear);
        seasons.push({ endingYear, url: source.absoluteUrl });
      }
      return { seasons };
    });
  }
}
