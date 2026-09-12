node.status({ fill: "red", shape: "ring", text: `inválida: ${msg.policy_error || "estrutura"}` });
node.warn(`Política do coordenador rejeitada: ${msg.policy_error || "estrutura"}`);
return null;
