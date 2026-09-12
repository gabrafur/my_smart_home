const state = msg.internet_state;
if (msg.internet_event === "down") {
    msg.notification = {
        id: "internet_connection_failure",
        title: "Internet indisponível",
        message: "A conexão com a internet foi perdida. Menos de " +
            String(msg.policy.required_responses) + " dos " +
            String(msg.internet_targets_total) + " destinos responderam em " +
            String(msg.policy.failure_cycles) + " ciclos consecutivos."
    };
} else if (msg.internet_event === "recovery") {
    const duration = state.last_outage_duration_s;
    const suffix = duration == null ? "" : " após " + String(Math.max(1, Math.round(duration / 60))) + " minuto(s) de indisponibilidade";
    msg.notification = {
        id: "internet_connection_recovered",
        dismiss_id: "internet_connection_failure",
        title: "Internet restabelecida",
        message: "A conexão com a internet voltou" + suffix + "."
    };
}
return msg;
