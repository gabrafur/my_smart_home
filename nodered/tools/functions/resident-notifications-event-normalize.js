const input = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const source = input.source;
const testMode = msg._location_test === true || input.test_mode === true;
const numericEventAt = Number(input.event_at);
const parsedEventAt = Date.parse(input.event_at ?? "");
const eventAt = Number.isFinite(numericEventAt) && numericEventAt > 0
    ? numericEventAt
    : parsedEventAt;
const localReturn = input.arrival_stage === "local_return" &&
    input.arrival_direction === "returning_local_excursion" &&
    input.local_excursion_return === true;

msg._location_test = testMode;
msg.resident_source = source;
msg.arrival_stage = input.arrival_stage;
msg.event_at = eventAt;
msg.arrival_contract_valid = input.contract === "security.arrival.v1";
msg.arrival_kind_valid = input.kind === "arrival" && input.arrival_source_type === "person";
msg.arrival_returning = input.arrival_direction === "returning" || localReturn;
msg.arrival_external_cycle_confirmed = input.external_cycle_confirmed === true || localReturn;
msg.arrival_cycle_confirmed = input.external_cycle_confirmed === true || localReturn;
msg.arrival_local_return_valid = localReturn;
msg.arrival_event_time_valid = Number.isFinite(eventAt) && eventAt > 0;
msg.notification_key = [source, input.arrival_stage, eventAt].join(":");
return msg;
