const updates=msg.zigbee_path_updates;if(!updates)return msg;
const test=msg._zigbee_test===true,suffix=test?'__test':'',store=test?undefined:'persistent';
const history=flow.get('zigbee_paths_v1'+suffix,store)||{};
// An incomplete scan cannot erase a previously observed path.
Object.assign(history,updates);
const bounded=Object.fromEntries(Object.entries(history).sort((a,b)=>b[1].observed_at-a[1].observed_at).slice(0,2048));
flow.set('zigbee_paths_v1'+suffix,bounded,store);
return msg;
