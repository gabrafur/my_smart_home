// Canonical passive accounting. No service, notification or device decision.
export function hostTimingTransition(previous, input) {
  try {
  const count = x => Number.isSafeInteger(x) && x >= 0 && x <= 1e12;
  const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1e15;
  const stamp = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(x) && Number.isFinite(Date.parse(x)) ? Date.parse(x) : NaN;
  const sources = ['docker', 'systemd', 'resources'];
  const fields = ['expected', 'observed', 'unknown', 'over_contract', 'missing'];
  const emptySource = () => ({expected: 0, observed: 0, unknown: 0, over_contract: 0, missing: 0,
    max_source_to_reader_ms: null, max_reader_to_canvas_ms: null, max_source_to_canvas_upper_ms: null});
  const flat = state => [...sources.flatMap(source => fields.map(field => state.sources[source][field])),
    state.report_gaps, state.source_unavailable, state.source_faults, state.clock_conflicts, state.invalid_observations];
  const reasons = ['measurement_policy_unavailable', 'report_unavailable_or_stale',
    'producer_timing_unavailable', 'producer_clock_unstable', 'reader_clock_unavailable',
    'clock_alignment_unconfirmed', 'producer_counter_reversed', 'producer_counter_mismatch',
    'accounting_counter_exhausted', 'accounting_state_invalid'];
  const priorInvalid = previous == null ? 0 :
    count(previous.invalid_observations) && Array.isArray(previous.past_counters) &&
    previous.past_counters.length === 20 && previous.past_counters.every(count)
      ? previous.invalid_observations + previous.past_counters[19] : NaN;
  if (!Number.isSafeInteger(priorInvalid)) throw new Error('invalid_accounting_state');
  const history = previous?.invalid_reason_history === undefined ? {
    version: 1, covered_total: priorInvalid, unattributed_prior_count: priorInvalid,
    counts: Object.fromEntries(reasons.map(reason => [reason, 0])), recent: []
  } : JSON.parse(JSON.stringify(previous.invalid_reason_history));
  const historyCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 2e12;
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  if (!exactKeys(history, ['version', 'covered_total', 'unattributed_prior_count', 'counts', 'recent']) ||
      history.version !== 1 || !historyCount(history.unattributed_prior_count) ||
      !historyCount(history.covered_total) || history.covered_total > priorInvalid ||
      !exactKeys(history.counts, reasons) || !Object.values(history.counts).every(historyCount) ||
      history.unattributed_prior_count + Object.values(history.counts).reduce((sum, n) => sum + n, 0) !== history.covered_total ||
      !Array.isArray(history.recent) || history.recent.length > 16 ||
      history.recent.some(row => !exactKeys(row, ['reason', 'observed_at', 'epoch']) ||
        !reasons.includes(row.reason) || history.counts[row.reason] < 1 || !count(row.epoch) ||
        !count(previous?.epoch) || row.epoch > previous.epoch ||
        !(row.observed_at === null || Number.isFinite(stamp(row.observed_at)))) ||
      reasons.some(reason => history.recent.filter(row => row.reason === reason).length > history.counts[reason])) {
    // Preserve the corrupt record and counters for review; never reset them to
    // a plausible clean history or export arbitrary reason text.
    return {...previous, state: 'unknown', collection_error: 'reason_history_invalid'};
  }
  // An older producer can preserve this record without attributing its new
  // failures. Reconcile that uncovered count as unknown after a rollback.
  history.unattributed_prior_count += priorInvalid - history.covered_total;
  history.covered_total = priorInvalid;
  const missing = reason => {
    const state = previous?.version === 1 && JSON.stringify(previous).length <= 24000
      ? JSON.parse(JSON.stringify(previous)) : {version: 1, state: 'unknown', collection_error: null,
        epoch: 0, previous_epochs: 0, historical_unknown_epochs: 0, past_counters: Array(20).fill(0),
        sources: Object.fromEntries(sources.map(source => [source, emptySource()])),
        report_gaps: 0, source_unavailable: 0, source_faults: 0, clock_conflicts: 0, invalid_observations: 0, anchors: []};
    state.state = 'unknown'; state.collection_error = reason;
    state.invalid_reason_history = history;
    if (count(state.invalid_observations) && state.invalid_observations < 1e12) {
      state.invalid_observations++;
      history.counts[reason]++;
      history.covered_total++;
      const observed = number(input?.now_ms) ? new Date(input.now_ms).toISOString() : null;
      history.recent.push({reason, observed_at: Number.isFinite(stamp(observed)) ? observed : null,
        epoch: count(state.epoch) ? state.epoch : 0});
      history.recent = history.recent.slice(-16);
    }
    if (reason.includes('clock') && count(state.clock_conflicts) && state.clock_conflicts < 1e12) state.clock_conflicts++;
    return state;
  };
  const {report, reader, now_ms: now, canvas_monotonic_ms: canvas, limits, max_report_age_ms: freshness,
    runtime_restarted: restarted} = input;
  if (!limits || Object.keys(limits).length !== 2 || !number(limits.event_latency_ms) ||
      limits.event_latency_ms < 1000 || limits.event_latency_ms > 60000 ||
      !number(limits.resource_latency_ms) || limits.resource_latency_ms < 20000 || limits.resource_latency_ms > 120000) {
    return missing('measurement_policy_unavailable');
  }
  if (!report || !number(now) || !number(canvas) || !number(freshness) ||
      !Number.isFinite(stamp(report.observed_at)) || now - stamp(report.observed_at) < -1000 ||
      now - stamp(report.observed_at) > freshness) return missing('report_unavailable_or_stale');
  const timing = report.timing_v1;
  if (timing?.version !== 1 || timing.state !== 'observed' ||
      !number(timing.report_monotonic_seconds) || !count(timing.resource_sample_sequence) ||
      !number(timing.resource_sampled_monotonic_seconds) ||
      !count(timing.source_event_counts?.docker) || !count(timing.source_event_counts?.systemd) ||
      !count(timing.source_fault_counts?.docker) || !count(timing.source_fault_counts?.systemd) ||
      !count(timing.clock_change_count) ||
      timing.source_event_counts.docker + timing.source_event_counts.systemd !== report.sequence) return missing('producer_timing_unavailable');
  if (timing.clock_stable !== true) return missing('producer_clock_unstable');
  if (reader?.state !== 'observed' || reader.boot_id_sha256 !== report.boot_id_sha256 ||
      !number(reader.monotonic_seconds) || !Number.isFinite(stamp(reader.observed_at))) return missing('reader_clock_unavailable');
  const wallOffset = now - canvas;
  const readerCanvas = now - stamp(reader.observed_at);
  // A one-second protocol alignment bound is included in the latency upper
  // bound. An unverified clock relation never becomes a zero duration.
  const alignment = Math.abs((stamp(reader.observed_at) - stamp(report.observed_at)) -
    (reader.monotonic_seconds - timing.report_monotonic_seconds) * 1000);
  if (readerCanvas < 0 || alignment > 1000 || reader.monotonic_seconds < timing.report_monotonic_seconds ||
      timing.resource_sampled_monotonic_seconds > reader.monotonic_seconds) return missing('clock_alignment_unconfirmed');
  let state = previous?.version === 1 ? JSON.parse(JSON.stringify(previous)) : null;
  if (state) state.invalid_reason_history = history;
  const reason = !state?.instance ? 'initial_baseline' : restarted ? 'consumer_runtime_restart' :
    state.instance !== report.instance_id || state.boot !== report.boot_id_sha256 ? 'producer_epoch_changed' :
    state.last_clock_change_count !== timing.clock_change_count ? 'producer_clock_changed' :
    JSON.stringify(state.limits) !== JSON.stringify(limits) ? 'measurement_policy_changed' :
    Math.abs(state.wall_offset_ms - wallOffset) > 1000 ? 'civil_clock_changed' :
    canvas < state.last_canvas_monotonic_ms ? 'consumer_monotonic_changed' : null;
  if (reason) {
    if (state?.instance && ['civil_clock_changed', 'producer_clock_changed', 'consumer_monotonic_changed'].includes(reason)) state.clock_conflicts++;
    const past = state?.past_counters ?? Array(20).fill(0);
    if (state?.sources) flat(state).forEach((value, index) => { past[index] += value; });
    state = {version: 1, state: 'observed', collection_error: null,
      epoch: (state?.epoch ?? 0) + 1, previous_epochs: state?.instance ? (state.previous_epochs ?? 0) + 1 : state?.previous_epochs ?? 0,
      historical_unknown_epochs: (state?.historical_unknown_epochs ?? 0) + (state ? 1 : 0),
      epoch_reason: reason, past_counters: past, instance: report.instance_id, boot: report.boot_id_sha256,
      limits: {...limits}, started_at: new Date(now).toISOString(),
      started_canvas_monotonic_ms: canvas, last_canvas_monotonic_ms: canvas,
      wall_offset_ms: wallOffset, observed_at: new Date(now).toISOString(),
      last_report_at: report.observed_at, report_observations: 1,
      last_event_sequence: report.sequence, last_event_totals: {...timing.source_event_counts},
      last_source_faults: {...timing.source_fault_counts}, last_clock_change_count: timing.clock_change_count,
      last_resource_sequence: timing.resource_sample_sequence,
      sources: Object.fromEntries(sources.map(source => [source, emptySource()])),
      report_gaps: 0, source_unavailable: 0, source_faults: 0, clock_conflicts: 0, invalid_observations: 0,
      invalid_reason_history: history,
      anchors: [], anchor_slot: -1, window24h: {state: 'collecting', minimum_span_seconds: 0, counters: null}};
    // The current report may precede instrumentation. Never backfill its
    // first detection or pretend its old ring members were newly observed.
    return state;
  }
  if (canvas - state.last_canvas_monotonic_ms > freshness) state.report_gaps++;
  state.last_canvas_monotonic_ms = canvas;
  state.wall_offset_ms = wallOffset;
  state.observed_at = new Date(now).toISOString();
  state.state = 'observed'; state.collection_error = null;
  if (report.sequence < state.last_event_sequence || timing.resource_sample_sequence < state.last_resource_sequence ||
      ['docker', 'systemd'].some(source => timing.source_event_counts[source] < state.last_event_totals[source])) {
    return missing('producer_counter_reversed');
  }
  const add = (source, sourceReader, unknown) => {
    const row = state.sources[source]; row.observed++;
    if (unknown || !number(sourceReader)) { row.unknown++; return; }
    const upper = sourceReader + readerCanvas + 1000;
    row.max_source_to_reader_ms = Math.max(row.max_source_to_reader_ms ?? 0, sourceReader);
    row.max_reader_to_canvas_ms = Math.max(row.max_reader_to_canvas_ms ?? 0, readerCanvas);
    row.max_source_to_canvas_upper_ms = Math.max(row.max_source_to_canvas_upper_ms ?? 0, upper);
    if (upper > limits[source === 'resources' ? 'resource_latency_ms' : 'event_latency_ms']) row.over_contract++;
  };
  const seen = {docker: 0, systemd: 0};
  for (const event of report.events ?? []) {
    if (!['docker', 'systemd'].includes(event.source) || !count(event.sequence) ||
        event.sequence <= state.last_event_sequence || event.sequence > report.sequence) continue;
    const delta = number(event.observer_monotonic_seconds)
      ? (reader.monotonic_seconds - event.observer_monotonic_seconds) * 1000 : null;
    const good = number(event.source_to_observer_ms) && number(delta) && event.source_clock_ordered === true;
    add(event.source, good ? event.source_to_observer_ms + delta : null, !good);
    seen[event.source]++;
  }
  for (const source of ['docker', 'systemd']) {
    const expected = timing.source_event_counts[source] - state.last_event_totals[source];
    if (seen[source] > expected) return missing('producer_counter_mismatch');
    state.sources[source].expected += expected;
    state.sources[source].missing += expected - seen[source];
    state.last_event_totals[source] = timing.source_event_counts[source];
  }
  state.last_event_sequence = report.sequence;
  const expectedResources = timing.resource_sample_sequence - state.last_resource_sequence;
  if (expectedResources > 0) {
    state.sources.resources.expected += expectedResources;
    state.sources.resources.missing += expectedResources - 1;
    const data = report.resources?.data ?? {};
    const good = Array.isArray(report.resources?.collection_errors) && report.resources.collection_errors.length === 0 &&
      ['cpu_busy_percent', 'memory_available_bytes', 'disk_used_percent', 'inodes_used_percent', 'temperature_celsius']
        .every(key => number(data[key]));
    add('resources', (reader.monotonic_seconds - timing.resource_sampled_monotonic_seconds) * 1000, !good);
    state.last_resource_sequence = timing.resource_sample_sequence;
  }
  if (report.observed_at !== state.last_report_at) {
    state.report_observations++;
    if (['docker', 'systemd'].some(source => report.sources?.[source]?.state !== 'connected' ||
        report.sources[source].collection_error !== null)) state.source_unavailable++;
    state.last_report_at = report.observed_at;
  }
  for (const source of ['docker', 'systemd']) {
    if (timing.source_fault_counts[source] < state.last_source_faults[source]) return missing('producer_counter_reversed');
    state.source_faults += timing.source_fault_counts[source] - state.last_source_faults[source];
  }
  state.last_source_faults = {...timing.source_fault_counts};
  const counts = flat(state);
  if (!counts.every(count)) return missing('accounting_counter_exhausted');
  const slot = Math.floor((canvas - state.started_canvas_monotonic_ms) / 3600000);
  const usable = ['docker', 'systemd'].every(source => report.sources?.[source]?.state === 'connected' &&
    report.sources[source].collection_error === null) &&
    report.resources?.data?.cpu_busy_percent !== null && report.resources?.collection_errors?.length === 0;
  if (slot > state.anchor_slot && usable) {
    state.anchors.push([canvas, state.observed_at, ...counts]);
    state.anchors = state.anchors.slice(-25); state.anchor_slot = slot;
  }
  const eligible = state.anchors.filter(anchor => canvas - anchor[0] >= 86400000);
  const anchor = eligible.at(-1);
  state.window24h = anchor ? {state: 'candidate', minimum_span_seconds: (canvas - anchor[0]) / 1000,
    started_at: anchor[1], ended_at: state.observed_at,
    counters: counts.map((value, index) => value - anchor[index + 2])} :
    {state: 'collecting', minimum_span_seconds: state.anchors.length ? (canvas - state.anchors[0][0]) / 1000 : 0, counters: null};
  return state;
  } catch {
    return {version: 1, state: 'unknown', collection_error: 'accounting_state_invalid',
      historical_state_unavailable: true, historical_unknown_epochs: 1};
  }
}

export function withHostTimingSource(body) {
  return body.includes('hostTimingTransition(') ? `${hostTimingTransition.toString()}\n${body}` : body;
}
