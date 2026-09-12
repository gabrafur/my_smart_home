node.status({ fill: "red", shape: "ring", text: `inválida: ${msg.policy_error || "estrutura"}` });
node.warn(`Política Zigbee rejeitada sem substituir a última válida: ${msg.policy_error || "estrutura"}`);
return null;
