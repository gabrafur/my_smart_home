const data = msg._refresh;
const state = data.state;
const reason = String(data.suppress_reason ?? "minimum_interval");
const deadline = reason === "cache_probe_in_flight" ? state.cache_probe_in_flight_until
    : reason === "cache_probe_settling" ? state.cache_probe_settle_until
    : reason === "in_flight" ? state.in_flight_until : state.next_allowed_at;
const waitS = Math.max(1, Math.ceil((Number(deadline) - data.now) / 1000));
state.state = reason.startsWith("cache_probe") ? "probing_cache"
    : reason === "in_flight" ? "in_flight"
    : state.awaiting_evidence === true ? "backoff" : "cooldown";
state.reason = reason === "minimum_interval" ? data.requested_reason : reason;
state.enabled = true;
state.updated_at = data.now;
state.next_retry_at = state.awaiting_evidence === true ? state.next_allowed_at || null : null;
state.cooldown_until = state.awaiting_evidence !== true && state.last_success_at > 0 &&
    state.next_allowed_at > data.now ? state.next_allowed_at : null;
data.output = null;
if (msg.payload?.reason === "manual_force") {
    msg.notification = {
        title: "Atualização do vehicle_primary não enviada",
        message: "Já existe uma tentativa dentro da janela de proteção. " +
            `Nenhuma nova consulta foi enviada; reavaliar em ${waitS} s.`,
        id: "vehicle_primary_refresh_blocked"
    };
    data.output = 2;
}
delete data.suppress_reason;
return msg;
