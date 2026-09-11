import {
  assertPageType,
  canonicalizeSourceUrl,
  isAllowedSourceUrl,
  serializeCanonicalPath,
  sourceKey,
} from '../contracts/source.mjs';

export class Discovery {
  constructor({ providerId, allowedHosts, targetEndingYears }) {
    this.providerId = providerId;
    this.allowedHosts = allowedHosts;
    this.targetEndingYears = targetEndingYears;
  }

  discover(pageType, snapshot, document) {
    assertPageType(pageType);
    const page = document ?? JSON.parse(Buffer.from(snapshot.body).toString('utf8'));
    const childJobs = [];
    const childKeys = new Set();
    const observations = [];
    const unavailableCoverage = [];
    const warnings = [];
    const sourceUrlFrom = (target) => snapshot.sourceUrlFrom(target, snapshot.sourceUrl?.absoluteUrl);
    const addChild = (targetUrl, childType, metadata = {}) => {
      let sourceUrl;
      try {
        sourceUrl = sourceUrlFrom(targetUrl);
      } catch (error) {
        observations.push({ kind: 'rejected_url', absoluteUrl: targetUrl, reason: error.message, parentKey: snapshot.jobKey });
        return;
      }
      if (!isAllowedSourceUrl(sourceUrl, this.allowedHosts)) {
        observations.push({ kind: 'rejected_url', absoluteUrl: targetUrl, reason: 'host or scheme is not allowlisted', parentKey: snapshot.jobKey });
        return;
      }
      const canonicalPath = canonicalizeSourceUrl(sourceUrl);
      const key = sourceKey(canonicalPath, childType);
      if (childKeys.has(key)) return;
      childKeys.add(key);
      childJobs.push({ key, pageType: childType, sourceUrl, canonicalPath, parentKey: snapshot.jobKey, ...metadata });
    };

    if (pageType === 'school_index') {
      for (const [rowIndex, school] of (page.schools ?? []).entries()) {
        const eligible = school.to === 2026;
        observations.push({ kind: 'school', school, eligible, parentKey: snapshot.jobKey, rowIndex });
        if (!eligible || !school.historyUrl) continue;
        if (!school.path) {
          observations.push({ kind: 'rejected_url', absoluteUrl: school.path, reason: 'school source path is missing', parentKey: snapshot.jobKey, rowIndex });
          continue;
        }
        let schoolSourcePath;
        try {
          schoolSourcePath = serializeCanonicalPath(canonicalizeSourceUrl(sourceUrlFrom(school.path)));
        } catch (error) {
          observations.push({ kind: 'rejected_url', absoluteUrl: school.path, reason: error.message, parentKey: snapshot.jobKey, rowIndex });
          continue;
        }
        addChild(school.historyUrl, 'school_history', { schoolSourcePath });
      }
    }
    if (pageType === 'school_history') {
      const linkedYears = new Set();
      for (const season of page.seasons ?? []) {
        if (!season.url || !this.targetEndingYears.includes(season.endingYear)) continue;
        linkedYears.add(season.endingYear);
        addChild(season.url, 'season', { schoolSourcePath: snapshot.schoolSourcePath });
      }
      for (const year of this.targetEndingYears) {
        if (!linkedYears.has(year)) unavailableCoverage.push({ schoolSourcePath: snapshot.schoolSourcePath, endingYear: year, reason: 'not_linked' });
      }
    }
    if (pageType === 'season' && page.gameLogUrl) addChild(page.gameLogUrl, 'game_log', { schoolSourcePath: snapshot.schoolSourcePath });
    if (pageType === 'game_log') {
      for (const [rowIndex, game] of (page.games ?? []).entries()) {
        let canonicalBoxScorePath = null;
        if (game.boxScoreUrl) {
          try {
            canonicalBoxScorePath = serializeCanonicalPath(canonicalizeSourceUrl(sourceUrlFrom(game.boxScoreUrl)));
          } catch (error) {
            observations.push({ kind: 'rejected_url', absoluteUrl: game.boxScoreUrl, reason: error.message, parentKey: snapshot.jobKey, rowIndex });
          }
        }
        observations.push({ kind: 'game_log', game, parentKey: snapshot.jobKey, canonicalBoxScorePath, rowIndex });
        if (game.boxScoreUrl) addChild(game.boxScoreUrl, 'box_score', { schoolSourcePath: snapshot.schoolSourcePath });
      }
    }
    if (pageType === 'box_score') observations.push({ kind: 'box_score', game: page, parentKey: snapshot.jobKey, rowIndex: 0 });
    return { observations, childJobs, unavailableCoverage, warnings };
  }
}
