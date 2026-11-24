// Facts for the phone alert of one alarm command; the canvas decides the route.
// Opened by repeated failures, closed by an accepted command or a new intention.
const test = msg.test_mode === true;
const key = "alarm_house_alert_v1" + (test ? "__test" : "");
const store = test ? undefined : "persistent";
const open = flow.get(key, store) ?? null;
const now = Number(msg.alarm_alert_now ?? Date.now());
const action = msg.alarm_request?.action === "disarm" ? "disarm" : "arm";
const verb = action === "disarm" ? "desarmar" : "armar";
const policy = msg.policy ?? flow.get("alarm_house_policy_v1", "persistent") ?? {};
const attempt = Number(msg.retry?.attempt ?? 0);
const clock = (value) => new Date(value).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
const alert = { id: "alarme_casa_comando_falhou", event: "none" };
if (msg.alarm_alert_kind === "failure") {
    const same = open?.action === action;
    const started = same ? open.started_at : now - Math.max(0, attempt - 1) * Number(msg.retry?.delay_ms ?? 0);
    const after = Number(policy.phone_after_attempts);
    const every = Number(policy.phone_every_attempts);
    const last = msg.retry?.retry_allowed === false;
    if (last || (attempt >= after && (attempt - after) % every === 0)) {
        const refused = /nao confirmou o (?:arme|desarme)/i.test(String(msg.error?.message ?? ""));
        alert.event = "failure";
        alert.title = `Alarme NÃO conseguiu ${verb}`;
        alert.message = `${refused ? "A Moni recusou o comando" : "Sem confirmação da Moni"}: ${attempt} tentativa(s) desde ${clock(started)}. ` +
            (last ? "As tentativas acabaram. " : `Continuo tentando a cada ${policy.retry_seconds} s. `) +
            (action === "arm" ? "Confira no app da Moni se há setor aberto." : "Use o app da Moni ou o teclado.");
        flow.set(key, { action, started_at: started, attempts: attempt }, store);
    }
} else if (open && msg.alarm_alert_kind === "accepted") {
    alert.event = "resolved";
    alert.title = action === "disarm" ? "Alarme desarmado" : "Alarme armado";
    alert.message = `A Moni aceitou o comando às ${clock(now)}, após as falhas iniciadas às ${clock(open.started_at)}.`;
    flow.set(key, null, store);
} else if (open && msg.alarm_alert_kind === "cancelled") {
    alert.event = "cancelled";
    flow.set(key, null, store);
}
node.status({ fill: alert.event === "failure" ? "red" : "grey", shape: "dot", text: (test ? "TESTE: " : "") + alert.event });
msg.alarm_alert = alert;
return msg;
