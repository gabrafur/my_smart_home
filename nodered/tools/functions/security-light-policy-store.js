const policy = msg.security_light_policy_candidate;
if (policy?.version !== 1 || policy?.complete !== true) {
    node.error("Candidato da política de iluminação inválido", msg);
    return null;
}
global.set("security_light_policy_v1", policy, "persistent");
msg.topic = "security_light_policy_v1";
msg.payload = { ...policy };
delete msg.security_light_policy_candidate;
node.status({ fill: "green", shape: "dot", text: "política ativa" });
return msg;
