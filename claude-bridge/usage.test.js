const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { scanCodexUsage, scanLocalAiTelemetry } = require('./usage');

function tokenEvent(timestamp, total, usedPercent, balance = '0') {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: total },
      rate_limits: {
        limit_id: 'codex',
        plan_type: 'plus',
        primary: {
          used_percent: usedPercent,
          window_minutes: 10080,
          resets_at: 1786895130,
        },
        credits: { has_credits: balance !== '0', unlimited: false, balance },
      },
    },
  });
}

test('aggregates session deltas and keeps the newest limit snapshot', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, '2026', '08', '15'), { recursive: true });
  fs.writeFileSync(path.join(directory, '2026', '08', '15', 'one.jsonl'), [
    '{not-json}',
    tokenEvent('2026-08-15T10:00:00Z', {
      input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, total_tokens: 110,
    }, 20),
    tokenEvent('2026-08-15T10:05:00Z', {
      input_tokens: 160, cached_input_tokens: 80, output_tokens: 20, total_tokens: 180,
    }, 25, '12.5'),
  ].join('\n'));
  fs.writeFileSync(path.join(directory, '2026', '08', '15', 'two.jsonl'),
    tokenEvent('2026-08-15T11:00:00Z', {
      input_tokens: 50, cached_input_tokens: 20, output_tokens: 5, total_tokens: 55,
    }, 30, '12.5'));

  const usage = scanCodexUsage(directory, new Date('2026-08-16T00:00:00Z'));
  assert.equal(usage.status, 'ok');
  assert.equal(usage.totals.total_tokens, 235);
  assert.equal(usage.totals.input_tokens, 210);
  assert.equal(usage.totals.sessions, 2);
  assert.equal(usage.rate_limit.used_percent, 30);
  assert.equal(usage.rate_limit.remaining_percent, 70);
  assert.equal(usage.rate_limit.credits.balance, '12.5');
  assert.equal(usage.daily[0].total_tokens, 235);
  assert.equal(usage.analytics.cache_hit_percent, 47.6);
  assert.equal(usage.analytics.tokens_per_day_7d, 34);
  assert.equal(usage.analytics.forecast.status, 'aguenta');
  assert.equal(usage.analytics.forecast.will_last, true);
  assert.equal(usage.analytics.forecast.projected_used_at_reset, 33.1);
  assert.equal(usage.freshness.activity.current, false);
  assert.equal(usage.freshness.activity.age_seconds, 46800);
  assert.equal(usage.freshness.rate_limit.current, false);
});

test('returns a stable empty response when there are no sessions', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-empty-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const usage = scanCodexUsage(directory, new Date('2026-08-16T00:00:00Z'));
  assert.equal(usage.status, 'no_data');
  assert.equal(usage.totals.total_tokens, 0);
  assert.deepEqual(usage.daily, []);
  assert.equal(usage.analytics.cache_hit_percent, null);
  assert.equal(usage.analytics.forecast.status, 'insuficiente');
});

