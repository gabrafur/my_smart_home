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
    operational_calls: 0,
    operational_successful_calls: 0,
    operational_failed_calls: 0,
    operational_quality_rejected_calls: 0,
    operational_not_beneficial_calls: 0,
    operational_quality_validated_calls: 0,
    operational_quality_validated_measured_calls: 0,
    operational_primary_context_used_calls: 0,
    operational_primary_context_unconfirmed_calls: 0,
    diagnostic_calls: 0,
    unclassified_calls: 0,
    successful_calls: 0,
    failed_calls: 0,
    quality_rejected_calls: 0,
    not_beneficial_calls: 0,
    quality_validated_calls: 0,
    quality_validated_measured_calls: 0,
    fallbacks_reported: 0,
    duration_seconds: 0,
    local_input_tokens: 0,
    local_output_tokens: 0,
    context_input_tokens: 0,
    attempted_context_input_tokens: 0,
    context_output_tokens: 0,
    context_overhead_tokens: 0,
    openai_context_tokens_avoided: 0,
    quality_validated_context_input_tokens: 0,
    quality_validated_context_output_tokens: 0,
    gross_useful_context_tokens_avoided: 0,
    quality_validation_input_tokens: 0,
    quality_validation_output_tokens: 0,
    quality_validation_tokens: 0,
    quality_validated_validation_tokens: 0,
    quality_validation_measured_calls: 0,
    quality_validation_unmeasured_calls: 0,
    quality_validation_unmeasured_gross_tokens: 0,
    useful_context_tokens_avoided: 0,
    confirmed_gross_useful_context_tokens_avoided: 0,
    confirmed_quality_validation_tokens: 0,
    confirmed_useful_context_tokens_avoided: 0,
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
    quality_rejected_tasks: 0,
    skipped_tasks: 0,
    unavailable_tasks: 0,
    availability_unknown_tasks: 0,
    confirmed_unavailable_tasks: 0,
    not_beneficial_tasks: 0,
    missed_opportunities: 0,
    unnecessary_calls: 0,
    potential_tokens_avoidable: 0,
    missed_potential_tokens_avoidable: 0,
    actual_tokens_avoided: 0,
    gross_useful_tokens_avoided: 0,
    quality_validation_tokens: 0,
    quality_validated_validation_tokens: 0,
    quality_validation_measured_calls: 0,
    quality_validation_unmeasured_calls: 0,
    quality_validation_unmeasured_gross_tokens: 0,
    useful_tokens_avoided: 0,
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
    if (Number.isFinite(value) && (value > 0 || (
      ['openai_context_tokens_avoided', 'useful_context_tokens_avoided'].includes(key)
      && value !== 0
    ))) {
      target[key] += value;
    }
  }
  return target;
}

