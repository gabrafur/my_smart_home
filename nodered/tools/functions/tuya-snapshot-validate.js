const valid = Array.isArray(msg.tuya_entity_registry) &&
    Array.isArray(msg.tuya_device_registry) && Array.isArray(msg.tuya_states);
msg.tuya_snapshot_valid = valid;
msg.tuya_now = Number(msg.monitor_now ?? Date.now());
msg.tuya_now_iso = new Date(msg.tuya_now).toISOString();
if (!valid) msg.tuya_snapshot_error = "registros ou estados ausentes";
return msg;
