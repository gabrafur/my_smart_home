const c=msg.zigbee_route_current||{};
msg.zigbee_path_next=msg.zigbee_route_response_valid===true&&msg.zigbee_route_response_status==='ok'&&
 msg.zigbee_route_response_reconcile_only!==true&&Array.isArray(c.configure_targets)&&Number.isInteger(c.configure_index)&&c.configure_index+1<c.configure_targets.length;
return msg;
