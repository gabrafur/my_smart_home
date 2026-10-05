// Cumulative, isolated snapshots enter the very same production calculations.
const scenario = msg.payload?.scenario;
const now = Date.now(), at = new Date(now).toISOString();
const entity = (state, attributes = {}) => ({ state, attributes: { collected_at: at, ...attributes }, last_updated: at, last_reported: at });
const empty = Object.fromEntries(["operational_calls", "operational_failed_calls", "operational_quality_rejected_calls", "operational_not_beneficial_calls", "operational_quality_validated_calls", "operational_quality_validated_measured_calls", "operational_primary_context_used_calls", "operational_primary_context_unconfirmed_calls", "diagnostic_calls", "unclassified_calls", "attempted_context_input_tokens", "confirmed_gross_useful_context_tokens_avoided", "confirmed_quality_validation_tokens", "confirmed_useful_context_tokens_avoided"].map(k => [k, 0]));
const counters = scenario === "empty" ? empty : { ...empty, operational_calls: 4, operational_failed_calls: 1, operational_quality_validated_calls: 2, operational_quality_validated_measured_calls: 2, operational_quality_rejected_calls: 1, operational_primary_context_used_calls: 1, operational_primary_context_unconfirmed_calls: 1, attempted_context_input_tokens: 2000, confirmed_gross_useful_context_tokens_avoided: 1000, confirmed_quality_validation_tokens: 100, confirmed_useful_context_tokens_avoided: 900 };
const snapshot = flow.get("rtx_metrics_test_snapshot") || {};
Object.assign(snapshot, { usage: entity("ok", { collected_at: at, local_ai: { periods: { today: counters, week: counters, month: counters }, totals: counters, daily_series: [] } }), live: entity(scenario === "empty" ? "available" : "in_use", { gpu_util_percent: 70, vram_mib: 4000, power_watts: 80, task: "analyze-tests", model: "synthetic-model" }), history: entity("0", { jobs: [] }), host: entity("online") });
if (scenario === "offline") { snapshot.host.state = "offline"; snapshot.live.state = "unavailable"; }
if (scenario === "stale") { snapshot.usage.attributes.collected_at = new Date(now - 600000).toISOString(); snapshot.live.attributes.collected_at = snapshot.usage.attributes.collected_at; snapshot.host.state = "unknown"; }
if (scenario === "invalid") snapshot.usage.state = "unavailable";
flow.set("rtx_metrics_test_snapshot", snapshot);
flow.set("rtx_metrics_test_policy", { usage_max_age_s: 30, live_max_age_s: 15, history_max_age_s: 90, host_max_age_s: 90, history_limit: 15 });
return { ...snapshot, test_mode: true, now };
