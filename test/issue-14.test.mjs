import test from 'node:test';
import assert from 'node:assert/strict';
import { safeMessage } from '../src/application/cli.mjs';

test('safeMessage redacts env-style and JSON-style secret-shaped fields', () => {
  assert.equal(safeMessage(new Error('bad token=abc123 rejected')), 'bad token=[redacted] rejected');
  assert.equal(
    safeMessage(new Error('invalid payload {"password":"hunter2","ok":true}')),
    'invalid payload {password=[redacted],"ok":true}',
  );
  assert.equal(safeMessage(new Error('apiKey=xyz is invalid')), 'apiKey=[redacted] is invalid');
  assert.equal(safeMessage(new Error('credential: "shh secret"')), 'credential=[redacted]');
  assert.equal(safeMessage(new Error('no secrets here')), 'no secrets here');
  assert.equal(safeMessage('plain string error'), 'plain string error');
});
