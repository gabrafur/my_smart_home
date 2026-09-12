const input = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const source = input.source;
const current = input.trigger_state;
const previous = input.trigger_prev_state;
const testMode = msg._location_test === true || input.test_mode === true;
const canonicalObservedAt = Number(msg._canonical_locations?.[source]?.selected?.observed_at);
const parsedEventAt = Date.parse(input.observed_at ?? "");

msg._location_test = testMode;
msg.resident_source = source;
msg.resident_current = current;
msg.resident_previous = previous;
msg.resident_states_available = [current, previous].every((value) =>
    typeof value === "string" && !["", "unknown", "unavailable"].includes(value)
);
msg.event_at = Number.isFinite(canonicalObservedAt)
    ? canonicalObservedAt
    : Number.isFinite(parsedEventAt)
        ? parsedEventAt
        : Date.now();
return msg;
