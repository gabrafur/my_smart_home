let p=msg.payload;
try {if(typeof p==='string')p=JSON.parse(p);} catch {return null;}
const test=msg._zigbee_test===true||String(p?.transaction||'').startsWith('nodered-zigbee-path-test-')||String(p?.transaction||'').startsWith('nodered-zigbee-route-test-');
const suffix=test?'__test':'',store=test?undefined:'persistent',tx=p?.transaction,now=Number(msg.monitor_now??Date.now());
const ticket=flow.get('zigbee_path_scan'+suffix,store);
const rows=flow.get('zigbee_route_incidents_v1'+suffix,store)||{};
const incident=Object.values(rows).find(c=>c.pending_transaction===tx&&c.native_stage==='networkmap'&&c.native_completion_state==='pending');
const background=typeof tx==='string'&&tx===ticket?.transaction&&now>=ticket.at&&now-ticket.at<=900000&&ticket.pending===true;
if(msg.retain===true||(!background&&!incident))return null;
msg._zigbee_test=test;
if(background)flow.set('zigbee_path_scan'+suffix,{...ticket,pending:false,status:p.status},store);
let map=p?.data?.value;
try {if(typeof map==='string')map=JSON.parse(map);}catch{map=null;}
if(p.status!=='ok'||!Array.isArray(map?.nodes)||!Array.isArray(map?.links)||map.nodes.length>512||map.links.length>4096)return msg;
msg.zigbee_path_map=map;return msg;
