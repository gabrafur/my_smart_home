const CONFIG_KEY = "vehicle_primary_refresh_policy_config_v1";
const PERSISTENT = "persistent";

if (msg.payload?.kind !== "refresh_command") {
    return [null, null, null, null, null];
}

const config = flow.get(CONFIG_KEY, PERSISTENT);
const configReady =
    config?.version === 1 &&
    config?.complete === true &&
    Number.isFinite(Number(config.away_interval_minutes)) &&
    Number.isFinite(Number(config.arrival_armed_interval_minutes)) &&
    Number.isFinite(Number(config.approaching_interval_minutes)) &&
    Number.isFinite(Number(config.home_interval_minutes)) &&
    Number.isInteger(Number(config.quiet_start_hour)) &&
    Number.isInteger(Number(config.quiet_end_hour)) &&
    Number.isInteger(Number(config.in_flight_lease_seconds)) &&
    Number.isInteger(Number(config.cache_probe_settle_seconds)) &&
    Number.isFinite(Number(config.provider_backoff_max_hours)) &&
    Number.isFinite(Number(config.semantic_evidence_window_minutes)) &&
    Number.isInteger(Number(config.unknown_location_start_hour)) &&
    Number.isInteger(Number(config.unknown_location_end_hour));

if (!configReady) {
    node.error(
        "Política de refresh não configurada; confira todos os blocos numéricos",
        msg
    );
    return [null, null, null, null];
}

const peopleContext = msg.payload?.test_mode === true
    ? flow.get("people_context_v1__test") ?? {}
    : flow.get("people_context_v1") ?? {};
const vehicleContext = msg.payload?.test_mode === true
    ? flow.get("vehicle_primary_context_v1__test") ?? {}
    : flow.get("vehicle_primary_context_v1") ?? {};
const residentPrimaryState = String(
    msg.payload?.resident_primary_state ??
    peopleContext.resident_primary?.state ??
    ""
).toLowerCase();
const residentSecondaryState = String(
    msg.payload?.resident_secondary_state ??
    peopleContext.resident_secondary?.state ??
    ""
).toLowerCase();
const residentStatesKnown =
    residentPrimaryState.length > 0 &&
    residentSecondaryState.length > 0;
const anyResidentAway =
    msg.payload?.any_resident_away === true ||
    peopleContext.best_location_away === true;
const bothResidentsHome =
    residentPrimaryState === "home" &&
    residentSecondaryState === "home" &&
    !anyResidentAway;
const anyoneApproaching =
    residentPrimaryState === "near_home" ||
    residentSecondaryState === "near_home";
const arrivalArmed = peopleContext.arrival_armed ?? {};
const armedResidentApproaching =
    (residentPrimaryState === "near_home" && arrivalArmed.resident_primary === true) ||
    (residentSecondaryState === "near_home" && arrivalArmed.resident_secondary === true);
const arrivalRestartPending = armedResidentApproaching && vehicleContext.engine_on !== true;
const anyoneAway =
    anyResidentAway ||
    msg.payload?.anyone_away === true ||
    peopleContext.anyone_away === true ||
    residentPrimaryState === "not_home" ||
    residentSecondaryState === "not_home";

msg.payload.refresh_policy_version = 1;
msg.payload.refresh_policy_config = {
    away_interval_ms:
        Number(config.away_interval_minutes) * 60 * 1000,
    arrival_armed_interval_ms:
        Number(config.arrival_armed_interval_minutes) * 60 * 1000,
    approaching_interval_ms:
        Number(config.approaching_interval_minutes) * 60 * 1000,
    home_interval_ms:
        Number(config.home_interval_minutes) * 60 * 1000,
    quiet_start_hour: Number(config.quiet_start_hour),
    quiet_end_hour: Number(config.quiet_end_hour),
    in_flight_lease_ms: Number(config.in_flight_lease_seconds) * 1000,
    cache_probe_settle_ms: Number(config.cache_probe_settle_seconds) * 1000,
    provider_backoff_max_ms: Number(config.provider_backoff_max_hours) * 3600000,
    semantic_evidence_window_ms: Number(config.semantic_evidence_window_minutes) * 60000,
    unknown_location_start_hour: Number(config.unknown_location_start_hour),
    unknown_location_end_hour: Number(config.unknown_location_end_hour)
};
msg.payload.refresh_resident_states_known = residentStatesKnown;
msg.payload.refresh_any_resident_away = anyResidentAway;
msg.payload.refresh_both_residents_home = bothResidentsHome;
msg.payload.refresh_anyone_approaching = anyoneApproaching;
msg.payload.refresh_arrival_restart_pending = arrivalRestartPending;
msg.payload.refresh_anyone_away = anyoneAway;

if (bothResidentsHome) {
    node.status({
        fill: "green",
        shape: "dot",
        text: `${config.home_interval_minutes} min — ambos em casa`
    });
    return [null, null, null, msg, null];
}

if (anyoneApproaching) {
    node.status({
        fill: "yellow",
        shape: "dot",
        text: arrivalRestartPending
            ? `${config.arrival_armed_interval_minutes} min — chegada armada, aguardando motor`
            : `${config.approaching_interval_minutes} min — near_home`
    });
    return arrivalRestartPending
        ? [msg, null, null, null, null]
        : [null, msg, null, null, null];
}

if (anyoneAway) {
    node.status({
        fill: "yellow",
        shape: "dot",
        text: `${config.away_interval_minutes} min — fora`
    });
    return [null, null, msg, null, null];
}

node.status({
    fill: "grey",
    shape: "ring",
    text: `${config.away_interval_minutes} min — presença pendente`
});
return [null, null, null, null, msg];
