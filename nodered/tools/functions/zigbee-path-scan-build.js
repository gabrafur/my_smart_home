const test=msg._zigbee_test===true,suffix=test?'__test':'',now=msg.zigbee_path_now;
const tx='nodered-zigbee-path-'+(test?'test-':'')+String(msg._msgid||'scan')+'-'+now;
const store=test?undefined:'persistent',old=flow.get('zigbee_path_scan'+suffix,store);
const unknown=Array.isArray(old?.unknown_transactions)?old.unknown_transactions:[];
if(old?.pending===true&&typeof old.transaction==='string')unknown.push(old.transaction);
flow.set('zigbee_path_scan'+suffix,{transaction:tx,at:now,pending:true,unknown_transactions:[...new Set(unknown)].slice(-8)},store);
msg.topic='zigbee2mqtt/bridge/request/networkmap';msg.payload={type:'raw',routes:true,transaction:tx};msg.retain=false;msg.qos='1';msg.zigbee_route_effect='route_scan';return msg;
