const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;

msg.payload = {
    ...(msg.payload && typeof msg.payload === "object" ? msg.payload : {}),
    location_refresh_provider: "icloud"
};

if (TEST_MODE) {
    msg.payload.simulated = true;
    msg.payload.dispatched = false;
    return [null, msg];
}

return [msg, null];
