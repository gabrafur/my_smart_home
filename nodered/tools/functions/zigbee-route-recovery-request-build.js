msg.topic = "zigbee2mqtt/bridge/request/networkmap";
msg.payload = {
    type: "raw",
    routes: true,
    transaction: msg.zigbee_route_transaction
};
msg.retain = false;
msg.qos = "1";
msg.zigbee_route_effect = "route_scan";
return msg;
