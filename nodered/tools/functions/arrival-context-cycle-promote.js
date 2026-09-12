const pending = msg.context_pending;
pending.force_recovery = true;
pending.require_lighting_ready = pending.require_lighting_ready === true || msg.context_require_lighting;
pending.request_reason = msg.context_request_reason;
flow.set(msg.context_pending_key, pending);
node.status({ fill: "yellow", shape: "ring", text: "ciclo em voo promovido para recovery" });
return null;
