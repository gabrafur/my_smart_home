const data = msg._vehicle;
if (!data?.arrival) return msg;
const key = "vehicle_primary:" + data.arrival.payload.arrival_stage;
const previousAt = Number(data.recovery.last_arrival_at ?? 0);
const previousKey = String(data.recovery.last_arrival_key ?? "");
const futureMs = Number(data.policy.future_tolerance_seconds) * 1000;
const dedupeMs = Number(data.policy.arrival_dedupe_minutes) * 60000;
const duplicate = (previousKey === key || previousKey.startsWith(key + ":")) &&
    previousAt <= Date.now() + futureMs && Date.now() - previousAt < dedupeMs;
if (duplicate) {
    data.arrival = null;
    data.deduplicated = true;
} else {
    data.recovery.last_arrival_key = key;
    data.recovery.last_arrival_at = Date.now();
}
return msg;
