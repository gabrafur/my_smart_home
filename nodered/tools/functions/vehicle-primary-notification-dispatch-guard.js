const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;

if (!TEST_MODE) return [msg, null];

msg.payload = {
    ...msg.payload,
    test_mode: true,
    side_effect: "notify:resident_primary",
    simulated: true,
    dispatched: false,
    notification_sent: false
};
return [null, msg];
