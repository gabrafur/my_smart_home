const limits = {
    recovery_cooldown_seconds: { min: 10, max: 600 },
    unavailable_confirmation_seconds: { min: 60, max: 600 },
};
const key = String(msg.topic || "");
const rule = limits[key];
const value = Number(msg.payload);
if (!rule || !Number.isInteger(value) || value < rule.min || value > rule.max) {
    node.error(`Política RTX inválida: ${key || "campo ausente"} deve ser inteiro entre ${rule?.min ?? "?"} e ${rule?.max ?? "?"} s`, msg);
    return null;
}
const previous = flow.get("local_ai_rtx_policy_v1", "persistent");
const policy = previous?.version === 1
    ? { ...previous }
    : { version: 1, owner: "node_red" };
policy[key] = value;
policy.complete = Object.keys(limits).every((field) => Number.isFinite(policy[field]));
policy.updated_at = Date.now();
flow.set("local_ai_rtx_policy_v1", policy, "persistent");
node.status({
    fill: policy.complete ? "green" : "yellow",
    shape: policy.complete ? "dot" : "ring",
    text: policy.complete
        ? `cooldown ${policy.recovery_cooldown_seconds} s | confirmação ${policy.unavailable_confirmation_seconds} s`
        : "sincronizando política",
});
return null;
