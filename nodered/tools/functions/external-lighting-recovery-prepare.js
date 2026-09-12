const localDate = (value, timeZone) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
};
const policy = global.get("external_lighting_policy_v1", "persistent");
if (policy?.version !== 1 || policy?.complete !== true) {
    node.error("iluminacao_externa: política visual ausente", msg);
    return null;
}
const testMode = msg._external_lighting_test === true || msg.payload?.test_mode === true;
const suffix = testMode ? "__test" : "";
const pendingKey = `external_lighting_recovery_pending_v1${suffix}`;
const promptedKey = `external_lighting_recovery_prompted_date_v1${suffix}`;
const store = testMode ? undefined : "persistent";
const get = (key) => store ? flow.get(key, store) : flow.get(key);
const now = new Date(msg.external_now ?? Date.now());
const sunsetAt = new Date(msg.sun_last_changed);
const timeZone = env.get("TZ") || "America/Sao_Paulo";
if (!Number.isFinite(sunsetAt.getTime())) {
    node.status({ fill: "red", shape: "ring", text: "horário do pôr do sol ausente" });
    return null;
}
const today = localDate(now, timeZone);
if (localDate(sunsetAt, timeZone) !== today) {
    node.status({ fill: "grey", shape: "ring", text: "pôr do sol foi em outro dia" });
    return null;
}
const pending = get(pendingKey);
if (get(promptedKey) === today || (pending?.localDate === today && Number(pending.expiresAt) > now.getTime())) {
    node.status({ fill: "grey", shape: "ring", text: "confirmação já enviada hoje" });
    return null;
}
const token = (now.getTime().toString(36) + "_" + Math.random().toString(36).slice(2, 10)).toUpperCase();
const candidate = { version: 1, localDate: today, createdAt: now.getTime(),
    expiresAt: now.getTime() + Number(policy.recovery_ttl_hours) * 3600000,
    confirmAction: "ILUMINACAO_EXTERNA_LIGAR_" + token,
    cancelAction: "ILUMINACAO_EXTERNA_NAO_LIGAR_" + token };
msg.external_lighting_recovery_candidate = candidate;
msg.confirm_action = candidate.confirmAction;
msg.cancel_action = candidate.cancelAction;
msg.notification_title = "Iluminação externa";
msg.notification_message = "O Node-RED voltou depois do pôr do sol de hoje. Deseja ligar as lâmpadas externas agora?";
msg.notification_tag = "external_lighting_sunset_recovery";
msg.notify_text = "O Node-RED voltou depois do pôr do sol. Você ainda quer ligar a iluminação externa? Responda pela notificação que enviei ao celular.";
msg._external_lighting_test = testMode;
node.status({ fill: "yellow", shape: "dot", text: "enviando confirmação" });
return msg;
