const testMode = msg._location_test === true;
const key = testMode
    ? "resident_notification_delivery_v4__test"
    : "resident_notification_delivery_v4";
const current = testMode ? flow.get(key) : flow.get(key, "persistent");
if (current?.version === 4 && typeof current.deliveries === "object") return msg;

const v3 = testMode ? null : flow.get("resident_notification_delivery_v3", "persistent");
const v2 = testMode ? null : flow.get("resident_notification_delivery_v2", "persistent");
const previous = v3?.version === 3 ? v3 : v2?.version === 2 ? v2 : null;
const deliveries = {};
for (const [source, item] of Object.entries(previous?.residents ?? {})) {
    const recipient = source === "resident_primary" ? "resident_secondary" : "resident_primary";
    deliveries[source + ":" + recipient] = {
        accepted_key: item?.accepted_key ?? item?.delivered_key ?? null,
        accepted_at: Number(item?.accepted_at ?? item?.delivered_at ?? 0),
        pending_key: item?.pending_key ?? null,
        pending_at: Number(item?.pending_at ?? 0)
    };
}
const migrated = { version: 4, deliveries, updated_at: Date.now() };
if (testMode) flow.set(key, migrated);
else flow.set(key, migrated, "persistent");
return msg;
