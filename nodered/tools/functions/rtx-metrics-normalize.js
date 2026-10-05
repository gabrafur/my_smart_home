// Adapt HA transport entities. Missing/stale data never become measured zeroes.
const policy = flow.get(msg.test_mode === true ? "rtx_metrics_test_policy" : "rtx_metrics_policy");
if (!policy) { node.warn("Métricas RTX aguardam política válida"); return null; }
const now = msg.test_mode === true && Number.isFinite(msg.now) ? msg.now : Date.now();
const age = value => { const t = Date.parse(value); return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : null; };
const fresh = (entity, seconds, timestamp) => {
    const secondsOld = age(timestamp || entity?.last_updated);
    return Boolean(entity && !["unknown", "unavailable", "error"].includes(entity.state) && secondsOld !== null && secondsOld <= seconds);
};
const usage = msg.usage?.attributes || {};
const local = usage.local_ai;
const usageOk = msg.usage?.state === "ok" && fresh(msg.usage, policy.usage_max_age_s, usage.collected_at) && local && typeof local === "object";
// Explicit observation timestamps also advance on repeated idle/empty samples.
const liveOk = fresh(msg.live, policy.live_max_age_s, msg.live?.attributes?.collected_at);
const historyOk = fresh(msg.history, policy.history_max_age_s, msg.history?.attributes?.collected_at) && Array.isArray(msg.history?.attributes?.jobs) && !msg.history.attributes.error;
const hostOk = fresh(msg.host, policy.host_max_age_s, msg.host?.attributes?.collected_at);
msg.rtx = { now, policy, local: usageOk ? local : {}, live: liveOk ? msg.live : null, history: historyOk ? msg.history.attributes.jobs : null };
msg.report = {
    schema_version: 1, updated_at: new Date(now).toISOString(), period_timezone: "UTC",
    data_status: usageOk ? "current" : "unavailable", data_reason: usageOk ? "Telemetria atualizada" : "Telemetria ausente, inválida ou desatualizada",
    source_at: usageOk ? usage.collected_at : null,
    history_status: historyOk ? "current" : "unavailable",
    host: hostOk && ["online", "offline"].includes(msg.host.state) ? msg.host.state : "unknown",
    metrics: {}, periods: {}, jobs: [], daily: [],
};
return msg;
