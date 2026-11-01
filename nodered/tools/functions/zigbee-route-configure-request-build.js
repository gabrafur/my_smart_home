const store = msg._zigbee_test === true ? undefined : "persistent";
const incidents = flow.get(msg.zigbee_route_state_key, store) || {};
const current = incidents[msg.zigbee_route_key];
if (!current || current.phase !== "scanning" || current.pending_transaction !== msg.payload?.transaction ||
    msg.zigbee_route_response_valid !== true || msg.zigbee_route_response_status !== "ok" ||
    msg.zigbee_route_response_stage !== "networkmap" || msg.zigbee_route_response_reconcile_only === true ||
    current.native_completion_state === "unknown") return null;
incidents[msg.zigbee_route_key] = { ...current, phase: "configuring", native_stage: "configure",
    native_completion_state: "pending", last_terminal_transaction: current.pending_transaction,
    last_terminal_stage: "networkmap", last_terminal_status: "ok",
    last_terminal_observed_at: msg.zigbee_route_now_iso, revision: Number(current.revision || 0) + 1 };
flow.set(msg.zigbee_route_state_key, incidents, store);
msg.topic = "zigbee2mqtt/bridge/request/device/configure";
msg.payload = { id: msg.zigbee_route_device,
    transaction: msg.zigbee_route_transaction || msg.payload?.transaction };
msg.retain = false;
msg.qos = "1";
msg.zigbee_route_effect = "configure";
return msg;
