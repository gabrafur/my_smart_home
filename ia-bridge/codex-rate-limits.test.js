const assert = require('node:assert/strict');
const test = require('node:test');

const { CodexRateLimitsPoller, normalizeRateLimit } = require('./codex-rate-limits');

test('normalizes an app-server rate-limit snapshot', () => {
  assert.deepEqual(normalizeRateLimit({
    limitId: 'codex', planType: 'prolite',
    primary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1787499010 },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
  }), {
    limit_id: 'codex', limit_name: null, plan_type: 'prolite',
    primary: { used_percent: 42, window_minutes: 10080, resets_at: 1787499010 },
    secondary: null,
    credits: { has_credits: false, unlimited: false, balance: '0' },
    spend_control_reached: false,
    rate_limit_reached_type: null,
  });
});

test('poller exposes refresh timing without model-credit consumption', async () => {
  const poller = new CodexRateLimitsPoller({
    refreshMs: 30_000,
    query: async () => ({
      rateLimits: normalizeRateLimit({
        limitId: 'codex', primary: { usedPercent: 42, windowDurationMins: 10080 },
      }),
      rateLimitsByLimitId: {},
    }),
  });
  await poller.refresh();
  const event = poller.readEvent();
  assert.equal(event.rateLimits.primary.used_percent, 42);
  assert.equal(event.refreshMetadata.refresh_interval_seconds, 30);
  assert.equal(event.refreshMetadata.consumes_model_credits, false);
  assert.ok(event.refreshMetadata.seconds_until_refresh > 0);
});

test('poller exposes the last refresh error even before a successful snapshot', async () => {
  const poller = new CodexRateLimitsPoller({
    query: async () => { throw new Error('backend unavailable'); },
  });
  await poller.refresh();
  const event = poller.readEvent();
  assert.equal(event.rateLimits, null);
  assert.equal(event.refreshMetadata.mode, 'codex_app_server');
  assert.equal(event.refreshMetadata.last_error, 'backend unavailable');
});

const { EventEmitter } = require('node:events');
const { CodexAppServerClient } = require('./codex-rate-limits');

function fakeAppServer({ answer = true } = {}) {
  const spawned = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];
    child.requests = [];
    const exit = (code) => setImmediate(() => child.emit('close', code));
    child.kill = (signal) => { child.signals.push(signal); exit(null); };
    child.stdin = new EventEmitter();
    child.stdin.end = () => exit(0);
    child.stdin.write = (line) => {
      const message = JSON.parse(line);
      child.requests.push(message.method);
      if (!answer || message.id === undefined) return;
      const result = message.method === 'initialize' ? {} : {
        rateLimits: { limitId: 'codex', primary: { usedPercent: 7 } },
      };
      setImmediate(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result })}\n`));
    };
    spawned.push(child);
    return child;
  };
  return { spawned, spawnFn };
}

test('poller reuses one app-server for successive reads', async () => {
  const fake = fakeAppServer();
  const poller = new CodexRateLimitsPoller({
    clientFactory: (options) => new CodexAppServerClient({ ...options, spawnFn: fake.spawnFn }),
  });
  await poller.refresh();
  await poller.refresh();
  assert.equal(fake.spawned.length, 1);
  assert.deepEqual(fake.spawned[0].requests,
    ['initialize', 'initialized', 'account/rateLimits/read', 'account/rateLimits/read']);
  assert.equal(poller.readEvent().rateLimits.primary.used_percent, 7);
  await poller.stop();
  assert.deepEqual(fake.spawned[0].signals, [], 'stop closes stdin instead of killing');
});

test('poller replaces an app-server that exited or exceeded its lifetime', async () => {
  const fake = fakeAppServer();
  const poller = new CodexRateLimitsPoller({
    maxLifetimeMs: 60_000,
    clientFactory: (options) => new CodexAppServerClient({ ...options, spawnFn: fake.spawnFn }),
  });
  await poller.refresh();
  fake.spawned[0].emit('close', 1);
  await poller.refresh();
  assert.equal(fake.spawned.length, 2);
  poller.client.startedAt -= 61_000;
  await poller.refresh();
  assert.equal(fake.spawned.length, 3);
  assert.deepEqual(fake.spawned[1].signals, [], 'lifetime recycle is a clean close');
  await poller.stop();
});

test('an unresponsive app-server times out, is killed and is replaced', async () => {
  const silent = fakeAppServer({ answer: false });
  const client = new CodexAppServerClient({ spawnFn: silent.spawnFn, timeoutMs: 20 });
  await assert.rejects(client.request('account/rateLimits/read'), /timed out/);
  assert.deepEqual(silent.spawned[0].signals, ['SIGTERM']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.alive, false);
});
