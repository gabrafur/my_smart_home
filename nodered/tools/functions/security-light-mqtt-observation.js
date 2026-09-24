// Protocol adapter only. Availability and lifecycle remain in the shared path.
// Retained broker cache must never masquerade as a new physical observation.
if (msg.retain === true || msg._location_test === true || msg.payload?.test_mode === true) return null;
const state = msg.payload?.state;
if (state !== "ON" && state !== "OFF") return null;
msg.payload = {
    kind: "light_physical",
    state: state.toLowerCase(),
    updated_at: Date.now(),
    source: "zigbee_live_report"
};
return msg;
