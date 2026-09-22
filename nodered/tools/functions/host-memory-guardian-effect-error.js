const result = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const status = String(result.status ?? "invalid");
const reason = String(result.reason ?? "none");
const stale = reason === "stale_result";
node.status({ fill: "red", shape: "ring", text: stale ? "resultado vencido" : status === "cleanup_partial" ? "limpeza parcial" : status === "failed" ? "worker falhou" : "resultado inválido" });
const event = stale ? "host_memory_guardian_result_stale" : status === "cleanup_partial" ? "host_memory_guardian_cleanup_partial" : status === "failed" ? "host_memory_guardian_failed" : "host_memory_guardian_result_unrecognized";
// Preserve the canonical diagnosis through catch and the shared notification hub.
const detail = reason.replace(/[^A-Za-z0-9_.:= -]/g, "_").slice(0, 160);
const explanation = reason.includes("temporary_process_scan_unavailable")
    ? "Não foi possível listar os processos do host. A limpeza foi bloqueada por segurança."
    : stale ? "O resultado do worker venceu; não há avaliação recente do host."
    : status === "cleanup_partial" ? "A limpeza de temporários terminou com erros."
    : status === "failed" ? "O worker de memória falhou."
    : "O worker retornou um resultado fora do contrato.";
msg.observer_alert = {
    title: "Falha no guardião de memória do host",
    message: explanation + " Diagnóstico: " + event + ". Motivo: " + detail +
        ". Consulte a ponte do guardião e seu resultado sanitizado."
};
node.error(event + " request_id=" + String(result.request_id ?? "unknown") + " reason=" + reason, msg);
return null;
