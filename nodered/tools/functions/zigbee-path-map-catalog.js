const map=msg.zigbee_path_map;if(!map)return msg;
const suffix=msg._zigbee_test===true?'__test':'';
let catalog=flow.get('zigbee_device_catalog_v1'+suffix)||{};
const derived={};
for(const n of map.nodes){
 const ieee=String(n?.ieeeAddr||'').toLowerCase(),name=String(n?.friendlyName||'').trim();
 if(/^0x[0-9a-f]{16}$/.test(ieee)&&name&&['Router','EndDevice','Coordinator'].includes(n.type))derived[ieee]={name,type:n.type};
}
// A correlated native map is itself an inventory producer. It also seeds a
// deployment before the unchanged bridge/devices subscription republishes.
if(!Object.keys(catalog).length&&Object.values(derived).filter(n=>n.type==='Coordinator').length===1){catalog=derived;flow.set('zigbee_device_catalog_v1'+suffix,catalog);}
const nodes=map.nodes.filter(n=>n&&/^0x[0-9a-f]{16}$/i.test(n.ieeeAddr)&&catalog[n.ieeeAddr.toLowerCase()]);
const co=nodes.filter(n=>n.type==='Coordinator'&&catalog[n.ieeeAddr.toLowerCase()].type==='Coordinator');
if(co.length!==1||new Set(nodes.map(n=>n.ieeeAddr.toLowerCase())).size!==nodes.length)return msg;
msg.zigbee_path_nodes=nodes;msg.zigbee_path_coordinator=co[0].ieeeAddr.toLowerCase();return msg;
