const platforms = new Set(["tuya", "localtuya"]);
const unreliable = new Set(["button", "event"]);
const states = new Map(msg.tuya_states.map((item) => [item.entity_id, item]));
const devices = new Map(msg.tuya_device_registry.map((item) => [item.id, item]));
const groups = new Map();
for (const entity of msg.tuya_entity_registry) {
    const platform = String(entity.platform || "").toLowerCase();
    if (!platforms.has(platform) || entity.disabled_by != null || !entity.entity_id) continue;
    const key = entity.device_id || `entity:${entity.entity_id}`;
    const group = groups.get(key) || { key, entities: [], platforms: new Set() };
    group.entities.push(entity);
    group.platforms.add(platform);
    groups.set(key, group);
}
const clean = (value, fallback) => {
    const label = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    return (label || fallback).slice(0, 120);
};
const observations = [];
for (const group of groups.values()) {
    const reliable = group.entities.filter((entity) => !unreliable.has(String(entity.entity_id).split(".", 1)[0]));
    if (!reliable.length) continue;
    const device = devices.get(group.key) || {};
    const first = states.get(reliable[0].entity_id);
    const name = clean(device.name_by_user || device.name || first?.attributes?.friendly_name || reliable[0].original_name, "Dispositivo Tuya");
    const values = reliable.map((entity) => String(states.get(entity.entity_id)?.state || "unavailable").toLowerCase());
    const rawState = values.some((state) => state !== "unknown" && state !== "unavailable") ? "online" : "offline";
    let hash = 0x811c9dc5;
    for (const byte of Buffer.from(group.key, "utf8")) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
    observations.push({ key: group.key, name, raw_state: rawState,
        platforms: [...group.platforms].sort(), notification_key: `tuya_device_${hash.toString(16).padStart(8, "0")}` });
}
msg.payload = observations;
msg.tuya_device_count = observations.length;
return msg;
