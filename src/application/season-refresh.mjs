import { assertBoundaryPort } from '../contracts/boundaries.mjs';
import { REFRESH_PAGE_TYPES } from '../contracts/jobs.mjs';
import { seasonEndingYearAt, targetEndingYearsFor } from '../contracts/season.mjs';

// Season rollover refresh (#154). The crawl scope follows the season, decided
// when the school index is fetched, so a store that already holds an index stays
// on its season: nothing reads the index or the histories again, and the new
// season is never discovered. This is the operator action that does it. It makes
// no request. It puts the parsed school index and every parsed school history
// back in the queue as one recorded disposition; the next worker run fetches them
// again under the season then, and what a changed page replaces is kept on record
// (contracts/jobs.mjs REFRESH_PAGE_TYPES, persistence requestRefresh).
//
// Without `force` it acts only when the season has moved on from the one the
// stored index was fetched under, and refuses a season earlier than that.
// `dryRun` reports what it would do and changes nothing.
export async function refreshSeason({ persistence, rootKey, pinnedYear, clock, operatorId, reason, dryRun = false, force = false, pageSize = 200 }) {
  assertBoundaryPort('persistenceReview', persistence);
  assertBoundaryPort('persistenceReprocess', persistence);
  const root = await persistence.getJob(rootKey);
  if (!root) throw new Error('the school index is not queued yet, so there is nothing to refresh. The first worker run fetches it under the season at that time');
  if (root.refreshRequestedAt) {
    return Object.freeze({ action: 'refresh-season', status: 'already_requested', requestedAt: root.refreshRequestedAt, indexState: root.state,
      note: 'the school index is already waiting to be fetched again. Start the worker to carry it out' });
  }
  if (root.state !== 'parsed') {
    throw new Error(`the school index is ${root.state}, not parsed, so it cannot be refreshed. Let the worker finish it, or release it with npm run review, first`);
  }
  const fetch = await persistence.lastSuccessfulFetch(rootKey);
  if (!fetch) throw new Error('the school index has no stored fetch to refresh');
  const stored = seasonEndingYearAt(new Date(fetch.fetchedAt));
  const target = pinnedYear ?? seasonEndingYearAt(clock());
  const source = pinnedYear === undefined ? 'clock' : 'configured';
  const base = { action: 'refresh-season', dryRun, storedSeasonEndingYear: stored, seasonEndingYear: target, seasonSource: source };
  if (target < stored && !force) {
    throw new Error(`the store's index was fetched under the season ending ${stored}, and the season now is ${target} (${source === 'configured' ? 'CURRENT_SEASON_ENDING_YEAR' : 'the clock'}). A refresh moves forward; use --force to read the pages again anyway`);
  }
  if (target === stored && !force) {
    return Object.freeze({ ...base, status: 'current', note: `the store is already crawled under the season ending ${stored}. Nothing to refresh; use --force to read the index and histories again anyway` });
  }

  const histories = [];
  for (let cursor; ;) {
    const page = await persistence.listJobsForReprocess({ pageTypes: ['school_history'], states: ['parsed'], limit: pageSize, cursor });
    for (const job of page.items) histories.push(job.key);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const keys = [rootKey, ...histories];

  // A full scope gains the years the window moves onto; a sample's years are its own.
  const scope = typeof persistence.crawlScope === 'function' ? await persistence.crawlScope() : null;
  const addedYears = scope?.kind === 'full' ? targetEndingYearsFor(target).filter((year) => !scope.endingYears.includes(year)) : [];
  const summary = { ...base, jobs: { school_index: 1, school_history: histories.length }, requests: keys.length, addedYears, pageTypes: [...REFRESH_PAGE_TYPES] };
  if (dryRun) return Object.freeze({ ...summary, status: 'dry_run', note: 'nothing was changed' });

  await persistence.requestRefresh({ keys, operatorId, reason, at: clock() });
  return Object.freeze({ ...summary, status: 'queued', note: 'start the worker: it fetches the school index and then each history again, and queues the seasons they now link' });
}
