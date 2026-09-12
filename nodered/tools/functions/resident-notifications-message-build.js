const role = msg.resident_source;
const alias = global.get("publicBindings")?.roles?.[role]?.source_alias;
const words = typeof alias === "string"
    ? alias.trim().split(/[\s_-]+/u).filter(Boolean)
    : [];
const safeAlias = words.length > 0 && words.every((word) => /^[\p{L}\p{M}.'’]+$/u.test(word));
const display = safeAlias
    ? words.map((word) => word.charAt(0).toLocaleUpperCase("pt-BR") + word.slice(1)).join(" ")
    : role;
const testMode = msg._location_test === true;

msg.payload = {
    contract: "security.resident-approach-notification.v1",
    kind: "resident_approach_notification",
    source: role,
    recipient: msg.resident_recipient,
    notification_key: msg.notification_key,
    event_at: msg.event_at,
    message: (testMode ? "[TESTE] " : "") + display + " está perto de casa.",
    test_mode: testMode,
    simulated: testMode,
    dispatched: false
};
return msg;
