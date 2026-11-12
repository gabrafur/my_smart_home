const store = msg._zigbee_test === true ? undefined : "persistent";
const incidents = flow.get(msg.zigbee_route_state_key, store) || {};
const current = incidents[msg.zigbee_route_key];
if (!current || current.phase !== "scanning" || current.pending_transaction !== msg.payload?.transaction ||
    msg.zigbee_route_response_valid !== true || msg.zigbee_route_response_status !== "ok" ||
    msg.zigbee_route_response_stage !== "networkmap" || msg.zigbee_route_response_reconcile_only === true ||
    current.native_completion_state === "unknown") return null;
const targets=msg.zigbee_route_targets||[msg.zigbee_route_device];
const base=current.pending_transaction,tx=targets.length>1?base+"-hop-0":base;
incidents[msg.zigbee_route_key] = { ...current,configure_targets:targets,configure_index:0,configure_base_transaction:base,pending_transaction:tx,path_evidence:msg.zigbee_route_path_evidence, phase: "configuring", native_stage: "configure",
    native_completion_state: "pending", last_terminal_transaction: current.pending_transaction,
    last_terminal_stage: "networkmap", last_terminal_status: "ok",
    last_terminal_observed_at: msg.zigbee_route_now_iso, revision: Number(current.revision || 0) + 1 };
flow.set(msg.zigbee_route_state_key, incidents, store);
msg.topic = "zigbee2mqtt/bridge/request/device/configure";
msg.payload = { id: targets[0],transaction:tx };
msg.retain = false;
msg.qos = "1";
msg.zigbee_route_effect = "configure";
return msg;
