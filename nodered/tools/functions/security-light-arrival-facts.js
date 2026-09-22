if (msg.payload?.kind !== "arrival") return null;
const testMode = msg._location_test === true || msg.payload?.test_mode === true;
const testCase = msg._location_test_case ?? msg.payload?.test_case ?? null;
const locationPolicy = global.get("location_policy_v1", "persistent");
const lightPolicy = global.get("security_light_policy_v1", "persistent");
if (locationPolicy?.version !== 1 || locationPolicy?.complete !== true ||
    lightPolicy?.version !== 1 || lightPolicy?.complete !== true) {
    node.error("iluminacao_seguranca: política canônica ausente", msg);
    return null;
}
const suffix = testMode ? "__test" : "";
const get = (name, store) => testMode || !store
    ? flow.get(name + suffix) : flow.get(name, store);
const now = Date.now();
const futureMs = Number(locationPolicy.future_tolerance_seconds) * 1000;
const vehicle = get("vehicle_primary_context_v1") ?? {};
const people = get("people_context_v1") ?? {};
const lifecycle = get("security_light_lifecycle_v1", "persistent") ?? {};
const physical = flow.get("security_light_physical_state") ?? "unknown";
const observedAt = Number(flow.get("security_light_physical_observed_at") ?? 0);
const physicalFresh = Number.isFinite(observedAt) && observedAt <= now + futureMs &&
    now - observedAt <= Number(lightPolicy.physical_fresh_seconds) * 1000;
const source = msg.payload?.source;
const stage = msg.payload?.arrival_stage;
const residentArrival = ["resident_primary", "resident_secondary"].includes(source);
const cachedResident = people[source];
const eventResident = msg.payload?.arrival_resident_snapshot;
const cachedObservedAt = Number(cachedResident?.updated_at ?? 0);
const eventObservedAt = Number(eventResident?.updated_at ?? 0);
const eventResidentValid = eventResident && typeof eventResident === "object" &&
    eventResident.ready === true && eventResident.stale !== true &&
    Number.isFinite(eventObservedAt) && eventObservedAt > 0 &&
    eventObservedAt <= now + futureMs &&
    now - eventObservedAt <= Number(locationPolicy.location_fresh_minutes) * 60000;
/* O contexto e o evento percorrem links independentes. A evidência canônica
 * carregada pelo próprio evento fecha a corrida sem aceitar dado mais antigo. */
const resident = eventResidentValid && eventObservedAt >= cachedObservedAt
    ? { ...(cachedResident ?? {}), ...eventResident }
    : cachedResident;
const residentObservedAt = Number(resident?.updated_at);
const residentCurrent = resident?.ready === true && resident?.stale !== true &&
    Number.isFinite(residentObservedAt) && residentObservedAt > 0 &&
    residentObservedAt <= now + futureMs &&
    now - residentObservedAt <= Number(locationPolicy.location_fresh_minutes) * 60000;
const previousState = msg.payload?.arrival_previous_state;
const previousAway = typeof previousState === "string" &&
    !["", "home", "near_home", "unknown", "unavailable"].includes(previousState);
const previousUnavailable = ["unknown", "unavailable"].includes(previousState);
const recoveredAway = msg.payload?.illumination_only === true &&
    previousUnavailable &&
    msg.payload?.external_cycle_confirmed === true;
const localExcursionReturn = msg.payload?.local_excursion_return === true &&
    msg.payload?.arrival_direction === "returning_local_excursion";
/* O iPhone pode atualizar em not_home fora de 700 m e somente voltar a
 * publicar depois de já cruzar os 100 m. O produtor canônico confirma esse
 * ciclo externo e carrega um snapshot atual no próprio evento. Aceitar esse
 * salto direto evita perder a chegada sem transformar near_home → home ou
 * um catch-up stale em autorização. */
const directHomeRecovery =
    stage === "home" &&
    (previousAway || previousUnavailable) &&
    msg.payload?.arrival_direction === "returning" &&
    msg.payload?.external_cycle_confirmed === true &&
    resident?.state === "home" &&
    resident?.current_home === true;
