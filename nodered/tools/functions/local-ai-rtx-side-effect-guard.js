if (msg.test_mode === true || msg._rtx_test === true) {
    msg.payload = { ...(msg.payload || {}), simulated: true, dispatched: false, side_effect: "mcp_recovery" };
    return [null, msg];
}
return [msg, null];
