const result = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const testMode = msg._host_memory_guardian_test === true || result.test_mode === true;
const signature = [result.request_id, result.status, result.checked_at].join(":");
const key = testMode ? "host_memory_guardian_last_result_v1__test" : "host_memory_guardian_last_result_v1";
const previous = testMode ? flow.get(key) : flow.get(key, "persistent");

msg.guardian_duplicate = previous?.signature === signature;
result.signature = signature;
msg.payload = result;
if (!msg.guardian_duplicate) {
    if (testMode) flow.set(key, result);
    else flow.set(key, result, "persistent");
}
return msg;
