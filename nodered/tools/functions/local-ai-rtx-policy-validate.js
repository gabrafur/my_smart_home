const value = Number(msg.payload);
if (msg.topic !== "recovery_cooldown_seconds" || !Number.isInteger(value) || value < 10 || value > 600) {
    node.error("Política RTX inválida: cooldown deve ser inteiro entre 10 e 600 s", msg);
    return null;
}
const policy = {
    version: 1,
    owner: "node_red",
    recovery_cooldown_seconds: value,
    complete: true,
    updated_at: Date.now(),
};
flow.set("local_ai_rtx_policy_v1", policy, "persistent");
node.status({ fill: "green", shape: "dot", text: `cooldown ${value} s` });
return null;
