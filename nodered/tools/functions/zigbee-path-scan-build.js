const test=msg._zigbee_test===true,suffix=test?'__test':'',now=msg.zigbee_path_now;
const tx='nodered-zigbee-path-'+(test?'test-':'')+String(msg._msgid||'scan')+'-'+now;
flow.set('zigbee_path_scan'+suffix,{transaction:tx,at:now,pending:true},test?undefined:'persistent');
msg.topic='zigbee2mqtt/bridge/request/networkmap';msg.payload={type:'raw',routes:true,transaction:tx};msg.retain=false;msg.qos='1';msg.zigbee_route_effect='route_scan';return msg;
