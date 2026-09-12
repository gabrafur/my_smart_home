const testMode = msg._location_test === true || msg.payload?.test_mode === true;
const stateKey = testMode ? "security_light_engine_bypass_enabled__test" : "security_light_engine_bypass_enabled";
const automaticKey = testMode ? "security_light_engine_bypass_automatic__test" : "security_light_engine_bypass_automatic";
const store = testMode ? undefined : "persistent";
const get = (key) => store ? flow.get(key, store) : flow.get(key);
let payload = msg.payload;
if (typeof payload === "string" && payload.trim().startsWith("{")) {
    try { payload = JSON.parse(payload); } catch (_error) { payload = msg.payload; }
}
const command = String(payload?.requested_state ?? payload ?? "").trim().toUpperCase();
const source = String(payload?.source ?? "dashboard");
let branch = "invalid";
if (command === "STARTUP") branch = "startup";
else if (["provider_backoff", "api_failure"].includes(source)) branch = "automatic_activation";
else if (["provider_recovered", "api_recovered"].includes(source)) branch = "automatic_recovery";
else if (["ON", "TRUE", "1"].includes(command)) branch = "manual_enable";
else if (["OFF", "FALSE", "0"].includes(command)) branch = "manual_disable";
msg._engine_bypass = {
    test_mode: testMode, state_key: stateKey, automatic_key: automaticKey, store,
    command, source, branch, previous_enabled: get(stateKey) === true,
    state_defined: get(stateKey) !== undefined, automatic_owned: get(automaticKey) === true
};
return msg;
