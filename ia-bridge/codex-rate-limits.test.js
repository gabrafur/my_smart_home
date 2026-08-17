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
