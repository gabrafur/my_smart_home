msg.payload = {
    ...(msg.payload && typeof msg.payload === "object" ? msg.payload : {}),
    kind: "refresh_command",
    origin: "contexto_vehicle_primary",
    reason: "vehicle_primary_refresh_completed"
};
return msg;
