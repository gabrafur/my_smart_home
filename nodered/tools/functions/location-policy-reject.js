const rejection = msg.location_policy_rejection ?? {};
node.warn(
    "Política de localização rejeitada; última configuração válida preservada: " +
    String(rejection.parameter ?? "parâmetro desconhecido")
);
node.status({ fill: "red", shape: "ring", text: "valor inválido rejeitado" });
msg.payload = {
    contract: "location.policy-rejection.v1",
    kind: "configuration_rejected",
    ...rejection,
    simulated: true,
    dispatched: false
};
return msg;
