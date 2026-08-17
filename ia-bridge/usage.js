const fs = require('fs');
const path = require('path');

function listJsonlFiles(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJsonlFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(entryPath);
  }
  return files;
}

function emptyTokens() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

function addTokens(target, usage) {
  for (const key of Object.keys(target)) {
    const value = Number(usage?.[key]);
    if (Number.isFinite(value) && value > 0) target[key] += value;
  }
}

function isoFromEpoch(value) {
  const epoch = Number(value);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  return new Date(epoch * 1000).toISOString();
}

const LIVE_USAGE_MAX_AGE_MS = 2 * 60 * 1000;
const RATE_LIMIT_MAX_AGE_MS = 15 * 60 * 1000;
const LIVE_GPU_SAMPLE_MAX_AGE_MS = 10 * 1000;
const ACTIVE_JOB_START_GRACE_MS = 10 * 1000;

function freshness(timestamp, now, maxAgeMs = LIVE_USAGE_MAX_AGE_MS) {
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.valueOf())) {
    return { current: false, age_seconds: null, max_age_seconds: Math.round(maxAgeMs / 1000) };
  }
  const ageMs = Math.max(0, now.valueOf() - timestamp.valueOf());
  return {
    current: ageMs <= maxAgeMs,
    age_seconds: Math.round(ageMs / 1000),
    max_age_seconds: Math.round(maxAgeMs / 1000),
  };
}

function sanitizeRateLimits(rateLimits) {
  if (!rateLimits) return null;
  const primary = rateLimits.primary || null;
  const credits = rateLimits.credits || null;
  const windowMinutes = Number.isFinite(Number(primary?.window_minutes))
    ? Number(primary.window_minutes)
    : null;
  const resetsAt = isoFromEpoch(primary?.resets_at);
  const windowType = windowMinutes === 7 * 24 * 60
    ? 'weekly'
    : windowMinutes === 24 * 60 ? 'daily' : 'rolling';
  const windowStartedAt = resetsAt && windowMinutes
    ? new Date(new Date(resetsAt).valueOf() - windowMinutes * 60_000).toISOString()
    : null;

  return {
    limit_id: rateLimits.limit_id || null,
    plan_type: rateLimits.plan_type || null,
    used_percent: Number.isFinite(Number(primary?.used_percent))
      ? Number(primary.used_percent)
      : null,
    remaining_percent: Number.isFinite(Number(primary?.used_percent))
      ? Math.max(0, 100 - Number(primary.used_percent))
      : null,
    window_minutes: windowMinutes,
    window_type: windowType,
    window_started_at: windowStartedAt,
    resets_at: resetsAt,
    credits: {
      has_credits: credits?.has_credits === true,
      unlimited: credits?.unlimited === true,
      balance: credits?.balance ?? null,
    },
    spend_control_reached: rateLimits.spend_control_reached === true,
    reached_type: rateLimits.rate_limit_reached_type || null,
  };
}

