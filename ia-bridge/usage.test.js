const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CodexUsageReader, scanCodexUsage, scanLocalAiTelemetry, scanLocalAiHistory,
} = require('./usage');

function tokenEvent(timestamp, total, usedPercent, balance = '0', plan = 'plus') {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: total },
      rate_limits: {
        limit_id: 'codex',
        ...(plan ? { plan_type: plan } : {}),
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
  assert.equal(usage.rate_limit.window_type, 'weekly');
  assert.equal(usage.rate_limit.window_started_at, '2026-08-09T15:45:30.000Z');
  assert.equal(usage.rate_limit.credits.balance, '12.5');
  assert.equal(usage.daily[0].total_tokens, 235);
  assert.equal(usage.analytics.cache_hit_percent, 47.6);
  assert.equal(usage.analytics.tokens_per_day_7d, 34);
  assert.equal(usage.analytics.forecast.status, 'risco');
  assert.equal(usage.analytics.forecast.will_last, false);
  assert.equal(usage.analytics.forecast.projected_used_at_reset, 100);
  assert.equal(usage.freshness.activity.current, false);
  assert.equal(usage.freshness.activity.age_seconds, 46800);
  assert.equal(usage.freshness.rate_limit.current, false);
  assert.equal(usage.freshness.rate_limit.max_age_seconds, 900);
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

test('overlays a live plan-limit snapshot without requiring a model turn', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-live-limit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reader = new CodexUsageReader(directory, null, null, 0);
  const timestamp = new Date();
  const nextRefreshAt = new Date(timestamp.valueOf() + 30_000).toISOString();
  const usage = reader.read({
    timestamp,
    rateLimits: {
      limit_id: 'codex',
      plan_type: 'prolite',
      primary: { used_percent: 42, window_minutes: 10080, resets_at: 1787499010 },
      credits: { has_credits: false, unlimited: false, balance: null },
    },
    refreshMetadata: {
      mode: 'codex_app_server',
      consumes_model_credits: false,
      refresh_interval_seconds: 30,
      next_refresh_at: nextRefreshAt,
      seconds_until_refresh: 30,
    },
  });

  assert.equal(usage.status, 'ok');
  assert.equal(usage.source_updated_at, null);
  assert.equal(usage.rate_limit_updated_at, timestamp.toISOString());
  assert.equal(usage.plan_type, 'prolite');
  assert.equal(usage.rate_limit.used_percent, 42);
  assert.equal(usage.rate_limit.remaining_percent, 58);
  assert.equal(usage.rate_limit_refresh.seconds_until_refresh, 30);
  assert.equal(usage.rate_limit_refresh.consumes_model_credits, false);
  assert.equal(usage.freshness.rate_limit.current, true);
});

test('keeps the last known plan when the newest rate snapshot omits it', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-plan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'usage.jsonl');
  fs.writeFileSync(file, [
    tokenEvent('2026-08-16T10:00:00Z', { total_tokens: 10 }, 10, '0', 'prolite'),
    tokenEvent('2026-08-16T10:01:00Z', { total_tokens: 20 }, 11, '0', null),
  ].join('\n'));

  const usage = scanCodexUsage(directory, new Date('2026-08-16T10:02:00Z'));
  assert.equal(usage.rate_limit.used_percent, 11);
  assert.equal(usage.plan_type, 'prolite');
  assert.equal(usage.rate_limit.plan_type, 'prolite');
});

test('prefers the account-wide live limit over a newer model-specific session snapshot', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-account-limit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'usage.jsonl'),
    tokenEvent('2026-08-16T10:01:00Z', { total_tokens: 10 }, 0, '0', 'spark'));
  const reader = new CodexUsageReader(directory, null, null, 0);

  const usage = reader.read({
    timestamp: new Date('2026-08-16T10:00:00Z'),
    rateLimits: {
      limit_id: 'codex',
      plan_type: 'prolite',
      primary: { used_percent: 77, window_minutes: 10080, resets_at: 1786897800 },
    },
    refreshMetadata: { mode: 'codex_app_server', consumes_model_credits: false },
  });

  assert.equal(usage.rate_limit.used_percent, 77);
  assert.equal(usage.rate_limit.remaining_percent, 23);
  assert.equal(usage.plan_type, 'prolite');
  assert.equal(usage.rate_limit_updated_at, '2026-08-16T10:00:00.000Z');
});

