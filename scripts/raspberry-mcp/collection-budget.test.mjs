import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBudgetedDockerRunner, DOCKER_TOTAL_BUDGET_MS } from './collect.mjs';
import { diagnosticLine, publishOnce, serializeSnapshot } from './publish.mjs';
import { project, MAX_BYTES } from './core.mjs';

const collectorPath = fileURLToPath(new URL('./collect.mjs', import.meta.url));
const publisherPath = fileURLToPath(new URL('./publish.mjs', import.meta.url));
const fakeSnapshot = () => ({
  observed_at: '2026-11-12T00:00:00.000Z',
  services: [], logs: [], backups: {},
});
const inspect = service => ['inspect', '--format', '{{json .State.Status}}|{{if .State.Health}}{{json .State.Health.Status}}{{else}}"not_configured"{{end}}|{{json .Config.Image}}|{{json (index .Config.Labels "io.hass.version")}}|{{json (index .Config.Labels "org.opencontainers.image.version")}}|{{json (index .Config.Labels "org.label-schema.version")}}', service];
const logs = service => ['logs', '--since', '15m', '--tail', '100', service];

test('one monotonic eight-second budget bounds every fixed Docker call', () => {
  let now = 0;
  const calls = [];
  const metrics = {docker_calls: 0, docker_timeouts: 0, docker_failures: 0,
    docker_elapsed_ms: 0, docker_budget_exhausted: false, last_docker_failure: null};
  const run = createBudgetedDockerRunner((args, timeout) => {
    calls.push({args, timeout});
    now += timeout;
    return 'ok';
  }, () => now, metrics);

  for (const service of ['homeassistant', 'nodered', 'mosquitto']) {
    assert.equal(run(inspect(service)), 'ok');
    assert.equal(run(logs(service)), 'ok');
  }
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map(call => call.timeout), [1500, 1500, 1500, 1500, 1500, 500]);
  assert.equal(now, DOCKER_TOTAL_BUDGET_MS);
  assert.throws(() => run(inspect('homeassistant')), /docker_total_budget_exhausted/);
  assert.equal(calls.length, 6, 'exhausted budget must skip invocation');
  assert.equal(metrics.docker_budget_exhausted, true);
  assert.equal(metrics.docker_elapsed_ms, DOCKER_TOTAL_BUDGET_MS);
  assert.throws(() => run(['inspect', '--format', 'private', 'homeassistant']), /fixed_docker_request_refused/);
});

test('successful and failed Docker calls both contribute bounded elapsed time', () => {
  let now = 0;
  const metrics = {docker_calls: 0, docker_timeouts: 0, docker_failures: 0,
    docker_elapsed_ms: 0, docker_budget_exhausted: false, last_docker_failure: null};
  let call = 0;
  const run = createBudgetedDockerRunner((_args, timeout) => {
    now += call++ === 0 ? 300 : timeout;
    if (call === 2) { const error = Error('private sentinel'); error.code = 'ETIMEDOUT'; throw error; }
    return 'ok';
  }, () => now, metrics);
  assert.equal(run(inspect('homeassistant')), 'ok');
  assert.throws(() => run(logs('homeassistant')), /docker_unavailable/);
  assert.equal(metrics.docker_elapsed_ms, 1800);
  assert.equal(metrics.docker_failures, 1);
  assert.equal(metrics.docker_timeouts, 1);
  assert.equal(metrics.last_docker_failure, 'command_timeout');
});

test('publisher imports in-process collector and keeps a direct CLI import guard', () => {
  const publisher = fs.readFileSync(publisherPath, 'utf8');
  const collector = fs.readFileSync(collectorPath, 'utf8');
  assert.match(publisher, /from ['"]\.\/collect\.mjs['"]/);
  assert.doesNotMatch(publisher, /execFileSync|spawnSync|\/usr\/bin\/node/);
  assert.match(collector, /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
  assert.match(publisher, /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
  assert.equal(project(fakeSnapshot()).host, 'raspberry');
});

test('diagnostics have a fixed allowlist and never include exception text', () => {
  const line = diagnosticLine({phase: 'private phase', failure_class: 'private cause',
    elapsed_ms: 500, docker_calls: 99, docker_elapsed_ms: 9000});
  assert.ok(Buffer.byteLength(line) <= 768);
  const row = JSON.parse(line);
  assert.equal(row.phase, 'collect');
  assert.equal(row.failure_class, 'collector_failure');
  assert.equal(row.docker_calls, 6);
  assert.equal(row.docker_elapsed_ms, 8000);
  assert.doesNotMatch(line, /private/);

  let stderr = '';
  const code = publishOnce({collect: () => { throw Error('do-not-leak-this-secret'); },
    writeFile: () => assert.fail('collection failure must not write'),
    rename: () => assert.fail('collection failure must not rename'),
    unlink: () => {}, writeError: value => { stderr += value; }, pid: 987654});
  assert.equal(code, 1);
  assert.match(stderr, /^collector_failed\n/);
  assert.doesNotMatch(stderr, /do-not-leak-this-secret/);
});

test('serialized snapshot stays within the protocol cap before any write', () => {
  const output = serializeSnapshot(fakeSnapshot());
  assert.ok(Buffer.byteLength(output) <= MAX_BYTES);
  assert.equal(JSON.parse(output).host, 'raspberry');
  assert.throws(() => serializeSnapshot(fakeSnapshot(), 1), /snapshot_bound/);
});

test('atomic publication failure removes only its fixed temporary file', () => {
  const calls = [];
  let stderr = '';
  const code = publishOnce({collect: () => ({snapshot: fakeSnapshot()}), pid: 987655,
    writeFile: (path, bytes, options) => calls.push(['write', path, bytes, options]),
    rename: (from, to) => { calls.push(['rename', from, to]); throw Error('secret rename detail'); },
    unlink: path => calls.push(['unlink', path]), writeError: value => { stderr += value; }});
  assert.equal(code, 1);
  assert.deepEqual(calls.map(row => row[0]), ['write', 'rename', 'unlink']);
  assert.equal(calls[0][1], '/run/raspberry-mcp/snapshot.987655.tmp');
  assert.equal(calls[0][3].flag, 'wx');
  assert.equal(calls[0][3].mode, 0o640);
  assert.equal(calls[1][2], '/run/raspberry-mcp/snapshot.json');
  assert.equal(calls[2][1], '/run/raspberry-mcp/snapshot.987655.tmp');
  assert.match(stderr, /^collector_failed\n/);
  assert.doesNotMatch(stderr, /secret rename detail/);
});

test('diagnostic output failure cannot undo a snapshot after atomic rename', () => {
  const calls = [];
  const code = publishOnce({collect: () => ({snapshot: fakeSnapshot(), diagnostics: {
      docker_failures: 1, docker_timeouts: 0, docker_budget_exhausted: false,
      elapsed_ms: 3, docker_calls: 1, docker_elapsed_ms: 2}}), pid: 987656,
    writeFile: path => calls.push(['write', path]), rename: (from, to) => calls.push(['rename', from, to]),
    unlink: path => calls.push(['unlink', path]), writeError: () => { throw Error('stderr unavailable'); }});
  assert.equal(code, 0);
  assert.deepEqual(calls.map(row => row[0]), ['write', 'rename']);
});