function planType(rateLimits) {
  const value = rateLimits?.plan_type;
  return typeof value === 'string' && value.trim() ? value : null;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function buildAnalytics({ totals, recentTokens, rateLimit, rateLimitSamples = [], now }) {
  const input = Number(totals.input_tokens) || 0;
  const cached = Number(totals.cached_input_tokens) || 0;
  const cacheHitPercent = input > 0 ? round((cached / input) * 100, 1) : null;
  const cacheEfficiency = cacheHitPercent === null
    ? 'sem_dados'
    : cacheHitPercent >= 80 ? 'excelente'
      : cacheHitPercent >= 60 ? 'boa'
        : cacheHitPercent >= 30 ? 'moderada' : 'baixa';

  const sevenDaysHours = 7 * 24;
  const tokensPerHour7d = round(recentTokens.total_tokens / sevenDaysHours, 0);
  const tokensPerDay7d = round(recentTokens.total_tokens / 7, 0);
  const forecast = {
    status: 'insuficiente',
    will_last: null,
    confidence: 'baixa',
    percent_per_day: null,
    projected_used_at_reset: null,
    projected_remaining_at_reset: null,
    estimated_exhaust_at: null,
    elapsed_window_percent: null,
  };

  const used = Number(rateLimit?.used_percent);
  const windowMinutes = Number(rateLimit?.window_minutes);
  const resetAt = rateLimit?.resets_at ? new Date(rateLimit.resets_at) : null;
  if (
    Number.isFinite(used)
    && Number.isFinite(windowMinutes)
    && windowMinutes > 0
    && resetAt
    && !Number.isNaN(resetAt.valueOf())
  ) {
    const windowStart = new Date(resetAt.valueOf() - windowMinutes * 60_000);
    const elapsedMs = Math.min(
      windowMinutes * 60_000,
      Math.max(0, now.valueOf() - windowStart.valueOf()),
    );
    const remainingMs = Math.max(0, resetAt.valueOf() - now.valueOf());
    const remainingDays = remainingMs / 86_400_000;
    const elapsedWindowPercent = (elapsedMs / (windowMinutes * 60_000)) * 100;
    forecast.elapsed_window_percent = round(elapsedWindowPercent, 1);

    // A snapshot can first appear after much of the weekly allowance has
    // already been consumed, including usage from other machines. Derive pace
    // only from two observations in the same reset window; treating the
    // current percentage as usage since the theoretical window start produces
    // misleading projections immediately after the bridge sees a new window.
    const samples = rateLimitSamples
      .filter((sample) => (
        sample.resets_at === rateLimit.resets_at
        && Number.isFinite(Number(sample.used_percent))
        && sample.timestamp instanceof Date
        && !Number.isNaN(sample.timestamp.valueOf())
        && sample.timestamp >= windowStart
        && sample.timestamp <= now
      ))
      .sort((left, right) => left.timestamp - right.timestamp);
    const first = samples[0];
    const last = samples.at(-1);
    const observedMs = first && last ? last.timestamp - first.timestamp : 0;
    const usedDelta = first && last
      ? Math.max(0, Number(last.used_percent) - Number(first.used_percent))
      : 0;

    if (observedMs >= 3_600_000) {
      const percentPerDay = usedDelta / (observedMs / 86_400_000);
      const projected = Math.min(100, used + percentPerDay * remainingDays);
      forecast.status = projected < 90 ? 'aguenta' : projected < 100 ? 'atencao' : 'risco';
      forecast.will_last = projected < 100;
      forecast.confidence = observedMs >= 24 * 3_600_000
        ? 'alta'
        : observedMs >= 6 * 3_600_000 ? 'media' : 'baixa';
      forecast.percent_per_day = round(percentPerDay, 2);
      forecast.projected_used_at_reset = round(projected, 1);
      forecast.projected_remaining_at_reset = round(Math.max(0, 100 - projected), 1);
      if (percentPerDay > 0 && projected >= 100) {
        forecast.estimated_exhaust_at = new Date(
          now.valueOf() + ((100 - used) / percentPerDay) * 86_400_000,
        ).toISOString();
      }
    }
  }

  return {
    cache_hit_percent: cacheHitPercent,
    cache_efficiency: cacheEfficiency,
    fresh_input_tokens: Math.max(0, input - cached),
    tokens_per_hour_7d: tokensPerHour7d,
    tokens_per_day_7d: tokensPerDay7d,
    forecast,
  };
}

function emptyLocalAiTotals() {
  return {
    calls: 0,
    successful_calls: 0,
    failed_calls: 0,
    fallbacks_reported: 0,
    duration_seconds: 0,
    local_input_tokens: 0,
    local_output_tokens: 0,
    context_input_tokens: 0,
    context_output_tokens: 0,
    context_overhead_tokens: 0,
    openai_context_tokens_avoided: 0,
  };
}

function emptyRoutingTotals() {
  return {
    tasks: 0,
    deterministic_tasks: 0,
    eligible_tasks: 0,
    eligible_and_available_tasks: 0,
    used_tasks: 0,
    failed_tasks: 0,
    skipped_tasks: 0,
    unavailable_tasks: 0,
    availability_unknown_tasks: 0,
    confirmed_unavailable_tasks: 0,
    not_beneficial_tasks: 0,
    missed_opportunities: 0,
    unnecessary_calls: 0,
    potential_tokens_avoidable: 0,
    actual_tokens_avoided: 0,
  };
}

function emptyMemoryTotals() {
  return {
    retrieval_calls: 0,
    retrieval_skips: 0,
    files_found: 0,
    memory_tokens_available: 0,
    memory_tokens_retrieved: 0,
    memory_tokens_sent_to_local_ai: 0,
    memory_tokens_sent_to_primary_model: 0,
    memory_tokens_avoided: 0,
    compression_events: 0,
    memory_overload_incidents: 0,
    local_ai_unavailable: 0,
    local_ai_not_beneficial: 0,
  };
}

function addLocalAiTotals(target, source) {
  for (const key of Object.keys(emptyLocalAiTotals())) {
    const value = Number(source?.[key]);
    if (Number.isFinite(value) && (value > 0 || (key === 'openai_context_tokens_avoided' && value !== 0))) {
      target[key] += value;
    }
  }
  return target;
}

function localAiDerived(totals) {
  const calls = Number(totals.calls) || 0;
  const successful = Number(totals.successful_calls) || 0;
  const failed = Number(totals.failed_calls) || 0;
  const input = Number(totals.context_input_tokens) || 0;
  const avoided = Number(totals.openai_context_tokens_avoided) || 0;
  const duration = Number(totals.duration_seconds) || 0;
  return {
    context_reduction_percent: input > 0 ? round((avoided / input) * 100, 1) : null,
    success_rate_percent: calls > 0 ? round((successful / calls) * 100, 1) : null,
    failure_rate_percent: calls > 0 ? round((failed / calls) * 100, 1) : null,
    average_duration_seconds: calls > 0 ? round(duration / calls, 2) : null,
  };
}

function addRoutingTotals(target, source) {
  for (const key of Object.keys(emptyRoutingTotals())) {
    const value = Number(source?.[key]);
    if (Number.isFinite(value)) target[key] += value;
  }
  return target;
}

function routingDerived(totals) {
  const eligibleAvailable = Number(totals.eligible_and_available_tasks) || 0;
  const used = Number(totals.used_tasks) || 0;
  const potential = Number(totals.potential_tokens_avoidable) || 0;
  const actual = Number(totals.actual_tokens_avoided) || 0;
  const unavailable = Number(totals.unavailable_tasks) || 0;
  const availabilityUnknown = Number(totals.availability_unknown_tasks) || 0;
  const confirmedUnavailable = Number(totals.confirmed_unavailable_tasks) || 0;
  return {
    rtx_delegation_rate_percent: eligibleAvailable > 0
      ? round((used / eligibleAvailable) * 100, 1)
      : null,
    weighted_context_savings_coverage_percent: potential > 0
      ? round(Math.min(100, Math.max(0, actual) / potential * 100), 1)
      : null,
    unclassified_unavailable_tasks: Math.max(0, unavailable - availabilityUnknown - confirmedUnavailable),
  };
}

function addMemoryTotals(target, source) {
  for (const key of Object.keys(emptyMemoryTotals())) {
    const value = Number(source?.[key]);
    if (!Number.isFinite(value)) continue;
    // Available corpus is a point-in-time inventory, never a sum of every
    // retrieval event. Keep its latest-largest observed value across periods.
    if (key === 'memory_tokens_available') target[key] = Math.max(target[key], value);
    else target[key] += value;
  }
  return target;
}

function memoryDerived(totals) {
  const retrieved = Number(totals.memory_tokens_retrieved) || 0;
  const avoided = Number(totals.memory_tokens_avoided) || 0;
  return {
    memory_compression_percent: retrieved > 0 ? round((avoided / retrieved) * 100, 1) : null,
  };
}

function readJson(pathname, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pathname, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function isoDayOffset(now, daysAgo) {
  const date = new Date(now.valueOf() - daysAgo * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function summarizePeriod(daily, now, days) {
  const totals = emptyLocalAiTotals();
  for (let offset = 0; offset < days; offset += 1) {
    addLocalAiTotals(totals, daily?.[isoDayOffset(now, offset)]?.totals);
  }
  return { ...totals, ...localAiDerived(totals) };
}

function summarizeMonth(daily, now) {
  const totals = emptyLocalAiTotals();
  const prefix = now.toISOString().slice(0, 7);
  for (const [day, value] of Object.entries(daily || {})) {
    if (day.startsWith(prefix)) addLocalAiTotals(totals, value?.totals);
  }
  return { ...totals, ...localAiDerived(totals) };
}

function summarizeRoutingPeriod(daily, now, days) {
  const totals = emptyRoutingTotals();
  for (let offset = 0; offset < days; offset += 1) {
    addRoutingTotals(totals, daily?.[isoDayOffset(now, offset)]?.routing);
  }
  return { ...totals, ...routingDerived(totals) };
}

function summarizeRoutingMonth(daily, now) {
  const totals = emptyRoutingTotals();
  const prefix = now.toISOString().slice(0, 7);
  for (const [day, value] of Object.entries(daily || {})) {
    if (day.startsWith(prefix)) addRoutingTotals(totals, value?.routing);
  }
  return { ...totals, ...routingDerived(totals) };
}

function summarizeMemoryPeriod(daily, now, days) {
  const totals = emptyMemoryTotals();
  for (let offset = 0; offset < days; offset += 1) {
    addMemoryTotals(totals, daily?.[isoDayOffset(now, offset)]?.memory);
  }
  return { ...totals, ...memoryDerived(totals) };
}

function summarizeMemoryMonth(daily, now) {
  const totals = emptyMemoryTotals();
  const prefix = now.toISOString().slice(0, 7);
  for (const [day, value] of Object.entries(daily || {})) {
    if (day.startsWith(prefix)) addMemoryTotals(totals, value?.memory);
  }
  return { ...totals, ...memoryDerived(totals) };
}

function sanitizeLocalAiJob(job) {
  if (!job || typeof job !== 'object') return {};
  // The dashboard needs only operational metadata. Keeping this compact avoids
  // Home Assistant's 16 KiB state-attribute limit and never exposes endpoint
  // details through its state machine or Recorder.
  const fields = [
    'id', 'status', 'task', 'model', 'chat_id', 'chat_name', 'started_at', 'finished_at',
    'duration_seconds', 'error_type', 'fallback_reported',
    'context_input_tokens', 'context_output_tokens',
    'context_overhead_tokens', 'context_overhead_method', 'context_savings_estimated',
    'token_count_method', 'context_replacement',
    'deterministic_omitted_lines', 'model_input_chars',
    'openai_context_tokens_avoided', 'context_reduction_percent',
    'tokens_per_second', 'local_attempts', 'gpu_telemetry_available', 'gpu_peak_percent',
    'vram_peak_mib', 'gpu_power_peak_watts', 'processor',
    'cpu_offload_detected',
  ];
  const sanitized = Object.fromEntries(
    fields.filter((field) => Object.hasOwn(job, field)).map((field) => [field, job[field]]),
  );
  // This is operational data only, but unlike the aggregate peaks it is the
  // actual sample for the running job. The one-second RTX card needs it to
  // show GPU, VRAM and power while work is in progress.
  if (job.live_gpu && typeof job.live_gpu === 'object') {
    const liveGpuFields = [
      'at', 'gpu_util_percent', 'vram_mib', 'vram_total_mib', 'power_watts',
    ];
    sanitized.live_gpu = Object.fromEntries(
      liveGpuFields
        .filter((field) => Object.hasOwn(job.live_gpu, field))
        .map((field) => [field, job.live_gpu[field]]),
    );
  }
  return sanitized;
}

function sanitizeRoutingDecision(decision) {
  if (!decision || typeof decision !== 'object') return {};
  const fields = [
    'id', 'timestamp', 'task_type', 'input_chars', 'estimated_input_tokens',
    'compressibility', 'compatible_helper', 'eligible', 'available',
    'expected_tokens_saved', 'actual_tokens_avoided', 'decision', 'reason',
    'minimum_input_tokens', 'minimum_expected_saved_tokens', 'model',
  ];
  return Object.fromEntries(
    fields.filter((field) => Object.hasOwn(decision, field)).map((field) => [field, decision[field]]),
  );
}

function sanitizeMemoryDecision(decision) {
  if (!decision || typeof decision !== 'object') return {};
  const fields = [
    'id', 'timestamp', 'topic', 'files_found', 'memory_tokens_available',
    'memory_tokens_retrieved', 'memory_tokens_sent_to_local_ai',
    'memory_tokens_sent_to_primary_model', 'memory_tokens_avoided',
    'decision', 'reason', 'available', 'expected_tokens_saved',
    'minimum_input_tokens', 'minimum_expected_saved_tokens', 'model',
    'memory_overload', 'canonical_source_conflict', 'token_count_method', 'estimated',
  ];
  return Object.fromEntries(
    fields.filter((field) => Object.hasOwn(decision, field)).map((field) => [field, decision[field]]),
  );
}

function sanitizeRoutingAudit(audit) {
  if (!audit || typeof audit !== 'object') return null;
  const numericFields = [
    'schema_version', 'window_days', 'conversations_audited', 'candidates',
    'correctly_used', 'historical_missed_opportunities', 'historical_unavailable',
    'unnecessary_calls', 'deterministic', 'too_small', 'not_appropriate',
    'retrospective_today_conversations', 'retrospective_today_candidates',
    'retrospective_today_correctly_used', 'retrospective_today_missed_opportunities',
  ];
  const result = {};
  for (const field of numericFields) {
    const value = Number(audit[field]);
    if (Number.isFinite(value) && value >= 0) result[field] = value;
  }
  if (typeof audit.audited_at === 'string' && !Number.isNaN(new Date(audit.audited_at).valueOf())) {
    result.audited_at = audit.audited_at;
  }
  result.adjustments = Array.isArray(audit.adjustments)
    ? audit.adjustments
      .filter((value) => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value))
      .slice(0, 12)
    : [];
  return Number.isFinite(result.conversations_audited) ? result : null;
}

function reconcileRoutingDecisions(decisions, jobs) {
  return decisions.map((decision) => {
    if (
      decision.decision !== 'LOCAL_AI_USED'
      || decision.reason !== 'local_ai_completed'
      || Object.hasOwn(decision, 'actual_tokens_avoided')
    ) return decision;
    const timestamp = new Date(decision.timestamp);
    const matchingFailure = jobs.find((job) => {
      if (job.status !== 'failed' || job.task !== decision.task_type) return false;
      const finished = new Date(job.finished_at);
      return !Number.isNaN(timestamp.valueOf())
        && !Number.isNaN(finished.valueOf())
        && Math.abs(finished.valueOf() - timestamp.valueOf()) <= 60_000;
    });
    return matchingFailure
      ? { ...decision, decision: 'LOCAL_AI_FAILED', reason: 'local_ai_call_failed' }
      : decision;
  });
}

function scanLocalAiTelemetry(telemetryPath, statusPath, now = new Date()) {
  const state = readJson(telemetryPath, {});
  const preflight = readJson(statusPath, {});
  const auditPath = telemetryPath
    ? path.join(path.dirname(telemetryPath), 'local-ai-routing-audit.json')
    : null;
  const routingAudit = sanitizeRoutingAudit(auditPath ? readJson(auditPath, null) : null);
  const totals = { ...emptyLocalAiTotals(), ...(state.totals || {}) };
  const routingTotals = { ...emptyRoutingTotals(), ...(state.routing?.totals || {}) };
  const memoryTotals = { ...emptyMemoryTotals(), ...(state.memory?.totals || {}) };
  const activeJobs = Object.values(state.active_jobs || {});
  const recentActiveJobs = activeJobs
    .filter((job) => {
      const started = new Date(job.started_at);
      if (Number.isNaN(started.valueOf())) return false;
      const ageMs = Math.max(0, now.valueOf() - started.valueOf());
      if (ageMs >= 30 * 60_000) return false;
      // The helper refreshes this sample every 1.5 seconds. A record with no
      // recent sample is a crashed/abandoned job, not evidence that the RTX is
      // still working. Keep a short grace period while the sampler starts.
      return ageMs <= ACTIVE_JOB_START_GRACE_MS
        || freshness(new Date(job.live_gpu?.at), now, LIVE_GPU_SAMPLE_MAX_AGE_MS).current;
    })
    .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)));
  const sanitizedActiveJobs = recentActiveJobs.map(sanitizeLocalAiJob);
  const currentJob = sanitizedActiveJobs[0] || null;
  const preflightState = typeof preflight.state === 'string' ? preflight.state : 'LOCAL_AI_UNKNOWN';
  const preflightFreshness = freshness(new Date(preflight.checked_at), now);
  const preflightAvailable = preflightFreshness.current
    && (preflightState === 'LOCAL_AI_AVAILABLE' || preflightState === 'LOCAL_AI_DEGRADED');
  // A running job takes precedence because it is independently recorded by
  // the telemetry writer. Without one, never report a stale health check as
  // an available RTX.
  const stateName = currentJob
    ? 'LOCAL_AI_IN_USE'
    : preflightFreshness.current ? preflightState : 'LOCAL_AI_UNKNOWN';
  const models = Object.entries(state.models || {})
    .map(([model, value]) => ({ model, ...(value.totals || {}), ...localAiDerived(value.totals || {}) }))
    .sort((left, right) => Number(right.calls || 0) - Number(left.calls || 0));
  const latestJobs = Array.isArray(state.latest_jobs)
    ? state.latest_jobs.slice(-5).reverse().map(sanitizeLocalAiJob)
    : [];
  const latestDecisions = Array.isArray(state.routing?.latest_decisions)
    ? state.routing.latest_decisions.slice(-5).reverse().map(sanitizeRoutingDecision)
    : [];
  const latestMemoryDecisions = Array.isArray(state.memory?.latest_decisions)
    ? state.memory.latest_decisions.slice(-5).reverse().map(sanitizeMemoryDecision)
    : [];

  return {
    state: stateName,
    available: preflightAvailable,
    freshness: {
      preflight: preflightFreshness,
    },
    preflight: {
      state: preflightState,
      checked_at: preflight.checked_at || null,
      reason: preflight.reason || null,
      gpu: preflight.gpu || null,
      vram_free_mib: preflight.vram_free_mib ?? null,
      vram_total_mib: preflight.vram_total_mib ?? null,
      ollama: preflight.ollama === true,
      model: preflight.model || null,
    },
    current_job: currentJob,
    active_jobs: sanitizedActiveJobs,
    totals: { ...totals, ...localAiDerived(totals) },
    periods: {
      today: summarizePeriod(state.daily, now, 1),
      week: summarizePeriod(state.daily, now, 7),
      month: summarizeMonth(state.daily, now),
    },
    routing: {
      totals: { ...routingTotals, ...routingDerived(routingTotals) },
      periods: {
        today: summarizeRoutingPeriod(state.daily, now, 1),
        week: summarizeRoutingPeriod(state.daily, now, 7),
        month: summarizeRoutingMonth(state.daily, now),
      },
      latest_decisions: reconcileRoutingDecisions(latestDecisions, latestJobs),
      audit: routingAudit,
    },
    memory: {
      totals: { ...memoryTotals, ...memoryDerived(memoryTotals) },
      periods: {
        today: summarizeMemoryPeriod(state.daily, now, 1),
        week: summarizeMemoryPeriod(state.daily, now, 7),
        month: summarizeMemoryMonth(state.daily, now),
      },
      startup_context: state.memory?.startup_context && typeof state.memory.startup_context === 'object'
        ? state.memory.startup_context
        : null,
      latest_decisions: latestMemoryDecisions,
    },
    models,
    // Five jobs cover the current job plus recent diagnostics, while staying
    // well below the attribute-size limit enforced by Home Assistant.
    latest_jobs: latestJobs,
  };
}