test('does not present a model-specific session limit as the account-wide limit', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-no-account-limit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'usage.jsonl'),
    tokenEvent('2026-08-16T10:01:00Z', { total_tokens: 10 }, 0, '0', 'spark'));
  const reader = new CodexUsageReader(directory, null, null, 0);

  const usage = reader.read({
    timestamp: null,
    rateLimits: null,
    refreshMetadata: { mode: 'codex_app_server', last_error: 'backend unavailable' },
  });

  assert.equal(usage.status, 'ok');
  assert.equal(usage.rate_limit, null);
  assert.equal(usage.plan_type, null);
  assert.equal(usage.rate_limit_updated_at, null);
  assert.equal(usage.freshness.rate_limit.current, false);
  assert.equal(usage.rate_limit_refresh.last_error, 'backend unavailable');
});

test('merges multiple session directories and refreshes only a changed session file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-reader-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bridgeDirectory = path.join(directory, 'bridge');
  const hostDirectory = path.join(directory, 'host');
  fs.mkdirSync(bridgeDirectory, { recursive: true });
  fs.mkdirSync(hostDirectory, { recursive: true });
  const bridgeFile = path.join(bridgeDirectory, 'bridge.jsonl');
  const hostFile = path.join(hostDirectory, 'host.jsonl');
  fs.writeFileSync(bridgeFile, tokenEvent('2026-08-16T10:00:00Z', {
    input_tokens: 10, total_tokens: 10,
  }, 10));
  fs.writeFileSync(hostFile, tokenEvent('2026-08-16T10:01:00Z', {
    input_tokens: 20, total_tokens: 20,
  }, 11));

  const reader = new CodexUsageReader([bridgeDirectory, hostDirectory], null, null, 0);
  assert.equal(reader.read().totals.total_tokens, 30);

  fs.appendFileSync(hostFile, `\n${tokenEvent('2026-08-16T10:02:00Z', {
    input_tokens: 25, total_tokens: 25,
  }, 12)}`);
  const refreshed = reader.read();
  assert.equal(refreshed.totals.total_tokens, 35);
  assert.equal(refreshed.totals.sessions, 2);
  assert.equal(reader.usageFiles.size, 2);
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
      context_input_tokens: 1200, context_output_tokens: 180, context_overhead_tokens: 0,
      openai_context_tokens_avoided: 1020, quality_rejected_calls: 1,
      quality_validated_calls: 1, quality_validated_context_input_tokens: 700,
      attempted_context_input_tokens: 1200,
      quality_validated_context_output_tokens: 100,
      gross_useful_context_tokens_avoided: 700,
      quality_validation_tokens: 140, quality_validated_validation_tokens: 100,
      quality_validation_measured_calls: 1, quality_validation_unmeasured_calls: 1,
      useful_context_tokens_avoided: 600,
    },
    daily: {
      '2026-08-16': { totals: {
        calls: 2, successful_calls: 1, failed_calls: 1, fallbacks_reported: 1,
        duration_seconds: 10, local_input_tokens: 800, local_output_tokens: 130,
        context_input_tokens: 700, context_output_tokens: 100,
        openai_context_tokens_avoided: 600, quality_rejected_calls: 1,
        quality_validated_calls: 1, quality_validated_context_input_tokens: 700,
        attempted_context_input_tokens: 1200,
        quality_validated_context_output_tokens: 100,
        gross_useful_context_tokens_avoided: 700,
        quality_validation_tokens: 140, quality_validated_validation_tokens: 100,
        quality_validation_measured_calls: 1, quality_validation_unmeasured_calls: 1,
        useful_context_tokens_avoided: 600,
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
  assert.equal(usage.totals.context_reduction_percent, 50);
  assert.equal(usage.totals.useful_reduction_percent, 50);
  assert.equal(usage.totals.gross_useful_context_tokens_avoided, 700);
  assert.equal(usage.totals.quality_validated_validation_tokens, 100);
  assert.equal(usage.totals.quality_validation_cost_coverage_percent, 50);
  assert.equal(usage.totals.quality_acceptance_rate_percent, 50);
  assert.equal(usage.totals.failure_rate_percent, 33.3);
  assert.equal(usage.totals.average_duration_seconds, 6.67);
  assert.equal(usage.periods.today.openai_context_tokens_avoided, 600);
  assert.equal(usage.periods.today.useful_reduction_percent, 50);
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
  assert.equal(usage.state, 'LOCAL_AI_UNKNOWN');
});

test('uses only operational calls for technical success and failure rates', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-local-ai-operational-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const telemetryPath = path.join(directory, 'local-ai-telemetry.json');
  const statusPath = path.join(directory, 'local-ai-status.json');
  fs.writeFileSync(telemetryPath, JSON.stringify({
    totals: {
      calls: 10,
      successful_calls: 7,
      failed_calls: 3,
      operational_calls: 5,
      operational_successful_calls: 2,
      operational_failed_calls: 1,
      operational_quality_rejected_calls: 1,
      operational_quality_validated_calls: 2,
      operational_not_beneficial_calls: 1,
      diagnostic_calls: 4,
      unclassified_calls: 1,
    },
  }));
  fs.writeFileSync(statusPath, JSON.stringify({
    state: 'LOCAL_AI_AVAILABLE', checked_at: '2026-08-16T12:00:00.000Z',
  }));

  const usage = scanLocalAiTelemetry(telemetryPath, statusPath, new Date('2026-08-16T12:00:00Z'));
  assert.equal(usage.totals.success_rate_percent, 80);
  assert.equal(usage.totals.failure_rate_percent, 20);
  assert.equal(usage.totals.quality_acceptance_rate_percent, 75);
  assert.equal(usage.totals.operational_accounting_coverage_percent, 90);
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

test('preserves a signed negative context delta instead of reporting false savings', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-local-ai-negative-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const telemetryPath = path.join(directory, 'local-ai-telemetry.json');
  const statusPath = path.join(directory, 'local-ai-status.json');
  fs.writeFileSync(telemetryPath, JSON.stringify({
    totals: {
      calls: 1, successful_calls: 1, context_input_tokens: 100,
      context_output_tokens: 120, openai_context_tokens_avoided: -20,
    },
  }));
  fs.writeFileSync(statusPath, JSON.stringify({
    state: 'LOCAL_AI_AVAILABLE', checked_at: '2026-08-16T12:00:00.000Z',
  }));
  const usage = scanLocalAiTelemetry(telemetryPath, statusPath, new Date('2026-08-16T12:00:00Z'));
  assert.equal(usage.totals.openai_context_tokens_avoided, -20);
  assert.equal(usage.totals.raw_context_reduction_percent, -20);
  assert.equal(usage.totals.context_reduction_percent, null);
});

test('reports routing coverage, weighted savings, and compact last decisions', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-routing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const telemetryPath = path.join(directory, 'local-ai-telemetry.json');
  const statusPath = path.join(directory, 'local-ai-status.json');
  fs.writeFileSync(telemetryPath, JSON.stringify({
    routing: {
      totals: {
        tasks: 4, eligible_tasks: 3, eligible_and_available_tasks: 3,
        used_tasks: 2, missed_opportunities: 1, not_beneficial_tasks: 1,
        potential_tokens_avoidable: 10_000, actual_tokens_avoided: 8_400,
        useful_tokens_avoided: 7_600, missed_potential_tokens_avoidable: 1_200,
      },
      latest_decisions: [
        {
          id: 'used', timestamp: '2026-08-16T12:00:00Z', task_type: 'analyze-tests',
          decision: 'LOCAL_AI_USED', reason: 'large_test_output', endpoint: 'http://private.example:11435',
        },
      ],
    },
    daily: {
      '2026-08-16': { routing: {
        tasks: 4, eligible_tasks: 3, eligible_and_available_tasks: 3,
        used_tasks: 2, missed_opportunities: 1, potential_tokens_avoidable: 10_000,
        actual_tokens_avoided: 8_400, useful_tokens_avoided: 7_600,
        missed_potential_tokens_avoidable: 1_200,
      } },
    },
  }));
  fs.writeFileSync(statusPath, JSON.stringify({
    state: 'LOCAL_AI_AVAILABLE', checked_at: '2026-08-16T12:00:00.000Z',
  }));

  const usage = scanLocalAiTelemetry(telemetryPath, statusPath, new Date('2026-08-16T12:00:00Z'));
  assert.equal(usage.routing.totals.rtx_delegation_rate_percent, 66.7);
  assert.equal(usage.routing.totals.weighted_context_savings_coverage_percent, 76);
  assert.equal(usage.routing.periods.today.missed_potential_tokens_avoidable, 1200);
  assert.equal(usage.routing.periods.today.missed_opportunities, 1);
  assert.equal(usage.routing.latest_decisions[0].endpoint, undefined);
});

