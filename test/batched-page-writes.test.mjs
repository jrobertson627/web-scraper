import test from 'node:test';
import assert from 'node:assert/strict';
import { writeNormalizedPage } from '../src/persistence/postgres-domain.mjs';
import { boxScoreDocument, seasonDocument, statLine } from '../src/application/fixture-documents.mjs';

const PROVIDER = 'fixture-provider';

function chunk(values, size) {
  return Array.from({ length: values.length / size }, (_, index) => values.slice(index * size, (index + 1) * size));
}

// A client that records statements and answers RETURNING clauses with one row
// per inserted tuple, so page writes can be inspected without a database.
function recordingClient() {
  const statements = [];
  let nextId = 100;
  const tuples = (text, values) => chunk(values, text.slice(text.indexOf('(') + 1, text.indexOf(')')).split(',').length);
  return {
    statements,
    async query(text, values = []) {
      statements.push({ text, values });
      if (/RETURNING id,canonical_source_path/.test(text)) return { rows: tuples(text, values).map((row) => ({ id: nextId++, canonical_source_path: row[1] })) };
      if (/RETURNING id,side/.test(text)) return { rows: tuples(text, values).map((row) => ({ id: nextId++, side: row[1] })) };
      if (/RETURNING id,source_row_index/.test(text)) return { rows: tuples(text, values).map((row) => ({ id: nextId++, source_row_index: row[2] })) };
      if (/RETURNING id|^SELECT id FROM schools/.test(text.trim())) return { rows: [{ id: nextId++ }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

function players(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `Player ${index}`, playerPath: index % 3 ? `/players/p${index}.html` : null, starter: index < 5,
    stats: statLine({ pts: index }), lines: [statLine({ pts: index })],
  }));
}

async function commitBoxScore(count) {
  const client = recordingClient();
  const job = { id: 9, provider_id: PROVIDER, canonical_path: 'fixture.example/box/one.html', page_type: 'box_score',
    source_url: 'https://fixture.example/box/one.html', school_source_path: null };
  const data = boxScoreDocument({ date: '2026-01-02', status: 'final',
    away: { name: 'Away', schoolPath: '/school/b', score: 60, stats: statLine({ pts: 60 }), players: players(count) },
    home: { name: 'Home', schoolPath: '/school/a', score: 70, stats: statLine({ pts: 70 }), players: players(count) } });
  await writeNormalizedPage(client, job, { jobKey: `${PROVIDER}:${job.canonical_path}:box_score`, kind: 'game',
    identity: `${PROVIDER}:${job.canonical_path}`, data: { ...data, gameDate: data.date, context: null, neutralSite: null } },
  { parserName: 'box_score', parserVersion: '1' }, '5');
  return client.statements;
}

async function commitSeason(count) {
  const client = recordingClient();
  const job = { id: 9, provider_id: PROVIDER, canonical_path: 'fixture.example/school/a/men/2026.html', page_type: 'season',
    source_url: 'https://fixture.example/school/a/men/2026.html', school_source_path: `${PROVIDER}:fixture.example/school/a` };
  const data = seasonDocument({ school: 'A', endingYear: 2026, gameLogUrl: null, players: players(count),
    games: [{ status: 'final', teamScore: 70, opponentScore: 60, teamStats: statLine({ pts: 70 }), opponentStats: statLine({ pts: 60 }) }] });
  await writeNormalizedPage(client, job, { jobKey: `${PROVIDER}:${job.canonical_path}:season`, kind: 'season', identity: `${PROVIDER}:${job.canonical_path}:season`, data },
    { parserName: 'season', parserVersion: '1' }, '5');
  return client.statements;
}

test('committing a box score issues a fixed number of statements whatever the player count', async () => {
  const small = await commitBoxScore(3);
  const large = await commitBoxScore(30);
  assert.equal(large.length, small.length);
  assert.ok(small.length <= 12, `${small.length} statements`);
  const playerRows = large.filter(({ text }) => /INSERT INTO player_game_stats/.test(text));
  assert.equal(playerRows.length, 2);
  const rowCounts = playerRows.map(({ text, values }) => values.length / text.slice(text.indexOf('(') + 1, text.indexOf(')')).split(',').length);
  assert.deepEqual(rowCounts.sort((a, b) => a - b), [20, 40]);
  const playerUpserts = large.filter(({ text }) => /INSERT INTO players/.test(text));
  assert.equal(playerUpserts.length, 1);
  assert.match(playerUpserts[0].text, /\$4::jsonb\),\(\$5,/);
});

test('committing a season issues a fixed number of statements whatever the roster size', async () => {
  const small = await commitSeason(3);
  const large = await commitSeason(30);
  assert.equal(large.length, small.length);
  assert.ok(small.length <= 14, `${small.length} statements`);
  const rosterValues = large.filter(({ text }) => /INSERT INTO season_rosters/.test(text)).reduce((total, { values }) => total + values.length, 0);
  assert.equal(rosterValues, 30 * 12);
});