function scanCodexUsageFile(filePath) {
  const totals = emptyTokens();
  const daily = new Map();
  let latestEvent = null;
  let latestRateEvent = null;
  let latestPlanEvent = null;
  let latestCreditEvent = null;
  let eventCount = 0;
  const rateEvents = [];

  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let previousTotal = emptyTokens();
  let hasUsage = false;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;

    const timestamp = new Date(event.timestamp);
    if (Number.isNaN(timestamp.valueOf())) continue;
    eventCount += 1;
    hasUsage = true;

    const current = event.payload.info?.total_token_usage || {};
    const delta = emptyTokens();
    for (const key of Object.keys(delta)) {
      const currentValue = Math.max(0, Number(current[key]) || 0);
      const previousValue = Math.max(0, Number(previousTotal[key]) || 0);
      delta[key] = currentValue >= previousValue ? currentValue - previousValue : currentValue;
    }
    addTokens(totals, delta);
    const day = timestamp.toISOString().slice(0, 10);
    const dayUsage = daily.get(day) || emptyTokens();
    addTokens(dayUsage, delta);
    daily.set(day, dayUsage);
    previousTotal = { ...previousTotal, ...current };

    const candidate = { timestamp, rateLimits: event.payload.rate_limits };
    if (!latestEvent || timestamp > latestEvent.timestamp) latestEvent = candidate;
    if (
      event.payload.rate_limits?.primary
      && (!latestRateEvent || timestamp > latestRateEvent.timestamp)
    ) latestRateEvent = candidate;
    if (
      planType(event.payload.rate_limits)
      && (!latestPlanEvent || timestamp > latestPlanEvent.timestamp)
    ) latestPlanEvent = candidate;
    if (event.payload.rate_limits?.primary) rateEvents.push(candidate);
    if (
      event.payload.rate_limits?.credits
      && (!latestCreditEvent || timestamp > latestCreditEvent.timestamp)
    ) latestCreditEvent = candidate;
  }

  return {
    totals,
    daily,
    latestEvent,
    latestRateEvent,
    latestPlanEvent,
    latestCreditEvent,
    sessionCount: hasUsage ? 1 : 0,
    eventCount,
    rateEvents,
  };
}

