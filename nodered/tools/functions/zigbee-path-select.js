const test=msg._zigbee_test===true,suffix=test?'__test':'',store=test?undefined:'persistent';
const catalog=flow.get('zigbee_device_catalog_v1'+suffix)||{};
const ieee=msg.zigbee_route_ieee||Object.keys(catalog).find(id=>catalog[id].name===msg.zigbee_route_device);
const known=(flow.get('zigbee_paths_v1'+suffix,store)||{})[ieee];
const policy=flow.get('zigbee_path_policy_v1'+suffix,store);
const now=Number(msg.zigbee_route_now??msg.monitor_now??Date.now());
msg.zigbee_path_known=known||null;
msg.zigbee_path_policy=policy;
msg.zigbee_path_catalog=catalog;
msg.zigbee_path_age_ms=known?now-known.observed_at:null;
msg.zigbee_path_valid=!!(policy&&known&&['active_routing_table','parent_and_active_routing_table','neighbor_parent'].includes(known.kind)&&Array.isArray(known.path)&&known.path.at(-1)===ieee&&
 known.path[0]===known.coordinator&&catalog[known.coordinator]?.type==='Coordinator'&&
 Object.keys(catalog).filter(id=>catalog[id].type==='Coordinator').length===1&&known.path.every(id=>catalog[id])&&
 known.path.length<=policy.max_hops+2&&new Set(known.path).size===known.path.length&&
 known.path.slice(1,-1).every(id=>catalog[id].type==='Router'));
return msg;
