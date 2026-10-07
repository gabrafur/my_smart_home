const text = String(msg.payload ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 400);
msg.guardian_request_status = text.match(/\bstatus=(accepted|coalesced)\b/)?.[1] ?? "invalid";
msg.guardian_request_id = text.match(/\brequest_id=([A-Za-z0-9_.:-]+)\b/)?.[1] ?? "invalid";
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
