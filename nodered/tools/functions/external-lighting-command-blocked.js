msg.zigbee_error = true;
msg.cancel_confirmation = true;
msg.reset = true;
msg.notify_text = "Erro na rede Zigbee. A iluminação externa não foi acionada e o comando não será repetido.";
node.status({ fill: "red", shape: "ring", text: "comando bloqueado: Zigbee offline" });
return msg;
