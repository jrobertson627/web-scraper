import {
  assertPageType,
  canonicalizeSourceUrl,
  isAllowedSourceUrl,
  EXPECTED_ELIGIBLE_SCHOOLS,
  REQUIRED_ELIGIBILITY_PREDICATE,
  isEligibleSchool,
  serializeCanonicalPath,
  sourceKey,
} from '../contracts/source.mjs';
import { createDiscoveryResult, createJob } from '../contracts/boundaries.mjs';
import { FULL_CRAWL_SCOPE } from '../contracts/crawl-scope.mjs';

// Discovery reads the frozen parsed documents (PARSED_DOCUMENTS.md) and follows
// only links the page published: it never builds a URL from a range, date, or
// display name. With a source adapter, every child link must also classify as
// the expected page type (which refuses robots.txt-disallowed paths), and school
// links are reduced to the school's identity path.
//
// A sample scope (contracts/crawl-scope.mjs, #78) narrows what is queued: the
// index still records every row's eligibility, but queues a history page only
// for the named schools, and a history page queues and records coverage only
// for the sample's years.
export class Discovery {
  // minEligibleSchools: a school index that yields fewer eligible schools fails
  // instead of queueing nothing (#115); 0 disables the check.
  constructor({ providerId, allowedHosts, targetEndingYears, sourceAdapter, scope = FULL_CRAWL_SCOPE, minEligibleSchools = 0 }) {
    this.minEligibleSchools = minEligibleSchools;
    this.providerId = providerId;
    this.allowedHosts = allowedHosts;
    this.targetEndingYears = targetEndingYears;
    this.sourceAdapter = sourceAdapter;
    this.scope = scope;
  }

