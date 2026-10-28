// Record an explicit metadata intent. The visual gates decide when it can start.
const suffix=msg.test_mode===true?"__test":"";
const store=msg.test_mode===true?"memoryOnly":"persistent";
const id=mqtt_crypto.randomBytes(32).toString("hex");
flow.set("mqtt_native_window_request_v1"+suffix,{id_sha256:id},store);
return msg;
