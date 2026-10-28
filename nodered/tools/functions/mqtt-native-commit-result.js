let result;
try {result = typeof msg.payload === "string" ? JSON.parse(msg.payload) : msg.payload;} catch {result = null;}
const previous = flow.get(msg._mqtt_key,msg._mqtt_store) ?? {};
const state = ["committed","stale_prepare","unknown"].includes(result?.state) ? result.state : "unknown";
if (state === "committed" && /^[a-f0-9]{64}$/.test(msg._mqtt_proposal_sha ?? ""))
    previous.last_committed_proposal_sha = msg._mqtt_proposal_sha;
previous.last_commit_state = state;
flow.set(msg._mqtt_key,previous,msg._mqtt_store);
return msg;
