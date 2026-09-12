const data = msg._light_reconcile;
const observedAt = Number(flow.get("security_light_physical_observed_at") ?? 0);
const freshMs = Number(data.policy.physical_fresh_seconds) * 1000;
const physicalFresh = Number.isFinite(observedAt) && observedAt <= data.now + data.future_ms &&
    data.now - observedAt <= freshMs;
if (!physicalFresh) flow.set("light_reconciled", false);
const people = flow.get("people_context_v1") ?? {};
const vehicle = flow.get("vehicle_primary_context_v1") ?? {};
const ready = people.ready === true && vehicle.ready === true && flow.get("sun_ready") === true &&
    flow.get("light_reconciled") === true && physicalFresh;
const wasReady = flow.get("security_light_ready");
flow.set("security_light_ready", ready);
if (wasReady !== ready) node.log?.(`iluminacao_seguranca: readiness ${ready ? "completo" : "pendente"}`);
data.recovery_needed = data.physical_accepted && ready &&
    flow.get("security_light_physical_state") === "on" && data.lifecycle.active_by_arrival === true;
data.deadlines = data.recovery_needed ? [
    Number.isFinite(data.lifecycle.force_off_at)
        ? { type: "backstop", at: data.lifecycle.force_off_at, reason: "recovered_backstop" } : null,
    Number.isFinite(data.lifecycle.pending_off_at)
        ? { type: "pending_off", at: data.lifecycle.pending_off_at,
            reason: data.lifecycle.pending_off_reason ?? "recovered_pending_off" } : null
].filter(Boolean) : [];
data.recovery_needed = data.deadlines.length > 0;
return msg;