function buildCodexUsage(fileSummaries, now = new Date(), liveRateEvent = null) {
  const totals = emptyTokens();
  const recentTokens = emptyTokens();
  const daily = new Map();
  let latestEvent = null;
  let latestRateEvent = null;
  let latestPlanEvent = null;
  let latestCreditEvent = null;
  let sessionCount = 0;
  let eventCount = 0;
  const rateLimitSamples = [];

  for (const summary of fileSummaries) {
    if (!summary) continue;
    addTokens(totals, summary.totals);
    sessionCount += summary.sessionCount;
    eventCount += summary.eventCount;
    for (const event of summary.rateEvents || []) {
      const sample = sanitizeRateLimits(event.rateLimits);
      if (sample) rateLimitSamples.push({ timestamp: event.timestamp, ...sample });
    }
    if (!latestEvent || summary.latestEvent?.timestamp > latestEvent.timestamp) {
      latestEvent = summary.latestEvent || latestEvent;
    }
    if (!latestRateEvent || summary.latestRateEvent?.timestamp > latestRateEvent.timestamp) {
      latestRateEvent = summary.latestRateEvent || latestRateEvent;
    }
    if (!latestPlanEvent || summary.latestPlanEvent?.timestamp > latestPlanEvent.timestamp) {
      latestPlanEvent = summary.latestPlanEvent || latestPlanEvent;
    }
    if (!latestCreditEvent || summary.latestCreditEvent?.timestamp > latestCreditEvent.timestamp) {
      latestCreditEvent = summary.latestCreditEvent || latestCreditEvent;
    }
    for (const [day, usage] of summary.daily.entries()) {
      const dayUsage = daily.get(day) || emptyTokens();
      addTokens(dayUsage, usage);
      daily.set(day, dayUsage);
    }
  }

  // Session JSONL files only receive a new rate-limit snapshot when a model
  // turn emits token telemetry. The app-server snapshot is independent of a
  // turn, so it can keep the plan limit current while Codex is idle.
  if (liveRateEvent?.rateLimits && liveRateEvent.timestamp instanceof Date) {
    const liveSample = sanitizeRateLimits(liveRateEvent.rateLimits);
    if (liveSample) {
      rateLimitSamples.push({ timestamp: liveRateEvent.timestamp, ...liveSample });
      if (!latestRateEvent || liveRateEvent.timestamp > latestRateEvent.timestamp) {
        latestRateEvent = liveRateEvent;
      }
      if (planType(liveRateEvent.rateLimits) && (
        !latestPlanEvent || liveRateEvent.timestamp > latestPlanEvent.timestamp
      )) latestPlanEvent = liveRateEvent;
      if (
        liveRateEvent.rateLimits.credits
        && (!latestCreditEvent || liveRateEvent.timestamp > latestCreditEvent.timestamp)
      ) latestCreditEvent = liveRateEvent;
    }
  }

  for (const [day, usage] of daily.entries()) {
    const timestamp = new Date(`${day}T00:00:00.000Z`);
    if (timestamp.valueOf() >= now.valueOf() - 7 * 86_400_000) addTokens(recentTokens, usage);
  }

  // The app-server's account endpoint is the canonical general allowance.
  // Session token events can instead carry the currently selected model's
  // allowance (for example, Codex-Spark), so a newer model event must never
  // replace an available account-level snapshot in this dashboard feed.
  const hasLiveRateLimit = liveRateEvent?.rateLimits
    && liveRateEvent.timestamp instanceof Date
    && !Number.isNaN(liveRateEvent.timestamp.valueOf());
  const rateSource = hasLiveRateLimit ? liveRateEvent : (latestRateEvent || latestEvent);
  const sanitized = sanitizeRateLimits(rateSource?.rateLimits);
  const lastKnownPlanType = planType(latestPlanEvent?.rateLimits);
  if (sanitized && !sanitized.plan_type && lastKnownPlanType) {
    sanitized.plan_type = lastKnownPlanType;
  }
  const creditSnapshot = sanitizeRateLimits(latestCreditEvent?.rateLimits)?.credits;
  if (sanitized && creditSnapshot) sanitized.credits = creditSnapshot;

  const analytics = buildAnalytics({
    totals,
    recentTokens,
    rateLimit: sanitized,
    rateLimitSamples,
    now,
  });

  return {
    status: latestEvent || latestRateEvent ? 'ok' : 'no_data',
    collected_at: now.toISOString(),
    source_updated_at: latestEvent?.timestamp.toISOString() || null,
    rate_limit_updated_at: rateSource?.timestamp.toISOString() || null,
    plan_type: sanitized?.plan_type || null,
    rate_limit: sanitized,
    rate_limit_refresh: liveRateEvent?.refreshMetadata || null,
    freshness: {
      activity: freshness(latestEvent?.timestamp, now),
      rate_limit: freshness(rateSource?.timestamp, now, RATE_LIMIT_MAX_AGE_MS),
    },
    totals: { ...totals, sessions: sessionCount, events: eventCount },
    analytics,
    daily: [...daily.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-30)
      .map(([date, usage]) => ({ date, ...usage })),
  };
}

