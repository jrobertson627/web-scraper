import { assertBoundaryPort } from '../contracts/boundaries.mjs';
import { CORE_STAT_FIELDS } from '../contracts/parsed-documents.mjs';
import { canonicalizeSourceUrl, createSourceUrl, serializeCanonicalPath } from '../contracts/source.mjs';
import { LEGACY_SEASON_ENDING_YEAR } from '../contracts/season.mjs';

const MINUTES_TOLERANCE = 1;
const SOURCE_VALUE_STATES = Object.freeze(['blank', 'unavailable', 'null', 'present']);
const GAME_STATUSES = Object.freeze(['scheduled', 'final', 'canceled', 'rescheduled', 'incomplete']);

function valueOf(sourceValue) { return sourceValue?.state === 'present' ? sourceValue.value : null; }

function sumLines(lines) {
  return Object.fromEntries(CORE_STAT_FIELDS.map((field) => [field,
    lines.reduce((total, line) => total + (valueOf(line?.[field]) ?? 0), 0)]));
}

// Differences between an expected stat line (or plain sums) and an observed one.
// Fields the expected side does not present are not compared.
function statDifferences(expected, observed, prefix) {
  const differences = [];
  for (const field of CORE_STAT_FIELDS) {
    const left = typeof expected[field] === 'number' ? expected[field] : valueOf(expected[field]);
    const right = typeof observed[field] === 'number' ? observed[field] : valueOf(observed[field]);
    if (left === null || right === null) continue;
    const tolerance = field === 'minutes' ? MINUTES_TOLERANCE : 0;
    if (Math.abs(left - right) > tolerance) differences.push({ field: `${prefix}.${field}`, expected: left, observed: right });
  }
  return differences;
}

// Adapters list observations in their own order; the report orders them by key
// (plain code-unit order, not a database collation) so both give one output.
const byKey = (left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);

