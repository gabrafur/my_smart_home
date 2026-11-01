const c = msg.zigbee_route_current || {}, f = msg.zigbee_route_native || {};
const store = msg._zigbee_test ? undefined : "persistent", key = msg.zigbee_route_key;
const rows = flow.get(msg.zigbee_route_state_key, store) || {};
if (Number(rows[key]?.revision || 0) !== Number(msg.zigbee_route_revision || 0)) return null;
const at = msg.zigbee_route_now_iso, action = msg.zigbee_route_action, p = msg.policy;
const retry = new Date(msg.zigbee_route_now + p.route_recovery_cooldown_min * 60000).toISOString();
const done = f.terminal === true, tx = msg.zigbee_route_response_transaction, mode = c.native_completion_state;
const stage = msg.zigbee_route_response_stage || f.stage || null;
const match = msg.zigbee_route_response_valid === true &&
  (tx === c.pending_transaction || (c.pending_transaction == null && mode === "terminal" && tx === c.last_terminal_transaction));
const unsure = {native_stage: stage, native_completion_state:"unknown"};
const status = msg.zigbee_route_response_status;
const proof = {native_completion_state:"terminal", pending_transaction:null, last_terminal_transaction:tx,
  last_terminal_stage:stage, last_terminal_status:status, last_terminal_observed_at:at};
let n;
if (["open","retry"].includes(action)) {
  if (c.pending_transaction != null || (mode != null && !done) || (action === "retry" && !done)) return null;
  const count = action === "open" ? 1 : Number(c.attempts || 0) + 1;
  if (count > p.route_recovery_max_attempts) return null;
  const id = `nodered-zigbee-route-${msg._zigbee_test ? "test-" : ""}${key}-${msg.zigbee_route_now}`;
  n = {...c, incident_open:true, phase:"scanning", attempts:count, device:msg.zigbee_route_device,
    ieee:msg.zigbee_route_ieee || c.ieee || null, first_failure_at:action === "open" ? at : c.first_failure_at,
    last_failure_at:at, last_error:msg.zigbee_route_error || c.last_error || "NWK_NO_ROUTE",
    pending_transaction:id, native_stage:"networkmap", native_completion_state:"pending",
    next_retry_at:retry, verification_started_at:null, exhaustion_notified:false};
  msg.zigbee_route_transaction = id;
} else if (action === "touch") {
  if (msg.zigbee_route_tick && (!f.expired || !f.unproven || mode === "unknown")) return null;
  n = {...c, ...(f.expired && f.unproven ? unsure : {})};
  if (!msg.zigbee_route_tick) Object.assign(n, {last_failure_at:at,
  last_error:msg.zigbee_route_error || c.last_error, verification_started_at:null,
  incident_open:c.incident_open || f.unproven,
  phase:c.phase === "verifying" || (c.phase === "recovered" && f.unproven) ? "failed" : c.phase});
} else if (action === "verify") {
  if (!match || stage !== "configure" || status !== "ok") return null;
  n = {...c, ...proof, phase:"verifying", verification_started_at:at};
} else if (action === "recovery_failed") {
  n = match ? {...c, ...proof, phase:c.incident_open ? "failed" : c.phase,
    recovery_error:status === "error" ? msg.zigbee_route_response_error || "unknown" : c.recovery_error,
    next_retry_at:c.incident_open ? retry : c.next_retry_at} : {...c, ...unsure};
  n.exhaustion_notified = c.exhaustion_notified || c.attempts >= p.route_recovery_max_attempts;
  if (msg.zigbee_route_response_reconcile_only) msg.zigbee_route_event = "none";
} else if (action === "recovered") {
  const unresolved = c.pending_transaction != null || !done;
  n = {...c, incident_open:false, phase:"recovered", recovered_at:at, next_retry_at:null,
    recovery_error:unresolved ? c.recovery_error : null,
    ...(unresolved ? unsure : {})};
} else return null;
n.revision = Number(c.revision || 0) + 1;
rows[key] = n;
flow.set(msg.zigbee_route_state_key, rows, store);
const bufferKey = "zigbee_route_pending" + (msg._zigbee_test ? "__test" : "");
const memory = msg._zigbee_test ? undefined : "memoryOnly", buffer = flow.get(bufferKey, memory) || {};
delete buffer[key]; flow.set(bufferKey, buffer, memory);
msg.zigbee_route_current = n;
if (msg._zigbee_test !== true) node.status({text:n.phase});
return msg;
