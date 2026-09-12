msg.payload = {
    key: msg.tuya_device.key,
    name: msg.tuya_device.name,
    raw_state: msg.tuya_device.raw_state,
    phase: msg.tuya_device_state.phase,
    platforms: msg.tuya_device.platforms,
    next_reminder_at: msg.tuya_device_state.next_reminder_at || null
};
return msg;
