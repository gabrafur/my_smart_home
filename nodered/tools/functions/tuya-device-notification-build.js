const event = msg.tuya_event;
const device = msg.tuya_device;
const when = new Date(msg.tuya_now).toLocaleString("pt-BR");
if (event === "down") msg.notification = {
    id: device.notification_key, title: "Dispositivo Tuya indisponível",
    message: `O dispositivo Tuya “${device.name}” está indisponível há pelo menos ${msg.policy.failure_confirmation_s} segundos. Detectado em ${when}. Verifique energia, Wi-Fi e a integração Tuya no Home Assistant.`
};
else if (event === "reminder") msg.notification = {
    id: device.notification_key, title: "Dispositivo Tuya continua indisponível",
    message: `O dispositivo Tuya “${device.name}” continua indisponível há pelo menos ${msg.policy.reminder_interval_h} horas. Novo lembrete em ${when}. Verifique energia, Wi-Fi e a integração Tuya no Home Assistant.`
};
else if (event === "recovery") msg.notification = {
    id: `${device.notification_key}_recovered`, dismiss_id: device.notification_key,
    title: "Dispositivo Tuya recuperado",
    message: `O dispositivo Tuya “${device.name}” voltou a ficar disponível e permaneceu estável por ${msg.policy.recovery_confirmation_s} segundos. Recuperado em ${when}.`
};
else return null;
return msg;
