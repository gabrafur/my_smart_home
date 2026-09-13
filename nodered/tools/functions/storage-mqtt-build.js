const s = msg.storage;
const input = s.input;
const growth = (window, value) => value === null
    ? [{ topic: `smart_home/raspberry/storage/growth_${window}_available`, payload: "offline", retain: true }]
    : [
        { topic: `smart_home/raspberry/storage/growth_${window}`, payload: String(value), retain: true },
        { topic: `smart_home/raspberry/storage/growth_${window}_available`, payload: "online", retain: true }
    ];
msg.storage_mqtt = [
    { topic: "smart_home/raspberry/storage/status", payload: s.severity, retain: true },
    { topic: "smart_home/raspberry/storage/attributes", payload: JSON.stringify(msg.storage_attributes), retain: true },
    { topic: "smart_home/raspberry/storage/health_last_run", payload: new Date(s.now).toISOString(), retain: true },
    { topic: "smart_home/raspberry/storage/history_coverage_hours", payload: String(s.history_coverage_hours), retain: true },
    { topic: "smart_home/raspberry/storage/growth_cause", payload: s.growth_cause, retain: true },
    ...(input.maintenance_last_at && !Number.isNaN(Date.parse(input.maintenance_last_at))
        ? [{ topic: "smart_home/raspberry/storage/last_maintenance", payload: input.maintenance_last_at, retain: true }] : []),
    ...(Number.isFinite(Number(input.maintenance_reclaimed_bytes)) && Number(input.maintenance_reclaimed_bytes) >= 0
        ? [{ topic: "smart_home/raspberry/storage/last_reclaimed_mib", payload: String(Math.round(Number(input.maintenance_reclaimed_bytes) / 104857.6) / 10), retain: true }] : []),
    ...growth("24h", s.growth24h), ...growth("7d", s.growth7d)
];
return msg;
