import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createSnapshot } from '../../src/contracts/boundaries.mjs';
import { assertParsedDocument } from '../../src/contracts/parsed-documents.mjs';
import { createSourceUrl } from '../../src/contracts/source.mjs';
import { present, unavailable } from '../../src/contracts/value-state.mjs';

// Test access to the real Sports Reference captures (#38). raw/ is gitignored
// (see README.md), so every test that reads a capture must skip when it is
// missing: pass captureSkip(...paths) as the test's `skip` option.

const ORIGIN = 'https://www.sports-reference.com';
const PROVIDER_ID = 'sports-reference';
const root = new URL('./', import.meta.url);
export const captureManifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));

function captureFile(sitePath) {
  const entry = captureManifest[sitePath];
  if (!entry) throw new Error(`no capture is recorded for ${sitePath}; see fixtures/sports-reference/manifest.json`);
  return new URL(entry.file, root);
}

// false when every named capture is present, otherwise the reason to skip.
export function captureSkip(...sitePaths) {
  if (!existsSync(new URL('raw/', root))) return 'real Sports Reference captures are not present: fixtures/sports-reference/raw/ is gitignored (see its README)';
  const missing = sitePaths.filter((sitePath) => !existsSync(captureFile(sitePath)));
  return missing.length ? `real Sports Reference captures are missing: ${missing.join(', ')}` : false;
}

export function readCapture(sitePath) { return readFileSync(captureFile(sitePath)); }

export function captureChecksum(sitePath) { return createHash('sha256').update(readCapture(sitePath)).digest('hex'); }

export function captureSourceUrl(sitePath) { return createSourceUrl(PROVIDER_ID, `${ORIGIN}${sitePath}`); }

// The snapshot the orchestrator would hand to parsers and discovery.
export function captureSnapshot(sitePath, { jobKey = `capture:${sitePath}`, schoolSourcePath } = {}) {
  const sourceUrl = captureSourceUrl(sitePath);
  return createSnapshot({
    jobKey, schoolSourcePath, sourceUrl, body: readCapture(sitePath),
    sourceUrlFrom: (target, baseUrl = sourceUrl.absoluteUrl) => createSourceUrl(PROVIDER_ID, target, baseUrl),
  });
}

// ---------------------------------------------------------------------------
// Link documents: a stand-in for the phase 2 parsers (#39-#42). Each returns a
// document in the frozen shape (PARSED_DOCUMENTS.md) whose link-bearing fields
// (school paths, history and season links, the game-log link, row box-score
// links, opponents, locations) are read from the real HTML. Statistics are left
// unavailable('not_parsed'). Discovery tests use these to exercise discovery
// against real page structure before the real parsers exist.
// ---------------------------------------------------------------------------

const NOT_PARSED = unavailable('not_parsed');

function decode(text) {
  return text.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ').trim();
}

function tableBody(html, id) {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) throw new Error(`table #${id} is missing`);
  const table = html.slice(start, html.indexOf('</table>', start));
  const body = table.indexOf('<tbody');
  return table.slice(body, table.indexOf('</tbody>', body));
}

// Data rows only: repeated header rows (class="thead") are dropped.
function dataRows(body) {
  return body.split(/<tr\b/).slice(1).filter((row) => !/^[^>]*class="[^"]*\bthead\b/.test(row));
}

function cell(row, stat) {
  const match = new RegExp(`<t[hd][^>]*data-stat="${stat}"[^>]*>([\\s\\S]*?)</t[hd]>`).exec(row);
  if (!match) return null;
  const href = /<a\s+href="([^"]*)"/.exec(match[1])?.[1] ?? null;
  return { text: decode(match[1]), href };
}

function integerOrNull(text) { return /^\d+$/.test(text ?? '') ? Number(text) : null; }

// Opponent and scorebox links point at the team's season page; its school page
// (identity) drops `<year>.html`.
function schoolPathOf(href) { return href ? href.replace(/\d{4}\.html$/, '') : null; }

function schoolIndex(html) {
  const men = html.slice(html.indexOf('id="NCAAM_schools"'));
  return {
    schools: dataRows(tableBody(men, 'NCAAM_schools')).flatMap((row) => {
      const school = cell(row, 'school_name');
      if (!school?.text) return [];
      return [{
        name: school.text, path: school.href, historyUrl: school.href ? new URL(school.href, ORIGIN).href : null,
        city: null, state: null, from: integerOrNull(cell(row, 'year_min')?.text), to: integerOrNull(cell(row, 'year_max')?.text),
      }];
    }),
  };
}

