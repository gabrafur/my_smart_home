const component = msg.zigbee_component;
if (!component || !msg.zigbee_component_key) {
    let hash = 0x811c9dc5;
    for (const byte of Buffer.from(component || "component", "utf8")) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
    const slug = String(component || "component").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    msg.zigbee_component_key = `${slug || "component"}_${hash.toString(16).padStart(8, "0")}`;
}
const when = new Date(msg.zigbee_now).toLocaleString("pt-BR");
if (msg.zigbee_component_event === "down") msg.notification = {
    id: `zigbee_component_${msg.zigbee_component_key}`, title: "Componente Zigbee indisponível",
    message: `O componente Zigbee “${component}” ficou indisponível em ${when}. Verifique alimentação, alcance, bateria e a malha Zigbee.`
};
else if (msg.zigbee_component_event === "recovery") msg.notification = {
    id: `zigbee_component_recovered_${msg.zigbee_component_key}`,
    dismiss_id: `zigbee_component_${msg.zigbee_component_key}`, title: "Componente Zigbee recuperado",
    message: `O componente Zigbee “${component}” voltou a ficar disponível em ${when}.`
};
else if (msg.zigbee_component_event === "reminder") msg.notification = {
    id: `zigbee_component_${msg.zigbee_component_key}`, title: "Componente Zigbee continua indisponível",
    message: `O componente Zigbee “${component}” continua indisponível há pelo menos ${msg.policy.reminder_interval_h} horas. Novo lembrete em ${when}.`
};
else return null;
return msg;
