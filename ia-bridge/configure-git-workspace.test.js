'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { configureGitWorkspace } = require('./configure-git-workspace');

test('adds the mounted workspace to Git safe.directory', () => {
  const calls = [];
  const changed = configureGitWorkspace({
    workdir: '/workspace',
    execFileSync(command, args) {
      calls.push([command, args]);
      if (args.includes('--get-all')) {
        const error = new Error('missing key');
        error.status = 1;
        throw error;
      }
      return '';
    },
  });

  assert.equal(changed, true);
  assert.deepEqual(calls.at(-1), [
    'git',
    ['config', '--global', '--add', 'safe.directory', '/workspace'],
  ]);
});

test('keeps an existing workspace trust entry unchanged', () => {
  let calls = 0;
  const changed = configureGitWorkspace({
    workdir: '/workspace',
    execFileSync() {
      calls += 1;
      return '/another/repository\n/workspace\n';
    },
  });

  assert.equal(changed, false);
  assert.equal(calls, 1);
});

test('does not hide unexpected Git configuration failures', () => {
  assert.throws(
    () => configureGitWorkspace({
      execFileSync() {
        const error = new Error('Git unavailable');
        error.status = 127;
        throw error;
      },
    }),
    /Git unavailable/,
  );
});
