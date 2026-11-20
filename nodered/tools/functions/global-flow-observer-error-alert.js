const data = msg._observer_event;
msg.payload = { test_mode: data.test_mode, observer_kind: "node_error",
    flow_id: data.flow_id, source_id: data.source_id,
    first_detected_at: new Date(data.now).toISOString(), policy_decided_at: new Date(data.now).toISOString() };
const tailored = msg.observer_alert && typeof msg.observer_alert === "object" ? msg.observer_alert : {};
const title = String(tailored.title ?? "").replace(/[\r\n]+/g, " ").slice(0, 140);
const message = String(tailored.message ?? "").replace(/[\r\n]+/g, " ").slice(0, 600);
msg.alert = title && message ? { title: data.test_mode ? `TESTE — ${title}` : title, message } : {
    title: data.test_mode ? "TESTE — Falha em fluxo Node-RED" : "Falha em fluxo Node-RED",
    message: `Um passo do fluxo “${data.flow_label}” terminou com ${data.classification}: o nó “${data.source_name}” não concluiu o que devia. ` +
        `Onde olhar: aba “${data.flow_label}” do Node-RED, nesse nó. ` +
        `O mesmo erro só será avisado de novo daqui a ${data.policy.reminder_hours} horas.`
};
return msg;
