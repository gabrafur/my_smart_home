const source = String(msg.error?.source?.name ?? "notificacao").replace(/[^a-zA-Z0-9 _-]/g, "");
const detail = String(msg.error?.message ?? "erro desconhecido").replace(/[\r\n]+/g, " ").slice(0, 240);
node.error(`alarm_arrival_notification_failed source=${source} message=${detail}`, msg);
node.status({ fill: "red", shape: "ring", text: "entrega falhou; sem cooldown" });
return msg;
