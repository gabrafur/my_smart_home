const now = Date.now();
const testMode = msg._location_test === true || msg.payload?.test_mode === true;
const locationPolicy = global.get("location_policy_v1", "persistent");
const policy = global.get("security_light_policy_v1", "persistent");
if (locationPolicy?.version !== 1 || locationPolicy?.complete !== true ||
    policy?.version !== 1 || policy?.complete !== true) {
    node.error("iluminacao_seguranca: política canônica ausente", msg);
    return null;
}
const suffix = testMode ? "__test" : "";
const get = (name, store) => testMode || !store
    ? flow.get(name + suffix) : flow.get(name, store);
const physical = flow.get("security_light_physical_state") ?? "unknown";
const observedAt = Number(flow.get("security_light_physical_observed_at") ?? 0);
const futureMs = Number(locationPolicy.future_tolerance_seconds) * 1000;
const physicalFresh = Number.isFinite(observedAt) && observedAt <= now + futureMs &&
    now - observedAt <= Number(policy.physical_fresh_seconds) * 1000;
const lifecycle = flow.get("security_light_lifecycle_v1", "persistent") ?? {};
const latch = get("security_light_turn_on_notification_latch_v1", "persistent") ?? {};
const decisionKey = msg.payload?.refresh_cycle_id != null
    ? `cycle:${msg.payload.refresh_cycle_id}`
    : msg.payload?.test_case ? `test:${msg.payload.test_case}`
        : `window:${Math.floor(now / 5000)}`;
const previous = flow.get("security_light_unavailable_decision_v1") ?? {};
const previousAt = Number(previous.at ?? 0);
msg._light_availability = {
    now, test_mode: testMode, policy, location_policy: locationPolicy,
    physical, physical_fresh: physicalFresh,
    reconciled: flow.get("light_reconciled") === true,
    latched: latch.latched === true,
    physical_known_on: physical === "on" && physicalFresh && flow.get("light_reconciled") === true,
    cycle_active: lifecycle.active_by_arrival === true && physical === "off" &&
        physicalFresh && flow.get("light_reconciled") === true,
    available: physical === "off" && physicalFresh && flow.get("light_reconciled") === true,
    decision_key: decisionKey,
    duplicate_unavailable: previous.key === decisionKey && Number.isFinite(previousAt) &&
        previousAt <= now + futureMs && now - previousAt < Number(policy.unavailable_dedupe_seconds) * 1000
};
return msg;