const residentArrivalValid =
    residentArrival &&
    residentCurrent &&
    ((stage === "approach" &&
        (previousAway || recoveredAway) &&
        resident?.state === "near_home" &&
        resident?.current_home !== true) ||
     directHomeRecovery ||
     (stage === "local_return" && localExcursionReturn &&
        ["home", "near_home"].includes(resident?.state)));
const bypassEnabled = get("security_light_engine_bypass_enabled", "persistent") === true;
const bypassAutomatic = get("security_light_engine_bypass_automatic", "persistent") === true;
const engineKnown = vehicle.engine_state_valid === true;
const communicationFailed = vehicle.engine_communication_failed === true ||
    get("security_light_engine_communication_failed", "persistent") === true || bypassAutomatic;
const staleEngineOff = engineKnown && vehicle.engine_on === false &&
    vehicle.engine_stale === true;
/* Um ciclo externo confirmado pode terminar diretamente em home depois de uma
 * parada longa em near_home. Nesse caso, um OFF vencido não prova que o motor
 * continuou desligado durante o último trecho. A contingência é restrita ao
 * salto final confirmado; chegadas comuns continuam exigindo ON ou bypass. */
const staleEngineHomeFallback = directHomeRecovery && staleEngineOff && !communicationFailed;
const engineKnownOff = engineKnown && vehicle.engine_on === false &&
    !communicationFailed && !staleEngineOff;
const manualBypassAllowed = bypassEnabled && communicationFailed;
const bypassAllowed = manualBypassAllowed || staleEngineHomeFallback;
const trustedEngine = engineKnown && !communicationFailed;
const vehicleLightingReady = trustedEngine && residentArrival;
const vehicleDecisionReady = engineKnownOff || vehicleLightingReady || bypassAllowed;
const sunReady = flow.get("sun_ready") === true;
const eventAt = Number(msg.payload?.event_at ?? msg.payload?.updated_at ?? now);
const queuedCandidate = Number(msg.payload?.arrival_originally_queued_at ?? now);
const queuedAt = Number.isFinite(queuedCandidate) && queuedCandidate > 0 &&
    queuedCandidate <= now + futureMs ? queuedCandidate : now;
const lastRecoveryAt = Number(get("security_light_last_recovery_request_at") ?? 0);
const recoveryThrottleMs = Number(lightPolicy.recovery_request_throttle_seconds) * 1000;
const directionValid = (msg.payload?.arrival_direction === "returning" &&
    msg.payload?.external_cycle_confirmed === true) || localExcursionReturn;
msg._light_arrival = {
    test_mode: testMode,
    test_case: testCase,
    location_policy: locationPolicy,
    policy: lightPolicy,
    future_ms: futureMs,
    now,
    source,
    stage,
    event_at: eventAt,
    queued_at: queuedAt,
    vehicle,
    people,
    lifecycle,
    physical,
    physical_fresh: physicalFresh,
    light_reconciled: flow.get("light_reconciled") === true,
    resident_arrival: residentArrival,
    resident_arrival_valid: residentArrivalValid,
    direct_home_recovery: directHomeRecovery,
    arrival_path: directHomeRecovery ? "direct_home_recovery"
        : stage === "approach" ? "near_home_approach"
        : localExcursionReturn ? "local_excursion_return"
        : "invalid",
    bypass_enabled: bypassEnabled,
    bypass_allowed: bypassAllowed,
    manual_bypass_allowed: manualBypassAllowed,
    stale_engine_home_fallback: staleEngineHomeFallback,
    engine_communication_failed: communicationFailed,
    engine_unreliable: communicationFailed || staleEngineOff,
    vehicle_lighting_ready: vehicleLightingReady,
    logic_ready: sunReady && vehicleDecisionReady,
    sun_ready: sunReady,
    dark: flow.get("sun_below_horizon") === true,
    direction_valid: directionValid,
    direction_and_arrival_valid: directionValid && residentArrivalValid,
    recovery_needed: !vehicleLightingReady && !bypassAllowed,
    recovery_allowed: !Number.isFinite(lastRecoveryAt) || lastRecoveryAt <= 0 ||
        now - lastRecoveryAt >= recoveryThrottleMs,
    arrival_recovery_ms: Number(stage === "approach"
        ? locationPolicy.local_excursion_minutes
        : locationPolicy.arrival_recovery_minutes) * 60000
};
return msg;