function localAiDerived(totals) {
  const allCalls = Number(totals.calls) || 0;
  const classifiedCalls = (Number(totals.operational_calls) || 0)
    + (Number(totals.diagnostic_calls) || 0)
    + (Number(totals.unclassified_calls) || 0);
  const hasOperationalAccounting = classifiedCalls > 0 || allCalls === 0;
  const calls = hasOperationalAccounting ? Number(totals.operational_calls) || 0 : allCalls;
  const failed = hasOperationalAccounting
    ? Number(totals.operational_failed_calls) || 0
    : Number(totals.failed_calls) || 0;
  const successful = hasOperationalAccounting
    ? Math.max(0, calls - failed)
    : Number(totals.successful_calls) || 0;
  const input = Number(totals.context_input_tokens) || 0;
  const avoided = Number(totals.openai_context_tokens_avoided) || 0;
  const qualityInput = Number(totals.quality_validated_context_input_tokens) || 0;
  const attemptedInput = Number(totals.attempted_context_input_tokens) || qualityInput;
  const provisionalUseful = Number(totals.useful_context_tokens_avoided) || 0;
  const usefulAvoided = Number(totals.confirmed_useful_context_tokens_avoided) || 0;
  const primaryUsed = Number(totals.operational_primary_context_used_calls) || 0;
  const primaryUnconfirmed = Number(totals.operational_primary_context_unconfirmed_calls) || 0;
  const qualityAccepted = hasOperationalAccounting
    ? (Number(totals.operational_quality_validated_calls) || 0)
      + (Number(totals.operational_not_beneficial_calls) || 0)
    : Number(totals.quality_validated_calls) || 0;
  const qualityRejected = hasOperationalAccounting
    ? Number(totals.operational_quality_rejected_calls) || 0
    : Number(totals.quality_rejected_calls) || 0;
  const validationMeasured = Number(totals.quality_validation_measured_calls) || 0;
  const validationUnmeasured = Number(totals.quality_validation_unmeasured_calls) || 0;
  const duration = Number(totals.duration_seconds) || 0;
  return {
    context_reduction_percent: attemptedInput > 0
      ? round((usefulAvoided / attemptedInput) * 100, 1)
      : null,
    useful_reduction_percent: attemptedInput > 0
      ? round((usefulAvoided / attemptedInput) * 100, 1)
      : null,
    provisional_useful_reduction_percent: attemptedInput > 0
      ? round((provisionalUseful / attemptedInput) * 100, 1)
      : null,
    primary_context_use_rate_percent: calls > 0
      ? round((primaryUsed / calls) * 100, 1)
      : 0,
    primary_context_usage_coverage_percent: primaryUsed + primaryUnconfirmed > 0
      ? round((primaryUsed / (primaryUsed + primaryUnconfirmed)) * 100, 1)
      : 0,
    raw_context_reduction_percent: input > 0 ? round((avoided / input) * 100, 1) : null,
    quality_acceptance_rate_percent: qualityAccepted + qualityRejected > 0
      ? round((qualityAccepted / (qualityAccepted + qualityRejected)) * 100, 1)
      : null,
    quality_validation_cost_coverage_percent: validationMeasured + validationUnmeasured > 0
      ? round((validationMeasured / (validationMeasured + validationUnmeasured)) * 100, 1)
      : null,
    operational_accounting_coverage_percent: allCalls > 0
      ? round(((Number(totals.operational_calls) || 0) + (Number(totals.diagnostic_calls) || 0)) / allCalls * 100, 1)
      : null,
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
  const useful = Number(totals.useful_tokens_avoided) || 0;
  const unavailable = Number(totals.unavailable_tasks) || 0;
  const availabilityUnknown = Number(totals.availability_unknown_tasks) || 0;
  const confirmedUnavailable = Number(totals.confirmed_unavailable_tasks) || 0;
  const validationMeasured = Number(totals.quality_validation_measured_calls) || 0;
  const validationUnmeasured = Number(totals.quality_validation_unmeasured_calls) || 0;
  return {
    rtx_delegation_rate_percent: eligibleAvailable > 0
      ? round((used / eligibleAvailable) * 100, 1)
      : null,
    weighted_context_savings_coverage_percent: potential > 0
      ? round(Math.min(100, Math.max(0, useful) / potential * 100), 1)
      : null,
    quality_validation_cost_coverage_percent: validationMeasured + validationUnmeasured > 0
      ? round((validationMeasured / (validationMeasured + validationUnmeasured)) * 100, 1)
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

function localAiDailySeries(daily, now, days = 7) {
  const series = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = isoDayOffset(now, offset);
    const totals = emptyLocalAiTotals();
    addLocalAiTotals(totals, daily?.[day]?.totals);
    const derived = localAiDerived(totals);
    series.push({
      day,
      useful_context_tokens_avoided:
        Number(totals.confirmed_useful_context_tokens_avoided) || 0,
      provisional_useful_context_tokens_avoided:
        Number(totals.useful_context_tokens_avoided) || 0,
      attempted_context_input_tokens: Number(totals.attempted_context_input_tokens) || 0,
      useful_reduction_percent: derived.useful_reduction_percent,
      operational_calls: Number(totals.operational_calls) || 0,
      operational_failed_calls: Number(totals.operational_failed_calls) || 0,
      operational_quality_rejected_calls: Number(totals.operational_quality_rejected_calls) || 0,
      operational_not_beneficial_calls: Number(totals.operational_not_beneficial_calls) || 0,
      operational_quality_validated_calls: Number(totals.operational_quality_validated_calls) || 0,
      operational_quality_validated_measured_calls:
        Number(totals.operational_quality_validated_measured_calls) || 0,
      operational_primary_context_used_calls:
        Number(totals.operational_primary_context_used_calls) || 0,
      operational_primary_context_unconfirmed_calls:
        Number(totals.operational_primary_context_unconfirmed_calls) || 0,
    });
  }
  return series;
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

function localAiDiscardReason(job) {
  if (!job || job.status !== 'discarded') return null;
  if (job.discard_reason === 'insufficient_net_savings') return 'insufficient_net_savings';
  if (job.discard_reason === 'quality_gate_rejected') return 'quality_gate_rejected';
  const input = Number(job.context_input_tokens);
  const output = Number(job.context_output_tokens);
  const validation = Number(job.quality_validation_tokens);
  if (
    job.quality_validation_tokens_measured === true
    && Number.isFinite(input) && Number.isFinite(output) && Number.isFinite(validation)
    && Math.max(0, input - output) <= Math.max(0, validation)
  ) {
    return 'insufficient_net_savings';
  }
  return 'quality_gate_rejected';
}

function validCodeModeDelivery(job, receipt) {
  return (
    receipt?.transport === 'code-mode-orchestrator-v1'
    && receipt?.job_id === job?.id
    && receipt?.task === job?.task
    && Number(receipt?.source_output_chars) > 0
    && Number(receipt.source_output_chars) === Number(job?.context_input_chars)
    && job?.invocation_source === 'mcp'
  );
}

function localAiPrimaryContextUsed(job, deliveryReceipts = new Map()) {
  const boundedTask = [
    'inspect-files', 'review-diff', 'summarize-document', 'summarize-memory',
  ].includes(String(job?.task || ''));
  const gateType = String(job?.quality_gate_type || 'llm-verifier');
  const independentValidation = gateType === 'deterministic-log-anchors-v1'
    ? (
      job?.task === 'summarize-log'
      && job?.verifier_model === 'deterministic:log-anchors-v1'
      && Number(job?.quality_validation_tokens) === 0
      && Number(job?.quality_verification_attempts) === 0
    )
    : (
      typeof job?.verifier_model === 'string'
      && job.verifier_model.length > 0
      && job.verifier_model !== job.model
    );
  return (
    job?.status === 'success'
    && job?.context_replacement !== false
    && job.quality_accepted === true
    && job.quality_validation_tokens_measured === true
    && independentValidation
    && (
      job.invocation_source === 'post-tool-hook'
      || validCodeModeDelivery(job, deliveryReceipts.get(job?.id))
    )
    && Number(job.useful_context_tokens_avoided) > 0
    && !(boundedTask && job.input_truncated === true)
  );
}

function sanitizeLocalAiJob(job, deliveryReceipts = new Map()) {
  if (!job || typeof job !== 'object') return {};
  // The dashboard needs only operational metadata. Keeping this compact avoids
  // Home Assistant's 16 KiB state-attribute limit and never exposes endpoint
  // details through its state machine or Recorder.
  const fields = [
    'id', 'status', 'task', 'model', 'verifier_model', 'chat_id', 'chat_name', 'started_at', 'finished_at',
    'invocation_source',
    'duration_seconds', 'error_type', 'discard_reason', 'fallback_reported',
    'context_input_chars', 'context_input_tokens', 'context_output_tokens',
    'context_overhead_tokens', 'context_overhead_method', 'context_savings_estimated',
    'token_count_method', 'context_replacement',
    'deterministic_omitted_lines', 'model_input_chars', 'model_input_tokens', 'input_truncated',
    'openai_context_tokens_avoided', 'context_reduction_percent',
    'gross_useful_context_tokens_avoided', 'useful_context_tokens_avoided',
    'quality_validation_input_tokens', 'quality_validation_output_tokens',
    'quality_validation_tokens', 'quality_validation_tokens_measured',
    'quality_accepted', 'quality_score_percent', 'quality_gate_type',
    'quality_verification_attempts', 'tokens_per_second', 'local_attempts',
    'gpu_telemetry_available', 'gpu_peak_percent',
    'vram_peak_mib', 'gpu_power_peak_watts', 'processor',
    'cpu_offload_detected',
  ];
  const sanitized = Object.fromEntries(
    fields.filter((field) => Object.hasOwn(job, field)).map((field) => [field, job[field]]),
  );
  const deliveryReceipt = deliveryReceipts.get(sanitized.id);
  sanitized.primary_context_used = localAiPrimaryContextUsed(sanitized, deliveryReceipts);
  if (sanitized.primary_context_used && validCodeModeDelivery(sanitized, deliveryReceipt)) {
    sanitized.delivery_transport = deliveryReceipt.transport;
  } else if (sanitized.primary_context_used && sanitized.invocation_source === 'post-tool-hook') {
    sanitized.delivery_transport = 'post-tool-hook';
  }
  if (!sanitized.primary_context_used) {
    sanitized.useful_context_tokens_avoided = 0;
  }
  if (sanitized.status === 'discarded') {
    sanitized.discard_reason = localAiDiscardReason(job);
  }
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

function codeModeDeliveryReceipts(state) {
  const jobs = Array.isArray(state?.latest_jobs) ? state.latest_jobs : [];
  const jobsById = new Map(jobs
    .filter((job) => job && typeof job === 'object' && typeof job.id === 'string')
    .map((job) => [job.id, job]));
  const receipts = Array.isArray(state?.deliveries?.latest_receipts)
    ? state.deliveries.latest_receipts
    : [];
  const valid = new Map();
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== 'object' || typeof receipt.job_id !== 'string') continue;
    const job = jobsById.get(receipt.job_id);
    if (!job || !validCodeModeDelivery(job, receipt)) continue;
    if (!localAiPrimaryContextUsed(job, new Map([[receipt.job_id, receipt]]))) continue;
    valid.set(receipt.job_id, receipt);
  }
  return valid;
}

function promoteDeliveredTotals(totals, job) {
  if (!totals || typeof totals !== 'object') return;
  totals.operational_primary_context_used_calls =
    (Number(totals.operational_primary_context_used_calls) || 0) + 1;
  totals.operational_primary_context_unconfirmed_calls = Math.max(
    0,
    (Number(totals.operational_primary_context_unconfirmed_calls) || 0) - 1,
  );
  totals.confirmed_gross_useful_context_tokens_avoided =
    (Number(totals.confirmed_gross_useful_context_tokens_avoided) || 0)
    + Math.max(0, Number(job.gross_useful_context_tokens_avoided) || 0);
  totals.confirmed_quality_validation_tokens =
    (Number(totals.confirmed_quality_validation_tokens) || 0)
    + Math.max(0, Number(job.quality_validation_tokens) || 0);
  totals.confirmed_useful_context_tokens_avoided =
    (Number(totals.confirmed_useful_context_tokens_avoided) || 0)
    + Math.max(0, Number(job.useful_context_tokens_avoided) || 0);
}

function reconcileCodeModeDeliveries(state, deliveryReceipts) {
  const jobs = Array.isArray(state?.latest_jobs) ? state.latest_jobs : [];
  for (const job of jobs) {
    if (!deliveryReceipts.has(job?.id)) continue;
    if (!localAiPrimaryContextUsed(job, deliveryReceipts)) continue;
    promoteDeliveredTotals(state.totals, job);
    const day = String(job.finished_at || job.started_at || '').slice(0, 10);
    promoteDeliveredTotals(state.daily?.[day]?.totals, job);
    promoteDeliveredTotals(state.models?.[String(job.model || 'unknown')]?.totals, job);
    promoteDeliveredTotals(state.tasks?.[String(job.task || 'unknown')]?.totals, job);
    for (const pair of Object.values(state.model_pairs || {})) {
      if (
        pair?.generator_model === (job.model || 'unknown')
        && pair?.verifier_model === (job.verifier_model || 'unmeasured')
      ) {
        promoteDeliveredTotals(pair.totals, job);
        break;
      }
    }
  }
}

function sanitizeRoutingDecision(decision) {
  if (!decision || typeof decision !== 'object') return {};
  const fields = [
    'id', 'timestamp', 'task_type', 'input_chars', 'estimated_input_tokens',
    'compressibility', 'compatible_helper', 'eligible', 'available',
    'expected_tokens_saved', 'actual_tokens_avoided', 'useful_tokens_avoided',
    'gross_useful_tokens_avoided', 'quality_validation_tokens',
    'quality_validation_tokens_measured',
    'quality_accepted', 'quality_score_percent', 'decision', 'reason',
    'minimum_input_tokens', 'minimum_expected_saved_tokens', 'model',
    'model_input_tokens', 'estimated_candidate_tokens',
    'estimated_validation_tokens', 'expected_net_tokens_saved', 'quality_gate_type',
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

function reconcileRoutingDecisions(decisions, jobs) {
  return decisions.map((decision) => {
    if (['LOCAL_AI_QUALITY_REJECTED', 'LOCAL_AI_FAILED'].includes(decision.decision)) {
      return { ...decision, actual_tokens_avoided: 0, useful_tokens_avoided: 0 };
    }
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
      ? {
        ...decision,
        decision: 'LOCAL_AI_FAILED',
        reason: 'local_ai_call_failed',
        actual_tokens_avoided: 0,
        useful_tokens_avoided: 0,
      }
      : decision;
  });
}

function sanitizeHighPotentialBenchmark(benchmarkPath, now = new Date()) {
  const report = readJson(benchmarkPath, null);
  const isV1 = report?.suite === 'local-ai-high-potential-v1';
  const isV2 = report?.schema_version === 2 && report?.suite === 'local-ai-high-potential-v2';
  const isV3 = report?.schema_version === 3 && report?.suite === 'local-ai-quality-bakeoff-v3';
  if (!report || (!isV1 && !isV2 && !isV3)
      || report.execution_mode !== 'benchmark'
      || report.excluded_from_production_metrics !== true) {
    return { available: false, status: 'insufficient_sample', activities: [] };
  }
  const safeNumber = (value) => {
    if (value === null || value === undefined || value === '') return null;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  };
  if (isV3) {
    const executedDate = new Date(report.benchmark_executed_at);
    const ageSeconds = Number.isNaN(executedDate.valueOf())
      ? null : Math.max(0, Math.floor((now.valueOf() - executedDate.valueOf()) / 1000));
    const primaryResults = Array.isArray(report.primary_results) ? report.primary_results.map((item) => ({
      activity: typeof item?.activity === 'string' ? item.activity : null,
      model_key: typeof item?.model_key === 'string' ? item.model_key : null,
      model: typeof item?.model === 'string' ? item.model : null,
      total_cases: safeNumber(item?.total_cases),
      local_inference_calls: safeNumber(item?.local_inference_calls),
      accepted_cases: safeNumber(item?.accepted_cases),
      fallback_cases: safeNumber(item?.fallback_cases),
      cases_with_critical_error: safeNumber(item?.cases_with_critical_error),
      pass_at_1: safeNumber(item?.pass_at_1),
      critical_fact_recall: safeNumber(item?.critical_fact_recall),
      schema_validity: safeNumber(item?.schema_validity),
      residual_gpt_avoidance_rate: safeNumber(item?.residual_gpt_avoidance_rate),
      run_to_run_consistency: safeNumber(item?.run_to_run_consistency),
      critical_fact_consistency: safeNumber(item?.critical_fact_consistency),
      duration_p50: safeNumber(item?.duration_p50),
      duration_p95: safeNumber(item?.duration_p95),
      tokens_per_second: safeNumber(item?.tokens_per_second),
      vram_peak: safeNumber(item?.vram_peak),
      ram_peak: safeNumber(item?.ram_peak),
      swap_peak: safeNumber(item?.swap_peak),
      cpu_offload_observed: typeof item?.cpu_offload_observed === 'boolean'
        ? item.cpu_offload_observed : null,
      timeouts: safeNumber(item?.timeouts),
      oom: safeNumber(item?.oom),
      macro_f1: safeNumber(item?.macro_f1),
      numeric_value_preservation: safeNumber(item?.numeric_value_preservation),
      critical_file_recall: safeNumber(item?.critical_file_recall),
      critical_false_merges: safeNumber(item?.critical_false_merges),
      root_cause_preservation: safeNumber(item?.root_cause_preservation),
      unsupported_claims: safeNumber(item?.unsupported_claims),
    })) : [];
    const verifierResults = Array.isArray(report.verifier_results) ? report.verifier_results.map((item) => ({
      activity: typeof item?.activity === 'string' ? item.activity : null,
      verifier_model_key: typeof item?.verifier_model_key === 'string' ? item.verifier_model_key : null,
      verifier: typeof item?.verifier === 'string' ? item.verifier : null,
      total_cases: safeNumber(item?.total_cases),
      critical_false_accepts: safeNumber(item?.critical_false_accepts),
      critical_error_detection_recall: safeNumber(item?.critical_error_detection_recall),
      false_accept_rate: safeNumber(item?.false_accept_rate),
      false_reject_rate: safeNumber(item?.false_reject_rate),
      verifier_precision: safeNumber(item?.verifier_precision),
      verifier_recall: safeNumber(item?.verifier_recall),
      natural_primary_errors_total: safeNumber(item?.natural_primary_errors_total),
      natural_primary_error_recall: safeNumber(item?.natural_primary_error_recall),
      approved: typeof item?.approved === 'boolean' ? item.approved : null,
    })) : [];
    const decisions = Array.isArray(report.promotion_decisions) ? report.promotion_decisions.map((item) => ({
      activity: typeof item?.activity === 'string' ? item.activity : null,
      winner: typeof item?.winner === 'string' ? item.winner : null,
      winner_model_key: typeof item?.winner_model_key === 'string' ? item.winner_model_key : null,
      verifier: typeof item?.verifier === 'string' ? item.verifier : null,
      verifier_model_key: typeof item?.verifier_model_key === 'string' ? item.verifier_model_key : null,
      verifier_status: typeof item?.verifier_status === 'string' ? item.verifier_status : null,
      operational_advantage_status: typeof item?.operational_advantage_status === 'string'
        ? item.operational_advantage_status : null,
      mode: typeof item?.mode === 'string' ? item.mode : null,
      production_enabled: typeof item?.production_enabled === 'boolean'
        ? item.production_enabled : null,
      unresolved_fallback: typeof item?.unresolved_fallback === 'string'
        ? item.unresolved_fallback : null,
      failed_gates: Array.isArray(item?.failed_gates)
        ? item.failed_gates.filter((value) => typeof value === 'string') : [],
    })) : [];
    const models = Array.isArray(report.models) ? report.models.map((item) => ({
      model_key: typeof item?.model_key === 'string' ? item.model_key : null,
      model: typeof item?.model === 'string' ? item.model : null,
      digest: typeof item?.digest === 'string' ? item.digest : null,
      size_bytes: safeNumber(item?.size_bytes),
      executed: item?.executed === true,
      not_run_status: typeof item?.not_run_status === 'string' ? item.not_run_status : null,
      capabilities: Array.isArray(item?.capabilities)
        ? item.capabilities.filter((value) => typeof value === 'string') : [],
    })) : [];
    const sum = (field) => primaryResults.reduce((total, item) => total + (item[field] || 0), 0);
    const dataset = report.dataset && typeof report.dataset === 'object' ? report.dataset : {};
    return {
      available: true,
      status: String(report.measurement_basis?.local_inference || 'not_tested'),
      schema_version: 3,
      compatibility_status: 'current',
      benchmark_run_id: typeof report.benchmark_run_id === 'string' ? report.benchmark_run_id : null,
      benchmark_executed_at: typeof report.benchmark_executed_at === 'string'
        ? report.benchmark_executed_at : null,
      artifact_recomputed_at: null,
      benchmark_age_seconds: ageSeconds,
      benchmark_event_count: safeNumber(report.benchmark_event_count),
      model: 'multi-model',
      measurement_basis: {
        gpt_tokens: report.measurement_basis?.gpt_tokens || null,
        gpt_direct_execution: report.measurement_basis?.gpt_direct_execution || null,
        local_inference: report.measurement_basis?.local_inference || null,
        gpu_telemetry: report.measurement_basis?.gpu_telemetry || null,
        deterministic_execution: report.measurement_basis?.deterministic_execution || null,
        gpt_final_quality: report.measurement_basis?.gpt_final_quality || null,
      },
      ground_truth_independence_status: 'MIXED_VERIFIED_AND_PARTIAL',
      operational_decision: typeof report.operational_advantage_status === 'string'
        ? report.operational_advantage_status : null,
      results_recomputed_from_existing_raw_artifacts: false,
      adversarial_metrics: {
        prompt_injection_cases: safeNumber(dataset.prompt_injection_cases),
        stability_cases: safeNumber(dataset.stability_cases),
      },
      totals: {
        total_cases: sum('total_cases'),
        local_inference_calls: sum('local_inference_calls'),
        accepted_cases: sum('accepted_cases'),
        fallback_cases: sum('fallback_cases'),
        useful_cases: sum('accepted_cases'),
        cases_with_critical_error: sum('cases_with_critical_error'),
      },
      activities: decisions,
      primary_results: primaryResults,
      verifier_results: verifierResults,
      promotion_decisions: decisions,
      models,
      dataset: {
        residual_cases: safeNumber(dataset.residual_cases),
        calibration_cases: safeNumber(dataset.calibration_cases),
        promotion_holdout_cases: safeNumber(dataset.promotion_holdout_cases),
        prompt_injection_cases: safeNumber(dataset.prompt_injection_cases),
        stability_cases: safeNumber(dataset.stability_cases),
        dataset_sha256: typeof dataset.dataset_sha256 === 'string' ? dataset.dataset_sha256 : null,
        ground_truth_sha256: typeof dataset.ground_truth_sha256 === 'string'
          ? dataset.ground_truth_sha256 : null,
        ground_truth_independence: dataset.ground_truth_independence || {},
      },
      artifact_hashes: report.artifact_hashes && typeof report.artifact_hashes === 'object'
        ? report.artifact_hashes : {},
      configuration_hash: typeof report.configuration_hash === 'string'
        ? report.configuration_hash : null,
      quality_pipeline_feature_flag: typeof report.quality_pipeline_feature_flag === 'string'
        ? report.quality_pipeline_feature_flag : null,
      summarize_log_policy: typeof report.summarize_log_policy === 'string'
        ? report.summarize_log_policy : null,
    };
  }
  const totals = report.totals && typeof report.totals === 'object' ? report.totals : {};
  const policy = report.operational_policy && typeof report.operational_policy === 'object'
    ? report.operational_policy : {};
  const activities = Object.entries(report.per_activity_class || {}).map(([activity, value]) => {
    const currentPolicy = policy[activity] && typeof policy[activity] === 'object' ? policy[activity] : {};
    const legacy = value?.legacy_metric_aliases || {};
    const totalCases = safeNumber(isV2 ? value?.total_cases : value?.cases);
    return {
      activity,
      total_cases: totalCases,
      eligible_cases: safeNumber(isV2 ? value?.eligible_cases : value?.eligible_tasks),
      non_eligible_cases: safeNumber(isV2 ? value?.non_eligible_cases : null),
      rtx_attempted_cases: safeNumber(isV2 ? value?.rtx_attempted_cases : value?.rtx_attempted),
      local_inference_calls: safeNumber(value?.local_inference_calls),
      accepted_cases: safeNumber(isV2 ? value?.accepted_cases : value?.outputs_accepted),
      rejected_cases: safeNumber(isV2 ? value?.rejected_cases : value?.outputs_rejected),
      fallback_cases: safeNumber(isV2 ? value?.fallback_cases : value?.fallbacks),
      useful_cases: safeNumber(isV2 ? value?.useful_cases : value?.useful_rtx_tasks),
      useful_rtx_rate_among_attempts: safeNumber(isV2 ? value?.useful_rtx_rate_among_attempts : value?.useful_rtx_rate),
      end_to_end_useful_coverage: safeNumber(isV2 ? value?.end_to_end_useful_coverage : null),
      class_eligibility_rate: safeNumber(isV2 ? value?.class_eligibility_rate : null),
      fallback_rate_among_attempts: safeNumber(isV2 ? value?.fallback_rate_among_attempts : value?.fallback_rate),
      inferences_per_attempted_case: safeNumber(isV2 ? value?.inferences_per_attempted_case : null),
      critical_error_occurrences: safeNumber(isV2 ? value?.critical_error_occurrences : null),
      cases_with_critical_error: safeNumber(isV2 ? value?.cases_with_critical_error : null),
      rtx_quality_score: safeNumber(isV2 ? value?.rtx_quality_score : value?.quality_score),
      baseline_quality_score: safeNumber(isV2 ? value?.baseline_quality_score : value?.deterministic_quality_score),
      rtx_latency_p50_seconds: safeNumber(isV2 ? value?.rtx_latency_p50_seconds : value?.latency_p50_seconds),
      baseline_latency_p50_seconds: safeNumber(isV2 ? value?.baseline_latency_p50_seconds : value?.deterministic_latency_p50_seconds),
      estimated_avoided_gpt_tokens: safeNumber(isV2 ? value?.estimated_avoided_gpt_tokens : value?.avoided_gpt_tokens),
      estimated_weighted_gpt_context_reduction: safeNumber(isV2 ? value?.estimated_weighted_gpt_context_reduction : value?.weighted_token_savings),
      rtx_operational_advantage: isV2 && typeof value?.rtx_operational_advantage === 'boolean'
        ? value.rtx_operational_advantage : null,
      decision: typeof value?.decision === 'string' ? value.decision : null,
      production_local_ai_enabled: typeof currentPolicy.production_local_ai_enabled === 'boolean'
        ? currentPolicy.production_local_ai_enabled : null,
      local_ai_mode: typeof currentPolicy.local_ai_mode === 'string' ? currentPolicy.local_ai_mode : null,
      sample_status: totalCases !== null && totalCases >= 20 ? 'sufficient' : 'insufficient_sample',
      legacy_aliases_present: Boolean(Object.keys(legacy).length),
    };
  });
  const benchmarkExecutedAt = isV2 ? report.benchmark_executed_at : report.generated_at;
  const executedDate = new Date(benchmarkExecutedAt);
  const ageSeconds = Number.isNaN(executedDate.valueOf())
    ? null : Math.max(0, Math.floor((now.valueOf() - executedDate.valueOf()) / 1000));
  const localBasis = isV2 ? report.measurement_basis?.local_inference : report.measurement_basis?.local_ai;
  const groundTruthStatus = isV2 && typeof report.ground_truth_provenance?.status === 'string'
    ? report.ground_truth_provenance.status : null;
  const totalsLegacy = totals.legacy_metric_aliases || {};
  return {
    available: true,
    status: isV2
      ? activities.every((item) => item.sample_status === 'sufficient') ? String(localBasis || 'not_tested') : 'insufficient_sample'
      : 'legacy_schema',
    schema_version: isV2 ? 2 : 1,
    compatibility_status: isV2 ? 'current' : 'legacy_schema',
    benchmark_run_id: typeof report.benchmark_run_id === 'string' ? report.benchmark_run_id : null,
    benchmark_executed_at: typeof benchmarkExecutedAt === 'string' ? benchmarkExecutedAt : null,
    artifact_recomputed_at: isV2 && typeof report.artifact_recomputed_at === 'string' ? report.artifact_recomputed_at : null,
    benchmark_age_seconds: ageSeconds,
    model: typeof report.model === 'string' ? report.model : null,
    measurement_basis: {
      gpt_tokens: isV2 ? report.measurement_basis?.gpt_tokens : 'estimated',
      gpt_token_estimation_method: isV2
        ? report.measurement_basis?.gpt_token_estimation_method : 'utf8_bytes_divided_by_4',
      gpt_direct_execution: isV2 ? report.measurement_basis?.gpt_direct_execution : 'simulated',
      local_inference: localBasis || null,
      gpu_telemetry: isV2 ? report.measurement_basis?.gpu_telemetry : null,
      deterministic_execution: isV2 ? report.measurement_basis?.deterministic_execution : null,
      gpt_final_quality: report.measurement_basis?.gpt_final_quality || 'not_tested',
    },
    ground_truth_independence_status: groundTruthStatus,
    operational_decision: isV2 ? 'NO_RTX_OPERATIONAL_ADVANTAGE' : null,
    results_recomputed_from_existing_raw_artifacts: isV2
      ? report.results_recomputed_from_existing_raw_artifacts === true : null,
    adversarial_metrics: isV2 ? {
      adversarial_scenarios_total: safeNumber(report.adversarial_metrics?.adversarial_scenarios_total),
      adversarial_guardrails_passed: safeNumber(report.adversarial_metrics?.adversarial_guardrails_passed),
      adversarial_model_outputs_accepted: safeNumber(report.adversarial_metrics?.adversarial_model_outputs_accepted),
      adversarial_model_outputs_rejected: safeNumber(report.adversarial_metrics?.adversarial_model_outputs_rejected),
    } : null,
    totals: {
      total_cases: safeNumber(isV2 ? totals.total_cases : totals.cases),
      eligible_cases: safeNumber(isV2 ? totals.eligible_cases : totals.eligible_tasks),
      non_eligible_cases: safeNumber(isV2 ? totals.non_eligible_cases : null),
      rtx_attempted_cases: safeNumber(isV2 ? totals.rtx_attempted_cases : totals.rtx_attempted),
      local_inference_calls: safeNumber(totals.local_inference_calls),
      accepted_cases: safeNumber(isV2 ? totals.accepted_cases : totals.outputs_accepted),
      rejected_cases: safeNumber(isV2 ? totals.rejected_cases : totals.outputs_rejected),
      fallback_cases: safeNumber(isV2 ? totals.fallback_cases : totals.fallbacks),
      useful_cases: safeNumber(isV2 ? totals.useful_cases : totals.useful_rtx_tasks),
      useful_rtx_rate_among_attempts: safeNumber(isV2 ? totals.useful_rtx_rate_among_attempts : totals.useful_rtx_rate),
      end_to_end_useful_coverage: safeNumber(isV2 ? totals.end_to_end_useful_coverage : null),
      inferences_per_attempted_case: safeNumber(isV2 ? totals.inferences_per_attempted_case : null),
      critical_error_occurrences: safeNumber(isV2 ? totals.critical_error_occurrences : null),
      cases_with_critical_error: safeNumber(isV2 ? totals.cases_with_critical_error : null),
      critical_case_rate_among_attempts: safeNumber(isV2 ? totals.critical_case_rate_among_attempts : null),
      critical_errors_per_inference: safeNumber(isV2 ? totals.critical_errors_per_inference : null),
      local_inferences_with_critical_error: safeNumber(
        isV2 ? totals.local_inferences_with_critical_error : null,
      ),
      critical_error_scope: isV2 && typeof totals.critical_error_scope === 'string'
        ? totals.critical_error_scope : null,
      estimated_baseline_gpt_tokens: safeNumber(isV2 ? totals.estimated_baseline_gpt_tokens : totals.baseline_gpt_tokens),
      estimated_routed_gpt_tokens: safeNumber(isV2 ? totals.estimated_routed_gpt_tokens : totals.routed_gpt_tokens),
      estimated_avoided_gpt_tokens: safeNumber(isV2 ? totals.estimated_avoided_gpt_tokens : totals.avoided_gpt_tokens),
      estimated_weighted_gpt_context_reduction: safeNumber(isV2 ? totals.estimated_weighted_gpt_context_reduction : totals.weighted_token_savings),
      local_added_latency_total_seconds: safeNumber(isV2 ? totals.local_added_latency_total_seconds : totals.net_latency_delta_seconds),
      rtx_quality_score: safeNumber(isV2 ? totals.rtx_quality_score : totals.quality_score),
      rtx_latency_p50_seconds: safeNumber(isV2 ? totals.rtx_latency_p50_seconds : totals.latency_p50_seconds),
      rtx_latency_p95_seconds: safeNumber(isV2 ? totals.rtx_latency_p95_seconds : totals.latency_p95_seconds),
      baseline_quality_score: safeNumber(isV2 ? totals.baseline_quality_score : totals.deterministic_quality_score),
      baseline_latency_p50_seconds: safeNumber(isV2 ? totals.baseline_latency_p50_seconds : totals.deterministic_latency_p50_seconds),
      legacy_critical_errors: safeNumber(isV1 ? totals.critical_errors : totalsLegacy.critical_errors),
    },
    activities,
  };
}

function scanLocalAiTelemetry(telemetryPath, statusPath, now = new Date(), benchmarkPath = null) {
  const state = readJson(telemetryPath, {});
  const deliveryReceipts = codeModeDeliveryReceipts(state);
  reconcileCodeModeDeliveries(state, deliveryReceipts);
  const preflight = readJson(statusPath, {});
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
  const sanitizedActiveJobs = recentActiveJobs.map((job) => sanitizeLocalAiJob(job, deliveryReceipts));
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
  const modelPairs = Object.values(state.model_pairs || {})
    .filter((value) => value && typeof value === 'object')
    .map((value) => ({
      generator_model: value.generator_model || 'unknown',
      verifier_model: value.verifier_model || 'unmeasured',
      independent_verifier: value.independent_verifier === true,
      ...(value.totals || {}),
      ...localAiDerived(value.totals || {}),
    }))
    .sort((left, right) => Number(right.operational_calls || 0) - Number(left.operational_calls || 0));
  const tasks = Object.entries(state.tasks || {})
    .filter(([task]) => !String(task).startsWith('benchmark:'))
    .map(([task, value]) => ({ task, ...(value.totals || {}), ...localAiDerived(value.totals || {}) }))
    .sort((left, right) => Number(right.operational_calls || 0) - Number(left.operational_calls || 0));
  const latestJobs = Array.isArray(state.latest_jobs)
    ? state.latest_jobs.slice(-5).reverse().map((job) => sanitizeLocalAiJob(job, deliveryReceipts))
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
    daily_series: localAiDailySeries(state.daily, now, 7),
    routing: {
      totals: { ...routingTotals, ...routingDerived(routingTotals) },
      periods: {
        today: summarizeRoutingPeriod(state.daily, now, 1),
        week: summarizeRoutingPeriod(state.daily, now, 7),
        month: summarizeRoutingMonth(state.daily, now),
      },
      latest_decisions: reconcileRoutingDecisions(latestDecisions, latestJobs),
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
    model_pairs: modelPairs,
    tasks,
    // Five jobs cover the current job plus recent diagnostics, while staying
    // well below the attribute-size limit enforced by Home Assistant.
    latest_jobs: latestJobs,
    deliveries: {
      confirmed_code_mode_calls: deliveryReceipts.size,
    },
    benchmark_high_potential: sanitizeHighPotentialBenchmark(benchmarkPath, now),
  };
}

function scanLocalAiHistory(telemetryPath, now = new Date(), windowHours = 48) {
  const state = readJson(telemetryPath, {});
  const deliveryReceipts = codeModeDeliveryReceipts(state);
  const cutoff = now.valueOf() - windowHours * 3_600_000;
  const jobs = Array.isArray(state.latest_jobs) ? state.latest_jobs : [];
  const recent = jobs
    .filter((job) => {
      if (String(job?.task || '').startsWith('benchmark:')) return false;
      const timestamp = new Date(job?.finished_at || job?.started_at);
      return !Number.isNaN(timestamp.valueOf()) && timestamp.valueOf() >= cutoff;
    })
    .slice(-40)
    .reverse()
    .map((job) => {
      return {
        started_at: job.started_at || null,
        finished_at: job.finished_at || null,
        task: job.task || null,
        model: job.model || null,
        verifier_model: job.verifier_model || null,
        quality_gate_type: job.quality_gate_type || null,
        status: job.status || null,
        discard_reason: localAiDiscardReason(job),
        duration_seconds: Number.isFinite(Number(job.duration_seconds))
          ? Number(job.duration_seconds)
          : null,
        quality_accepted: job.quality_accepted === true
          ? true
          : job.quality_accepted === false ? false : null,
        quality_score_percent: Number.isFinite(Number(job.quality_score_percent))
          ? Number(job.quality_score_percent)
          : null,
        delivery_transport: validCodeModeDelivery(job, deliveryReceipts.get(job?.id))
          ? 'code-mode-orchestrator-v1'
          : job.invocation_source === 'post-tool-hook' ? 'post-tool-hook' : null,
        primary_context_used: localAiPrimaryContextUsed(job, deliveryReceipts),
        useful_context_tokens_avoided: localAiPrimaryContextUsed(job, deliveryReceipts)
          ? Math.max(0, Number(job.useful_context_tokens_avoided) || 0)
          : 0,
      };
    });
  return { window_hours: windowHours, count: recent.length, jobs: recent };
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

function buildCodexUsage(
  fileSummaries,
  now = new Date(),
  liveRateEvent = null,
  { accountLimitOnly = false } = {},
) {
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
  const rateSource = hasLiveRateLimit
    ? liveRateEvent
    : accountLimitOnly ? null : (latestRateEvent || latestEvent);
  const sanitized = sanitizeRateLimits(rateSource?.rateLimits);
  const lastKnownPlanType = planType(latestPlanEvent?.rateLimits);
  if (sanitized && !sanitized.plan_type && lastKnownPlanType && !accountLimitOnly) {
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
  constructor(
    sessionsDirectory,
    localAiTelemetryPath = null,
    localAiStatusPath = null,
    cacheMs = 5_000,
    localAiBenchmarkPath = null,
  ) {
    this.sessionsDirectories = Array.isArray(sessionsDirectory) ? sessionsDirectory : [sessionsDirectory];
    this.localAiTelemetryPath = localAiTelemetryPath;
    this.localAiStatusPath = localAiStatusPath;
    this.localAiBenchmarkPath = localAiBenchmarkPath;
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
      { accountLimitOnly: true },
    );
  }

  read(liveRateEvent = null) {
    if (this.cached && Date.now() - this.cachedAt < this.cacheMs) return this.cached;
    const now = new Date();
    this.cached = {
      ...this.readCodexUsage(now, liveRateEvent),
      local_ai: scanLocalAiTelemetry(
        this.localAiTelemetryPath,
        this.localAiStatusPath,
        new Date(),
        this.localAiBenchmarkPath,
      ),
    };
    this.cachedAt = Date.now();
    return this.cached;
  }

  readLocalAiLive() {
    return scanLocalAiTelemetry(
      this.localAiTelemetryPath,
      this.localAiStatusPath,
      new Date(),
      this.localAiBenchmarkPath,
    );
  }

  readLocalAiHistory() {
    return scanLocalAiHistory(this.localAiTelemetryPath);
  }
}

module.exports = {
  CodexUsageReader, scanCodexUsage, scanLocalAiTelemetry, scanLocalAiHistory,
};
