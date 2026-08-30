const KEY = "vpn_monitor_last_dry_run_v1";
const previous = flow.get(KEY) ?? { events: [] };
const event = {
    simulated: true,
    dispatched: false,
    external_call_sent: false,
    notification_sent: false,
    observer_kind: msg.payload?.observer_kind ?? "unknown",
    side_effect: msg.payload?.side_effect ?? msg._vpn_side_effect ?? "unknown",
    completed_at: Date.now()
};
const events = [...(previous.events ?? []), event].slice(-20);
flow.set(KEY, { version: 1, events, ...event });
node.status({ fill: "blue", shape: "dot", text: `TESTE ${event.observer_kind}: bloqueado` });
return null;
