const TEST_MODE =
    msg._vehicle_primary_remote_command_test === true ||
    msg.payload?.test_mode === true;

if (!TEST_MODE) return [msg, msg, null];

msg.payload = {
    ...msg.payload,
    test_mode: true,
    simulated: true,
    dispatched: false,
    notification_sent: false,
    persistent_notification_created: false,
    side_effect: "notify:resident_primary+persistent_notification"
};
return [null, null, msg];
