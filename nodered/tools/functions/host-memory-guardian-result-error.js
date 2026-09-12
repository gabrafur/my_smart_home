const detail = String(msg.payload ?? "indisponível").replace(/[\r\n]+/g, " ").slice(0, 240);
node.status({ fill: "red", shape: "ring", text: "resultado indisponível" });
node.error("host_memory_guardian_result_unavailable detail=" + detail, msg);
return null;