  discover(pageType, snapshot, document) {
    assertPageType(pageType);
    const page = document ?? JSON.parse(Buffer.from(snapshot.body).toString('utf8'));
    const adapter = this.sourceAdapter;
    const childJobs = [];
    const childKeys = new Set();
    const observations = [];
    const unavailableCoverage = [];
    const warnings = [];
    const reject = (absoluteUrl, reason, rowIndex) => {
      observations.push({ kind: 'rejected_url', absoluteUrl, reason, parentKey: snapshot.jobKey, ...(rowIndex === undefined ? {} : { rowIndex }) });
    };
    // Resolves a published link against the page and checks scheme and host;
    // returns null (after recording a rejection) when the link is unusable.
    const resolveLink = (target, rowIndex) => {
      let sourceUrl;
      try {
        sourceUrl = snapshot.sourceUrlFrom(target, snapshot.sourceUrl?.absoluteUrl);
      } catch (error) {
        reject(target, error.message, rowIndex);
        return null;
      }
      if (!isAllowedSourceUrl(sourceUrl, this.allowedHosts)) {
        reject(target, 'host or scheme is not allowlisted', rowIndex);
        return null;
      }
      return sourceUrl;
    };
    // Rejections carry rowIndex only where the observation key allows one per row.
    const addChild = (targetUrl, childType, metadata = {}) => {
      const sourceUrl = resolveLink(targetUrl);
      if (!sourceUrl) return false;
      let canonicalPath;
      try {
        if (adapter) {
          const classified = adapter.classify(sourceUrl);
          if (classified !== childType) throw new Error(`link is a ${classified} page, expected ${childType}`);
          canonicalPath = adapter.canonicalize(sourceUrl);
        } else {
          canonicalPath = canonicalizeSourceUrl(sourceUrl);
        }
      } catch (error) {
        reject(targetUrl, error.message);
        return false;
      }
      const key = sourceKey(canonicalPath, childType);
      if (childKeys.has(key)) return true;
      childKeys.add(key);
      childJobs.push(createJob({ key, pageType: childType, sourceUrl, canonicalPath, parentKey: snapshot.jobKey, ...metadata }));
      return true;
    };
    // A school's identity (serialized canonical path). Identity only: never queued.
    const schoolIdentity = (target, rowIndex) => {
      const sourceUrl = resolveLink(target, rowIndex);
      if (!sourceUrl) return null;
      try {
        return serializeCanonicalPath(canonicalizeSourceUrl(adapter?.schoolUrl ? adapter.schoolUrl(sourceUrl) : sourceUrl));
      } catch (error) {
        reject(target, error.message, rowIndex);
        return null;
      }
    };

    if (pageType === 'school_index') {
      const eligibleCount = (page.schools ?? []).filter((school) => isEligibleSchool(school)).length;
      if (eligibleCount < this.minEligibleSchools) {
        throw new Error(`the school index yields only ${eligibleCount} eligible school${eligibleCount === 1 ? '' : 's'}; expected at least ${this.minEligibleSchools} (about ${EXPECTED_ELIGIBLE_SCHOOLS}). The eligibility rule (${REQUIRED_ELIGIBILITY_PREDICATE}) may no longer match the site, for example after it added a new season`);
      }
      // The sample's schools as identities, resolved like the index rows' links.
      const sample = this.scope.kind === 'sample' ? new Set(this.scope.schools.map((path) => {
        try {
          const sourceUrl = snapshot.sourceUrlFrom(path, snapshot.sourceUrl?.absoluteUrl);
          return serializeCanonicalPath(canonicalizeSourceUrl(adapter?.schoolUrl ? adapter.schoolUrl(sourceUrl) : sourceUrl));
        } catch { return null; }
      })) : null;
      for (const [rowIndex, school] of (page.schools ?? []).entries()) {
        const eligible = isEligibleSchool(school);
        observations.push({ kind: 'school', school, eligible, parentKey: snapshot.jobKey, rowIndex });
        if (!eligible || !school.historyUrl) continue;
        if (!school.path) {
          reject(school.path, 'school source path is missing', rowIndex);
          continue;
        }
        const schoolSourcePath = schoolIdentity(school.path, rowIndex);
        if (!schoolSourcePath || (sample && !sample.has(schoolSourcePath))) continue;
        addChild(school.historyUrl, 'school_history', { schoolSourcePath });
      }
    }
    if (pageType === 'school_history') {
      const years = this.scope.kind === 'sample' ? this.scope.endingYears : this.targetEndingYears;
      const linkedYears = new Set();
      const rejectedYears = new Set();
      for (const season of page.seasons ?? []) {
        if (!season.url || !years.includes(season.endingYear)) continue;
        if (addChild(season.url, 'season', { schoolSourcePath: snapshot.schoolSourcePath })) linkedYears.add(season.endingYear);
        else rejectedYears.add(season.endingYear);
      }
      // A season the history page does not link is unavailable, not a failure.
      for (const year of years) {
        if (linkedYears.has(year)) continue;
        unavailableCoverage.push({ schoolSourcePath: snapshot.schoolSourcePath, endingYear: year, reason: rejectedYears.has(year) ? 'link_rejected' : 'not_linked' });
      }
    }
    if (pageType === 'season') {
      if (page.gameLogUrl) addChild(page.gameLogUrl, 'game_log', { schoolSourcePath: snapshot.schoolSourcePath });
      else warnings.push(`season page ${snapshot.sourceUrl?.absoluteUrl} publishes no game-log link`);
    }
    if (pageType === 'game_log') {
      // Every row is observed, including incomplete rows. Only a published
      // box-score link creates a child job; the opponent link identifies the
      // opponent school and is never crawled.
      for (const [rowIndex, game] of (page.games ?? []).entries()) {
        let canonicalBoxScorePath = null;
        if (game.boxScoreUrl) {
          const boxScoreUrl = resolveLink(game.boxScoreUrl, rowIndex);
          if (boxScoreUrl) {
            try {
              if (adapter && adapter.classify(boxScoreUrl) !== 'box_score') throw new Error('link is not a box score page');
              canonicalBoxScorePath = serializeCanonicalPath(adapter ? adapter.canonicalize(boxScoreUrl) : canonicalizeSourceUrl(boxScoreUrl));
            } catch (error) {
              reject(game.boxScoreUrl, error.message, rowIndex);
            }
          }
        }
        const opponentSchoolSourcePath = game.opponent?.schoolPath ? schoolIdentity(game.opponent.schoolPath) : null;
        observations.push({ kind: 'game_log', game, parentKey: snapshot.jobKey, canonicalBoxScorePath, opponentSchoolSourcePath, rowIndex });
        if (canonicalBoxScorePath) addChild(game.boxScoreUrl, 'box_score', { schoolSourcePath: snapshot.schoolSourcePath });
      }
    }
    if (pageType === 'box_score') {
      const teams = (page.teams ?? []).map((team) => ({
        side: team.side, name: team.name, schoolSourcePath: team.schoolPath ? schoolIdentity(team.schoolPath) : null,
      }));
      observations.push({ kind: 'box_score', game: page, teams, parentKey: snapshot.jobKey, rowIndex: 0 });
    }
    return createDiscoveryResult({ observations, childJobs, unavailableCoverage, warnings });
  }
}
