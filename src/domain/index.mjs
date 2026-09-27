import { gameKey } from '../contracts/source.mjs';
import { assertGameContext, assertGameStatus } from '../contracts/value-state.mjs';
import { createNormalizedPage } from '../contracts/boundaries.mjs';

export class Normalizer {
  normalize(pageType, document, context) {
    if (pageType === 'school_index') {
      return createNormalizedPage({ jobKey: context.jobKey, kind: 'school_index', identity: context.jobKey, data: document, ...context });
    }
    if (pageType === 'school_history') {
      return createNormalizedPage({ jobKey: context.jobKey, kind: 'school_history', identity: context.jobKey, data: document, ...context });
    }
    if (pageType === 'season') {
      return createNormalizedPage({ jobKey: context.jobKey, kind: 'season', identity: context.jobKey, data: document, ...context });
    }
    if (pageType === 'game_log') {
      return createNormalizedPage({ jobKey: context.jobKey, kind: 'game_log', identity: context.jobKey, data: document, ...context });
    }
    if (pageType === 'box_score') {
      if (!document.status) throw new Error('box score is missing game status; status must be explicit or unavailable');
      assertGameStatus(document.status);
      // Sports Reference box scores do not state neutral-site context; when absent it
      // is resolved from the game-log rows that link this box score.
      if (document.context !== undefined) assertGameContext(document.context);
      const side = (name) => document.teams.find((team) => team.side === name);
      const score = (team) => (team?.finalScore?.state === 'present' ? team.finalScore.value : null);
      const identity = gameKey(context.canonicalPath);
      return createNormalizedPage({
        jobKey: context.jobKey,
        kind: 'game',
        identity,
        data: {
          ...document,
          gameDate: document.date ?? null,
          context: document.context ?? null,
          neutralSite: document.context === undefined ? null : document.context === 'neutral',
          home: side('home')?.name ?? null,
          away: side('away')?.name ?? null,
          homeScore: score(side('home')),
          awayScore: score(side('away')),
        },
        observations: context.observations ?? [],
        childJobs: context.childJobs,
        unavailableCoverage: context.unavailableCoverage,
      });
    }
    throw new Error(`cannot normalize unknown page type: ${pageType}`);
  }
}
