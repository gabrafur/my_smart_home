const accepted = msg.context_snapshot_action === "accept";
if (accepted) flow.set(msg.context_cache_key, msg.payload.context);
msg.context_snapshot_accepted = accepted;
msg.context_cached = accepted ? msg.payload.context : msg.context_previous;
const episodeKey = `${msg.context_domain}_rejected_snapshot_episode_v1${msg._location_test ? "__test" : ""}`;
const previousEpisode = flow.get(episodeKey);
const reason = msg.context_rejected_reason;
const now = msg.context_now;
const expired = previousEpisode && (now < previousEpisode.started_at ||
    now - previousEpisode.started_at >= 6 * 60 * 60 * 1000);
if (!accepted && reason && reason !== "duplicate") {
    const signature = `${reason}:${msg.context_incoming_at}:${msg.context_previous_at}`;
    if (previousEpisode?.signature === signature && !expired) {
        flow.set(episodeKey, { ...previousEpisode, repeats: Math.min(previousEpisode.repeats + 1, Number.MAX_SAFE_INTEGER) });
    } else {
        if (previousEpisode) node.log?.(`contexto_chegadas: ${expired ? "expirou" : "fim"} ${msg.context_domain} (${previousEpisode.reason}; ${previousEpisode.repeats} repeticoes)`);
        flow.set(episodeKey, { signature, reason, repeats: 0, started_at: now });
        node.warn(`contexto_chegadas: snapshot ${msg.context_domain} rejeitado: ${reason}; incoming_at=${msg.context_incoming_at}; cached_at=${msg.context_previous_at}`);
    }
} else if (previousEpisode) {
    flow.set(episodeKey, null);
    node.log?.(`contexto_chegadas: ${expired ? "expirou" : "fim"} ${msg.context_domain} (${previousEpisode.reason}; ${previousEpisode.repeats} repeticoes)`);
}
return msg;
