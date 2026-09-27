import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSourceAdapter } from '../src/contracts/source-adapter.mjs';
import { createSourceUrl, serializeCanonicalPath, sourceKey } from '../src/contracts/source.mjs';
import {
  SPORTS_REFERENCE_DISALLOWED_PATHS, SportsReferenceSourceAdapter, unrefusedRobotsRules,
} from '../src/application/sports-reference-source-adapter.mjs';

const adapter = new SportsReferenceSourceAdapter();
const url = (path, origin = 'https://www.sports-reference.com') => createSourceUrl('sports-reference', `${origin}${path}`);

test('Sports Reference adapter satisfies the source adapter contract with the school index as its root', () => {
  assert.equal(assertSourceAdapter(adapter), adapter);
  assert.equal(adapter.providerId(), 'sports-reference');
  assert.equal(adapter.indexUrl().absoluteUrl, 'https://www.sports-reference.com/cbb/schools/');
  assert.equal(adapter.classify(adapter.indexUrl()), 'school_index');
  assert.equal(serializeCanonicalPath(adapter.canonicalize(adapter.indexUrl())), 'sports-reference:www.sports-reference.com/cbb/schools');
});

test('Sports Reference adapter classifies the five published URL patterns', () => {
  for (const [path, pageType] of [
    ['/cbb/schools/', 'school_index'],
    ['/cbb/schools/duke/men/', 'school_history'],
    ['/cbb/schools/saint-francis-pa/men/', 'school_history'],
    ['/cbb/schools/duke/men/2024.html', 'season'],
    ['/cbb/schools/le-moyne/men/2024-gamelogs.html', 'game_log'],
    ['/cbb/boxscores/2024-01-27-16-duke.html', 'box_score'],
    ['/cbb/boxscores/2024-02-03-18-north-carolina.html', 'box_score'],
  ]) assert.equal(adapter.classify(url(path)), pageType, path);
});

test('Sports Reference adapter refuses robots.txt-disallowed paths before classifying or canonicalizing', () => {
  for (const path of [
    '/cbb/boxscores/index.cgi?month=1&day=20&year=2024', '/cbb/boxscores/index.cgi',
    '/cbb/req/202602162/tlogo/ncaa/duke-2024.png', '/cbb/short/inc/footer.html', '/cbb/nocdn/schools/duke/men/2024.html',
  ]) {
    assert.throws(() => adapter.classify(url(path)), /robots\.txt disallows/, path);
    assert.throws(() => adapter.canonicalize(url(path)), /robots\.txt disallows/, path);
    assert.throws(() => adapter.schoolUrl(url(path)), /robots\.txt disallows/, path);
  }
  assert.deepEqual([...SPORTS_REFERENCE_DISALLOWED_PATHS], ['/cbb/boxscores/index.cgi', '/cbb/req/', '/cbb/short/', '/cbb/nocdn/']);
});

test('Sports Reference adapter refuses other hosts, providers, queries, and unpublished shapes', () => {
  assert.throws(() => adapter.classify(url('/cbb/schools/', 'https://sports-reference.com')), /host is sports-reference\.com/);
  assert.throws(() => adapter.classify(url('/cbb/schools/', 'https://www.basketball-reference.com')), /host is/);
  assert.throws(() => adapter.classify(createSourceUrl('fixture-provider', 'https://www.sports-reference.com/cbb/schools/')), /provider is fixture-provider/);
  assert.throws(() => adapter.classify(url('/cbb/schools/duke/men/2024.html?ref=nav')), /no query string/);
  for (const path of [
    '/cbb/schools', '/cbb/schools/duke/men', '/cbb/schools/duke/women/', '/cbb/schools/duke/women/2024.html',
    '/cbb/schools/Duke/men/', '/cbb/schools/duke/men/24.html', '/cbb/players/kyle-filipowski-1.html',
    '/cbb/boxscores/', '/cbb/boxscores/2024-01-27-duke.html', '/cbb/seasons/men/2024.html', '/cbb//schools/duke/men/',
  ]) assert.throws(() => adapter.classify(url(path)), /is not a school index, school history, season, game log, or box score page/, path);
});

test('Sports Reference canonical paths give one identity per page regardless of host case', () => {
  const upper = url('/cbb/boxscores/2024-02-03-18-north-carolina.html', 'https://WWW.Sports-Reference.com');
  const lower = url('/cbb/boxscores/2024-02-03-18-north-carolina.html');
  assert.equal(sourceKey(adapter.canonicalize(upper), 'box_score'), sourceKey(adapter.canonicalize(lower), 'box_score'));
  assert.equal(serializeCanonicalPath(adapter.canonicalize(url('/cbb/schools/duke/men/'))), 'sports-reference:www.sports-reference.com/cbb/schools/duke/men');
});

test('a school link reduces to the school history path for identity only', () => {
  for (const path of ['/cbb/schools/georgetown/men/2024.html', '/cbb/schools/georgetown/men/2024-gamelogs.html', '/cbb/schools/georgetown/men/']) {
    assert.equal(adapter.schoolUrl(url(path)).absoluteUrl, 'https://www.sports-reference.com/cbb/schools/georgetown/men/', path);
  }
  assert.throws(() => adapter.schoolUrl(url('/cbb/boxscores/2024-01-27-16-duke.html')), /not a school history, season, or game log page/);
  assert.throws(() => adapter.schoolUrl(url('/cbb/schools/')), /not a school history, season, or game log page/);
});

test('robots.txt check reports only /cbb/ disallow rules the adapter does not already refuse', () => {
  const current = [
    'User-agent: *', 'Disallow: /cbb/boxscores/index.cgi?*', 'Disallow: /cbb/req/', 'Disallow: /cbb/short/',
    'Disallow: /cbb/nocdn/', 'Disallow: /cfb/req/', '# Disallow: /cbb/schools/', 'Allow: /cbb/',
  ].join('\r\n');
  assert.deepEqual(unrefusedRobotsRules(current), []);
  assert.deepEqual(unrefusedRobotsRules(`${current}\nUser-agent: *\nDisallow: /cbb/schools/*/women/\ndisallow: /cbb/req/extra/`), ['/cbb/schools/*/women/']);
  assert.deepEqual(unrefusedRobotsRules('User-agent: *\nDisallow: /cbb/'), ['/cbb/']);
});
