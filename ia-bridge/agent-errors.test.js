'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isTransientNetworkError,
  publicAgentError,
  retryTransientNetwork,
  safeErrorCategory,
} = require('./agent-errors');

test('classifies and sanitizes DNS failures', () => {
  const error = new Error('failed to lookup address information: Try again; private detail');
  assert.equal(isTransientNetworkError(error), true);
  assert.equal(safeErrorCategory(error), 'transient_network');
  const reply = publicAgentError('Codex', error);
  assert.match(reply, /DNS\/rede externa/);
  assert.doesNotMatch(reply, /private detail|lookup address information/);
});

test('retries a transient network failure once', async () => {
  let calls = 0;
  let waits = 0;
  const result = await retryTransientNetwork(async () => {
    calls += 1;
    if (calls === 1) throw new Error('EAI_AGAIN');
    return 'ok';
  }, {
    wait: async () => { waits += 1; },
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.equal(waits, 1);
});

test('does not retry an unrelated execution failure', async () => {
  let calls = 0;
  await assert.rejects(
    retryTransientNetwork(async () => {
      calls += 1;
      throw new Error('invalid request');
    }),
    /invalid request/,
  );
  assert.equal(calls, 1);
});