function scanCodexUsage(sessionsDirectory, now = new Date()) {
  const directories = Array.isArray(sessionsDirectory) ? sessionsDirectory : [sessionsDirectory];
  const files = [...new Set(directories.flatMap((directory) => listJsonlFiles(directory)))];
  return buildCodexUsage(files.map(scanCodexUsageFile), now);
}

class CodexUsageReader {
  constructor(sessionsDirectory, localAiTelemetryPath = null, localAiStatusPath = null, cacheMs = 5_000) {
    this.sessionsDirectories = Array.isArray(sessionsDirectory) ? sessionsDirectory : [sessionsDirectory];
    this.localAiTelemetryPath = localAiTelemetryPath;
    this.localAiStatusPath = localAiStatusPath;
    this.cacheMs = cacheMs;
    this.cachedAt = 0;
    this.cached = null;
    this.usageFiles = new Map();
  }

  readCodexUsage(now, liveRateEvent = null) {
    const files = [...new Set(
      this.sessionsDirectories.flatMap((directory) => listJsonlFiles(directory)),
    )];
    const present = new Set(files);
    for (const filePath of files) {
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      const fingerprint = `${stat.size}:${stat.mtimeMs}`;
      const previous = this.usageFiles.get(filePath);
      if (!previous || previous.fingerprint !== fingerprint || !previous.summary) {
        this.usageFiles.set(filePath, {
          fingerprint,
          summary: scanCodexUsageFile(filePath),
        });
      }
    }
    for (const filePath of this.usageFiles.keys()) {
      if (!present.has(filePath)) this.usageFiles.delete(filePath);
    }
    return buildCodexUsage(
      [...this.usageFiles.values()].map((entry) => entry.summary),
      now,
      liveRateEvent,
    );
  }

  read(liveRateEvent = null) {
    if (this.cached && Date.now() - this.cachedAt < this.cacheMs) return this.cached;
    const now = new Date();
    this.cached = {
      ...this.readCodexUsage(now, liveRateEvent),
      local_ai: scanLocalAiTelemetry(this.localAiTelemetryPath, this.localAiStatusPath),
    };
    this.cachedAt = Date.now();
    return this.cached;
  }

  readLocalAiLive() {
    return scanLocalAiTelemetry(this.localAiTelemetryPath, this.localAiStatusPath);
  }
}

module.exports = { CodexUsageReader, scanCodexUsage, scanLocalAiTelemetry };
