const data = msg._observer_evaluation;
const first = data.sources[0];
if (!first) return null;
let title = "Nó Node-RED indisponível";
let message = `O nó “${first.source_name}” do fluxo “${first.flow_label}” permanece em estado de falha ` +
    `há pelo menos ${data.policy.status_confirm_seconds} segundos.`;
if (data.kind === "home_assistant") {
    title = "Node-RED sem Home Assistant";
    message = "Os fluxos perderam a conexão com o Home Assistant pelo período de confirmação configurado. " +
        "As chamadas com fila serão retomadas e este push será entregue quando a conexão voltar.";
} else if (data.kind === "mqtt") {
    title = "Node-RED sem MQTT";
    message = "Os fluxos perderam a conexão com o broker MQTT pelo período de confirmação configurado. " +
        "Verifique o Mosquitto e a rede local.";
}
msg.payload = {
    test_mode: data.test_mode,
    observer_kind: "node_unavailable",
    incident_key: data.key
};
msg.alert = { title: data.test_mode ? `TESTE — ${title}` : title, message };
return msg;
