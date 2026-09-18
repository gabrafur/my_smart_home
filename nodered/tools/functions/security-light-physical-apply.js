const data = msg._light_reconcile;
const lifecycle = data.lifecycle;
const now = data.now;
if (data.physical_signal && flow.get("security_light_startup_logged") !== true) {
    node.log?.("iluminacao_seguranca: startup/reconciliação física iniciada");
    flow.set("security_light_startup_logged", true);
}
if (data.physical_signal) {
    const state = msg.payload.state;
    const updatedAt = Number(msg.payload.updated_at ?? 0);
    const previousAt = Number(flow.get("security_light_physical_updated_at") ?? 0);
    const timestampConflict = updatedAt && previousAt && updatedAt === previousAt &&
        flow.get("security_light_physical_state") !== undefined &&
        flow.get("security_light_physical_state") !== state;
    if (updatedAt > now + data.future_ms || (updatedAt && previousAt && updatedAt < previousAt) ||
        timestampConflict) {
        flow.set("light_reconciled", false);
        data.physical_accepted = false;
        node.warn(timestampConflict
            ? "iluminacao_seguranca: conflito de estado físico no mesmo timestamp; primeiro preservado"
            : "iluminacao_seguranca: leitura física fora de ordem ou futura; descartada");
    } else {
        flow.set("security_light_physical_observed_at", now);
        if (updatedAt) flow.set("security_light_physical_updated_at", updatedAt);
        flow.set("security_light_physical_state", state ?? "unknown");
        if (["on", "off"].includes(state)) {
            flow.set("light_reconciled", true);
            flow.set("security_light_last_unavailable_state", null);
            flow.set("security_light_turn_on_notification_latch_v1", state === "on"
                ? { version: 1, latched: true, reason: "physical_on", latched_at: now }
                : null, "persistent");
            if (state === "off" && lifecycle.active_by_arrival === true) {
                Object.assign(lifecycle, { active_by_arrival: false, on_since: null, force_off_at: null,
                    pending_off_at: null, pending_off_reason: null, pending_off_source: null,
                    vehicle_refresh_at: null, vehicle_refresh_reason: null, vehicle_refresh_source: null,
                    cooldown_until: now + Number(data.policy.post_off_cooldown_minutes) * 60000,
                    updated_at: now });
                node.warn("iluminacao_seguranca: contexto ON corrigido porque o refletor físico está OFF");
            }
        } else {
            flow.set("light_reconciled", false);
            const previous = flow.get("security_light_last_unavailable_state");
            if (previous !== (state ?? "unknown")) node.warn(state === "unavailable"
                ? "iluminacao_seguranca: refletor unavailable; chegada válida ainda pode tentar ligar"
                : `iluminacao_seguranca: refletor ${state ?? "unknown"}; efeitos físicos bloqueados`);
            flow.set("security_light_last_unavailable_state", state ?? "unknown");
        }
    }
}
flow.set("security_light_lifecycle_v1", lifecycle, "persistent");
return msg;
