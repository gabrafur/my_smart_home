const data = msg.home_refresh_due;
if (msg._location_test === true) flow.set(data.pending_key, undefined);
else flow.set(data.pending_key, undefined, "persistent");
node.status({ fill: "grey", shape: "ring", text: msg.home_refresh_clear_reason ?? "confirmação encerrada" });
return null;
