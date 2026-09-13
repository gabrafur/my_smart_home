const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;
const PERSISTENT = "persistent";
const stateKey = TEST_MODE
    ? "security_vehicle_primary_refresh_v1__test"
    : "security_vehicle_primary_refresh_v1";
const nowCandidate = Number(msg.payload?.test_now);
const now = TEST_MODE && Number.isFinite(nowCandidate)
    ? nowCandidate
    : Date.now();
const config = msg.payload?.refresh_policy_config ?? {};
const startHour = Number(config.quiet_start_hour);
const endHour = Number(config.quiet_end_hour);

if (
    msg.payload?.refresh_policy_version !== 1 ||
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour)
) {
    node.error("Política de madrugada ausente ou inválida", msg);
    return null;
}

const hour = new Date(now).getHours();
const quietHours = startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
const requestedReason =
    msg.payload?.reason ??
    msg.payload?.recovery_reason ??
    "scheduled_refresh";
const manualBypass = requestedReason === "manual_force";
const departureBypass =
    requestedReason === "resident_departure" &&
    msg.payload?.resident_departure_force === true;
const arrivalBypass =
    requestedReason === "resident_arrival_confirmation" &&
    msg.payload?.resident_arrival_force === true;
const paused =
    !manualBypass &&
    !departureBypass &&
    !arrivalBypass &&
    msg.payload?.refresh_both_residents_home === true &&
    quietHours;

msg.payload.refresh_quiet_hours_active = quietHours;
msg.payload.refresh_quiet_hours_blocked = paused;

if (!paused) {
    node.status({
        fill: "green",
        shape: "dot",
        text: quietHours
            ? "madrugada liberada por exceção"
            : "fora da pausa noturna"
    });
    return msg;
}

let state = TEST_MODE
    ? flow.get(stateKey)
    : flow.get(stateKey, PERSISTENT);
if (!state || typeof state !== "object" || Array.isArray(state)) {
    state = {};
}

Object.assign(state, {
    state: "waiting",
    reason: "quiet_hours_both_home",
    enabled: false,
    next_retry_at: null,
    cooldown_until: null,
    updated_at: now
});

if (TEST_MODE) {
    flow.set(stateKey, state);
} else {
    flow.set(stateKey, state, PERSISTENT);
}

node.status({
    fill: "grey",
    shape: "ring",
    text: `pausado de ${startHour}h até ${endHour}h`
});
return null;
