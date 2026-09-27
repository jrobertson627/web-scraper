import { CORE_STAT_FIELDS } from '../contracts/parsed-documents.mjs';
import {
  TARGET_ENDING_YEARS, canonicalizeSourceUrl, createSourceUrl, serializeCanonicalPath,
} from '../contracts/source.mjs';

const MINUTES_TOLERANCE = 1;

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

// A local, read-only report. It never fetches or repairs source data.
export function buildFixtureReconciliationReport(persistence) {
  const jobs = persistence.listJobs();
  const jobByKey = new Map(jobs.map((job) => [job.key, job]));
  const pages = [...persistence.pages.values()];
  const pageByJob = new Map(pages.map((page) => [page.jobKey, page]));
  const observations = [...persistence.observations.entries()];
  const games = pages.filter((page) => page.kind === 'game');
  const gameByJob = new Map(games.map((game) => [game.jobKey, game]));
  const boxJobs = jobs.filter((job) => job.pageType === 'box_score');
  const boxByPath = new Map(boxJobs.map((job) => [serializeCanonicalPath(job.canonicalPath), job]));
  const checks = [];
  const add = (id, records) => checks.push(Object.freeze({ id, passed: records.length === 0, records: Object.freeze(records) }));

  // Links resolve against the page that carried them, then compare by canonical identity.
  const identityOf = (target, job) => {
    if (!target || !job) return null;
    try {
      return serializeCanonicalPath(canonicalizeSourceUrl(createSourceUrl(job.sourceUrl.providerId, target, job.sourceUrl.absoluteUrl)));
    } catch { return null; }
  };
  const boxGameFor = (row, logJob) => {
    const path = identityOf(row.boxScoreUrl, logJob);
    const box = path && boxByPath.get(path);
    return box ? gameByJob.get(box.key) ?? null : null;
  };
  const sidesFor = (game, schoolSourcePath) => {
    const gameJob = jobByKey.get(game.jobKey);
    const own = game.data.teams.find((team) => identityOf(team.schoolPath, gameJob) === schoolSourcePath);
    return own ? { own, other: game.data.teams.find((team) => team !== own) } : null;
  };
  const gameLogFor = (seasonPage) => {
    const child = (seasonPage.childJobs ?? []).find((job) => job.pageType === 'game_log');
    return child && jobByKey.get(child.key)?.state === 'parsed' ? pageByJob.get(child.key) ?? null : null;
  };

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
    const parsed = children.filter((child) => jobByKey.get(child.key)?.state === 'parsed');
    if (linked.length !== children.length || children.length !== parsed.length) {
      seasonRecords.push({ key: page.jobKey, linkedRows: linked.length, discovered: children.length, parsed: parsed.length });
    }
    for (const year of TARGET_ENDING_YEARS) {
      const expectedMissing = !linked.some((season) => season.endingYear === year);
      const schoolSourcePath = jobByKey.get(page.jobKey)?.schoolSourcePath;
      const recordedMissing = persistence.unavailableCoverage.has(`${schoolSourcePath}:${year}`);
      if (expectedMissing !== recordedMissing) coverageRecords.push({ key: page.jobKey, endingYear: year, expectedMissing, recordedMissing });
    }
  }
  add('linked_season_count', seasonRecords);
  add('partial_coverage', coverageRecords);

  const linkedRecords = [];
  const duplicateSides = new Map();
  for (const [key, observation] of observations.filter(([, value]) => value.kind === 'game_log' && value.canonicalBoxScorePath)) {
    const box = boxByPath.get(observation.canonicalBoxScorePath);
    const game = box && gameByJob.get(box.key);
    if (!box || !game) linkedRecords.push({ key, boxScorePath: observation.canonicalBoxScorePath, jobKey: box?.key ?? null, state: box?.state ?? 'missing' });
    const parents = duplicateSides.get(observation.canonicalBoxScorePath) ?? new Set();
    parents.add(observation.parentKey);
    duplicateSides.set(observation.canonicalBoxScorePath, parents);
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

  const resultRecords = [];
  const logBoxRecords = [];
  const contextsByGame = new Map();
  const logPages = pages.filter((page) => page.kind === 'game_log');
  for (const page of logPages) {
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
      if (row.location) contextsByGame.set(game.identity, [...(contextsByGame.get(game.identity) ?? []), row.location]);
      if (row.status !== game.data.status) logBoxRecords.push({ key, gameKey: game.identity, field: 'status', gameLog: row.status, boxScore: game.data.status });
      if (row.status !== 'final') continue;
      const sides = sidesFor(game, logJob?.schoolSourcePath);
      if (!sides) {
        logBoxRecords.push({ key, gameKey: game.identity, field: 'team', gameLog: logJob?.schoolSourcePath ?? null, boxScore: null });
        continue;
      }
      for (const [field, logged, boxed] of [['teamScore', teamScore, valueOf(sides.own.finalScore)], ['opponentScore', opponentScore, valueOf(sides.other.finalScore)]]) {
        if (logged !== boxed) logBoxRecords.push({ key, gameKey: game.identity, field, gameLog: logged, boxScore: boxed });
      }
      for (const [prefix, logged, boxed] of [['teamStats', row.teamStats, sides.own.stats], ['opponentStats', row.opponentStats, sides.other.stats]]) {
        if (!logged || !boxed) continue;
        for (const difference of statDifferences(logged, boxed, prefix)) {
          logBoxRecords.push({ key, gameKey: game.identity, field: difference.field, gameLog: difference.expected, boxScore: difference.observed });
        }
      }
    }
  }
  add('game_log_result_matches_scores', resultRecords);
  add('box_score_game_log_totals', logBoxRecords);

  const recordRecords = [];
  const logTotalRecords = [];
  const boxTotalRecords = [];
  const playerRecords = [];
  for (const season of pages.filter((page) => page.kind === 'season')) {
    const log = gameLogFor(season);
    if (!log) continue;
    const logJob = jobByKey.get(log.jobKey);
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
      const games = valueOf(teamTotals[side].games);
      if (games !== null && games !== lines.length) logTotalRecords.push({ key: season.jobKey, field: `${side}.games`, season: games, gameLog: lines.length });
      for (const difference of statDifferences(teamTotals[side].stats, sumLines(lines), side)) {
        logTotalRecords.push({ key: season.jobKey, field: difference.field, season: difference.expected, gameLog: difference.observed });
      }
    }
    // Box-score totals are only comparable once every final game's box score is parsed.
    const boxGames = finals.map((row) => (row.boxScoreUrl ? boxGameFor(row, logJob) : null));
    if (boxGames.some((game) => !game)) continue;
    const sides = boxGames.map((game) => sidesFor(game, logJob?.schoolSourcePath));
    if (sides.some((side) => !side)) continue;
    for (const [side, pick] of [['team', (entry) => entry.own], ['opponent', (entry) => entry.other]]) {
      for (const difference of statDifferences(teamTotals[side].stats, sumLines(sides.map((entry) => pick(entry).stats)), side)) {
        boxTotalRecords.push({ key: season.jobKey, field: difference.field, season: difference.expected, boxScores: difference.observed });
      }
    }
    for (const player of season.data.players.filter((entry) => entry.playerPath)) {
      const identity = identityOf(player.playerPath, jobByKey.get(season.jobKey));
      const lines = sides.flatMap((entry, index) => entry.own.players
        .filter((line) => identityOf(line.playerPath, jobByKey.get(boxGames[index].jobKey)) === identity)
        .map((line) => line.stats));
      for (const difference of statDifferences(player.stats, sumLines(lines), player.playerPath)) {
        playerRecords.push({ key: season.jobKey, field: difference.field, season: difference.expected, boxScores: difference.observed });
      }
    }
  }
  add('season_record_matches_game_logs', recordRecords);
  add('season_totals_match_game_logs', logTotalRecords);
  add('season_totals_match_box_scores', boxTotalRecords);
  add('player_season_totals_match_box_scores', playerRecords);

  const sourceValues = games.flatMap((game) => [
    game.data.attendance,
    ...game.data.teams.flatMap((team) => [
      team.finalScore,
      ...CORE_STAT_FIELDS.map((field) => team.stats?.[field]),
      ...team.players.flatMap((player) => CORE_STAT_FIELDS.map((field) => player.stats[field])),
    ]),
  ]).filter(Boolean);
  const states = new Set(sourceValues.map((value) => value.state));
  const zeroPreserved = sourceValues.some((value) => value.state === 'present' && value.value === 0);
  add('distinct_source_values', ['blank', 'unavailable', 'null', 'present'].filter((state) => !states.has(state)).map((state) => ({ missingState: state }))
    .concat(zeroPreserved ? [] : [{ missingValue: 0 }]));

  const statuses = new Set(games.map((game) => game.data.status));
  const contexts = new Set(games.map((game) => game.data.context
    ?? (contextsByGame.get(game.identity)?.includes('neutral') ? 'neutral' : contextsByGame.get(game.identity)?.[0])));
  const statusRecords = ['scheduled', 'final', 'canceled', 'rescheduled', 'incomplete'].filter((status) => !statuses.has(status)).map((status) => ({ missingStatus: status }));
  if (!contexts.has('neutral')) statusRecords.push({ missingContext: 'neutral' });
  if (!games.some((game) => game.data.overtimes > 0)) statusRecords.push({ missingFeature: 'overtime' });
  add('game_statuses_and_context', statusRecords);

  add('layout_shift_quarantine', persistence.parseRuns.filter((run) => run.status === 'structural_failure')
    .filter((run) => jobByKey.get(run.jobKey)?.state !== 'parse_failed' || pages.some((page) => page.jobKey === run.jobKey))
    .map((run) => ({ key: run.jobKey, reason: 'structural failure was not quarantined' })));

  const quarantined = [
    ...jobs.filter((job) => job.state === 'parse_failed').map((job) => ({ key: job.key, reason: job.failureReason ?? 'parse_failed' })),
    ...observations.filter(([, value]) => value.kind === 'rejected_url').map(([key, value]) => ({ key, reason: value.reason })),
    ...persistence.reconciliationIssues.map((issue) => ({ key: issue.recordKey, reason: issue.issueType })),
  ];
  return Object.freeze({ passed: checks.every((check) => check.passed) && quarantined.length === 0, checks: Object.freeze(checks), quarantined: Object.freeze(quarantined) });
}
