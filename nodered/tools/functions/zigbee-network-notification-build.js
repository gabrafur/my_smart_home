const event = msg.zigbee_event;
const when = new Date(msg.zigbee_now).toLocaleString("pt-BR");
if (event === "network_down") msg.notification = {
    id: "zigbee_network_failure",
    title: "Falha na rede Zigbee",
    message: `A rede Zigbee está indisponível. O Zigbee2MQTT perdeu a conexão com a antena/coordenador ou parou de funcionar. Detectado em ${when}.`
};
else if (event === "network_reminder") msg.notification = {
    id: "zigbee_network_failure",
    title: "Falha na rede Zigbee persiste",
    message: `A rede Zigbee continua indisponível há pelo menos ${msg.policy.reminder_interval_h} horas. Novo lembrete em ${when}. Verifique o Zigbee2MQTT, a antena/coordenador e a conexão MQTT.`
};
else if (event === "network_recovery") msg.notification = {
    id: "zigbee_network_recovered",
    dismiss_id: "zigbee_network_failure",
    title: "Rede Zigbee recuperada",
    message: `A rede Zigbee voltou a funcionar e permaneceu conectada por ${msg.policy.recovery_confirmation_s} segundos. Recuperada em ${when}.`
};
else return null;
return msg;
