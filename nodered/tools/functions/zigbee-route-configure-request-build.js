msg.topic = "zigbee2mqtt/bridge/request/device/configure";
msg.payload = {
    id: msg.zigbee_route_device,
    transaction: msg.zigbee_route_transaction || msg.payload?.transaction
};
msg.retain = false;
msg.qos = "1";
msg.zigbee_route_effect = "configure";
return msg;
