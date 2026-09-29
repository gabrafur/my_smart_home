const message = String(msg.error?.message ?? "");
const normalized = message.toLowerCase();
if (/^(?:HomeAssistantError: )?ICLOUD_TRANSPORT_INTERRUPTED$/.test(message) &&
    msg.payload?.refresh_transport_retry_pending === true) {
    node.status({ fill: "yellow", shape: "ring", text: "iCloud interrompeu HTTP; retry canônico pendente" });
    return null;
}
const transient =
    normalized.includes("connection lost") ||
    normalized.includes("noconnectionerror") ||
    /\b(?:e?timedout|timeout|timed out)\b/.test(normalized);

if (transient) {
    node.status({
        fill: "grey",
        shape: "ring",
        text: "HA temporariamente indisponível; refresh será reavaliado"
    });
    return null;
}

// O observador global já recebe o erro do nó de serviço original. Não crie
// um segundo incidente no tratador para a mesma falha.
node.warn(
    "Falha inesperada ao solicitar localização: " +
    (message || "erro sem mensagem")
);
node.status({ fill: "red", shape: "ring", text: "falha inesperada no refresh" });
return null;
