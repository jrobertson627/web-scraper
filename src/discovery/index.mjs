import { assertPageType, canonicalizeSourceUrl, isAllowedSourceUrl, sourceKey } from '../contracts/source.mjs';

export class Discovery {
  constructor({ providerId, allowedHosts, targetEndingYears }) {
    this.providerId = providerId;
    this.allowedHosts = allowedHosts;
    this.targetEndingYears = targetEndingYears;
  }

  discover(pageType, snapshot) {
    assertPageType(pageType);
    const document = JSON.parse(Buffer.from(snapshot.body).toString('utf8'));
    const childJobs = [];
    const observations = [];
    const unavailableCoverage = [];
    const warnings = [];
    const addChild = (absoluteUrl, childType, parentKey = snapshot.jobKey) => {
      const sourceUrl = snapshot.sourceUrlFrom(absoluteUrl);
      if (!isAllowedSourceUrl(sourceUrl, this.allowedHosts)) {
        observations.push({ kind: 'rejected_url', absoluteUrl, reason: 'host or scheme is not allowlisted', parentKey });
        return;
      }
      const canonicalPath = canonicalizeSourceUrl(sourceUrl);
      childJobs.push({ key: sourceKey(canonicalPath, childType), pageType: childType, sourceUrl, canonicalPath, parentKey });
    };

    if (pageType === 'school_index') {
      for (const school of document.schools ?? []) {
        const eligible = school.to === 2026;
        observations.push({ kind: 'school', school, eligible });
        if (eligible && school.historyUrl) addChild(school.historyUrl, 'school_history');
      }
    }
    if (pageType === 'school_history') {
      const linkedYears = new Set();
      for (const season of document.seasons ?? []) {
        if (!season.url || !this.targetEndingYears.includes(season.endingYear)) continue;
        linkedYears.add(season.endingYear);
        addChild(season.url, 'season');
      }
      for (const year of this.targetEndingYears) if (!linkedYears.has(year)) unavailableCoverage.push({ schoolKey: snapshot.parentKey, endingYear: year, reason: 'not_linked' });
    }
    if (pageType === 'season' && document.gameLogUrl) addChild(document.gameLogUrl, 'game_log');
    if (pageType === 'game_log') {
      for (const game of document.games ?? []) {
        observations.push({ kind: 'game_log', game });
        if (game.boxScoreUrl) addChild(game.boxScoreUrl, 'box_score');
      }
    }
    if (pageType === 'box_score') observations.push({ kind: 'box_score', game: document });
    return { observations, childJobs, unavailableCoverage, warnings };
  }
}
