const testMode = msg._host_memory_guardian_test === true || msg.payload?.test_mode === true;
msg._host_memory_guardian_test = testMode;
msg.payload = {
    version: 1,
    event: "host_memory_guardian_requested",
    source: testMode ? "manual_test" : "node_red_schedule",
    test_mode: testMode,
    requested_at: new Date().toISOString()
};
node.status({
    fill: testMode ? "blue" : "green",
    shape: "dot",
    text: testMode ? "TESTE preparado" : "verificação solicitada"
});
return msg;
