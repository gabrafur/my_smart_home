const TEST_MODE =
    msg._global_observer_test === true ||
    msg.payload?.test_mode === true;
const DELIVERY_TEST = msg._observer_delivery_test === true;

if (TEST_MODE && !DELIVERY_TEST) return [null, msg];

if (DELIVERY_TEST) {
    msg.payload = {
        ...(msg.payload ?? {}),
        test_mode: true,
        notification_delivery_under_test: true
    };
    msg.alert = {
        title: "TESTE — Monitor global do Node-RED",
        message:
            "TESTE de entrega: o canal central de falhas dos fluxos " +
            "Node-RED conseguiu solicitar esta notificação ao Home Assistant."
    };
}
return [msg, null];