test('does not expose a stale retrospective audit as current routing telemetry', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-routing-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const telemetryPath = path.join(directory, 'local-ai-telemetry.json');
  const statusPath = path.join(directory, 'local-ai-status.json');
  fs.writeFileSync(telemetryPath, JSON.stringify({
    routing: { totals: { tasks: 2, missed_opportunities: 0 } },
    daily: { '2026-08-17': { routing: { tasks: 2, missed_opportunities: 0 } } },
  }));
  fs.writeFileSync(path.join(directory, 'local-ai-routing-audit.json'), JSON.stringify({
    schema_version: 1,
    audited_at: '2026-08-17T15:00:00Z',
    window_days: 7,
    conversations_audited: 18,
    candidates: 13,
    correctly_used: 2,
    historical_missed_opportunities: 11,
    historical_unavailable: 0,
    unnecessary_calls: 1,
    deterministic: 3,
    too_small: 2,
    not_appropriate: 0,
    retrospective_today_conversations: 18,
    retrospective_today_candidates: 15,
    retrospective_today_correctly_used: 2,
    retrospective_today_missed_opportunities: 13,
    adjustments: ['post_tool_routing_hook'],
    private_prompt: 'must not expose',
  }));
  fs.writeFileSync(statusPath, JSON.stringify({
    state: 'LOCAL_AI_AVAILABLE', checked_at: '2026-08-17T15:00:00.000Z',
  }));

  const usage = scanLocalAiTelemetry(telemetryPath, statusPath, new Date('2026-08-17T15:00:00Z'));
  assert.equal(usage.routing.periods.today.tasks, 2);
  assert.equal(usage.routing.periods.today.missed_opportunities, 0);
  assert.equal(usage.routing.audit, undefined);
});

