import { gameKey } from '../contracts/source.mjs';
import { assertGameContext, assertGameStatus } from '../contracts/value-state.mjs';

export class Normalizer {
  normalize(pageType, document, context) {
    if (pageType === 'school_index') {
      return { jobKey: context.jobKey, kind: 'school_index', identity: context.jobKey, data: document, observations: context.observations ?? [] };
    }
    if (pageType === 'school_history') {
      return { jobKey: context.jobKey, kind: 'school_history', identity: context.jobKey, data: document, observations: context.observations ?? [] };
    }
    if (pageType === 'season') {
      return { jobKey: context.jobKey, kind: 'season', identity: context.jobKey, data: document, observations: context.observations ?? [] };
    }
    if (pageType === 'game_log') {
      return { jobKey: context.jobKey, kind: 'game_log', identity: context.jobKey, data: document, observations: context.observations ?? [] };
    }
    if (pageType === 'box_score') {
      if (!document.status) throw new Error('box score is missing game status; status must be explicit or unavailable');
      assertGameStatus(document.status);
      if (!document.context) throw new Error('box score is missing game context; context must be explicit or unavailable');
      assertGameContext(document.context);
      const identity = gameKey(context.canonicalPath);
      return {
        jobKey: context.jobKey,
        kind: 'game',
        identity,
        data: {
          gameDate: document.date ?? null,
          status: document.status,
          gameType: document.gameType ?? null,
          neutralSite: document.context === 'neutral',
          overtime: document.overtime ?? null,
          lineScores: document.lineScores ?? {},
          playerSourceId: document.playerSourceId ?? null,
          teams: [
            { side: 'home', name: document.home ?? null, finalScore: document.homeScore ?? null },
            { side: 'away', name: document.away ?? null, finalScore: document.awayScore ?? null },
          ],
        },
        observations: context.observations ?? [],
      };
    }
    throw new Error(`cannot normalize unknown page type: ${pageType}`);
  }
}
