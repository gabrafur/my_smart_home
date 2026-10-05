// The bridge owns sanitized counters/receipts; Node-RED owns dashboard formulas.
const n = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const sum = (...values) => values.every(v => v !== null) ? values.reduce((a, b) => a + b, 0) : null;
const subtract = (a, b) => a !== null && b !== null && a >= b ? a - b : null;
const ratio = (a, b) => a !== null && b !== null && b > 0 && a <= b ? Math.round(1000 * a / b) / 10 : null;
function period(raw = {}) {
    const p = {};
    const fields = {
        calls: "operational_calls", failed: "operational_failed_calls", rejected: "operational_quality_rejected_calls",
        no_gain: "operational_not_beneficial_calls", validated: "operational_quality_validated_calls",
        measured: "operational_quality_validated_measured_calls", used: "operational_primary_context_used_calls",
        unconfirmed: "operational_primary_context_unconfirmed_calls", diagnostics: "diagnostic_calls",
        unclassified: "unclassified_calls", attempted: "attempted_context_input_tokens",
        gross: "confirmed_gross_useful_context_tokens_avoided", gate: "confirmed_quality_validation_tokens",
    };
    for (const [key, source] of Object.entries(fields)) p[key] = n(raw[source]);
    p.completed = subtract(p.calls, p.failed);
    p.gated = sum(p.rejected, p.no_gain, p.validated);
    p.accepted = sum(p.no_gain, p.validated);
    p.without_gate = subtract(p.completed, p.gated);
    p.without_cost = subtract(p.validated, p.measured);
    p.net = subtract(p.gross, p.gate);
    // A mismatched source contract must not manufacture a confirmed saving.
    p.accounting_valid = p.net !== null && p.net === n(raw.confirmed_useful_context_tokens_avoided);
    if (!p.accounting_valid) p.net = null;
    p.use_rate = ratio(p.used, p.calls);
    p.failure_rate = ratio(p.failed, p.calls);
    p.reduction = ratio(p.net, p.attempted);
    p.confirmation = ratio(p.used, sum(p.used, p.unconfirmed));
    p.reason = p.calls === 0 ? "Sem tentativas operacionais neste período" : p.calls === null ? "Sem dados válidos neste período" : "Contadores de Local AI; não comprovam execução exclusiva na GPU";
    return p;
}
const local = msg.rtx.local;
for (const key of ["today", "week", "month", "total"]) msg.report.periods[key] = period(key === "total" ? local.totals : local.periods?.[key]);
// Preserve the waterfall's total-context denominator, separately from attempted context.
const usage = msg.report.data_status === "current" ? msg.usage?.attributes || {} : {};
const utcDay = new Date(msg.rtx.now).toISOString().slice(0, 10);
const daily = Array.isArray(usage.daily) ? usage.daily : null;
const dailyUsage = daily?.find(row => row?.date === utcDay);
msg.report.periods.today.codex_tokens = daily ? (dailyUsage ? n(dailyUsage.total_tokens) : 0) : null;
msg.report.periods.total.codex_tokens = n(usage.totals?.total_tokens);
for (const key of ["today", "total"]) {
    const p = msg.report.periods[key];
    const baseline = sum(p.codex_tokens, p.net);
    p.overall_reduction = p.net !== null && baseline !== null && baseline > 0 ? Math.round(1000000 * p.net / baseline) / 10000 : null;
}
const today = msg.report.periods.today;
Object.assign(msg.report.metrics, { net_today: today.net, calls_today: today.calls, used_today: today.used, reduction_today: today.reduction, use_rate_today: today.use_rate, net_total: msg.report.periods.total.net });
const r = local.routing?.periods?.today || {};
msg.report.routing = {};
for (const key of ["tasks", "eligible_tasks", "eligible_and_available_tasks", "missed_opportunities", "missed_potential_tokens_avoidable", "confirmed_unavailable_tasks", "availability_unknown_tasks", "failed_tasks"]) msg.report.routing[key] = n(r[key]);
msg.report.routing.availability_percent = ratio(n(r.eligible_and_available_tasks), n(r.eligible_tasks));
msg.report.daily = (Array.isArray(local.daily_series) ? local.daily_series : []).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row?.day)).slice(-7).map(row => ({
    day: row.day, calls: n(row.operational_calls), used: n(row.operational_primary_context_used_calls),
    net: n(row.useful_context_tokens_avoided), reduction: ratio(n(row.useful_context_tokens_avoided), n(row.attempted_context_input_tokens)),
}));
return msg;