test('returns a bounded quality-aware Local AI history for the last 48 hours', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-local-ai-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const telemetryPath = path.join(directory, 'local-ai-telemetry.json');
  fs.writeFileSync(telemetryPath, JSON.stringify({ latest_jobs: [
    { id: 'old', task: 'review-diff', status: 'success', quality_accepted: true,
      finished_at: '2026-08-14T11:59:00Z', useful_context_tokens_avoided: 500 },
    { id: 'benchmark', task: 'benchmark:review-diff', status: 'success',
      finished_at: '2026-08-16T11:00:00Z' },
    { id: 'discarded-quality', task: 'inspect-files', status: 'discarded', quality_accepted: false,
      discard_reason: 'quality_gate_rejected', finished_at: '2026-08-16T11:30:00Z',
      useful_context_tokens_avoided: 900 },
    { id: 'discarded-savings', task: 'summarize-document', status: 'discarded', quality_accepted: false,
      finished_at: '2026-08-16T11:40:00Z', context_input_tokens: 2_463,
      context_output_tokens: 713, quality_validation_tokens: 6_488,
      quality_validation_tokens_measured: true, quality_score_percent: 100,
      useful_context_tokens_avoided: 1_750 },
    { id: 'accepted', task: 'summarize-log', status: 'success', quality_accepted: true,
      finished_at: '2026-08-16T11:45:00Z', useful_context_tokens_avoided: 800 },
  ] }));

  const history = scanLocalAiHistory(telemetryPath, new Date('2026-08-16T12:00:00Z'));
  assert.equal(history.window_hours, 48);
  assert.equal(history.count, 3);
  assert.equal(history.jobs[0].task, 'summarize-log');
  assert.equal(history.jobs[0].useful_context_tokens_avoided, 800);
  assert.equal(history.jobs[1].discard_reason, 'insufficient_net_savings');
  assert.equal(history.jobs[1].quality_score_percent, 100);
  assert.equal(history.jobs[1].useful_context_tokens_avoided, 0);
  assert.equal(history.jobs[2].discard_reason, 'quality_gate_rejected');
  assert.equal(history.jobs[2].useful_context_tokens_avoided, 0);
});

