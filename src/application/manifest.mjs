import { assertBoundaryPort } from '../contracts/boundaries.mjs';

// The manifest dry-run report (#44; SCRAPING_PLAN.md "Manifest dry run"). A run
// with CRAWL_STAGE=manifest fetches the school index and history pages only;
// this report reads what they discovered: eligible schools, linked target
// seasons, unavailable seasons per school, unique URLs, and the projected
// requests, runtime and raw storage of the rest of the crawl. It makes no
// request. Once game logs are parsed, their box-score links replace the
// estimate.

// Estimates from the #38 captures (see #44): about 30,000 unique box scores
// for about 1,800 target seasons, since most games are shared by two in-scope
// teams, and the captured page sizes.
export const MANIFEST_ESTIMATES = Object.freeze({
  boxScoresPerSeason: 16.5,
  bytesPerPage: Object.freeze({ school_index: 1_150_000, school_history: 300_000, season: 520_000, game_log: 250_000, box_score: 215_000 }),
});

const SETTLED = new Set(['parsed', 'parse_failed', 'permanently_failed']);

export async function buildManifestReport(reads, { minIntervalMs = 6000, estimates = MANIFEST_ESTIMATES } = {}) {
  assertBoundaryPort('persistenceReconciliation', reads);
  const scope = await reads.crawlScope();
  const jobs = await reads.reconciliationJobs();
  const ofType = (pageType) => jobs.filter((job) => job.pageType === pageType);
  const count = (list, predicate = () => true) => list.filter(predicate).length;

  const indexJobs = ofType('school_index');
  const parsedIndex = indexJobs.filter((job) => job.state === 'parsed');
  const schoolRows = parsedIndex.length
    ? (await reads.acceptedObservations(parsedIndex.map((job) => job.key))).filter((entry) => entry.observation.kind === 'school') : [];
  const histories = ofType('school_history');
  const seasons = ofType('season');
  const gameLogs = ofType('game_log');
  const boxScores = ofType('box_score');

  const gaps = new Map();
  for (const gap of await reads.coverageGaps()) gaps.set(gap.schoolSourcePath, [...(gaps.get(gap.schoolSourcePath) ?? []), gap.endingYear]);
  const unavailable = [...gaps].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([schoolSourcePath, endingYears]) => ({ schoolSourcePath, endingYears: endingYears.sort((a, b) => a - b) }));

  // One game log per season; box scores are the discovered links once every
  // game log is parsed, else the per-season estimate.
  const projectedGameLogs = Math.max(gameLogs.length, seasons.length);
  const allLogsParsed = seasons.length > 0 && gameLogs.length === seasons.length && gameLogs.every((job) => SETTLED.has(job.state));
  const projectedBoxScores = allLogsParsed ? boxScores.length : Math.max(boxScores.length, Math.round(seasons.length * estimates.boxScoresPerSeason));
  const projected = { school_index: Math.max(indexJobs.length, 1), school_history: histories.length, season: seasons.length,
    game_log: projectedGameLogs, box_score: projectedBoxScores };
  const projectedTotal = Object.values(projected).reduce((sum, value) => sum + value, 0);
  const fetched = count(jobs, (job) => SETTLED.has(job.state));
  const remainingRequests = Math.max(0, projectedTotal - fetched);

  return Object.freeze({
    scope,
    // The manifest is complete once the index and every history page are settled.
    complete: parsedIndex.length > 0 && histories.every((job) => SETTLED.has(job.state)),
    schools: {
      indexRows: schoolRows.length,
      eligible: count(schoolRows, (entry) => entry.observation.eligible),
      histories: { discovered: histories.length, parsed: count(histories, (job) => job.state === 'parsed'),
        failed: count(histories, (job) => ['parse_failed', 'permanently_failed', 'operator_stop'].includes(job.state)) },
    },
    seasons: { linked: seasons.length, unavailable: unavailable.reduce((sum, entry) => sum + entry.endingYears.length, 0), unavailableBySchool: unavailable },
    urls: { discovered: jobs.length, fetched, projected: projectedTotal, projectedByPageType: projected,
      boxScoreBasis: allLogsParsed ? 'discovered' : 'estimate' },
    projection: {
      remainingRequests,
      hoursAtPolicyPace: Math.round((remainingRequests * minIntervalMs / 3_600_000) * 10) / 10,
      rawStorageBytes: Object.entries(projected).reduce((sum, [pageType, pages]) => sum + pages * estimates.bytesPerPage[pageType], 0),
    },
    assumptions: estimates,
  });
}

export function formatManifestReport(report) {
  const gigabytes = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
  const lines = [
    `manifest dry run: ${report.complete ? 'complete' : 'INCOMPLETE (index or history pages still pending or stopped)'}`,
    `scope: ${report.scope.kind === 'sample' ? `SAMPLE (${report.scope.schools.length} schools, ending years ${report.scope.endingYears.join(', ')})` : 'full'}`,
    `schools: ${report.schools.eligible} eligible of ${report.schools.indexRows} index rows; ${report.schools.histories.parsed} of ${report.schools.histories.discovered} history pages parsed, ${report.schools.histories.failed} stopped or failed`,
    `seasons: ${report.seasons.linked} linked target seasons; ${report.seasons.unavailable} unavailable across ${report.seasons.unavailableBySchool.length} schools`,
    `unique URLs: ${report.urls.discovered} discovered, ${report.urls.fetched} fetched; about ${report.urls.projected} in total (box scores: ${report.urls.boxScoreBasis})`,
    `projected: ${report.projection.remainingRequests} more requests, about ${report.projection.hoursAtPolicyPace} hours at the policy pace, ${gigabytes(report.projection.rawStorageBytes)} of raw HTML`,
    'unavailable seasons by school:',
    ...report.seasons.unavailableBySchool.map((entry) => `  ${entry.schoolSourcePath}: ${entry.endingYears.join(', ')}`),
  ];
  if (!report.seasons.unavailableBySchool.length) lines.push('  none');
  return lines.join('\n');
}
