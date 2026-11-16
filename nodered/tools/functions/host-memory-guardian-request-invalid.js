const detail = msg.guardian_request_diagnostic ?? {};
const reason = ["execution_interrupted", "execution_failed", "empty_response", "invalid_response"].includes(detail.reason) ? detail.reason : "invalid_response";
const code = Number.isInteger(detail.exit_code) ? detail.exit_code : "unknown";
const signal = typeof detail.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(detail.signal) ? detail.signal : "none";
const elapsed = Number.isSafeInteger(detail.elapsed_ms) && detail.elapsed_ms >= 0 ? detail.elapsed_ms : "unknown";
const report = `host_memory_guardian_request_unrecognized reason=${reason} exit_code=${code} signal=${signal} elapsed_ms=${elapsed}`;
// SIGTERM at the 15 s exec limit = whole-host stall; two per hour are transient.
if (reason === "execution_interrupted" && signal === "SIGTERM" && Number.isSafeInteger(elapsed) && elapsed >= 14000) {
    const now = Date.now();
    const previous = flow.get("host_memory_guardian_request_stalls_v1", "memoryOnly");
    const recent = (Array.isArray(previous) ? previous : [])
        .filter((at) => Number.isSafeInteger(at) && at <= now && now - at < 3600000).concat(now).slice(-8);
    flow.set("host_memory_guardian_request_stalls_v1", recent, "memoryOnly");
    if (recent.length < 3) {
        node.status({ fill: "yellow", shape: "ring", text: "interrupção transitória do host" });
        node.warn(`host_memory_guardian_request_transient reason=host_stall_timeout signal=${signal} elapsed_ms=${elapsed} recent_1h=${recent.length}`);
        return null;
    }
    node.status({ fill: "red", shape: "ring", text: "travamentos recorrentes do host" });
    node.error(report, msg);
    return null;
}
node.status({ fill: "red", shape: "ring", text: "resposta inválida" });
node.error(report, msg);
return null;
