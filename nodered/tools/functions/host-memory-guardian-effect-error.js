const result = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const status = String(result.status ?? "invalid");
const reason = String(result.reason ?? "none");
const stale = reason === "stale_result";
node.status({ fill: "red", shape: "ring", text: stale ? "resultado vencido" : status === "cleanup_partial" ? "limpeza parcial" : status === "failed" ? "worker falhou" : "resultado inválido" });
const event = stale ? "host_memory_guardian_result_stale" : status === "cleanup_partial" ? "host_memory_guardian_cleanup_partial" : status === "failed" ? "host_memory_guardian_failed" : "host_memory_guardian_result_unrecognized";
node.error(event + " request_id=" + String(result.request_id ?? "unknown") + " reason=" + reason, msg);
return null;
