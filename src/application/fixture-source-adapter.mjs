import { canonicalizeSourceUrl, createSourceUrl } from '../contracts/source.mjs';

export class FixtureSourceAdapter {
  constructor({ providerId = 'fixture-provider', origin = 'https://fixture.example' } = {}) {
    this.provider = providerId;
    this.origin = new URL(origin).origin;
  }

  providerId() { return this.provider; }
  indexUrl() { return createSourceUrl(this.provider, `${this.origin}/cbb/schools/`); }
  canonicalize(sourceUrl) { return canonicalizeSourceUrl(sourceUrl); }

  classify(sourceUrl) {
    const path = sourceUrl?.path ?? new URL(sourceUrl.absoluteUrl).pathname;
    if (path === '/cbb/schools/' || path === '/cbb/schools') return 'school_index';
    if (/\/box\/[^/]+\.html$/.test(path)) return 'box_score';
    if (/-gamelogs\.html$/.test(path)) return 'game_log';
    if (/\/men\/\d{4}\.html$/.test(path)) return 'season';
    if (/\/men\/?$/.test(path)) return 'school_history';
    throw new Error(`fixture source adapter cannot classify path: ${path}`);
  }
}
