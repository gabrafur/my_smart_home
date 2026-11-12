const known=msg.zigbee_path_known,catalog=msg.zigbee_path_catalog||{};
const upstream=msg.zigbee_path_use===true?known.path.slice(1,-1).map(id=>catalog[id].name):[];
msg.zigbee_route_targets=[...upstream,msg.zigbee_route_device];
msg.zigbee_route_path_evidence={via_names:upstream,reason:upstream.length?'known_upstream_path':'direct_device',path:msg.zigbee_path_use===true?known.path:[],observed_at:msg.zigbee_path_use===true?known.observed_at:null};
return msg;