test('separates confirmed RTX unavailability from unknown availability', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-routing-availability-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const telemetryPath = path.join(directory, 'local-ai-telemetry.json');
  const statusPath = path.join(directory, 'local-ai-status.json');
  fs.writeFileSync(telemetryPath, JSON.stringify({
    routing: { totals: {
      unavailable_tasks: 4, availability_unknown_tasks: 3, confirmed_unavailable_tasks: 1,
    } },
    daily: { '2026-08-17': { routing: {
      unavailable_tasks: 3, availability_unknown_tasks: 3, confirmed_unavailable_tasks: 0,
    } } },
  }));
  fs.writeFileSync(statusPath, JSON.stringify({
    state: 'LOCAL_AI_AVAILABLE', checked_at: '2026-08-17T15:00:00.000Z',
  }));
  const usage = scanLocalAiTelemetry(telemetryPath, statusPath, new Date('2026-08-17T15:00:00Z'));
  assert.equal(usage.routing.periods.today.confirmed_unavailable_tasks, 0);
  assert.equal(usage.routing.periods.today.availability_unknown_tasks, 3);
  assert.equal(usage.routing.periods.today.unclassified_unavailable_tasks, 0);
});

test('labels an unmeasured used decision as failed when its matching Local AI job failed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-routing-failure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const telemetryPath = path.join(directory, 'local-ai-telemetry.json');
  const statusPath = path.join(directory, 'local-ai-status.json');
  fs.writeFileSync(telemetryPath, JSON.stringify({
    routing: { latest_decisions: [{
      id: 'decision', timestamp: '2026-08-16T12:00:01.000Z', task_type: 'review-diff',
      decision: 'LOCAL_AI_USED', reason: 'local_ai_completed',
    }] },
    latest_jobs: [{
      id: 'failed-job', task: 'review-diff', status: 'failed',
      finished_at: '2026-08-16T12:00:00.000Z', error_type: 'RuntimeError',
    }],
  }));
  fs.writeFileSync(statusPath, JSON.stringify({
    state: 'LOCAL_AI_AVAILABLE', checked_at: '2026-08-16T12:00:00.000Z',
  }));

  const usage = scanLocalAiTelemetry(telemetryPath, statusPath, new Date('2026-08-16T12:00:00Z'));
  assert.equal(usage.routing.latest_decisions[0].decision, 'LOCAL_AI_FAILED');
  assert.equal(usage.routing.latest_decisions[0].reason, 'local_ai_call_failed');
  assert.equal(usage.routing.latest_decisions[0].actual_tokens_avoided, 0);
  assert.equal(usage.routing.latest_decisions[0].useful_tokens_avoided, 0);
});

