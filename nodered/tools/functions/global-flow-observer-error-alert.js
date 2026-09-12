const data = msg._observer_event;
msg.payload = { test_mode: data.test_mode, observer_kind: "node_error",
    flow_id: data.flow_id, source_id: data.source_id };
const tailored = msg.observer_alert && typeof msg.observer_alert === "object" ? msg.observer_alert : {};
const title = String(tailored.title ?? "").replace(/[\r\n]+/g, " ").slice(0, 140);
const message = String(tailored.message ?? "").replace(/[\r\n]+/g, " ").slice(0, 600);
msg.alert = title && message ? { title: data.test_mode ? `TESTE — ${title}` : title, message } : {
    title: data.test_mode ? "TESTE — Falha em fluxo Node-RED" : "Falha em fluxo Node-RED",
    message: `O fluxo “${data.flow_label}” registrou ${data.classification} no nó “${data.source_name}”. ` +
        `O mesmo erro será silenciado por ${data.policy.reminder_hours} horas para evitar notificações repetidas.`
};
return msg;
