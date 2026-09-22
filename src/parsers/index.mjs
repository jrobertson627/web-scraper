import { createParseResult } from '../contracts/boundaries.mjs';

export class ParserRegistry {
  #parsers = new Map();
  register(parser) {
    const key = `${parser.pageType()}@${parser.version()}`;
    if (this.#parsers.has(key)) throw new Error(`duplicate parser registration: ${key}`);
    this.#parsers.set(key, parser);
    return this;
  }
  get(pageType, version = '1') {
    const parser = this.#parsers.get(`${pageType}@${version}`);
    if (!parser) throw new Error(`no parser registered for ${pageType}@${version}. Example: register(pageType, version)`);
    return parser;
  }
}

export class FixtureParser {
  constructor(pageType, version = '1') { this.type = pageType; this.rev = version; }
  pageType() { return this.type; }
  version() { return this.rev; }
  parse(snapshot) {
    try {
      const document = JSON.parse(Buffer.from(snapshot.body).toString('utf8'));
      if (document.layoutShift) return createParseResult({ kind: 'structural_failure', error: 'fixture layout changed; column meaning is uncertain', warnings: [] });
      return createParseResult({ kind: 'valid', document, warnings: document.warnings ?? [] });
    } catch (error) {
      return createParseResult({ kind: 'structural_failure', error: `document could not be parsed: ${error.message}`, warnings: [] });
    }
  }
}
