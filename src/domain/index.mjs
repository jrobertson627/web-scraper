import { gameKey } from '../contracts/source.mjs';
import { assertGameContext, assertGameStatus } from '../contracts/value-state.mjs';

export class Normalizer {
  normalize(pageType, document, context) {
    if (pageType === 'school_index') return { jobKey: context.jobKey, kind: 'school', identity: context.jobKey, data: document, observations: [] };
    if (pageType === 'school_history' || pageType === 'season') return { jobKey: context.jobKey, kind: 'season', identity: context.jobKey, data: document, observations: [] };
    if (pageType === 'game_log') return { jobKey: context.jobKey, kind: 'game_log', identity: context.jobKey, data: document, observations: [] };
    if (pageType === 'box_score') {
      assertGameStatus(document.status ?? 'final');
      if (document.context) assertGameContext(document.context);
      const identity = gameKey(context.canonicalPath);
      return { jobKey: context.jobKey, kind: 'game', identity, data: { ...document, playerSourceId: document.playerSourceId ?? null }, observations: context.observations ?? [] };
    }
    throw new Error(`cannot normalize unknown page type: ${pageType}`);
  }
}
