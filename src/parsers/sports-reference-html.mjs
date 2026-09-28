import { load } from 'cheerio';
import { createParseResult } from '../contracts/boundaries.mjs';
import { blank, present } from '../contracts/value-state.mjs';

export function loadSportsReferenceHtml(snapshot) {
  if (!snapshot || !Buffer.isBuffer(snapshot.body)) throw new Error('parser input is missing its raw HTML body');
  return load(snapshot.body.toString('utf8'));
}

// Sports Reference places some tables inside HTML comments. Always use this
// helper so direct and commented tables have identical parser behavior.
export function sportsReferenceTable($, id) {
  const direct = $('table').filter((_, table) => $(table).attr('id') === id);
  if (direct.length > 1) throw new Error(`table #${id} appears more than once`);
  if (direct.length === 1) return direct.first();

  const matches = [];
  $.root().contents().add($.root().find('*').contents()).each((_, node) => {
    if (node.type !== 'comment' || !String(node.data).includes(`id="${id}"`)) return;
    const comment = load(node.data);
    const table = comment('table').filter((__, candidate) => comment(candidate).attr('id') === id);
    table.each((index) => matches.push(table.eq(index)));
  });
  if (matches.length !== 1) throw new Error(`expected exactly one table #${id}, found ${matches.length}`);
  return matches[0];
}

// Ids of the direct and commented tables whose id starts with `prefix`, in
// document order. Pages with one table per team (box scores) name them by slug.
export function sportsReferenceTableIds($, prefix) {
  const ids = [];
  const visit = (node) => {
    if (node.type === 'comment') {
      if (!String(node.data).includes(`id="${prefix}`)) return;
      const comment = load(node.data);
      comment('table').each((_, table) => { if (comment(table).attr('id')?.startsWith(prefix)) ids.push(comment(table).attr('id')); });
      return;
    }
    if (node.type === 'tag' && node.name === 'table' && node.attribs?.id?.startsWith(prefix)) ids.push(node.attribs.id);
    for (const child of node.children ?? []) visit(child);
  };
  visit($.root()[0]);
  return ids;
}

// Whether the page carries table #id at all, directly or inside a comment. For
// tables a page may legitimately omit; sportsReferenceTable still checks there
// is exactly one.
export function hasSportsReferenceTable($, id) {
  if ($('table').filter((_, table) => $(table).attr('id') === id).length) return true;
  let found = false;
  $.root().contents().add($.root().find('*').contents()).each((_, node) => {
    if (node.type === 'comment' && String(node.data).includes(`id="${id}"`)) found = true;
  });
  return found;
}

// The data-stat names in a table's header, for optional columns.
export function tableHeaderStats($, table) {
  return new Set(table.find('thead [data-stat]').map((_, cell) => $(cell).attr('data-stat')).get());
}

export function assertTableLayout($, table, id, requiredStats) {
  if (!table?.length) throw new Error(`table #${id} is missing`);
  if (!table.find('tbody').length) throw new Error(`table #${id} has no tbody`);
  const headers = new Set(table.find('thead [data-stat]').map((_, cell) => $(cell).attr('data-stat')).get());
  for (const stat of requiredStats) {
    if (!headers.has(stat)) throw new Error(`table #${id} is missing the ${stat} column`);
  }
}

export function tableDataRows($, table) {
  return table.find('tbody > tr').filter((_, row) => !$(row).hasClass('thead')).toArray();
}

export function requiredCell($, row, stat, tableId) {
  const cells = $(row).children(`[data-stat="${stat}"]`);
  if (cells.length !== 1) throw new Error(`table #${tableId} row has ${cells.length} ${stat} cells; expected one`);
  return cells.first();
}

export function integerText(text, label, { min = 0 } = {}) {
  const value = String(text).trim();
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) {
    throw new Error(`${label} is not an integer >= ${min}`);
  }
  return Number(value);
}

export function numericSourceValue(text, label, { integer = false } = {}) {
  const value = String(text).trim();
  if (!value) return blank();
  const parsed = Number(value.replaceAll(',', ''));
  if (!Number.isFinite(parsed) || (integer && !Number.isSafeInteger(parsed))) {
    throw new Error(`${label} is not a ${integer ? 'whole number' : 'number'}`);
  }
  return present(parsed);
}

export function sportsReferenceParse(pageType, action) {
  try {
    return createParseResult({ kind: 'valid', document: action(), warnings: [] });
  } catch (error) {
    return createParseResult({
      kind: 'structural_failure',
      error: `${pageType} layout could not be parsed: ${error.message}`,
      warnings: [],
    });
  }
}