test('normalizes rejected routing and discarded jobs to zero useful savings', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-routing-rejected-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const telemetryPath = path.join(directory, 'local-ai-telemetry.json');
  const statusPath = path.join(directory, 'local-ai-status.json');
  fs.writeFileSync(telemetryPath, JSON.stringify({
    routing: { latest_decisions: [{
      id: 'rejected', timestamp: '2026-08-16T12:00:00.000Z', task_type: 'review-diff',
      decision: 'LOCAL_AI_QUALITY_REJECTED', reason: 'quality_gate_rejected',
    }] },
    latest_jobs: [{
      id: 'discarded', task: 'review-diff', status: 'discarded', quality_accepted: false,
      finished_at: '2026-08-16T12:00:00.000Z', useful_context_tokens_avoided: 900,
    }],
  }));
  fs.writeFileSync(statusPath, JSON.stringify({
    state: 'LOCAL_AI_AVAILABLE', checked_at: '2026-08-16T12:00:00.000Z',
  }));

  const usage = scanLocalAiTelemetry(telemetryPath, statusPath, new Date('2026-08-16T12:00:00Z'));
  assert.equal(usage.routing.latest_decisions[0].actual_tokens_avoided, 0);
  assert.equal(usage.routing.latest_decisions[0].useful_tokens_avoided, 0);
  assert.equal(usage.latest_jobs[0].useful_context_tokens_avoided, 0);
});

test('reports bounded memory retrieval separately from tool-output context savings', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-memory-routing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const telemetryPath = path.join(directory, 'local-ai-telemetry.json');
  const statusPath = path.join(directory, 'local-ai-status.json');
  fs.writeFileSync(telemetryPath, JSON.stringify({
    memory: {
      totals: {
        retrieval_calls: 2, retrieval_skips: 1, files_found: 4, memory_tokens_available: 3655,
        memory_tokens_retrieved: 2400, memory_tokens_sent_to_local_ai: 2200,
        memory_tokens_sent_to_primary_model: 420, memory_tokens_avoided: 1980,
        compression_events: 1, memory_overload_incidents: 0,
      },
      startup_context: {
        global_agents_tokens: 4034, repo_agents_tokens: 4158,
        observable_startup_context_tokens: 8192, total_startup_context_tokens: null,
        estimated: true,
      },
      latest_decisions: [{
        id: 'memory', timestamp: '2026-08-17T12:00:00Z', topic: 'codex-local-ai',
        files_found: 2, memory_tokens_retrieved: 2000, memory_tokens_sent_to_primary_model: 200,
        decision: 'MEMORY_LOCAL_AI_USED', reason: 'memory_compressed_locally', source: 'must not expose',
      }],
    },
    daily: {
      '2026-08-17': { memory: {
        retrieval_calls: 2, retrieval_skips: 1, files_found: 4, memory_tokens_available: 3655,
        memory_tokens_retrieved: 2400, memory_tokens_sent_to_local_ai: 2200,
        memory_tokens_sent_to_primary_model: 420, memory_tokens_avoided: 1980,
        compression_events: 1, memory_overload_incidents: 0,
      } },
    },
  }));
  fs.writeFileSync(statusPath, JSON.stringify({
    state: 'LOCAL_AI_AVAILABLE', checked_at: '2026-08-17T12:00:00.000Z',
  }));

  const usage = scanLocalAiTelemetry(telemetryPath, statusPath, new Date('2026-08-17T12:00:00Z'));
  assert.equal(usage.memory.totals.memory_compression_percent, 82.5);
  assert.equal(usage.memory.periods.today.memory_tokens_avoided, 1980);
  assert.equal(usage.memory.startup_context.observable_startup_context_tokens, 8192);
  assert.equal(usage.memory.latest_decisions[0].source, undefined);
});
