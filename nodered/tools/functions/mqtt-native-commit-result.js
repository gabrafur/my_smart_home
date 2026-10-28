if (msg._mqtt_owns_flight === true && typeof msg._mqtt_flight_token === "string"
    && flow.get(msg._mqtt_flight_key,"memoryOnly")?.token !== msg._mqtt_flight_token) return null;
let result;
try {result = typeof msg.payload === "string" ? JSON.parse(msg.payload) : msg.payload;} catch {result = null;}
const previous = flow.get(msg._mqtt_key,msg._mqtt_store) ?? {};
let state = ["committed","checkpoint_committed","stale_prepare","unknown"].includes(result?.state) ? result.state : "unknown";
const matched=msg._mqtt_owns_flight===true && flow.get(msg._mqtt_flight_key,"memoryOnly")?.token===msg._mqtt_flight_token
    && msg._mqtt_window_encoded===true && result?.canvas_checkpoint_sha256===msg._mqtt_window_checkpoint_sha
    && (msg._mqtt_window_mode==="commit" && state==="committed"
        || msg._mqtt_window_mode==="checkpoint-commit" && state==="checkpoint_committed"
        && result.ack_written===false && result.ack_intended===false);
if(msg._mqtt_window_encoded===true && !matched)state="unknown";
if ((state === "committed" || state === "checkpoint_committed") && /^[a-f0-9]{64}$/.test(msg._mqtt_proposal_sha ?? ""))
    previous.last_committed_proposal_sha = msg._mqtt_proposal_sha;
if(matched){
    previous.callback_window=JSON.parse(JSON.stringify(msg._mqtt_window_candidate.window));
    previous.callback_window_scope="seven_native_MQTT_callback_classes";
    previous.callback_window_checkpoint_sha256=msg._mqtt_window_checkpoint_sha;
    previous.callback_window_durable=true;
}
previous.last_commit_state = state;
flow.set(msg._mqtt_key,previous,msg._mqtt_store);
return msg;
