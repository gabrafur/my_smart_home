// Owner policy (23/11/2026): the SD card stalls of 22/11 froze the house for
// minutes. Alert when the guardian sees slow writes or tasks blocked on disk in
// two consecutive readings, and remove the alert after three normal readings.
const WRITE_MS_LIMIT = 500;
const BLOCKED_LIMIT = 5;
const RAISE_AFTER = 2;
const CLEAR_AFTER = 3;
const NOTIFICATION_ID = "raspberry_pi_cartao_sd_lento";
const testMode = msg.test_mode === true;
const key = testMode ? "sd_card_alert_state_v1__test" : "sd_card_alert_state_v1";
const load = () => (testMode ? flow.get(key) : flow.get(key, "persistent"));
const save = (value) => (testMode ? flow.set(key, value) : flow.set(key, value, "persistent"));

if (testMode && msg.sd_card_alert_reset === true) {
    save(undefined);
    node.status({ fill: "blue", shape: "dot", text: "TESTE: estado zerado" });
    return null;
}
const raw = typeof msg.payload === "string" ? msg.payload.replace(/[\r\n]+/g, " ").trim().slice(0, 800) : "";
const field = (name) => raw.match(new RegExp("(?:^| )" + name + "=([^ ]+)"))?.[1];
const metric = (name) => {
    const value = field(name);
    return /^[0-9]+(\.[0-9]+)?$/.test(value ?? "") ? Number(value) : null;
};
const checkedAt = field("checked_at");
if (!raw.startsWith("host-memory-guardian ") || !checkedAt) {
    node.status({ fill: "grey", shape: "ring", text: "sem leitura do guardião" });
    return null;
}
const state = load() ?? { version: 1, active: false, slow: 0, normal: 0, last_checked_at: null };
const prefix = testMode ? "TESTE: " : "";
if (state.last_checked_at === checkedAt) return null;
state.last_checked_at = checkedAt;

const writeMs = metric("sd_write_ms");
const blocked = metric("blocked_tasks");
if (writeMs === null && blocked === null) {
    save(state);
    node.status({ fill: "grey", shape: "ring", text: prefix + "métricas do SD indisponíveis" });
    return null;
}
const slow = (writeMs ?? 0) > WRITE_MS_LIMIT || (blocked ?? 0) > BLOCKED_LIMIT;
if (slow) {
    state.slow += 1;
    state.normal = 0;
    state.worst_write_ms = Math.max(state.worst_write_ms ?? 0, writeMs ?? 0);
    state.worst_blocked = Math.max(state.worst_blocked ?? 0, blocked ?? 0);
} else {
    state.normal += 1;
    state.slow = 0;
}

let operation = null;
if (!state.active && state.slow >= RAISE_AFTER) {
    state.active = true;
    state.since = checkedAt;
    operation = "create";
} else if (state.active && state.normal >= CLEAR_AFTER) {
    state.active = false;
    operation = "dismiss";
}
if (!state.active && !slow) {
    delete state.worst_write_ms;
    delete state.worst_blocked;
}
save(state);

const reading = "escrita " + (writeMs ?? "?") + " ms · " + (blocked ?? "?") + " em espera";
node.status({
    fill: state.active ? "red" : slow ? "yellow" : "green",
    shape: state.active ? "ring" : "dot",
    text: prefix + (state.active ? "SD lento" : slow ? "pico isolado" : "SD normal") + " · " + reading
});
if (!operation) return null;

const notification = { source: "alerta_cartao_sd", operation, delivery: "queued", notification_id: NOTIFICATION_ID, test_mode: testMode };
if (operation === "create") {
    notification.title = "Cartão SD do Raspberry Pi lento";
    msg.payload = "O cartão SD respondeu devagar em " + RAISE_AFTER + " leituras seguidas (escrita média de até " +
        state.worst_write_ms + " ms, " + state.worst_blocked + " processo(s) esperando o disco; desde " +
        checkedAt.replace("T", " ").replace("Z", "") + " UTC). A casa pode ficar lenta ou travar por alguns minutos. " +
        "Evite builds e validações pesadas agora. Se isso se repetir, é sinal para migrar o sistema para um SSD. " +
        "Este aviso some sozinho depois de " + CLEAR_AFTER + " leituras normais.";
} else {
    msg.payload = "";
}
msg.topic = NOTIFICATION_ID;
msg.notification = notification;
msg._sd_card_alert = { operation, test_mode: testMode, checked_at: checkedAt };
return msg;
