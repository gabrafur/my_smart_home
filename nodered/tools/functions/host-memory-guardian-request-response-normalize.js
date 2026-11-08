const raw = String(msg.payload ?? "");
const text = raw.replace(/[\r\n]+/g, " ").trim().slice(0, 400);
const rc = msg.rc && typeof msg.rc === "object" ? msg.rc : {};
const exitCode = Number.isInteger(rc.code) ? rc.code : null;
const signal = typeof rc.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(rc.signal) ? rc.signal : null;
const failed = signal !== null || (Object.hasOwn(rc, "code") && rc.code !== 0);
const match = text.match(/^host-memory-guardian-request status=(accepted|coalesced) request_id=([A-Za-z0-9_.:-]+)(?: lock_recovered=(?:true|false))?$/);
msg.guardian_request_status = !failed && match ? match[1] : "invalid";
msg.guardian_request_id = !failed && match ? match[2] : "invalid";
msg.guardian_request_diagnostic = {
    reason: signal ? "execution_interrupted" : failed ? "execution_failed" : !text ? "empty_response" : match ? "recognized_response" : "invalid_response",
    exit_code: exitCode,
    signal,
    response_length: Math.min(raw.length, 65536)
};
if (
    ["accepted", "coalesced"].includes(msg.guardian_request_status) &&
    !["invalid", "busy", "pending"].includes(msg.guardian_request_id)
) {
    const previous = flow.get("host_memory_guardian_expected_request_v1", "memoryOnly") ?? {};
    const requestIds = [...new Set([...(previous.request_ids ?? []), msg.guardian_request_id])].slice(-8);
    flow.set("host_memory_guardian_expected_request_v1", {
        request_id: msg.guardian_request_id,
        request_ids: requestIds,
        accepted_at: Date.now()
    }, "memoryOnly");
}
return msg;
