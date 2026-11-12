const test=msg._zigbee_test===true,suffix=test?'__test':'';
const policy=flow.get('zigbee_path_policy_v1'+suffix,test?undefined:'persistent');
msg.zigbee_path_policy=policy;
msg.zigbee_route_key=msg.zigbee_component_key;msg.zigbee_route_device=msg.zigbee_component;
msg.zigbee_route_now=msg.zigbee_now;msg.zigbee_route_now_iso=msg.zigbee_now_iso;msg.zigbee_route_error='availability_offline';msg.zigbee_route_quiet_open=true;
return msg;
