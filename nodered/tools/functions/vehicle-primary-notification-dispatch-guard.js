const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;

if (msg.notification?.dismiss_only === true && !TEST_MODE) {
    return [null, null, null, msg];
}

if (!TEST_MODE) {
    return [msg, msg, null, null];
}

msg.payload = {
    ...msg.payload,
    test_mode: true,
    side_effect: "notify:resident_primary+persistent_notification",
    simulated: true,
    dispatched: false,
    notification_sent: false,
    persistent_notification_created: false
};
return [null, null, msg, null];
