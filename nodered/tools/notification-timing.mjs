// Structural adaptation only. These observations never authorize a delivery.
export function notificationTimingObservation(input, acceptedAt) {
  const empty = (reason) => ({ version: 1, state: "unknown", reason,
    source_observed_at: null, source_time_kind: "unknown", first_detected_at: null,
    policy_decided_at: null, source_to_detection_ms: null,
    detection_to_decision_ms: null, decision_to_accept_ms: null });
  if (input === undefined) return empty("metadata_not_supplied");
  const keys = ["version", "source_observed_at", "source_time_kind", "first_detected_at", "policy_decided_at"];
  if (!input || typeof input !== "object" || Array.isArray(input) || input.version !== 1 ||
      Object.keys(input).length !== keys.length || !keys.every(key => Object.hasOwn(input, key)) ||
      !["producer_occurrence", "producer_observation", "unknown"].includes(input.source_time_kind)) {
    return empty("invalid_metadata");
  }
  const stamp = value => {
    if (typeof value !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return NaN;
    const at = Date.parse(value);
    return Number.isFinite(at) && new Date(at).toISOString().slice(0, 19) === value.slice(0, 19) ? at : NaN;
  };
  const values = [input.source_observed_at, input.first_detected_at, input.policy_decided_at];
  if (values.some(value => value !== null && !Number.isFinite(stamp(value))) ||
      (input.source_time_kind === "unknown") !== (input.source_observed_at === null)) return empty("invalid_metadata");
  const accepted = stamp(acceptedAt);
  if (!Number.isFinite(accepted)) return empty("acceptance_clock_invalid");
  const times = values.map(value => value === null ? null : stamp(value));
  if (times.every(value => value === null)) return empty("timestamps_missing");
  const known = [...times, accepted].filter(value => value !== null);
  const ordered = known.every((value, index) => index === 0 || value >= known[index - 1]);
  const delta = (left, right) => ordered && left !== null && right !== null ? right - left : null;
  return { version: 1, state: !ordered ? "clock_conflict" : times.every(value => value !== null) ? "observed" : "partial",
    reason: !ordered ? "wall_clock_order_conflict" : times.some(value => value === null) ? "timestamps_missing" : null,
    source_observed_at: input.source_observed_at, source_time_kind: input.source_time_kind,
    first_detected_at: input.first_detected_at, policy_decided_at: input.policy_decided_at,
    source_to_detection_ms: delta(times[0], times[1]),
    detection_to_decision_ms: delta(times[1], times[2]),
    decision_to_accept_ms: delta(times[2], accepted) };
}

// Embed this same pure function in generated Function nodes; no runtime module
// loading or additional Node-RED capabilities are needed.
export function withNotificationTimingSource(body) {
  return body.includes("notificationTimingObservation(")
    ? `${notificationTimingObservation.toString()}\n${body}` : body;
}
