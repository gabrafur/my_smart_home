const test=msg._zigbee_test===true,store=test?undefined:'persistent';
const rows=flow.get(msg.zigbee_route_state_key,store)||{},c=rows[msg.zigbee_route_key];
if(!c||msg.zigbee_path_next!==true||c.revision!==msg.zigbee_route_revision||c.pending_transaction!==msg.zigbee_route_response_transaction||c.native_completion_state!=='pending'||c.phase!=='configuring')return null;
const index=c.configure_index+1,tx=c.configure_base_transaction+'-hop-'+index;
rows[msg.zigbee_route_key]={...c,configure_index:index,pending_transaction:tx,last_terminal_transaction:c.pending_transaction,last_terminal_stage:'configure',last_terminal_status:'ok',last_terminal_observed_at:msg.zigbee_route_now_iso,revision:c.revision+1};
flow.set(msg.zigbee_route_state_key,rows,store);
msg.topic='zigbee2mqtt/bridge/request/device/configure';msg.payload={id:c.configure_targets[index],transaction:tx};msg.retain=false;msg.qos='1';msg.zigbee_route_effect='configure';
return msg;
