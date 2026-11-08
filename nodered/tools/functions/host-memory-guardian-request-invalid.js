node.status({ fill: "red", shape: "ring", text: "resposta inválida" });
const detail = msg.guardian_request_diagnostic ?? {};
const reason = ["execution_interrupted", "execution_failed", "empty_response", "invalid_response"].includes(detail.reason) ? detail.reason : "invalid_response";
const code = Number.isInteger(detail.exit_code) ? detail.exit_code : "unknown";
const signal = typeof detail.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(detail.signal) ? detail.signal : "none";
node.error(`host_memory_guardian_request_unrecognized reason=${reason} exit_code=${code} signal=${signal}`, msg);
return null;
