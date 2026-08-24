'use strict';

const { execFileSync } = require('node:child_process');

function configureGitWorkspace(options = {}) {
  const workdir = options.workdir || process.env.WORKDIR || '/workspace';
  const run = options.execFileSync || execFileSync;
  const commonOptions = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  };

  let configured = '';
  try {
    configured = run(
      'git',
      ['config', '--global', '--get-all', 'safe.directory'],
      commonOptions,
    );
  } catch (error) {
    // Git exits with status 1 when the key has not been configured yet.
    if (error.status !== 1) throw error;
  }

  if (String(configured).split(/\r?\n/).includes(workdir)) return false;

  run(
    'git',
    ['config', '--global', '--add', 'safe.directory', workdir],
    commonOptions,
  );
  return true;
}

module.exports = { configureGitWorkspace };
