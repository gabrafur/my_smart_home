const test = require('node:test');
const assert = require('node:assert/strict');
const {
  codexExecOptions,
  codexSessionKey,
  validateCodexOptions,
} = require('./codex-options');

test('accepts supported GPT-5.6 model and reasoning combinations', () => {
  assert.deepEqual(
    validateCodexOptions({ model: 'gpt-5.6-terra', reasoningEffort: 'ultra' }),
    { model: 'gpt-5.6-terra', reasoningEffort: 'ultra' },
  );
  assert.deepEqual(
    codexExecOptions({ model: 'gpt-5.6-sol', reasoningEffort: 'medium' }),
    ['--disable', 'apps', '--model', 'gpt-5.6-sol', '--config', 'model_reasoning_effort="medium"'],
  );
});

test('uses Terra Medium by default and separates selected configurations', () => {
  assert.deepEqual(
    validateCodexOptions({}),
    { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
  );
  assert.equal(
    codexSessionKey('home-assistant:codex:user', {}),
    'codex:home-assistant:codex:user:model=gpt-5.6-terra:reasoning=medium',
  );
  assert.equal(
    codexSessionKey('home-assistant:codex:user', { model: 'gpt-5.6-luna', reasoningEffort: 'low' }),
    'codex:home-assistant:codex:user:model=gpt-5.6-luna:reasoning=low',
  );
});

test('rejects unknown models and unsupported reasoning combinations', () => {
  assert.throws(
    () => validateCodexOptions({ model: 'gpt-5.7', reasoningEffort: 'medium' }),
    /unsupported Codex model/,
  );
  assert.throws(
    () => validateCodexOptions({ model: 'gpt-5.6-luna', reasoningEffort: 'ultra' }),
    /unsupported reasoning effort/,
  );
});
