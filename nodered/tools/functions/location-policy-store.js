const policy = msg.location_policy_candidate;
if (policy?.version !== 1 || policy?.complete !== true) {
    node.error("Candidato da política de localização inválido", msg);
    return null;
}
global.set("location_policy_v1", policy, "persistent");
msg.topic = "location_policy_v1";
msg.payload = { ...policy };
delete msg.location_policy_candidate;
node.status({ fill: "green", shape: "dot", text: String(msg.topic) });
return msg;
