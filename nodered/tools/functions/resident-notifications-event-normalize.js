const input = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const source = input.source;
const testMode = msg._location_test === true || input.test_mode === true;
const numericEventAt = Number(input.event_at);
const parsedEventAt = Date.parse(input.event_at ?? "");
const eventAt = Number.isFinite(numericEventAt) && numericEventAt > 0
    ? numericEventAt
    : parsedEventAt;

msg._location_test = testMode;
msg.resident_source = source;
msg.arrival_stage = input.arrival_stage;
msg.event_at = eventAt;
msg.arrival_contract_valid = input.contract === "security.arrival.v1";
msg.arrival_kind_valid = input.kind === "arrival" && input.arrival_source_type === "person";
msg.arrival_returning = input.arrival_direction === "returning";
msg.arrival_external_cycle_confirmed = input.external_cycle_confirmed === true;
msg.arrival_event_time_valid = Number.isFinite(eventAt) && eventAt > 0;
msg.notification_key = [source, input.arrival_stage, eventAt].join(":");
return msg;
