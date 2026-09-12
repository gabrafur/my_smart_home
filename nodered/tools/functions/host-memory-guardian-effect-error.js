const result = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const status = String(result.status ?? "invalid");
node.status({ fill: "red", shape: "ring", text: status === "failed" ? "worker falhou" : "resultado inválido" });
const event = status === "failed" ? "host_memory_guardian_failed" : "host_memory_guardian_result_unrecognized";
node.error(event + " request_id=" + String(result.request_id ?? "unknown"), msg);
return null;
