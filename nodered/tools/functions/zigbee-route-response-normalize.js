let p = msg.payload;
if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = null; } }
const tx = String(p?.transaction || ""), test = tx.startsWith("nodered-zigbee-route-test-");
const stateKey = test ? "zigbee_route_incidents_v1__test" : "zigbee_route_incidents_v1";
const rows = (test ? flow.get(stateKey) : flow.get(stateKey,"persistent")) || {};
const pair = Object.entries(rows).find(([,v]) => v.pending_transaction === tx ||
    (v.pending_transaction == null && v.native_completion_state === "terminal" && v.last_terminal_transaction === tx));
const c = pair?.[1], kind = msg.topic === "zigbee2mqtt/bridge/response/networkmap" ? "networkmap" :
    msg.topic === "zigbee2mqtt/bridge/response/device/configure" ? "configure" : null;
const stage = c?.native_stage || ({scanning:"networkmap",configuring:"configure",verifying:"configure"})[c?.phase];
const old = c?.pending_transaction == null && c?.native_completion_state === "terminal";
msg.zigbee_route_response_valid = Boolean(msg.retain !== true && tx.startsWith("nodered-zigbee-route-") && c && kind === stage &&
    ["ok","error"].includes(p?.status) && !(old && c.last_terminal_status === p.status));
if (!msg.zigbee_route_response_valid) return msg;
const now = Number.isFinite(Number(msg.monitor_now)) ? Number(msg.monitor_now) : Date.now();
Object.assign(msg, {_zigbee_test:test, payload:p, zigbee_route_state_key:stateKey,
    zigbee_route_key:pair[0], zigbee_route_current:{...c}, zigbee_route_revision:Number(c.revision || 0),
    zigbee_route_device:c.device, zigbee_route_ieee:c.ieee, zigbee_route_response_status:p.status,
    zigbee_route_response_error:String(p.error || ""), zigbee_route_response_transaction:tx,
    zigbee_route_response_stage:kind, zigbee_route_response_reconcile_only:old || !c.incident_open ||
        c.native_completion_state === "unknown" || now >= Date.parse(c.next_retry_at || ""),
    zigbee_route_now:now, zigbee_route_now_iso:new Date(now).toISOString()});
return msg;
