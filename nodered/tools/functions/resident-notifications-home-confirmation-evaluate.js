const now = Date.now();
const entity = msg.home_confirmation_entity ?? {};
const state = String(msg.home_confirmation_state ?? entity.state ?? "");
const lastChanged = Date.parse(entity.last_changed ?? "");
const observedAt = Date.parse(entity.attributes?.location_observed_at ?? "");
const fresh = entity.attributes?.location_fresh === true;
const stable = Number.isFinite(lastChanged) &&
    now - lastChanged >= msg.home_confirmation_required_ms;
const currentObservation = Number.isFinite(observedAt) &&
    observedAt >= Number(msg.event_at);
const eventAt = Number(msg.event_at);
const eventCurrent = Number.isFinite(eventAt) &&
    eventAt <= now + Number(msg.policy?.future_tolerance_ms) &&
    now - eventAt <= Number(msg.policy?.max_event_age_ms);
const withinWindow = now <= Number(msg.home_confirmation_deadline_at);
const confirmed = state === "home" && fresh && stable &&
    currentObservation && eventCurrent && withinWindow;
const retryable = eventCurrent && now < msg.home_confirmation_deadline_at &&
    ["", "home", "near_home", "unknown", "unavailable"].includes(state);

msg.home_confirmation_result = confirmed
    ? "confirmed"
    : retryable ? "retry" : "rejected";
if (confirmed) {
    msg.home_confirmation_confirmed_at = now;
} else if (retryable) {
    msg.delay = msg._location_test === true
        ? 1 : msg.home_confirmation_recheck_ms;
}
return msg;