function schoolHistory(html, sitePath) {
  const slug = /^\/cbb\/schools\/([^/]+)\/men\/$/.exec(sitePath)[1];
  return {
    seasons: dataRows(tableBody(html, slug)).flatMap((row) => {
      const season = cell(row, 'season');
      const years = /^(\d{4})-\d{2}/.exec(season?.text ?? '');
      if (!years) return [];
      return [{ endingYear: Number(years[1]) + 1, url: season.href ? new URL(season.href, ORIGIN).href : null }];
    }),
  };
}

function season(html, sitePath) {
  const links = [...html.matchAll(/<a href="([^"]*-gamelogs\.html)"[^>]*>Game Log<\/a>/g)].map((match) => match[1]);
  const title = decode(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? '').replace(/\s+/g, ' ');
  return {
    school: title || sitePath,
    endingYear: Number(/(\d{4})\.html$/.exec(sitePath)[1]),
    gameLogUrl: links.length ? new URL(links[0], ORIGIN).href : null,
    summary: {
      wins: NOT_PARSED, losses: NOT_PARSED, confWins: NOT_PARSED, confLosses: NOT_PARSED,
      srs: NOT_PARSED, sos: NOT_PARSED, offRtg: NOT_PARSED, defRtg: NOT_PARSED,
      conference: null, coach: null, ncaaTournament: null,
    },
    roster: [],
    teamTotals: null,
    players: [],
  };
}

const LOCATIONS = Object.freeze({ '': 'home', '@': 'away', N: 'neutral' });

function score(text) { return /^\d+$/.test(text) ? present(Number(text)) : unavailable('not_played'); }

function gameLog(html, sitePath) {
  return {
    endingYear: Number(/(\d{4})-gamelogs\.html$/.exec(sitePath)[1]),
    games: dataRows(tableBody(html, 'team_game_log')).flatMap((row) => {
      const date = cell(row, 'date');
      if (!date?.text) return [];
      const opponent = cell(row, 'opp_name_abbr');
      const result = cell(row, 'team_game_result')?.text;
      const final = result === 'W' || result === 'L';
      const overtimes = cell(row, 'overtimes')?.text ?? '';
      return [{
        gameNumber: integerOrNull(cell(row, 'team_game_num_season')?.text),
        date: date.text,
        location: LOCATIONS[cell(row, 'game_location')?.text ?? ''] ?? null,
        opponent: { name: opponent?.text || null, schoolPath: schoolPathOf(opponent?.href) },
        gameType: cell(row, 'game_type')?.text || null,
        result: final ? result : null,
        status: final ? 'final' : 'incomplete',
        overtimes: final ? (overtimes ? Number(/^(\d*)OT$/.exec(overtimes)?.[1] || 1) : 0) : null,
        teamScore: score(cell(row, 'team_game_score')?.text ?? ''),
        opponentScore: score(cell(row, 'opp_team_game_score')?.text ?? ''),
        teamStats: null,
        opponentStats: null,
        boxScoreUrl: date.href ? new URL(date.href, ORIGIN).href : null,
      }];
    }),
  };
}

function boxScore(html) {
  const team = (side, index) => {
    const start = html.indexOf(`id="sb_team_${index}"`);
    const block = html.slice(start, html.indexOf('class="scores"', start) + 200);
    const link = /<strong>\s*<a(?:\s+href="([^"]*)")?[^>]*>([\s\S]*?)<\/a>/.exec(block);
    return {
      side, name: decode(link[2]), schoolPath: schoolPathOf(link[1]),
      finalScore: score(/<div class="score">(\d+)<\/div>/.exec(block)?.[1] ?? ''),
      lineScore: [], stats: null, advanced: {}, players: [],
    };
  };
  const teams = [team('away', 0), team('home', 1)];
  return {
    date: null,
    status: teams.every((entry) => entry.finalScore.state === 'present') ? 'final' : 'incomplete',
    gameType: null, description: null, venue: null, attendance: NOT_PARSED, overtimes: null, teams,
  };
}

const READERS = Object.freeze({ school_index: schoolIndex, school_history: schoolHistory, season, game_log: gameLog, box_score: boxScore });

export function captureLinkDocument(pageType, sitePath) {
  return assertParsedDocument(pageType, READERS[pageType](readCapture(sitePath).toString('utf8'), sitePath));
}
