import { TARGET_ENDING_YEARS, serializeCanonicalPath } from '../contracts/source.mjs';

// A local, read-only report. It never fetches or repairs source data.
export function buildFixtureReconciliationReport(persistence) {
  const jobs = persistence.listJobs();
  const pages = [...persistence.pages.values()];
  const observations = [...persistence.observations.entries()];
  const games = pages.filter((page) => page.kind === 'game');
  const gameByJob = new Map(games.map((game) => [game.jobKey, game]));
  const boxJobs = jobs.filter((job) => job.pageType === 'box_score');
  const boxByPath = new Map(boxJobs.map((job) => [serializeCanonicalPath(job.canonicalPath), job]));
  const checks = [];
  const add = (id, records) => checks.push(Object.freeze({ id, passed: records.length === 0, records: Object.freeze(records) }));

  const indexPages = pages.filter((page) => page.kind === 'school_index');
  const eligibleRecords = [];
  for (const page of indexPages) {
    for (const [rowIndex, school] of (page.data.schools ?? []).entries()) {
      // persistence.observations is already keyed `${kind}:${parentKey}:${rowIndex}`
      // (see InMemoryPersistence#stagePage / #queryModels) -- an O(1) lookup here
      // instead of an O(n) scan of the flattened observations array per row.
      const observation = persistence.observations.get(`school:${page.jobKey}:${rowIndex}`);
      const expected = school.to === 2026;
      if (observation?.eligible !== expected) eligibleRecords.push({ key: `${page.jobKey}:${rowIndex}`, expected, observed: observation?.eligible ?? null });
    }
  }
  add('eligible_school_count', eligibleRecords);

  add('season_scope', pages.filter((page) => page.kind === 'season' && !TARGET_ENDING_YEARS.includes(page.data.endingYear))
    .map((page) => ({ key: page.jobKey, endingYear: page.data.endingYear })));

  const seasonRecords = [];
  const coverageRecords = [];
  for (const page of pages.filter((item) => item.kind === 'school_history')) {
    const linked = (page.data.seasons ?? []).filter((season) => season.url && TARGET_ENDING_YEARS.includes(season.endingYear));
    const children = (page.childJobs ?? []).filter((job) => job.pageType === 'season');
    const parsed = children.filter((child) => jobs.some((job) => job.key === child.key && job.state === 'parsed'));
    if (linked.length !== children.length || children.length !== parsed.length) {
      seasonRecords.push({ key: page.jobKey, linkedRows: linked.length, discovered: children.length, parsed: parsed.length });
    }
    for (const year of TARGET_ENDING_YEARS) {
      const expectedMissing = !linked.some((season) => season.endingYear === year);
      const schoolSourcePath = jobs.find((job) => job.key === page.jobKey)?.schoolSourcePath;
      const recordedMissing = persistence.unavailableCoverage.has(`${schoolSourcePath}:${year}`);
      if (expectedMissing !== recordedMissing) coverageRecords.push({ key: page.jobKey, endingYear: year, expectedMissing, recordedMissing });
    }
  }
  add('linked_season_count', seasonRecords);
  add('partial_coverage', coverageRecords);

  const linkedRecords = [];
  const duplicateSides = new Map();
  const totalRecords = [];
  for (const [key, observation] of observations.filter(([, value]) => value.kind === 'game_log' && value.canonicalBoxScorePath)) {
    const box = boxByPath.get(observation.canonicalBoxScorePath);
    const game = box && gameByJob.get(box.key);
    if (!box || !game) linkedRecords.push({ key, boxScorePath: observation.canonicalBoxScorePath, jobKey: box?.key ?? null, state: box?.state ?? 'missing' });
    const parents = duplicateSides.get(observation.canonicalBoxScorePath) ?? new Set();
    parents.add(observation.parentKey);
    duplicateSides.set(observation.canonicalBoxScorePath, parents);
    if (game) {
      for (const field of ['homeScore', 'awayScore']) {
        if (typeof observation.game?.[field] === 'number' && observation.game[field] !== game.data[field]) {
          totalRecords.push({ key, gameKey: game.identity, field, gameLog: observation.game[field], boxScore: game.data[field] });
        }
      }
    }
  }
  add('linked_game_resolution', linkedRecords);
  const boxPathCounts = new Map();
  for (const job of boxJobs) {
    const path = serializeCanonicalPath(job.canonicalPath);
    boxPathCounts.set(path, (boxPathCounts.get(path) ?? 0) + 1);
  }
  const gameIdentityCounts = new Map();
  for (const game of games) gameIdentityCounts.set(game.identity, (gameIdentityCounts.get(game.identity) ?? 0) + 1);
  add('box_score_url_uniqueness', [
    ...[...boxPathCounts].filter(([, count]) => count !== 1).map(([path, count]) => ({ path, jobCount: count })),
    ...[...gameIdentityCounts].filter(([, count]) => count !== 1).map(([key, count]) => ({ key, gameCount: count })),
  ]);
  add('two_sided_merge', [...duplicateSides].filter(([, parents]) => parents.size > 1)
    .filter(([path]) => !gameByJob.has(boxByPath.get(path)?.key))
    .map(([path, parents]) => ({ path, parentKeys: [...parents] })));

  const winnerRecords = [];
  for (const game of games.filter((item) => item.data.status === 'final')) {
    const { homeScore, awayScore, home, away, winner } = game.data;
    const expectedWinner = typeof homeScore === 'number' && typeof awayScore === 'number' && homeScore !== awayScore
      ? (homeScore > awayScore ? home : away) : null;
    if (!expectedWinner || winner !== expectedWinner) winnerRecords.push({ key: game.identity, expectedWinner, winner: winner ?? null });
  }
  add('winner_matches_final_scores', winnerRecords);
  add('box_score_game_log_totals', totalRecords);

  const states = new Set(games.flatMap((game) => Object.values(game.data.valueStates ?? {}).map((value) => value?.state)));
  const zeroPreserved = games.some((game) => Object.values(game.data.valueStates ?? {}).some((value) => value?.state === 'present' && value.value === 0));
  add('distinct_source_values', ['blank', 'unavailable', 'null', 'present'].filter((state) => !states.has(state)).map((state) => ({ missingState: state }))
    .concat(zeroPreserved ? [] : [{ missingValue: 0 }]));

  const statuses = new Set(games.map((game) => game.data.status));
  const contexts = new Set(games.map((game) => game.data.context));
  const statusRecords = ['scheduled', 'final', 'canceled', 'rescheduled', 'incomplete'].filter((status) => !statuses.has(status)).map((status) => ({ missingStatus: status }));
  if (!contexts.has('neutral')) statusRecords.push({ missingContext: 'neutral' });
  if (!games.some((game) => Number(game.data.overtime) > 0)) statusRecords.push({ missingFeature: 'overtime' });
  add('game_statuses_and_context', statusRecords);

  add('layout_shift_quarantine', persistence.parseRuns.filter((run) => run.status === 'structural_failure')
    .filter((run) => jobs.find((job) => job.key === run.jobKey)?.state !== 'parse_failed' || pages.some((page) => page.jobKey === run.jobKey))
    .map((run) => ({ key: run.jobKey, reason: 'structural failure was not quarantined' })));

  const quarantined = [
    ...jobs.filter((job) => job.state === 'parse_failed').map((job) => ({ key: job.key, reason: job.failureReason ?? 'parse_failed' })),
    ...observations.filter(([, value]) => value.kind === 'rejected_url').map(([key, value]) => ({ key, reason: value.reason })),
    ...persistence.reconciliationIssues.map((issue) => ({ key: issue.recordKey, reason: issue.issueType })),
  ];
  return Object.freeze({ passed: checks.every((check) => check.passed) && quarantined.length === 0, checks: Object.freeze(checks), quarantined: Object.freeze(quarantined) });
}
