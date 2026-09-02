const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;
const PERSISTENT = "persistent";

function contextKey(base) {
    return TEST_MODE ? `${base}__test` : base;
}

function ctxGet(base, store) {
    const key = contextKey(base);
    return TEST_MODE || !store
        ? flow.get(key)
        : flow.get(key, store);
}

const bypassEnabled =
    ctxGet("security_light_engine_bypass_enabled", PERSISTENT) === true;
const engineUnreliable =
    msg.payload?.engine_data_unreliable === true ||
    msg.payload?.vehicle_primary_engine_state_valid !== true ||
    msg.payload?.vehicle_primary_engine_stale === true ||
    msg.payload?.vehicle_primary_lighting_ready !== true;
const bypassAllowed = bypassEnabled && engineUnreliable;
const engineGateAllowed =
    msg.payload?.vehicle_primary_in_use === true &&
    msg.payload?.vehicle_primary_engine_on === true &&
    msg.payload?.vehicle_primary_engine_state_valid === true &&
    msg.payload?.vehicle_primary_engine_stale !== true;

if (!engineGateAllowed && !bypassAllowed) {
    node.status({
        fill: "yellow",
        shape: "ring",
        text: engineUnreliable
            ? `${TEST_MODE ? "TESTE: " : ""}motor não confiável; bypass desligado`
            : `${TEST_MODE ? "TESTE: " : ""}bloqueado — motor OFF confiável`
    });
    return null;
}

if (!TEST_MODE) {
    const lifecycle =
        flow.get("security_light_lifecycle_v1", PERSISTENT) ?? {};
    const until = Number(lifecycle.cooldown_until ?? 0);
    if (Number.isFinite(until) && Date.now() < until) {
        node.status({
            fill: "grey",
            shape: "ring",
            text: "iluminação em cooldown"
        });
        return null;
    }
}

msg.payload.engine_bypass_enabled = bypassEnabled;
msg.payload.engine_bypass_allowed = bypassAllowed;
msg.payload.vehicle_primary_gate = bypassAllowed
    ? "manual_bypass_for_unreliable_engine"
    : "fresh_engine_on";

if (TEST_MODE) {
    node.status({
        fill: bypassAllowed ? "yellow" : "green",
        shape: "dot",
        text: bypassAllowed
            ? "TESTE: bypass manual aprovado — continuando dry-run"
            : "TESTE: gate aprovado — continuando dry-run"
    });
    msg.payload.simulated = true;
    msg.payload.dispatched = false;
} else if (bypassAllowed) {
    node.status({
        fill: "yellow",
        shape: "dot",
        text: "bypass manual ativo — motor não confiável ignorado"
    });
}

return msg;
