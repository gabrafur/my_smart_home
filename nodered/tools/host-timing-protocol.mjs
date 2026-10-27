// Optional observation metadata. Failure here must not remove ordinary facts.
export function projectProducerTiming(report) {
  const value = report?.timing_v1;
  if (value === undefined) return undefined;
  const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1e12;
  const count = x => Number.isSafeInteger(x) && x >= 0 && x <= 1e12;
  const totals = value?.source_event_counts;
  const faults = value?.source_fault_counts;
  if (!value || value.version !== 1 || !number(value.report_monotonic_seconds) ||
      !count(value.resource_sample_sequence) || !number(value.resource_sampled_monotonic_seconds) ||
      value.resource_sampled_monotonic_seconds > value.report_monotonic_seconds ||
      !count(totals?.docker) || !count(totals?.systemd) || totals.docker + totals.systemd !== report.sequence ||
      !count(faults?.docker) || !count(faults?.systemd) || !count(value.clock_change_count) ||
      typeof value.clock_stable !== 'boolean' ||
      value.resource_period_seconds !== 20 || value.idle_report_period_seconds !== 10) {
    return { version: 1, state: 'unknown', collection_error: 'producer_timing_invalid' };
  }
  return { version: 1, state: 'observed', collection_error: null,
    report_monotonic_seconds: value.report_monotonic_seconds,
    resource_sample_sequence: value.resource_sample_sequence,
    resource_sampled_monotonic_seconds: value.resource_sampled_monotonic_seconds,
    source_event_counts: { docker: totals.docker, systemd: totals.systemd },
    source_fault_counts: { docker: faults.docker, systemd: faults.systemd },
    clock_change_count: value.clock_change_count, clock_stable: value.clock_stable,
    resource_period_seconds: value.resource_period_seconds,
    idle_report_period_seconds: value.idle_report_period_seconds };
}
