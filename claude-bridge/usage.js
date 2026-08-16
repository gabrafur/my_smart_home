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
  return {
    limit_id: rateLimits.limit_id || null,
    plan_type: rateLimits.plan_type || null,
    used_percent: Number.isFinite(Number(primary?.used_percent))
      ? Number(primary.used_percent)
      : null,
    remaining_percent: Number.isFinite(Number(primary?.used_percent))
      ? Math.max(0, 100 - Number(primary.used_percent))
      : null,
    window_minutes: Number.isFinite(Number(primary?.window_minutes))
      ? Number(primary.window_minutes)
      : null,
    resets_at: isoFromEpoch(primary?.resets_at),
    credits: {
      has_credits: credits?.has_credits === true,
      unlimited: credits?.unlimited === true,
      balance: credits?.balance ?? null,
    },
    spend_control_reached: rateLimits.spend_control_reached === true,
    reached_type: rateLimits.rate_limit_reached_type || null,
  };
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function buildAnalytics({ totals, recentTokens, rateLimit, now }) {
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
    const elapsedDays = elapsedMs / 86_400_000;
    const remainingDays = remainingMs / 86_400_000;
    const elapsedWindowPercent = (elapsedMs / (windowMinutes * 60_000)) * 100;
    forecast.elapsed_window_percent = round(elapsedWindowPercent, 1);

    // Wait for at least one hour of the window before extrapolating a rounded
    // percentage. Earlier than that, a displayed 1% produces a wild forecast.
    if (elapsedMs >= 3_600_000) {
      const percentPerDay = used / elapsedDays;
      const projected = Math.min(100, used + percentPerDay * remainingDays);
      forecast.status = projected < 90 ? 'aguenta' : projected < 100 ? 'atencao' : 'risco';
      forecast.will_last = projected < 100;
      forecast.confidence = elapsedWindowPercent >= 50
        ? 'alta'
        : elapsedWindowPercent >= 20 ? 'media' : 'baixa';
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
    openai_context_tokens_avoided: 0,
  };
}

function addLocalAiTotals(target, source) {
  for (const key of Object.keys(emptyLocalAiTotals())) {
    const value = Number(source?.[key]);
    if (Number.isFinite(value) && value > 0) target[key] += value;
  }
  return target;
}

function localAiDerived(totals) {
  const calls = Number(totals.calls) || 0;
  const successful = Number(totals.successful_calls) || 0;
  const failed = Number(totals.failed_calls) || 0;
  const input = Number(totals.context_input_tokens) || 0;
  const output = Number(totals.context_output_tokens) || 0;
  const duration = Number(totals.duration_seconds) || 0;
  return {
    context_reduction_percent: input > 0 ? round(Math.max(0, (1 - output / input) * 100), 1) : null,
    success_rate_percent: calls > 0 ? round((successful / calls) * 100, 1) : null,
    failure_rate_percent: calls > 0 ? round((failed / calls) * 100, 1) : null,
    average_duration_seconds: successful > 0 ? round(duration / successful, 2) : null,
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

function sanitizeLocalAiJob(job) {
  if (!job || typeof job !== 'object') return {};
  // The dashboard needs only operational metadata. Keeping this compact avoids
  // Home Assistant's 16 KiB state-attribute limit and never exposes endpoint
  // details through its state machine or Recorder.
  const fields = [
    'id', 'status', 'task', 'model', 'chat_id', 'chat_name', 'started_at', 'finished_at',
    'duration_seconds', 'error_type', 'fallback_reported',
    'context_input_tokens', 'context_output_tokens',
    'openai_context_tokens_avoided', 'context_reduction_percent',
    'tokens_per_second', 'gpu_telemetry_available', 'gpu_peak_percent',
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

function scanLocalAiTelemetry(telemetryPath, statusPath, now = new Date()) {
  const state = readJson(telemetryPath, {});
  const preflight = readJson(statusPath, {});
  const totals = { ...emptyLocalAiTotals(), ...(state.totals || {}) };
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
    : preflightFreshness.current ? preflightState : 'LOCAL_AI_UNAVAILABLE';
  const models = Object.entries(state.models || {})
    .map(([model, value]) => ({ model, ...(value.totals || {}), ...localAiDerived(value.totals || {}) }))
    .sort((left, right) => Number(right.calls || 0) - Number(left.calls || 0));

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
    models,
    // Five jobs cover the current job plus recent diagnostics, while staying
    // well below the attribute-size limit enforced by Home Assistant.
    latest_jobs: Array.isArray(state.latest_jobs)
      ? state.latest_jobs.slice(-5).reverse().map(sanitizeLocalAiJob)
      : [],
  };
}

function scanCodexUsage(sessionsDirectory, now = new Date()) {
  const totals = emptyTokens();
  const recentTokens = emptyTokens();
  const daily = new Map();
  let latestEvent = null;
  let latestRateEvent = null;
  let latestCreditEvent = null;
  let sessionCount = 0;
  let eventCount = 0;

  for (const filePath of listJsonlFiles(sessionsDirectory)) {
    let contents;
    try {
      contents = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
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
      if (timestamp.valueOf() >= now.valueOf() - 7 * 86_400_000) {
        addTokens(recentTokens, delta);
      }
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
        event.payload.rate_limits?.credits
        && (!latestCreditEvent || timestamp > latestCreditEvent.timestamp)
      ) latestCreditEvent = candidate;
    }
    if (hasUsage) sessionCount += 1;
  }

  const rateSource = latestRateEvent || latestEvent;
  const sanitized = sanitizeRateLimits(rateSource?.rateLimits);
  const creditSnapshot = sanitizeRateLimits(latestCreditEvent?.rateLimits)?.credits;
  if (sanitized && creditSnapshot) sanitized.credits = creditSnapshot;

  const analytics = buildAnalytics({
    totals,
    recentTokens,
    rateLimit: sanitized,
    now,
  });

  return {
    status: latestEvent ? 'ok' : 'no_data',
    collected_at: now.toISOString(),
    source_updated_at: latestEvent?.timestamp.toISOString() || null,
    rate_limit_updated_at: latestRateEvent?.timestamp.toISOString() || null,
    plan_type: sanitized?.plan_type || null,
    rate_limit: sanitized,
    freshness: {
      activity: freshness(latestEvent?.timestamp, now),
      rate_limit: freshness(latestRateEvent?.timestamp, now),
    },
    totals: { ...totals, sessions: sessionCount, events: eventCount },
    analytics,
    daily: [...daily.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-30)
      .map(([date, usage]) => ({ date, ...usage })),
  };
}

class CodexUsageReader {
  constructor(sessionsDirectory, localAiTelemetryPath = null, localAiStatusPath = null, cacheMs = 5_000) {
    this.sessionsDirectory = sessionsDirectory;
    this.localAiTelemetryPath = localAiTelemetryPath;
    this.localAiStatusPath = localAiStatusPath;
    this.cacheMs = cacheMs;
    this.cachedAt = 0;
    this.cached = null;
  }

  read() {
    if (this.cached && Date.now() - this.cachedAt < this.cacheMs) return this.cached;
    this.cached = {
      ...scanCodexUsage(this.sessionsDirectory),
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
