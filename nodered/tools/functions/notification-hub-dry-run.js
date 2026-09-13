const notification = msg.notification ?? {};
const channel = String(msg._notification_hub_channel ?? "unknown");
const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    status: msg._notification_hub_failure_reason ? "rejected" : "simulated",
    channel,
    recipients: Array.isArray(notification.recipients) ? [...notification.recipients] : [],
    targets: Array.isArray(notification.targets) ? [...notification.targets] : [],
    operation: notification.operation ?? null,
    source: notification.source ?? "manual_test",
    reason: msg._notification_hub_failure_reason ?? "test_mode",
    completed_at: Date.now()
};
flow.set(`notification_hub_${channel}_last_dry_run_v1`, result);
msg.notification_delivery = result;
node.status({ fill: "blue", shape: "dot", text: `TESTE ${channel}: nenhum efeito` });

const original = msg._notification_hub_context;
if (original && Object.hasOwn(original, "payload")) msg.payload = original.payload;
if (original?.had_notification === true) msg.notification = original.notification;
else delete msg.notification;
delete msg._notification_hub_context;
delete msg._notification_hub_channel;
delete msg._notification_hub_recipient;
delete msg._notification_hub_target;
delete msg._notification_hub_failure_reason;

const caller = Array.isArray(msg._linkSource) && msg._linkSource.length > 0 ? msg : null;
return [msg, caller];
