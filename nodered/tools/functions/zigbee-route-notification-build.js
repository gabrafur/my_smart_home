const current = msg.zigbee_route_current || {};
const device = msg.zigbee_route_device || current.device || "desconhecido";
const id = `zigbee_route_${msg.zigbee_route_key}`;
const when = new Date(msg.zigbee_route_now).toLocaleString("pt-BR");
if (msg.zigbee_route_event === "route_failure") msg.notification = {
    id, title: "Falha de rota Zigbee",
    message: `O dispositivo Zigbee “${device}” apresentou NWK_NO_ROUTE em ${when}. A recuperação automática foi iniciada (tentativa 1 de ${msg.policy.route_recovery_max_attempts}).`
};
else if (msg.zigbee_route_event === "route_recovery_failed") {
    const exhausted = current.attempts >= msg.policy.route_recovery_max_attempts;
    msg.notification = { id, title: "Recuperação Zigbee não concluída",
        message: exhausted
            ? `“${device}” continua sem rota após ${current.attempts} tentativas. O processo automático foi encerrado; verifique a alimentação e a malha Zigbee.`
            : `A tentativa ${current.attempts} de recuperar “${device}” falhou. Uma nova tentativa poderá ocorrer após ${msg.policy.route_recovery_cooldown_min} minutos se o erro reaparecer.` };
} else if (msg.zigbee_route_event === "route_recovery") msg.notification = {
    id: `${id}_recovered`, dismiss_id: id, title: "Rota Zigbee recuperada",
    message: `As rotas da malha foram reconstruídas e o dispositivo Zigbee “${device}” foi reconfigurado e voltou a responder em ${when}.`
};
else return null;
return msg;
