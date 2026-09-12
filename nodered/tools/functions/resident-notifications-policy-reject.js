node.status({ fill: "red", shape: "ring", text: "política inválida rejeitada" });
node.error("resident_notifications_policy_invalid fields=" + String(msg.policy_error ?? "unknown"), msg);
return null;
