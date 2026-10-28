if (msg._mqtt_owns_flight === true && typeof msg._mqtt_flight_token === "string"
    && flow.get(msg._mqtt_flight_key,"memoryOnly")?.token !== msg._mqtt_flight_token) return null;
const code = typeof msg.payload === "object" ? msg.payload?.code : msg.payload;
if (code === 0 || code === "0") return null;
msg.payload = {state:"unknown",collection_error:"metadata_commit_failed"};
return msg;