test('summarizes idempotent Local AI telemetry without treating local tokens as saved tokens', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-local-ai-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const telemetryPath = path.join(directory, 'local-ai-telemetry.json');
  const statusPath = path.join(directory, 'local-ai-status.json');
  fs.writeFileSync(telemetryPath, JSON.stringify({
    totals: {
      calls: 3, successful_calls: 2, failed_calls: 1, fallbacks_reported: 1,
      duration_seconds: 20, local_input_tokens: 1500, local_output_tokens: 260,
      context_input_tokens: 1200, context_output_tokens: 180,
      openai_context_tokens_avoided: 1020,
    },
    daily: {
      '2026-08-16': { totals: {
        calls: 2, successful_calls: 1, failed_calls: 1, fallbacks_reported: 1,
        duration_seconds: 10, local_input_tokens: 800, local_output_tokens: 130,
        context_input_tokens: 700, context_output_tokens: 100,
        openai_context_tokens_avoided: 600,
      } },
    },
    models: { 'qwen2.5-coder:7b': { totals: { calls: 3, successful_calls: 2 } } },
    active_jobs: { running: {
      id: 'running', started_at: '2026-08-16T11:55:00.000Z', task: 'review-diff',
      endpoint: 'http://private.example:11435',
      live_gpu: { at: '2026-08-16T12:00:00.000Z', gpu_util_percent: 87, vram_mib: 6321 },
    } },
    latest_jobs: [
      { id: 'old', status: 'failed', task: 'summarize-log' },
      { id: 'done', status: 'success', task: 'analyze-tests', endpoint: 'http://private.example:11435' },
    ],
  }));
  fs.writeFileSync(statusPath, JSON.stringify({
    state: 'LOCAL_AI_AVAILABLE', checked_at: '2026-08-16T11:50:00.000Z',
    gpu: 'NVIDIA GeForce RTX 4070', ollama: true, model: 'qwen2.5-coder:7b',
  }));

  const usage = scanLocalAiTelemetry(telemetryPath, statusPath, new Date('2026-08-16T12:00:00Z'));
  assert.equal(usage.state, 'LOCAL_AI_IN_USE');
  assert.equal(usage.totals.local_input_tokens, 1500);
  assert.equal(usage.totals.openai_context_tokens_avoided, 1020);
  assert.equal(usage.totals.context_reduction_percent, 85);
  assert.equal(usage.totals.failure_rate_percent, 33.3);
  assert.equal(usage.periods.today.openai_context_tokens_avoided, 600);
  assert.equal(usage.current_job.task, 'review-diff');
  assert.equal(usage.current_job.endpoint, undefined);
  assert.equal(usage.current_job.live_gpu.gpu_util_percent, 87);
  assert.equal(usage.freshness.preflight.current, false);
  assert.equal(usage.models[0].model, 'qwen2.5-coder:7b');
  assert.equal(usage.latest_jobs[0].id, 'done');
  assert.equal(usage.latest_jobs[0].endpoint, undefined);
});

test('does not report a stale Local AI preflight as available', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-local-ai-stale-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const telemetryPath = path.join(directory, 'local-ai-telemetry.json');
  const statusPath = path.join(directory, 'local-ai-status.json');
  fs.writeFileSync(telemetryPath, JSON.stringify({ active_jobs: {} }));
  fs.writeFileSync(statusPath, JSON.stringify({
    state: 'LOCAL_AI_AVAILABLE', checked_at: '2026-08-16T11:57:59.000Z',
  }));

  const usage = scanLocalAiTelemetry(telemetryPath, statusPath, new Date('2026-08-16T12:00:00Z'));
  assert.equal(usage.freshness.preflight.current, false);
  assert.equal(usage.available, false);
  assert.equal(usage.state, 'LOCAL_AI_UNAVAILABLE');
});

test('does not keep an abandoned Local AI job marked as in use', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-local-ai-job-stale-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const telemetryPath = path.join(directory, 'local-ai-telemetry.json');
  const statusPath = path.join(directory, 'local-ai-status.json');
  fs.writeFileSync(telemetryPath, JSON.stringify({
    active_jobs: {
      abandoned: {
        id: 'abandoned', task: 'inspect-files', started_at: '2026-08-16T11:58:00.000Z',
        live_gpu: { at: '2026-08-16T11:58:05.000Z', gpu_util_percent: 88 },
      },
    },
  }));
  fs.writeFileSync(statusPath, JSON.stringify({
    state: 'LOCAL_AI_AVAILABLE', checked_at: '2026-08-16T11:59:59.000Z',
  }));

  const usage = scanLocalAiTelemetry(telemetryPath, statusPath, new Date('2026-08-16T12:00:00Z'));
  assert.equal(usage.current_job, null);
  assert.equal(usage.state, 'LOCAL_AI_AVAILABLE');
});
