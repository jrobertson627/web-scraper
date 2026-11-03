// Which season a crawl is about (#115). Sports Reference names a season by the
// year it ends in: a school's `To` of 2026 means it played in 2025-26. Eligible
// schools are those whose To is the current season's ending year, and the target
// seasons are the last TARGET_SEASON_COUNT ending years up to it.
//
// The current season is a matter of the calendar, not of the site's data, and it
// is decided once per crawl, when the school index is fetched (see
// resolveSeasonEndingYear), so a crawl that runs across the rollover date keeps
// the answer it started with. See "Decision: the current season" in
// REQUEST_POLICY.md.

// A new season counts from this month (UTC, 1-12): 11 is November, when games
// start. From then on the season ends in the following calendar year.
export const SEASON_ROLLOVER_MONTH = 11;
export const TARGET_SEASON_COUNT = 5;

// What every store crawled before the season was resolved (the fixed scope of
// #25-#108) was crawled under.
export const LEGACY_SEASON_ENDING_YEAR = 2026;

// The rules as the authorization record's scope states them. They name the
// season symbolically, so the record stays valid as the season rolls forward.
export const ELIGIBILITY_RULE = 'To == CurrentSeasonEndingYear';
// The target window ends at the target final season, which is the current season
// unless an operator sets it earlier (#165): the schools active now, over the
// seasons before this one.
export const TARGET_YEARS_RULE = `TargetFinalEndingYear-${TARGET_SEASON_COUNT - 1}..TargetFinalEndingYear`;

export function assertSeasonEndingYear(year) {
  if (!Number.isSafeInteger(year) || year < 1900 || year > 2200) {
    throw new Error(`season ending year ${year} is invalid. Expected a four-digit year. Example: 2026`);
  }
  return year;
}

// The ending year of the season in progress, or about to start, at `date`.
export function seasonEndingYearAt(date, rolloverMonth = SEASON_ROLLOVER_MONTH) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('season ending year needs a valid date');
  return date.getUTCFullYear() + (date.getUTCMonth() + 1 >= rolloverMonth ? 1 : 0);
}

// The target ending years for a season, oldest first.
export function targetEndingYearsFor(seasonEndingYear) {
  assertSeasonEndingYear(seasonEndingYear);
  return Object.freeze(Array.from({ length: TARGET_SEASON_COUNT }, (_, index) => seasonEndingYear - (TARGET_SEASON_COUNT - 1) + index));
}

// The last season of the target window (#165): the configured year, else the
// season itself. It may not be later than the season, since the window would then
// reach seasons the eligible schools have not played.
export function resolveTargetFinalEndingYear({ explicit, seasonEndingYear }) {
  assertSeasonEndingYear(seasonEndingYear);
  if (explicit === undefined || explicit === null) return seasonEndingYear;
  assertSeasonEndingYear(explicit);
  if (explicit > seasonEndingYear) {
    throw new Error(`the target final season ${explicit} is later than the season ${seasonEndingYear}. Expected a year no later than the season, or leave TARGET_FINAL_ENDING_YEAR unset`);
  }
  return explicit;
}

// The season a crawl runs under. An explicit year (CURRENT_SEASON_ENDING_YEAR)
// wins: it is the operator saying what the site's index is. Otherwise it is the
// season at the time the school index was fetched, so a restart after the
// rollover date still reads that index the way it was read at first; before the
// index has been fetched, the season now.
//
// refreshPending says an operator has asked for the index to be fetched again
// (#154). The stored fetch is then the old season's, and the fetch that will
// replace it happens now, so the season is the one now, not the stored one.
// Returns { seasonEndingYear, source }.
export function resolveSeasonEndingYear({ explicit, indexFetchedAt, now, refreshPending = false }) {
  if (explicit !== undefined && explicit !== null) return { seasonEndingYear: assertSeasonEndingYear(explicit), source: 'configured' };
  if (refreshPending) return { seasonEndingYear: seasonEndingYearAt(now), source: 'refresh_pending' };
  if (indexFetchedAt) return { seasonEndingYear: seasonEndingYearAt(new Date(indexFetchedAt)), source: 'index_fetch' };
  return { seasonEndingYear: seasonEndingYearAt(now), source: 'clock' };
}