function batches(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

// A game's record key is its canonical box-score identity; every other page's
// is its job key (see domain/index.mjs).
function recordKeyOf(job) { return job.pageType === 'box_score' ? serializeCanonicalPath(job.canonicalPath) : job.key; }

// A local, read-only report over the persistence reconciliation port
// (BOUNDARY_PORT_METHODS.persistenceReconciliation), so the same checks run
// against the in-memory store and PostgreSQL. It never fetches or repairs
// source data. It loads the job list once, then pages in bounded batches: the
// school index, school histories, and each batch of seasons with their game
// logs and the box scores those logs link to.
//
// requireCoverage makes the value-state and game-status invariants demand that
// every state, status, neutral site and overtime appears, which is right for
// the fixture corpus that exercises them all. Real data need not contain every
// one (Sports Reference never prints an explicit null, and a sample may have
// no canceled game), so without it those two checks report what is missing
// but do not fail.
// minEligibleSchools makes the eligible_school_count check fail an index that
// yields fewer eligible schools than that (#115), whatever its stored decisions say.
export async function buildReconciliationReport(reads, { requireCoverage = false, batchSize = 50, minEligibleSchools = 0 } = {}) {
  assertBoundaryPort('persistenceReconciliation', reads);
  // A sample (#78) is checked against its own years, and the report says so.
  const scope = await reads.crawlScope();
  const scopeYears = scope.endingYears;
  const jobs = await reads.reconciliationJobs();
  const jobByKey = new Map(jobs.map((job) => [job.key, job]));
  const children = new Map();
  for (const job of jobs) if (job.parentKey) children.set(job.parentKey, [...(children.get(job.parentKey) ?? []), job]);
  const childrenOf = (key, pageType) => (children.get(key) ?? []).filter((job) => job.pageType === pageType);
  const boxJobs = jobs.filter((job) => job.pageType === 'box_score');
  const boxByPath = new Map(boxJobs.map((job) => [serializeCanonicalPath(job.canonicalPath), job]));
  const parsedJobs = (pageType) => jobs.filter((job) => job.pageType === pageType && job.state === 'parsed');
  const pagesFor = async (keys) => new Map((keys.length ? await reads.acceptedPages(keys) : []).map((page) => [page.recordKey, page]));
  const checks = [];
  const add = (id, records, extra = {}) => checks.push(Object.freeze({ id, passed: records.length === 0, records: Object.freeze(records), ...extra }));

  // Links resolve against the page that carried them, then compare by canonical identity.
  const identityOf = (target, job) => {
    if (!target || !job) return null;
    try {
      return serializeCanonicalPath(canonicalizeSourceUrl(createSourceUrl(job.sourceUrl.providerId, target, job.sourceUrl.absoluteUrl)));
    } catch { return null; }
  };
  const sidesFor = (game, schoolSourcePath) => {
    const gameJob = jobByKey.get(game.jobKey);
    const own = game.data.teams.find((team) => identityOf(team.schoolPath, gameJob) === schoolSourcePath);
    return own ? { own, other: game.data.teams.find((team) => team !== own) } : null;
  };

  // School index: the stored eligibility decision agrees with the rule, To equal to
  // the season the decision was made under (recorded on each observation, #115;
  // an observation from before that is 2026).
  const indexJobs = parsedJobs('school_index');
  const indexPages = await pagesFor(indexJobs.map((job) => job.key));
  const schoolObservations = new Map((indexJobs.length ? await reads.acceptedObservations(indexJobs.map((job) => job.key)) : [])
    .map((entry) => [entry.key, entry.observation]));
  const eligibleRecords = [];
  for (const page of indexPages.values()) {
    let eligibleCount = 0;
    for (const [rowIndex, school] of (page.data.schools ?? []).entries()) {
      const observation = schoolObservations.get(`school:${page.jobKey}:${rowIndex}`);
      const expected = school.to === (observation?.seasonEndingYear ?? LEGACY_SEASON_ENDING_YEAR);
      if (expected) eligibleCount += 1;
      if (observation?.eligible !== expected) eligibleRecords.push({ key: `${page.jobKey}:${rowIndex}`, expected, observed: observation?.eligible ?? null });
    }
    if (eligibleCount < minEligibleSchools) eligibleRecords.push({ key: page.jobKey, eligibleSchools: eligibleCount, minimum: minEligibleSchools });
  }
  add('eligible_school_count', eligibleRecords);

  // School histories: linked target seasons are discovered and parsed, and the
  // missing ones are recorded as unavailable coverage.
  const unavailable = new Set((await reads.coverageGaps()).map((gap) => `${gap.schoolSourcePath}:${gap.endingYear}`));
  const seasonRecords = [];
  const coverageRecords = [];
  for (const batch of batches(parsedJobs('school_history'), batchSize)) {
    for (const page of (await pagesFor(batch.map((job) => job.key))).values()) {
      const linked = (page.data.seasons ?? []).filter((season) => season.url && scopeYears.includes(season.endingYear));
      const seasons = childrenOf(page.jobKey, 'season');
      const parsed = seasons.filter((child) => child.state === 'parsed');
      if (linked.length !== seasons.length || seasons.length !== parsed.length) {
        seasonRecords.push({ key: page.jobKey, linkedRows: linked.length, discovered: seasons.length, parsed: parsed.length });
      }
      const schoolSourcePath = jobByKey.get(page.jobKey)?.schoolSourcePath;
      for (const year of scopeYears) {
        const expectedMissing = !linked.some((season) => season.endingYear === year);
        const recordedMissing = unavailable.has(`${schoolSourcePath}:${year}`);
        if (expectedMissing !== recordedMissing) coverageRecords.push({ key: page.jobKey, endingYear: year, expectedMissing, recordedMissing });
      }
    }
  }

  // Seasons in batches, each with its game log and the box scores it links to.
  const scopeRecords = [];
  const linkedRecords = [];
  const resultRecords = [];
  const logBoxRecords = [];
  const recordRecords = [];
  const logTotalRecords = [];
  const boxTotalRecords = [];
  const playerRecords = [];
  const parentsByBoxPath = new Map();
  const gamesSeen = new Set();
  const contextsByGame = new Map();
  const coverage = { states: new Set(), zero: false, statuses: new Set(), overtime: false };
  const observeGame = (game) => {
    if (gamesSeen.has(game.recordKey)) return;
    gamesSeen.add(game.recordKey);
    coverage.statuses.add(game.data.status);
    if (game.data.overtimes > 0) coverage.overtime = true;
    for (const value of [game.data.attendance, ...game.data.teams.flatMap((team) => [
      team.finalScore,
      ...CORE_STAT_FIELDS.map((field) => team.stats?.[field]),
      ...team.players.flatMap((player) => CORE_STAT_FIELDS.map((field) => player.stats[field])),
    ])].filter(Boolean)) {
      coverage.states.add(value.state);
      if (value.state === 'present' && value.value === 0) coverage.zero = true;
    }
    if (game.data.context) contextsByGame.set(game.recordKey, [...(contextsByGame.get(game.recordKey) ?? []), game.data.context]);
  };

  for (const batch of batches(parsedJobs('season'), batchSize)) {
    const seasonPages = await pagesFor(batch.map((job) => job.key));
    const logJobs = batch.flatMap((season) => childrenOf(season.key, 'game_log').filter((job) => job.state === 'parsed'));
    const logPages = await pagesFor(logJobs.map((job) => job.key));
    const logObservations = logJobs.length ? (await reads.acceptedObservations(logJobs.map((job) => job.key)))
      .filter((entry) => entry.observation.kind === 'game_log').sort(byKey) : [];
    const gameKeys = new Set();
    for (const page of logPages.values()) {
      const logJob = jobByKey.get(page.jobKey);
      for (const row of page.data.games ?? []) {
        const path = identityOf(row.boxScoreUrl, logJob);
        const box = path && boxByPath.get(path);
        if (box) gameKeys.add(recordKeyOf(box));
      }
    }
    for (const { observation } of logObservations) {
      const box = observation.canonicalBoxScorePath && boxByPath.get(observation.canonicalBoxScorePath);
      if (box) gameKeys.add(recordKeyOf(box));
    }
    const games = await pagesFor([...gameKeys]);
    for (const game of games.values()) observeGame(game);
    const boxGameFor = (row, logJob) => {
      const path = identityOf(row.boxScoreUrl, logJob);
      const box = path && boxByPath.get(path);
      return box ? games.get(recordKeyOf(box)) ?? null : null;
    };

    for (const { key, observation } of logObservations) {
      if (!observation.canonicalBoxScorePath) continue;
      const box = boxByPath.get(observation.canonicalBoxScorePath);
      const game = box && games.get(recordKeyOf(box));
      if (!box || !game) linkedRecords.push({ key, boxScorePath: observation.canonicalBoxScorePath, jobKey: box?.key ?? null, state: box?.state ?? 'missing' });
      const parents = parentsByBoxPath.get(observation.canonicalBoxScorePath) ?? new Set();
      parents.add(observation.parentKey);
      parentsByBoxPath.set(observation.canonicalBoxScorePath, parents);
    }

    for (const page of logPages.values()) {
      const logJob = jobByKey.get(page.jobKey);
      for (const [rowIndex, row] of page.data.games.entries()) {
        const key = `${page.jobKey}:${rowIndex}`;
        const teamScore = valueOf(row.teamScore);
        const opponentScore = valueOf(row.opponentScore);
        if (row.status === 'final') {
          const expected = teamScore === null || opponentScore === null || teamScore === opponentScore ? null
            : teamScore > opponentScore ? 'W' : 'L';
          if (!expected || row.result !== expected) resultRecords.push({ key, expectedResult: expected, result: row.result, teamScore, opponentScore });
        }
        const game = row.boxScoreUrl ? boxGameFor(row, logJob) : null;
        if (!game) continue;
        if (row.location) contextsByGame.set(game.recordKey, [...(contextsByGame.get(game.recordKey) ?? []), row.location]);
        if (row.status !== game.data.status) logBoxRecords.push({ key, gameKey: game.recordKey, field: 'status', gameLog: row.status, boxScore: game.data.status });
        if (row.status !== 'final') continue;
        const sides = sidesFor(game, logJob?.schoolSourcePath);
        if (!sides) {
          logBoxRecords.push({ key, gameKey: game.recordKey, field: 'team', gameLog: logJob?.schoolSourcePath ?? null, boxScore: null });
          continue;
        }
        for (const [field, logged, boxed] of [['teamScore', teamScore, valueOf(sides.own.finalScore)], ['opponentScore', opponentScore, valueOf(sides.other.finalScore)]]) {
          if (logged !== boxed) logBoxRecords.push({ key, gameKey: game.recordKey, field, gameLog: logged, boxScore: boxed });
        }
        for (const [prefix, logged, boxed] of [['teamStats', row.teamStats, sides.own.stats], ['opponentStats', row.opponentStats, sides.other.stats]]) {
          if (!logged || !boxed) continue;
          for (const difference of statDifferences(logged, boxed, prefix)) {
            logBoxRecords.push({ key, gameKey: game.recordKey, field: difference.field, gameLog: difference.expected, boxScore: difference.observed });
          }
        }
      }
    }

    for (const season of seasonPages.values()) {
      if (!scopeYears.includes(season.data.endingYear)) scopeRecords.push({ key: season.jobKey, endingYear: season.data.endingYear });
      const logJob = childrenOf(season.jobKey, 'game_log').find((job) => job.state === 'parsed');
      const log = logJob ? logPages.get(logJob.key) : null;
      if (!log) continue;
      const finals = log.data.games.filter((row) => row.status === 'final');
      const { summary, teamTotals } = season.data;
      for (const [field, result] of [['wins', 'W'], ['losses', 'L']]) {
        const expected = valueOf(summary[field]);
        const observed = log.data.games.filter((row) => row.result === result).length;
        if (expected !== null && expected !== observed) recordRecords.push({ key: season.jobKey, field, season: expected, gameLog: observed });
      }
      if (!teamTotals) continue;
      for (const side of ['team', 'opponent']) {
        const lines = finals.map((row) => row[side === 'team' ? 'teamStats' : 'opponentStats']).filter(Boolean);
        const count = valueOf(teamTotals[side].games);
        if (count !== null && count !== lines.length) logTotalRecords.push({ key: season.jobKey, field: `${side}.games`, season: count, gameLog: lines.length });
        for (const difference of statDifferences(teamTotals[side].stats, sumLines(lines), side)) {
          logTotalRecords.push({ key: season.jobKey, field: difference.field, season: difference.expected, gameLog: difference.observed });
        }
      }
      // Box-score totals are only comparable once every final game's box score is parsed.
      const boxGames = finals.map((row) => (row.boxScoreUrl ? boxGameFor(row, logJob) : null));
      if (boxGames.some((game) => !game)) continue;
      const sides = boxGames.map((game) => sidesFor(game, logJob.schoolSourcePath));
      if (sides.some((side) => !side)) continue;
      for (const [side, pick] of [['team', (entry) => entry.own], ['opponent', (entry) => entry.other]]) {
        for (const difference of statDifferences(teamTotals[side].stats, sumLines(sides.map((entry) => pick(entry).stats)), side)) {
          boxTotalRecords.push({ key: season.jobKey, field: difference.field, season: difference.expected, boxScores: difference.observed });
        }
      }
      const seasonJob = jobByKey.get(season.jobKey);
      for (const player of season.data.players.filter((entry) => entry.playerPath)) {
        const identity = identityOf(player.playerPath, seasonJob);
        const lines = sides.flatMap((entry, index) => entry.own.players
          .filter((line) => identityOf(line.playerPath, jobByKey.get(boxGames[index].jobKey)) === identity)
          .map((line) => line.stats));
        for (const difference of statDifferences(player.stats, sumLines(lines), player.playerPath)) {
          playerRecords.push({ key: season.jobKey, field: difference.field, season: difference.expected, boxScores: difference.observed });
        }
      }
    }
  }

  // Games no parsed game log reached still count toward coverage.
  for (const batch of batches(parsedJobs('box_score').map(recordKeyOf).filter((key) => !gamesSeen.has(key)), batchSize)) {
    for (const game of (await pagesFor(batch)).values()) observeGame(game);
  }

  add('season_scope', scopeRecords);
  add('linked_season_count', seasonRecords);
  add('partial_coverage', coverageRecords);
  add('linked_game_resolution', linkedRecords);
  const boxPathCounts = new Map();
  for (const job of boxJobs) {
    const path = serializeCanonicalPath(job.canonicalPath);
    boxPathCounts.set(path, (boxPathCounts.get(path) ?? 0) + 1);
  }
  add('box_score_url_uniqueness', [...boxPathCounts].filter(([, count]) => count !== 1).map(([path, count]) => ({ path, jobCount: count })));
  add('two_sided_merge', [...parentsByBoxPath].filter(([, parents]) => parents.size > 1)
    .filter(([path]) => { const box = boxByPath.get(path); return !box || !gamesSeen.has(recordKeyOf(box)); })
    .map(([path, parents]) => ({ path, parentKeys: [...parents] })));
  add('game_log_result_matches_scores', resultRecords);
  add('box_score_game_log_totals', logBoxRecords);
  add('season_record_matches_game_logs', recordRecords);
  add('season_totals_match_game_logs', logTotalRecords);
  add('season_totals_match_box_scores', boxTotalRecords);
  add('player_season_totals_match_box_scores', playerRecords);

  const missingValues = SOURCE_VALUE_STATES.filter((state) => !coverage.states.has(state)).map((state) => ({ missingState: state }))
    .concat(coverage.zero ? [] : [{ missingValue: 0 }]);
  const contexts = new Set([...gamesSeen].map((key) => {
    const seen = contextsByGame.get(key) ?? [];
    return seen.includes('neutral') ? 'neutral' : seen[0];
  }));
  const missingStatuses = GAME_STATUSES.filter((status) => !coverage.statuses.has(status)).map((status) => ({ missingStatus: status }));
  if (!contexts.has('neutral')) missingStatuses.push({ missingContext: 'neutral' });
  if (!coverage.overtime) missingStatuses.push({ missingFeature: 'overtime' });
  for (const [id, missing] of [['distinct_source_values', missingValues], ['game_statuses_and_context', missingStatuses]]) {
    if (requireCoverage) add(id, missing);
    else add(id, [], { informational: true, missing: Object.freeze(missing) });
  }

  // A structural failure that no later parse replaced must be quarantined as
  // parse_failed, never published.
  const failed = await reads.failedParses();
  const failedJobs = failed.map((entry) => jobByKey.get(entry.jobKey)).filter(Boolean);
  const failedPages = await pagesFor(failedJobs.map(recordKeyOf));
  add('layout_shift_quarantine', failedJobs.filter((job) => job.state !== 'parse_failed' || failedPages.has(recordKeyOf(job)))
    .map((job) => ({ key: job.key, reason: 'structural failure was not quarantined' })));

  const quarantined = [
    ...jobs.filter((job) => job.state === 'parse_failed').map((job) => ({ key: job.key, reason: job.reason ?? 'parse_failed' })),
    ...[...(await reads.rejectedUrls())].sort(byKey).map((entry) => ({ key: entry.key, reason: entry.reason })),
    ...(await reads.openIssues()).map((issue) => ({ key: issue.recordKey, reason: issue.issueType })),
  ];
  return Object.freeze({ passed: checks.every((check) => check.passed) && quarantined.length === 0, scope,
    checks: Object.freeze(checks), quarantined: Object.freeze(quarantined) });
}
