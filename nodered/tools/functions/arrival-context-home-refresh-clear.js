const data = msg.home_refresh_due;
delete data.pending_state.residents[data.pending.source];
data.pending_state.updated_at = data.now;
const remaining = Object.keys(data.pending_state.residents).length
    ? data.pending_state
    : undefined;
if (msg._location_test === true) flow.set(data.pending_key, remaining);
else flow.set(data.pending_key, remaining, "persistent");
node.status({ fill: "grey", shape: "ring", text: msg.home_refresh_clear_reason ?? "confirmação encerrada" });
return null;
