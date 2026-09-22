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
      if (!document.context) throw new Error('box score is missing game context; context must be explicit or unavailable');
      assertGameContext(document.context);
      const identity = gameKey(context.canonicalPath);
      return createNormalizedPage({
        jobKey: context.jobKey,
        kind: 'game',
        identity,
        data: {
          ...document,
          gameDate: document.date ?? null,
          status: document.status,
          gameType: document.gameType ?? null,
          neutralSite: document.context === 'neutral',
          overtime: document.overtime ?? null,
          lineScores: document.lineScores ?? {},
          playerSourceId: document.playerSourceId ?? null,
          teams: document.teams ?? [
            { side: 'home', name: document.home ?? null, finalScore: document.homeScore ?? null },
            { side: 'away', name: document.away ?? null, finalScore: document.awayScore ?? null },
          ],
        },
        observations: context.observations ?? [],
        childJobs: context.childJobs,
        unavailableCoverage: context.unavailableCoverage,
      });
    }
    throw new Error(`cannot normalize unknown page type: ${pageType}`);
  }
}
