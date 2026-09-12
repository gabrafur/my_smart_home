const accepted = msg.context_snapshot_action === "accept";
if (accepted) flow.set(msg.context_cache_key, msg.payload.context);
msg.context_snapshot_accepted = accepted;
msg.context_cached = accepted ? msg.payload.context : msg.context_previous;
if (!accepted && msg.context_rejected_reason && msg.context_rejected_reason !== "duplicate") {
    node.warn(`contexto_chegadas: snapshot ${msg.context_domain} rejeitado: ${msg.context_rejected_reason}`);
}
return msg;
