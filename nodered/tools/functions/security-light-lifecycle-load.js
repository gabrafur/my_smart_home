const now = Date.now();
const locationPolicy = global.get("location_policy_v1", "persistent");
const policy = global.get("security_light_policy_v1", "persistent");
if (locationPolicy?.version !== 1 || locationPolicy?.complete !== true ||
    policy?.version !== 1 || policy?.complete !== true) {
    node.error("iluminacao_seguranca: política canônica ausente na reconciliação", msg);
    return null;
}
const futureMs = Number(locationPolicy.future_tolerance_seconds) * 1000;
const retentionMs = Number(policy.lifecycle_retention_hours) * 3600000;
const maxDeadlineMs = (Number(policy.backstop_minutes) + Number(policy.deadline_slack_minutes)) * 60000;
let lifecycle = flow.get("security_light_lifecycle_v1", "persistent");
if (!lifecycle || lifecycle.version !== 1 || !Number.isFinite(lifecycle.updated_at) ||
    lifecycle.updated_at > now + futureMs || now - lifecycle.updated_at > retentionMs) {
    if (lifecycle) node.warn("iluminacao_seguranca: lifecycle persistido inválido ou expirado; descartado");
    lifecycle = { version: 1, active_by_arrival: false, updated_at: now };
}
if (lifecycle.active_by_arrival !== true) lifecycle.active_by_arrival = false;
if (lifecycle.active_by_arrival === true && (!Number.isFinite(lifecycle.on_since) ||
    lifecycle.on_since > now + futureMs || !Number.isFinite(lifecycle.force_off_at) ||
    lifecycle.force_off_at < lifecycle.on_since || lifecycle.force_off_at > lifecycle.on_since + maxDeadlineMs)) {
    node.warn("iluminacao_seguranca: lifecycle ativo sem deadline coerente; tratado como origem desconhecida");
    Object.assign(lifecycle, { active_by_arrival: false, on_since: null, force_off_at: null,
        pending_off_at: null, pending_off_reason: null, pending_off_source: null });
}
if (lifecycle.active_by_arrival === true && lifecycle.pending_off_at != null &&
    (!Number.isFinite(lifecycle.pending_off_at) || lifecycle.pending_off_at < lifecycle.on_since ||
    lifecycle.pending_off_at > lifecycle.force_off_at)) {
    node.warn("iluminacao_seguranca: deadline de carência inválido; descartado");
    Object.assign(lifecycle, { pending_off_at: null, pending_off_reason: null, pending_off_source: null });
}
const cooldownMaxMs = Number(policy.cooldown_max_minutes) * 60000;
if (lifecycle.cooldown_until != null && (!Number.isFinite(lifecycle.cooldown_until) ||
    lifecycle.cooldown_until <= now || lifecycle.cooldown_until > now + cooldownMaxMs)) lifecycle.cooldown_until = null;
msg._light_reconcile = { now, policy, location_policy: locationPolicy, future_ms: futureMs,
    lifecycle, physical_signal: msg.payload?.kind === "light_physical", physical_accepted: true };
return msg;
