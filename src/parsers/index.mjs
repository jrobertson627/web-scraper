import { createParseResult } from '../contracts/boundaries.mjs';
import { parsedDocumentError } from '../contracts/parsed-documents.mjs';
import { assertPageType } from '../contracts/source.mjs';
import { SchoolHistoryParser } from './school-history.mjs';
import { SchoolIndexParser } from './school-index.mjs';
import { SeasonParser } from './season.mjs';

export { SchoolHistoryParser, SchoolIndexParser, SeasonParser };

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
  has(pageType, version = '1') { return this.#parsers.has(`${assertPageType(pageType)}@${version}`); }
  get(pageType, version = '1') {
    assertPageType(pageType);
    const parser = this.#parsers.get(`${pageType}@${version}`);
    if (!parser) throw new Error(`no parser registered for ${pageType}@${version}. Example: register(pageType, version)`);
    return parser;
  }

  parse(pageType, version, snapshot) {
    if (!snapshot || !Buffer.isBuffer(snapshot.body)) throw new Error('parser input must be an immutable raw snapshot with a Buffer body');
    const result = createParseResult(this.get(pageType, version).parse(snapshot));
    if (result.kind !== 'valid') return result;
    // A document outside the frozen contract is quarantined like a layout change.
    const shapeError = parsedDocumentError(pageType, result.document);
    if (!shapeError) return result;
    return createParseResult({ kind: 'structural_failure', error: `parsed document breaks the ${pageType} contract: ${shapeError}`, warnings: result.warnings });
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

// Production parsers for real provider pages, one per page type, registered by
// the worker assembly. The remaining Sports Reference parsers land in #40-#42;
// until then the worker reports those page types as missing and refuses to start.
export const PRODUCTION_PARSERS = Object.freeze([
  new SchoolIndexParser(),
  new SchoolHistoryParser(),
  new SeasonParser(),
]);

export function createProductionParserRegistry(parsers = PRODUCTION_PARSERS) {
  const registry = new ParserRegistry();
  for (const parser of parsers) registry.register(parser);
  return registry;
}

// `pageType@version` entries the worker needs but the registry lacks. Fixture
// parsers read synthetic JSON pages, so they never count for a real crawl.
export function missingProductionParsers(registry, parserVersions) {
  return Object.entries(parserVersions)
    .filter(([pageType, version]) => !registry.has(pageType, version) || registry.get(pageType, version) instanceof FixtureParser)
    .map(([pageType, version]) => `${pageType}@${version}`);
}
