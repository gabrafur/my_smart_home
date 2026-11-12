const test=msg._zigbee_test===true,suffix=test?'__test':'',store=test?undefined:'persistent',memory=test?undefined:'memoryOnly';
let guard=test?msg.guard_test_facts:msg.payload;try{if(typeof guard==='string')guard=JSON.parse(guard)}catch{guard=null}
const scan=flow.get('zigbee_path_scan'+suffix,store),now=Number(msg.monitor_now??Date.now());
const bridge=flow.get('zigbee_bridge_observation'+suffix,memory),boot=flow.get('zigbee_boot_at'+suffix,memory);
const incidents=flow.get('zigbee_route_incidents_v1'+suffix,store)||{};
Object.assign(msg,{zigbee_path_guard:guard,zigbee_path_policy:flow.get('zigbee_path_policy_v1'+suffix,store),zigbee_path_monitor_policy:flow.get('zigbee_monitor_policy_v2','persistent'),
 zigbee_path_bridge_online:bridge?.state==='online',zigbee_path_boot_age_ms:Number.isFinite(boot)?now-boot:null,zigbee_path_bridge_age_ms:bridge?now-bridge.changed_at:null,
 zigbee_path_native_pending:Object.values(incidents).some(c=>c.pending_transaction!=null),zigbee_path_has_scan:!!scan,zigbee_path_scan_pending:scan?.pending===true,
 zigbee_path_scan_age_ms:scan?now-scan.at:null,zigbee_path_now:now});return msg;
