import { createParseResult } from '../contracts/boundaries.mjs';
import { assertPageType } from '../contracts/source.mjs';

export class ParserRegistry {
  #parsers = new Map();
  register(parser) {
    if (!parser || typeof parser.pageType !== 'function' || typeof parser.version !== 'function' || typeof parser.parse !== 'function') {
      throw new Error('parser registration requires pageType(), version(), and parse(snapshot)');
    }
    const pageType = assertPageType(parser.pageType());
    const version = parser.version();
    if (typeof version !== 'string' || !version.trim()) throw new Error('parser version must be a non-empty string');
    const key = `${pageType}@${version}`;
    if (this.#parsers.has(key)) throw new Error(`duplicate parser registration: ${key}`);
    this.#parsers.set(key, parser);
    return this;
  }
  get(pageType, version = '1') {
    assertPageType(pageType);
    const parser = this.#parsers.get(`${pageType}@${version}`);
    if (!parser) throw new Error(`no parser registered for ${pageType}@${version}. Example: register(pageType, version)`);
    return parser;
  }

  parse(pageType, version, snapshot) {
    if (!snapshot || !Buffer.isBuffer(snapshot.body)) throw new Error('parser input must be an immutable raw snapshot with a Buffer body');
    return createParseResult(this.get(pageType, version).parse(snapshot));
  }
}

export class FixtureParser {
  constructor(pageType, version = '1') { this.type = pageType; this.rev = version; }
  pageType() { return this.type; }
  version() { return this.rev; }
  parse(snapshot) {
    try {
      const raw = Buffer.from(snapshot.body).toString('utf8');
      const fixtureDocument = raw.trimStart().startsWith('<')
        ? raw.match(/<script\s+id="fixture-document"\s+type="application\/json">([\s\S]*?)<\/script>/i)?.[1]
        : raw;
      if (!fixtureDocument) throw new Error('HTML fixture has no fixture-document script');
      const document = JSON.parse(fixtureDocument);
      if (document.layoutShift) return createParseResult({ kind: 'structural_failure', error: 'fixture layout changed; column meaning is uncertain', warnings: [] });
      return createParseResult({ kind: 'valid', document, warnings: document.warnings ?? [] });
    } catch (error) {
      return createParseResult({ kind: 'structural_failure', error: `document could not be parsed: ${error.message}`, warnings: [] });
    }
  }
}
