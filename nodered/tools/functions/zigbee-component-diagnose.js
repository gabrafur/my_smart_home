// Evidence only: outages in 24 h and whether the module rebooted to return.
const test = msg._zigbee_test === true;
const read = (key) => (test ? flow.get(key + "__test") : flow.get(key, "persistent")) || {};
const all = read("zigbee_component_outages_v1");
const name = msg.zigbee_component;
const before = Array.isArray(all[name]) ? all[name] : [];
const start = (entry) => Date.parse(entry.start);
const rows = before.filter((entry) => msg.zigbee_now - start(entry) < 86400000).map((entry) => ({ ...entry }));
if (msg.zigbee_component_action === "open") rows.push({ start: msg.zigbee_now_iso, rebooted: null });
const open = rows.findLast((entry) => entry.rebooted === null);
if (msg.zigbee_component_action === "recover" && open) {
    open.rebooted = Number(read("zigbee_announce_v1")[name] ?? 0) >= start(open);
}
if (JSON.stringify(rows) !== JSON.stringify(before)) {
    all[name] = rows.slice(-48);
    if (test) flow.set("zigbee_component_outages_v1__test", all);
    else flow.set("zigbee_component_outages_v1", all, "persistent");
}
const rebooted = rows.filter((entry) => entry.rebooted === true).length;
const silent = rows.filter((entry) => entry.rebooted === false).length;
const code = silent >= 2 && !rebooted ? "sinal" : rebooted && !silent ? "energia"
    : rebooted && silent ? "misto" : "indefinido";
msg.zigbee_component_diagnosis = { code, outages_24h: rows.length, silent, rebooted };
msg.zigbee_component_diagnosis_text = {
    sinal: ` Diagnóstico: ${rows.length} quedas em 24 h e ${silent} retornos sem o módulo reiniciar. Isso indica que ele tem energia e perde o sinal Zigbee; religar não resolve, reforce a malha.`,
    energia: ` Diagnóstico: o módulo reiniciou ao voltar, o que indica falta de energia (interruptor, tomada ou disjuntor).`,
    misto: ` Diagnóstico: ${rebooted} retorno(s) com reinício e ${silent} sem. Verifique energia e malha.`,
    indefinido: " Diagnóstico: ainda sem retornos suficientes para separar energia de sinal."
}[code];
return msg;
